#!/usr/bin/env node
// LLM 종단 평가 러너 — 도구 단위 테스트가 못 잡는 구간(도구 선택·파라미터 구성·caveat 전달)을
// claude CLI 헤드리스 실행으로 회귀 검증한다.
//
// 사용법:
//   node scripts/eval-e2e.mjs [--only id1,id2] [--concurrency N]
//
// 전제: 리포 루트에서 `npm run build` 로 dist/src/cli.js 가 만들어져 있어야 한다
//       (eval/e2e/mcp-config.json 이 상대경로로 이 파일을 가리킨다).

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const QUESTIONS_PATH = join(REPO_ROOT, 'eval', 'e2e', 'questions.json');
const MCP_CONFIG_REL = 'eval/e2e/mcp-config.json';
const RESULTS_DIR = join(REPO_ROOT, 'eval', 'e2e', 'results');

const ITEM_TIMEOUT_MS = 240_000;
const RAW_KEEP_CHARS = 1000;

/** 인자 파싱 */
function parseArgs(argv) {
  const opts = { only: null, concurrency: 2 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--only') {
      const value = argv[i + 1];
      if (!value) throw new Error('--only 옵션에 문항 id 목록이 필요합니다 (쉼표 구분).');
      opts.only = value.split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
    } else if (arg.startsWith('--only=')) {
      opts.only = arg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
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

/** 콤마·공백 제거 정규화 (금액 표기 차이 흡수) */
function normalize(text) {
  return String(text).replace(/[\s,]/g, '');
}

/** 원문 포함 또는 정규화 포함이면 매치 */
function contains(answer, needle) {
  if (answer.includes(needle)) return true;
  return normalize(answer).includes(normalize(needle));
}

/** 그룹(OR 후보 배열) 중 하나라도 답변에 있으면 true */
function matchGroup(answer, group) {
  return group.some((alt) => contains(answer, alt));
}

/** 문항 1건 채점 — 결정적 */
function grade(item, answer, numTurns) {
  const failures = [];
  let signalMisses = 0;

  for (const group of item.expect ?? []) {
    if (!matchGroup(answer, group)) {
      failures.push(`expect: ${group.join('|')}`);
    }
  }
  for (const group of item.signals ?? []) {
    if (!matchGroup(answer, group)) {
      failures.push(`signal: ${group.join('|')}`);
      signalMisses += 1;
    }
  }
  for (const banned of item.forbid ?? []) {
    if (contains(answer, banned)) {
      failures.push(`forbid: ${banned}`);
    }
  }
  // 기본은 도구 사용 필수(자체 지식 답변 = #52 유형 실패). 도구 설명 자체에 근거가 있는
  // 개념 교정 문항만 require_tool:false 로 예외.
  if ((item.require_tool ?? true) && typeof numTurns === 'number' && numTurns < 2) {
    failures.push('tool_not_used');
  }
  return { failures, signalMisses };
}

/** claude CLI 헤드리스 1회 실행 — 질문은 stdin 으로 넘긴다(한글 인용부호 문제 회피) */
function runClaude(question) {
  return new Promise((resolve) => {
    const args = [
      '-p',
      '--mcp-config', MCP_CONFIG_REL,
      '--strict-mcp-config',
      '--allowedTools', 'mcp__gongsi',
      '--output-format', 'json',
      '--max-turns', '12',
    ];
    // 인자는 전부 ASCII 상수라 문자열 결합이 안전하다 (DEP0190 회피 — 질문은 stdin 으로만)
    const child = process.platform === 'win32'
      ? spawn(`claude ${args.join(' ')}`, { cwd: REPO_ROOT, shell: true })
      : spawn('claude', args, { cwd: REPO_ROOT });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, ITEM_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ timedOut: false, spawnError: err.message, stdout, stderr });
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ timedOut, spawnError: null, stdout, stderr });
    });

    child.stdin.setDefaultEncoding('utf8');
    child.stdin.write(question);
    child.stdin.end();
  });
}

