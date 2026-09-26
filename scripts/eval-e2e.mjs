#!/usr/bin/env node
// LLM 종단 평가 러너 — 도구 단위 테스트가 못 잡는 구간(도구 선택·파라미터 구성·caveat 전달)을
// claude CLI 헤드리스 실행으로 회귀 검증한다.
//
// 사용법:
//   node scripts/eval-e2e.mjs [--suite eval/b2a] [--only id1,id2] [--concurrency N] [--repeat N]
//
// --suite: 문항 묶음 폴더 (기본 eval/e2e). <폴더>/questions.json 을 읽고 결과는 <폴더>/results 에 쓴다.
//   MCP 설정·채점 규칙은 묶음과 무관하게 eval/e2e 것을 쓴다.
//
// 전제: 리포 루트에서 `npm run build` 로 dist/src/cli.js 가 만들어져 있어야 한다
//       (eval/e2e/mcp-config.json 이 상대경로로 이 파일을 가리킨다).
//
// 채점 규칙은 eval/e2e/grade.mjs (부작용 없는 모듈, test/eval-e2e-grade.test.mjs 로 고정).

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
// ★ 도구 호출 기록이 없으면 "무슨 근거로 답했는지" 를 사후에 확정할 수 없다 (2026-09-07 m06 사고).
//   messy 게이트의 파서를 그대로 재사용한다 — 파서가 하나여야 과거 실행도 다시 읽을 수 있다.
import { parseStream, toolNames } from '../eval/messy/parse-stream.mjs';
import { grade, environmentProblem, toolSearchProbes, EVAL_SERVER } from '../eval/e2e/grade.mjs';
import { DISALLOWED_TOOLS } from '../eval/disallowed-tools.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const DEFAULT_SUITE_DIR = join(REPO_ROOT, 'eval', 'e2e');
const CLI_PATH = join(REPO_ROOT, 'dist', 'src', 'cli.js');

/** 문항 기본 타임아웃 — 문항에 `timeout_ms` 가 있으면 그것을 쓴다 (집단 탐지처럼 긴 문항) */
const ITEM_TIMEOUT_MS = 240_000;
/** 타임아웃 뒤 프로세스 트리가 닫히기를 기다리는 상한 */
const KILL_WAIT_MS = 15_000;
const RAW_KEEP_CHARS = 1000;

/** 인자 파싱 */
function parseArgs(argv) {
  const opts = { only: null, concurrency: 2, suiteDir: DEFAULT_SUITE_DIR, repeat: 1, noTools: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--only') {
      const value = argv[i + 1];
      if (!value) throw new Error('--only 옵션에 문항 id 목록이 필요합니다 (쉼표 구분).');
      opts.only = value.split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
    } else if (arg.startsWith('--only=')) {
      opts.only = arg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--suite') {
      const value = argv[i + 1];
      if (!value) throw new Error('--suite 옵션에 문항 묶음 폴더가 필요합니다 (예: eval/b2a).');
      opts.suiteDir = join(REPO_ROOT, value);
      i += 1;
    } else if (arg.startsWith('--suite=')) {
      opts.suiteDir = join(REPO_ROOT, arg.slice('--suite='.length));
    } else if (arg === '--repeat' || arg.startsWith('--repeat=')) {
      // 문항당 N회 — 답변 1건으로는 회차 간 흔들림이 개선 효과보다 컸다 (b2a 2차 A9 → 3차 A7, 대부분 모델 재서술)
      const value = arg === '--repeat' ? argv[++i] : arg.slice('--repeat='.length);
      opts.repeat = Number(value);
    } else if (arg === '--no-tools') {
      // 대조군: 우리 MCP 없이 같은 격리(웹·파일 차단)로 Claude 단독 답변 — 도구의 순효과를 재는 기준
      opts.noTools = true;
    } else if (arg === '--concurrency') {
      const value = argv[i + 1];
      if (!value) throw new Error('--concurrency 옵션에 숫자가 필요합니다.');
      opts.concurrency = Number(value);
      i += 1;
    } else if (arg.startsWith('--concurrency=')) {
      opts.concurrency = Number(arg.slice('--concurrency='.length));
    } else {
      throw new Error(`알 수 없는 옵션입니다: ${arg}`);
    }
  }
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
    throw new Error('--concurrency 는 1 이상의 정수여야 합니다.');
  }
  return opts;
}

/**
 * 우리가 띄운 프로세스 **트리만** 종료한다.
 *
 * ⚠️ Windows 에서 shell:true 로 띄우면 `child.pid` 는 cmd.exe 다. `child.kill()` 은 cmd.exe 만
 *   죽이고 그 아래 claude(와 그 claude 가 띄운 MCP 서버 node)는 **살아 남는다** — 다음 문항과
 *   세션 한도를 계속 잡아먹는다. 그래서 정확히 이 PID 를 루트로 한 트리를 끊는다.
 *   ★ 프로세스 **이름**으로 종료하지 않는다 (taskkill /IM claude.exe 는 사용자의 다른 세션까지 죽인다).
 */
