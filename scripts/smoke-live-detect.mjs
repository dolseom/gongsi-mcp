#!/usr/bin/env node
/**
 * 실물(live) 탐지 → 상세 왕복 스모크 — **실제 DART 키**로 빌드된 stdio 서버를 띄워 확인한다.
 *
 *   node scripts/smoke-live-detect.mjs [--rcept 20260819000341] [--no-evict]
 *
 * 무엇을 보나 (키 없는 설치 스모크 scripts/smoke-tarball.mjs 가 원리상 못 보는 것):
 *  1. detect_undisclosed_transactions 첫 응답이 **실제 전송 문자열 기준** 24,576바이트 이하
 *  2. read_detection_result 로 전체를 끝까지 읽어 이어붙이면 파싱되고, 요약의 집계와 같다
 *  3. section 별로 읽은 조각이 전체 결과의 해당 항목과 같다
 *  4. 없는 section 은 거절, **서버를 새로 띄우면** 앞 result_id 는 result_unavailable (프로세스 범위)
 *  5. (기본) 탐지를 4번 더 돌리면 첫 result_id 가 회수돼 result_unavailable — 다른 결과를 대신 주지 않는다
 *
 * ⚠️ 비결정: 판정은 J001 신규 접수에 따라 달라질 수 있다. 그래서 수치 골든을 두지 않고 **계약**만 본다.
 * ⚠️ 키·네트워크·한도 문제는 제품 실패가 아니다 — "미수행"으로 종료 코드 2 를 낸다.
 * 키 값은 출력하지 않는다 (server_info 의 설정 여부 boolean 만 본다).
 * 사전 조건: npm run build, DART_API_KEY 가 .env 또는 ~/.gongsi-mcp/.env 에 있을 것.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const cli = join(root, 'dist', 'src', 'cli.js');
const BUDGET = 24_576;
const REQUEST_TIMEOUT_MS = 120_000;
const ENV_ERRORS = new Set([
  'missing_api_key',
  'rate_limit',
  'dart_api_error',
  'egroup_api_error',
  'upstream_forbidden',
  'deadline_exceeded',
]);

const argv = process.argv.slice(2);
const rceptIdx = argv.indexOf('--rcept');
const RCEPT = rceptIdx >= 0 ? argv[rceptIdx + 1] : '20260819000341';
const EVICT = !argv.includes('--no-evict');

function log(msg) {
  console.error(`[smoke-live] ${msg}`);
}
function fail(msg) {
  log(`실패: ${msg}`);
  process.exit(1);
}
function notPerformed(msg) {
  log(`미수행(환경): ${msg}`);
  process.exit(2);
}

/** stdio MCP 서버 하나 — 요청 타이머는 응답 즉시 지운다 (종료 지연 방지) */
function startServer() {
  const proc = spawn(process.execPath, [cli], { cwd: root, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buf = '';
  let nextId = 1;
  proc.stderr.on('data', () => {});
  proc.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        fail(`stdout 에 JSON 아닌 출력이 섞였습니다: ${line.slice(0, 120)}`);
      }
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  });
  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} ${REQUEST_TIMEOUT_MS / 1000}초 응답 없음`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async function init() {
    await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-live', version: '0.0.0' },
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }
  async function stop() {
    if (proc.exitCode !== null || proc.signalCode !== null) return { code: proc.exitCode, signal: proc.signalCode };
    const exited = new Promise((r) => proc.once('exit', (code, signal) => r({ code, signal })));
    proc.kill();
    let t;
    const res = await Promise.race([exited, new Promise((r) => (t = setTimeout(() => r(null), 5_000)))]);
    clearTimeout(t);
    return res;
  }
  return { proc, request, init, stop, call: (name, args) => request('tools/call', { name, arguments: args }) };
}

const text = (res) => res?.content?.[0]?.text ?? '';
const body = (res) => {
  try {
    return JSON.parse(text(res));
  } catch {
    return null;
  }
};
const bytesOf = (res) => Buffer.byteLength(text(res), 'utf8');

const report = { rcept_no: RCEPT, kind: 'live keyed stdio (non-deterministic)', checks: [] };
function ok(name, detail) {
  report.checks.push({ name, ...detail });
  log(`✓ ${name} ${JSON.stringify(detail)}`);
}

const a = startServer();
log(`서버 A 기동 pid=${a.proc.pid}`);
await a.init();

const info = body(await a.call('server_info', {}));
if (!info?.keys?.dart_api_key_set) notPerformed('DART_API_KEY 가 설정돼 있지 않습니다');

async function detect(server) {
  const t0 = Date.now();
  const res = await server.call('detect_undisclosed_transactions', { rcept_no: RCEPT });
  const b = body(res);
  if (res.isError) {
    if (b && ENV_ERRORS.has(b.error)) notPerformed(`탐지 실패 ${b.error}: ${String(b.message).slice(0, 160)}`);
    fail(`탐지 오류: ${text(res).slice(0, 300)}`);
  }
  return { res, b, ms: Date.now() - t0 };
}

// 1) 첫 응답
const first = await detect(a);
const sum = first.b;
const firstBytes = bytesOf(first.res);
if (firstBytes > BUDGET) fail(`첫 응답 ${firstBytes}바이트 > ${BUDGET}`);
const rid = sum?.detail_access?.result_id;
if (!/^[0-9a-f]{32}$/.test(rid ?? '')) fail(`result_id 형식 이상: ${rid}`);
if (!sum.required_warnings?.some((w) => w.includes('후보(candidate)는 확정이 아닙니다'))) {
  fail('필수 경고(후보≠확정)가 첫 응답에 없습니다');
}
ok('첫 응답 예산', {
  bytes: firstBytes,
  elapsed_ms: first.ms,
  continuation_complete: sum.continuation?.complete,
  actions_total: sum.action_items_preview?.total,
  actions_shown: sum.action_items_preview?.shown,
  summary_incomplete: sum.summary_incomplete,
  sections: sum.detail_access.available_sections_total,
  total_chars: sum.detail_access.total_chars,
});

// 2) 전체를 끝까지 읽어 복원
async function readAll(server, section) {
  let offset = 0;
  let joined = '';
  let pages = 0;
  let maxBytes = 0;
  for (;;) {
    const res = await server.call('read_detection_result', { result_id: rid, ...(section ? { section } : {}), offset });
    if (res.isError) fail(`상세 읽기 오류(${section ?? '전체'} @${offset}): ${text(res).slice(0, 200)}`);
    const p = body(res);
    pages += 1;
    maxBytes = Math.max(maxBytes, bytesOf(res));
    if (p.offset !== offset) fail(`offset 불일치 ${p.offset} ≠ ${offset}`);
    joined += p.text;
    if (p.complete) {
      if (p.next_offset !== null) fail('complete 인데 next_offset 이 null 이 아닙니다');
      break;
    }
    if (!(p.next_offset > offset)) fail(`next_offset 이 전진하지 않습니다 (${p.next_offset})`);
    offset = p.next_offset;
  }
  return { joined, pages, maxBytes };
}
const whole = await readAll(a);
if (whole.maxBytes > BUDGET) fail(`상세 페이지 최대 ${whole.maxBytes}바이트 > ${BUDGET}`);
let full;
try {
  full = JSON.parse(whole.joined);
} catch (e) {
  fail(`이어붙인 전체가 JSON 으로 파싱되지 않습니다: ${e}`);
}
if (whole.joined.length !== sum.detail_access.total_chars) {
  fail(`복원 길이 ${whole.joined.length} ≠ total_chars ${sum.detail_access.total_chars}`);
}
const summaryMatches =
  sum.summary?.summary_omitted_due_to_size === true ||
  JSON.stringify(full.summary) === JSON.stringify(sum.summary);
if (!summaryMatches) fail('요약의 summary 와 상세 전체의 summary 가 다릅니다');
if (full.action_items?.total !== sum.action_items_preview?.total) fail('조치 총수가 요약과 상세에서 다릅니다');
ok('전체 복원', { pages: whole.pages, max_page_bytes: whole.maxBytes, chars: whole.joined.length, summary_matches: true });

// 3) section 조각 = 전체의 해당 항목
// 실물 최상위 항목 이름으로 확인한다 — `not_judged` 는 summary 카운터라 최상위 section 이 아니다
for (const s of ['scope_caveats', 'goods_services_signals', 'coverage', 'action_items']) {
  if (!sum.detail_access.available_sections.includes(s)) {
    ok(`section ${s}`, { present: false });
    continue;
  }
  const r = await readAll(a, s);
  const same = JSON.stringify(JSON.parse(r.joined)) === JSON.stringify(full[s]);
  if (!same) fail(`section ${s} 조각이 전체 결과의 해당 항목과 다릅니다`);
  ok(`section ${s}`, { pages: r.pages, max_page_bytes: r.maxBytes, equals_full: true });
}

// 4) 없는 section
const bad = await a.call('read_detection_result', { result_id: rid, section: 'no_such_section' });
if (!bad.isError || body(bad)?.error !== 'invalid_argument') fail(`없는 section 이 거절되지 않았습니다: ${text(bad).slice(0, 200)}`);
ok('없는 section 거절', { error: 'invalid_argument' });

// 5) 회수(eviction) — 탐지 4번 더 → 첫 id 는 없어야 한다
if (EVICT) {
  const later = [];
  for (let i = 0; i < 4; i += 1) {
    const d = await detect(a);
    later.push(d.b.detail_access.result_id);
  }
  const stale = await a.call('read_detection_result', { result_id: rid, section: 'summary' });
  if (!stale.isError || body(stale)?.error !== 'result_unavailable') {
    fail(`회수된 result_id 가 거절되지 않았습니다: ${text(stale).slice(0, 200)}`);
  }
  const newest = await a.call('read_detection_result', { result_id: later[3], section: 'summary' });
  if (newest.isError) fail(`최신 result_id 읽기 실패: ${text(newest).slice(0, 200)}`);
  ok('회수된 id 거절', { later_ids_distinct: new Set(later).size === 4, stale_error: 'result_unavailable' });
}

const exitA = await a.stop();
if (!exitA) fail(`서버 A(pid=${a.proc.pid})가 5초 안에 종료되지 않았습니다`);
ok('서버 A 종료', { pid: a.proc.pid, code: exitA.code, signal: exitA.signal });

// 6) 새 프로세스에서는 앞 id 가 없다 (다른 결과를 대신 주지 않는다)
const b = startServer();
await b.init();
const other = await b.call('read_detection_result', { result_id: rid });
if (!other.isError || body(other)?.error !== 'result_unavailable') {
  fail(`새 서버 프로세스에서 앞 result_id 가 거절되지 않았습니다: ${text(other).slice(0, 200)}`);
}
const exitB = await b.stop();
if (!exitB) fail(`서버 B(pid=${b.proc.pid})가 5초 안에 종료되지 않았습니다`);
ok('재시작 뒤 id 거절', { pid: b.proc.pid, error: 'result_unavailable', code: exitB.code, signal: exitB.signal });

console.log(JSON.stringify(report, null, 2));
log('통과');
