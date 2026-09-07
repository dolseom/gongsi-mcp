// 두서없는 질문 게이트 러너 — 답변 원문과 도구 사용 흔적을 보관한다. 채점은 사람이 한다.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseStream, toolNames } from './parse-stream.mjs';

const REPO = 'C:/Users/jjang/Desktop/AI공부/☆☆클로드코드/dart-mcp';
const HERE = process.cwd();
const items = JSON.parse(readFileSync(path.join(HERE, 'messy-questions.json'), 'utf8')).items;
const only = process.argv[2] ? process.argv[2].split(',') : null;
const CONC = Number(process.argv[3] ?? 2);
const OUT = path.join(HERE, 'messy-results');
mkdirSync(OUT, { recursive: true });

// 홈 .env 의 키를 자식 프로세스에 넘긴다 (프로젝트 .env 는 캐시 DB 가 다르다)
const env = { ...process.env };
for (const line of readFileSync(path.join(process.env.USERPROFILE ?? process.env.HOME, '.gongsi-mcp', '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}

/**
 * ⚠️ **auto 모드에서는 `--allowedTools` 가 허용 목록으로 동작하지 않는다.**
 * 사용자 설정이 `defaultMode: auto` 라 내장 도구가 그대로 살아 있다 — 2026-09-07 stream-json
 * 으로 확인한 결과 init 이벤트의 `tools` 에 WebFetch·WebSearch·Bash 가 전부 들어 있었다.
 * 그러면 이 평가가 재는 것이 "우리 MCP 가 유용한가"가 아니라 "모델이 웹을 잘 뒤지는가"가 된다.
 * → 차단이 필요하다. `--disallowedTools` 로 막는다.
 *
 * ★ `ToolSearch` 는 **남긴다.** MCP 도구가 지연 로드라 모델이 ToolSearch 로 스키마를 먼저
 *   가져온다 (실측: m06 의 첫 호출이 `ToolSearch{select:mcp__gongsi__search_ftc_qna}`).
 *   이걸 막으면 MCP 도구를 아예 부를 수 없다.
 */
const DISALLOWED = 'WebFetch,WebSearch,Bash,PowerShell,Read,Glob,Grep,Edit,Write,Task,Agent';

function runOne(q) {
  return new Promise((resolve) => {
    const args = ['-p', '--mcp-config', `"${path.join(HERE, "mcp-eval.json")}"`,
      '--strict-mcp-config', '--allowedTools', 'mcp__gongsi',
      '--disallowedTools', `"${DISALLOWED}"`,
      // stream-json + verbose 라야 도구 호출 이벤트가 나온다 (json 은 최종 결과만 준다)
      '--output-format', 'stream-json', '--verbose', '--max-turns', '30'];
    const child = spawn(`claude ${args.join(' ')}`, { cwd: REPO, shell: true, env });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill(), 300_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', () => { clearTimeout(timer); resolve({ out, err }); });
    child.stdin.setDefaultEncoding('utf8');
    child.stdin.write(q);
    child.stdin.end();
  });
}

const targets = only ? items.filter((i) => only.includes(i.id)) : items;
let idx = 0;
const results = [];
async function worker() {
  while (idx < targets.length) {
    const item = targets[idx++];
    const t0 = Date.now();
    const { out, err } = await runOne(item.question);
    // 원본 스트림은 그대로 남긴다 — 파서를 고쳤을 때 과거 실행을 다시 읽을 수 있어야 한다
    writeFileSync(path.join(OUT, `${item.id}.stream.jsonl`), out, 'utf8');
    const p = parseStream(out);
    const rec = {
      id: item.id, type: item.type, question: item.question, watch: item.watch,
      elapsed_s: ((Date.now() - t0) / 1000).toFixed(1),
      is_error: p.result_seen ? p.is_error : true,
      num_turns: p.num_turns,
      answer: p.answer,
      raw_head: p.result_seen ? null : (out || err).slice(0, 600),
      // ── 도구 사용 흔적 (2026-09-06 실행에 없어서 근거 출처를 확정하지 못했다) ──
      tools_available: p.tools_available,
      mcp_servers: p.mcp_servers,
      tool_calls: p.tool_calls,
      tool_results: p.tool_results,
      permission_denials: p.permission_denials,
      duration_ms: p.duration_ms,
    };
    // 요약에서 한눈에 보는 값 — 중복 제거·호출 순서 유지
    rec.tool_names = toolNames(rec);
    results.push(rec);
    writeFileSync(path.join(OUT, `${item.id}.json`), JSON.stringify(rec, null, 2), 'utf8');
    console.error(`[${rec.id}] ${rec.is_error ? 'ERROR' : 'ok'} turns=${rec.num_turns} ${rec.elapsed_s}s tools=${rec.tool_names.join(',') || '(없음)'}`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
// _all.json 은 종전대로 **레코드 배열**이다 (각 레코드에 tool_names·tool_calls 가 들어 있다)
writeFileSync(path.join(OUT, '_all.json'), JSON.stringify(results, null, 2), 'utf8');
console.error(`\n완료 ${results.length}건 · 오류 ${results.filter((r) => r.is_error).length}건`);