function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => child.kill());
  } else {
    child.kill('SIGTERM');
  }
}

/**
 * 문항마다 **빈 임시 작업 디렉터리**를 만든다.
 *
 * ⚠️ 2026-09-13 1차 실행은 저장소를 cwd 로 claude 를 띄워, 프로젝트 CLAUDE.local.md(법령 수치·개발 기록)가
 *   세션에 섞였다 — 답변이 "프로젝트 기록(과태료 부과기준 고시 Ⅴ)에서 가져왔다" 고 적고 "도구 결함(개발 관점)"
 *   절까지 붙였다. 도구 근거와 개발자 메모를 가를 수 없으면 이 평가는 무효다.
 *   → cwd 를 빈 임시 디렉터리로, MCP 설정은 절대경로로 생성한다.
 */
let NO_TOOLS = false;
function makeWorkDir() {
  const dir = mkdtempSync(join(tmpdir(), 'gongsi-eval-'));
  const config = join(dir, 'mcp.json');
  writeFileSync(
    config,
    JSON.stringify({ mcpServers: NO_TOOLS ? {} : { [EVAL_SERVER]: { command: process.execPath, args: [CLI_PATH] } } }),
    'utf8',
  );
  return { dir, config };
}

/** 작업 디렉터리의 조상에 CLAUDE.md 가 있으면 그것도 세션에 섞인다 — 실행 전에 거절한다 */
function contextFilesAbove(dir) {
  const found = [];
  let d = dir;
  for (;;) {
    // AGENTS.md: CLI 내장 agents-md 플러그인이 읽는다 (2.1.281~)
    for (const name of ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']) {
      if (existsSync(join(d, name))) found.push(join(d, name));
    }
    const parent = dirname(d);
    if (parent === d) return found;
    d = parent;
  }
}

/** claude CLI 헤드리스 1회 실행 — 질문은 stdin 으로 넘긴다(한글 인용부호 문제 회피) */
function runClaude(question, timeoutMs, work) {
  return new Promise((resolve) => {
    const configArg = process.platform === 'win32' ? `"${work.config}"` : work.config;
    const args = [
      '-p',
      '--mcp-config', configArg,
      '--strict-mcp-config',
      // ★ 사용자 설정(플러그인·훅·auto 권한 모드)을 읽지 않는다. 1차 실행 init 에는 플러그인 14개가 붙고
      //   SessionStart 훅이 additionalContext 를 주입했다. 인증(OAuth)은 설정 파일이 아니라 그대로 된다.
      //   ⚠️ 한계: 사용자 전역 ~/.claude/CLAUDE.md 는 이 설정에서도 로드된다(2026-09-13 탐침) — 프로젝트·
      //   플러그인·훅 격리이지 완전히 깨끗한 환경이 아니다 (eval/e2e/README.md "맥락 격리").
      '--setting-sources', 'project,local',
      '--allowedTools', 'mcp__gongsi',
      // ⚠️ **auto 모드에서는 `--allowedTools` 가 허용 목록으로 동작하지 않는다** (2026-09-07 실측).
      //   차단 목록이 유일한 격리 수단이고, messy 러너와 같은 목록을 쓴다 (eval/disallowed-tools.mjs).
      //   ★ ToolSearch 는 남긴다 (MCP 도구가 지연 로드라 막으면 MCP 도구를 아예 못 부른다).
      '--disallowedTools', DISALLOWED_TOOLS,
      // stream-json + verbose 라야 도구 호출 이벤트가 나온다 (json 은 최종 결과만 준다)
      '--output-format', 'stream-json', '--verbose',
      '--max-turns', '16',
    ];
    // 인자는 전부 ASCII 상수라 문자열 결합이 안전하다 (DEP0190 회피 — 질문은 stdin 으로만)
    const child = process.platform === 'win32'
      ? spawn(`claude ${args.join(' ')}`, { cwd: work.dir, shell: true, windowsHide: true })
      : spawn('claude', args, { cwd: work.dir });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killWait);
      resolve({ timedOut, stdout, stderr, pid: child.pid ?? null, ...extra });
    };

    let killWait;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // 트리가 닫히지 않으면(파이프를 쥔 손자 프로세스) 무한 대기하지 않고 그 사실을 기록한다
      killWait = setTimeout(() => finish({ spawnError: null, exitCode: null, killConfirmed: false }), KILL_WAIT_MS);
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (err) => finish({ spawnError: err.message, exitCode: null, killConfirmed: true }));
    child.on('close', (code) => finish({ spawnError: null, exitCode: code, killConfirmed: true }));

    child.stdin.setDefaultEncoding('utf8');
    child.stdin.write(question);
    child.stdin.end();
  });
}