/** 문항 1건 실행 + 채점 */
async function runItem(item) {
  const started = Date.now();
  const { timedOut, spawnError, stdout, stderr } = await runClaude(item.question);
  const elapsedMs = Date.now() - started;

  if (timedOut) {
    return {
      id: item.id,
      category: item.category,
      status: 'timeout',
      failures: [`timeout: ${ITEM_TIMEOUT_MS / 1000}초 초과`],
      signalMisses: 0,
      num_turns: null,
      cost_usd: null,
      elapsed_ms: elapsedMs,
      answer: '',
      raw: stdout.slice(0, RAW_KEEP_CHARS),
    };
  }
  if (spawnError) {
    return {
      id: item.id,
      category: item.category,
      status: 'error',
      failures: [`실행 실패: ${spawnError}`],
      signalMisses: 0,
      num_turns: null,
      cost_usd: null,
      elapsed_ms: elapsedMs,
      answer: '',
      raw: (stderr || stdout).slice(0, RAW_KEEP_CHARS),
    };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    return {
      id: item.id,
      category: item.category,
      status: 'error',
      failures: [`응답 JSON 파싱 실패: ${err.message}`],
      signalMisses: 0,
      num_turns: null,
      cost_usd: null,
      elapsed_ms: elapsedMs,
      answer: '',
      raw: stdout.slice(0, RAW_KEEP_CHARS),
    };
  }

  if (parsed.is_error) {
    return {
      id: item.id,
      category: item.category,
      status: 'error',
      failures: ['claude 응답이 is_error 로 반환됨'],
      signalMisses: 0,
      num_turns: parsed.num_turns ?? null,
      cost_usd: parsed.total_cost_usd ?? null,
      elapsed_ms: elapsedMs,
      answer: typeof parsed.result === 'string' ? parsed.result : '',
      raw: stdout.slice(0, RAW_KEEP_CHARS),
    };
  }

  const answer = typeof parsed.result === 'string' ? parsed.result : '';
  const { failures, signalMisses } = grade(item, answer, parsed.num_turns);

  return {
    id: item.id,
    category: item.category,
    status: failures.length === 0 ? 'pass' : 'fail',
    failures,
    signalMisses,
    num_turns: parsed.num_turns ?? null,
    cost_usd: parsed.total_cost_usd ?? null,
    elapsed_ms: elapsedMs,
    answer,
  };
}

/** 동시 실행 풀 */
async function runPool(items, concurrency, onDone) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const result = await runItem(items[index]);
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
  const suite = JSON.parse(readFileSync(QUESTIONS_PATH, 'utf8'));

  let items = suite.items;
  if (opts.only) {
    const wanted = new Set(opts.only);
    items = items.filter((item) => wanted.has(item.id));
    const missing = opts.only.filter((id) => !suite.items.some((item) => item.id === id));
    if (missing.length > 0) {
      throw new Error(`questions.json 에 없는 문항 id 입니다: ${missing.join(', ')}`);
    }
  }
  if (items.length === 0) {
    throw new Error('실행할 문항이 없습니다.');
  }

  console.log(`[eval] 문항 ${items.length}건 · 동시성 ${opts.concurrency} · 문항당 타임아웃 ${ITEM_TIMEOUT_MS / 1000}초`);

  const results = await runPool(items, opts.concurrency, (result) => {
    const mark = result.status === 'pass' ? '✓' : '✗';
    const reason = result.status === 'pass' ? '' : ` — ${result.failures.join(' / ')}`;
    console.log(`${mark} ${result.id}${reason}`);
  });

  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const timeouts = results.filter((r) => r.status === 'timeout').length;
  const errors = results.filter((r) => r.status === 'error').length;
  const signalMisses = results.reduce((sum, r) => sum + (r.signalMisses ?? 0), 0);
  const totalCost = results.reduce((sum, r) => sum + (typeof r.cost_usd === 'number' ? r.cost_usd : 0), 0);

  const summary = {
    version: suite.version,
    ran_at: new Date().toISOString(),
    total: results.length,
    passed,
    failed,
    timeouts,
    errors,
    signal_misses: signalMisses,
    total_cost_usd: Number(totalCost.toFixed(4)),
  };

  mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = join(RESULTS_DIR, `eval-${timestamp(new Date())}.json`);
  writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2), 'utf8');

  console.log('');
  console.log(`통과 ${passed}/${results.length} · 실패 ${failed} · 타임아웃 ${timeouts} · 오류 ${errors} · 신호누락 ${signalMisses}건`);
  console.log(`총 비용 $${totalCost.toFixed(4)}`);
  console.log(`결과 저장: ${outPath}`);

  if (passed !== results.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[eval] 실행 중단: ${err.message}`);
  process.exitCode = 1;
});