/** 결과 파일에 남길 도구 흔적 */
function traceOf(rec) {
  return {
    tools_used: toolNames(rec),
    tool_calls: rec.tool_calls,
    tool_results: (rec.tool_results ?? []).map((r) => ({
      tool_use_id: r.tool_use_id ?? null,
      name: r.name,
      is_error: r.is_error,
      result_chars: r.chars ?? null,
      head: (r.head ?? '').slice(0, 200),
    })),
    permission_denials: rec.permission_denials ?? [],
    toolsearch_probes: toolSearchProbes(rec),
    /** 도구 밖 맥락 — cwd·권한 모드·모델·플러그인·훅 수·메모리 경로 */
    context: rec.context ?? null,
    mcp_servers: rec.mcp_servers ?? null,
    tools_available: rec.tools_available ?? null,
  };
}

/** 문항 1건 실행 + 채점 */
async function runItem(item, streamsDir) {
  const timeoutMs = item.timeout_ms ?? ITEM_TIMEOUT_MS;
  const work = makeWorkDir();
  const started = Date.now();
  const run = await runClaude(item.question, timeoutMs, work);
  const elapsedMs = Date.now() - started;
  // 우리가 만든 임시 디렉터리만 지운다 (Windows 파일 잠금이면 남았다고 기록한다)
  let workDirRemoved = true;
  try {
    rmSync(work.dir, { recursive: true, force: true });
  } catch {
    workDirRemoved = false;
  }

  // 원본 스트림은 그대로 남긴다 — 채점기를 고쳤을 때 과거 실행을 다시 읽을 수 있어야 한다
  const streamPath = join(streamsDir, `${item.id}.stream.jsonl`);
  writeFileSync(streamPath, run.stdout, 'utf8');
  const base = {
    id: item.id,
    category: item.category,
    question: item.question,
    elapsed_ms: elapsedMs,
    stream_path: relative(REPO_ROOT, streamPath).replace(/\\/g, '/'),
    claude_pid: run.pid,
    exit_code: run.exitCode ?? null,
    work_dir: work.dir,
    work_dir_removed: workDirRemoved,
  };

  if (run.timedOut) {
    return {
      ...base,
      status: 'timeout',
      failures: [`timeout: ${timeoutMs / 1000}초 초과`],
      kill_confirmed: run.killConfirmed,
      signalMisses: 0,
      answer: '',
      ...traceOf(parseStream(run.stdout)),
      raw: run.stdout.slice(-RAW_KEEP_CHARS),
    };
  }
  if (run.spawnError) {
    return {
      ...base,
      status: 'runner_error',
      failures: [`실행 실패: ${run.spawnError}`],
      signalMisses: 0,
      answer: '',
      raw: (run.stderr || run.stdout).slice(0, RAW_KEEP_CHARS),
    };
  }

  const rec = parseStream(run.stdout);
  if (!rec.result_seen) {
    return {
      ...base,
      status: 'runner_error',
      failures: [
        `stream-json 에 result 이벤트가 없습니다 (파싱 ${rec.events_parsed}건 / 실패 ${rec.lines_unparsed}줄)`,
      ],
      signalMisses: 0,
      answer: '',
      ...traceOf(rec),
      raw: (run.stderr || run.stdout).slice(0, RAW_KEEP_CHARS),
    };
  }

  const common = {
    ...base,
    num_turns: rec.num_turns,
    cost_usd: rec.cost_usd,
    answer: rec.answer ?? '',
    ...traceOf(rec),
  };

  // 서버가 안 떴거나 격리가 샜으면 "우리 MCP 만으로 답이 되는가" 를 잰 것이 아니다 — 통과도 실패도 아니다
  const env = environmentProblem(rec);
  if (env) {
    return { ...common, status: 'env_error', failures: [env], signalMisses: 0 };
  }
  // 세션 한도·API 오류 등 호스트 가용성 문제 — 제품 실패와 구분해 센다
  if (rec.is_error) {
    return {
      ...common,
      status: 'host_error',
      failures: [
        `claude 응답이 is_error 로 반환됨 (subtype=${rec.subtype ?? '?'}, api_error_status=${rec.api_error_status ?? 'null'})`,
      ],
      signalMisses: 0,
    };
  }

  const { failures, signalMisses } = grade(item, common.answer, rec);
  return { ...common, status: failures.length === 0 ? 'pass' : 'fail', failures, signalMisses };
}

/** 동시 실행 풀 */
async function runPool(items, concurrency, streamsDir, onDone) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const result = await runItem(items[index], streamsDir);
      results[index] = result;
      onDone(result);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

function timestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const questionsPath = join(opts.suiteDir, 'questions.json');
  if (!existsSync(questionsPath)) throw new Error(`문항 파일이 없습니다: ${questionsPath}`);
  const suite = JSON.parse(readFileSync(questionsPath, 'utf8'));
  const resultsDir = join(opts.suiteDir, 'results');

  let items = suite.items;
  if (opts.only) {
    const wanted = new Set(opts.only);
    items = items.filter((item) => wanted.has(item.id));
    const missing = opts.only.filter((id) => !suite.items.some((item) => item.id === id));
    if (missing.length > 0) {
      throw new Error(`questions.json 에 없는 문항 id 입니다: ${missing.join(', ')}`);
    }
  }
  if (!Number.isInteger(opts.repeat) || opts.repeat < 1) {
    throw new Error('--repeat 는 1 이상의 정수여야 합니다.');
  }
  if (opts.repeat > 1) {
    // 반복분은 id 에 @k 를 붙인다 — 스트림 파일이 겹치지 않고, regrade 는 @ 앞을 문항 id 로 본다
    items = items.flatMap((item) =>
      Array.from({ length: opts.repeat }, (_, k) => (k === 0 ? item : { ...item, id: `${item.id}@${k + 1}` })),
    );
  }
  if (items.length === 0) {
    throw new Error('실행할 문항이 없습니다.');
  }
  if (!existsSync(CLI_PATH)) {
    throw new Error(`빌드 산출물이 없습니다: ${CLI_PATH} — npm run build 를 먼저 실행하세요.`);
  }
  const above = contextFilesAbove(tmpdir());
  if (above.length > 0) {
    throw new Error(
      `임시 디렉터리 조상에 CLAUDE 파일이 있어 세션 맥락이 오염됩니다: ${above.join(', ')} — TMP/TEMP 를 다른 곳으로 지정하세요.`,
    );
  }

  NO_TOOLS = opts.noTools;
  const runId = `eval-${timestamp(new Date())}${opts.noTools ? '-notools' : ''}`;
  const streamsDir = join(resultsDir, runId);
  mkdirSync(streamsDir, { recursive: true });

  console.log(
    `[eval] 문항 ${items.length}건 (${items.map((i) => i.id).join(', ')}) · 동시성 ${opts.concurrency} · ` +
      `기본 타임아웃 ${ITEM_TIMEOUT_MS / 1000}초`,
  );

  const results = await runPool(items, opts.concurrency, streamsDir, (result) => {
    const mark = result.status === 'pass' ? '✓' : '✗';
    const reason = result.status === 'pass' ? '' : ` [${result.status}] ${result.failures.join(' / ')}`;
    const tools = (result.tools_used ?? []).join(',') || '(도구 없음)';
    console.log(`${mark} ${result.id} (${(result.elapsed_ms / 1000).toFixed(1)}s · ${tools})${reason}`);
  });

  const count = (s) => results.filter((r) => r.status === s).length;
  const signalMisses = results.reduce((sum, r) => sum + (r.signalMisses ?? 0), 0);
  const totalCost = results.reduce((sum, r) => sum + (typeof r.cost_usd === 'number' ? r.cost_usd : 0), 0);

  const summary = {
    version: suite.version,
    run_id: runId,
    ran_at: new Date().toISOString(),
    total: results.length,
    passed: count('pass'),
    failed: count('fail'),
    timeouts: count('timeout'),
    /** 제품 실패가 아닌 것 — 서버 미기동·격리 누출 / 세션 한도·API 오류 / 러너 자체 오류 */
    env_errors: count('env_error'),
    host_errors: count('host_error'),
    runner_errors: count('runner_error'),
    signal_misses: signalMisses,
    total_cost_usd: Number(totalCost.toFixed(4)),
  };

  const outPath = join(resultsDir, `${runId}.json`);
  writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2), 'utf8');

  console.log('');
  console.log(
    `통과 ${summary.passed}/${summary.total} · 실패 ${summary.failed} · 타임아웃 ${summary.timeouts} · ` +
      `환경 ${summary.env_errors} · 호스트 ${summary.host_errors} · 러너 ${summary.runner_errors} · ` +
      `신호누락 ${signalMisses}건`,
  );
  console.log(`총 비용 $${totalCost.toFixed(4)}`);
  console.log(`결과 저장: ${outPath}`);
  console.log(`스트림 원본: ${streamsDir}`);

  if (summary.passed !== results.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[eval] 실행 중단: ${err.message}`);
  process.exitCode = 1;
});
