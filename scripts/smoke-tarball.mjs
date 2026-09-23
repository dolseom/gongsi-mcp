#!/usr/bin/env node
/**
 * 타르볼 설치 스모크 — 배포 산출물이 "설치한 그대로" 동작하는지 검증한다.
 *
 * npm pack → 임시 디렉터리에 설치 → stdio 로 MCP 서버 기동 →
 * initialize / tools/list / 실제 tools/call 을 프로토콜로 왕복 확인.
 *
 * API 키 없이 검증 가능한 범위만 본다 (HOME 을 임시 디렉터리로 바꿔
 * ~/.gongsi-mcp/.env 가 있는 개발 PC에서도 키 없는 신규 설치와 동일 조건).
 * ⚠️ 큰 탐지 결과의 왕복은 여기서 보지 않는다 — DART 베이스 URL 은 상수이고 J001 목록은 캐시하지
 *   않아 키 없이 재현할 방법이 없다. 그 검증은 합성 fixture 로 프로세스 안에서(vitest), 실물은
 *   실제 키로 따로 한다. 여기서는 **키 없는 사용자가 실제로 받는 응답**만 본다.
 * 사전 조건: dist 가 빌드되어 있을 것 (npm run build).
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStdioServer, resultBody } from './lib/stdio-client.mjs';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const REQUIRED_TOOLS = [
  'check_disclosure_duty',
  'search_disclosures',
  'server_info',
  'detect_undisclosed_transactions',
  'read_detection_result',
];
/** README "도구 (N개)" 와 같아야 한다 — 다르면 둘 중 하나가 거짓이다 */
const EXPECTED_TOOL_COUNT = 17;
const REQUEST_TIMEOUT_MS = 30_000;
const SERVER_EXIT_WAIT_MS = 5_000;
const started = Date.now();

function log(msg) {
  console.error(`[smoke-tarball] ${msg}`);
}
function fail(msg) {
  log(`실패: ${msg}`);
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'gongsi-smoke-'));
let server = null;
process.on('exit', () => {
  if (server && server.exitCode === null && server.signalCode === null) server.kill();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows 는 파일 잠금으로 정리가 실패할 수 있다 — 임시 디렉터리라 방치 무해 */
  }
});

// 1) pack — 산출물 타르볼 생성 (경로 인자는 전부 ASCII 임시 경로만 셸에 넘긴다)
// ⚠️ `npm pack --json` 의 stdout 형식은 npm 버전에 따라 다르다 (publish CI 의
// npm@latest 에서 [0].filename 파싱이 실제로 깨졌다) — 파일명을 결정적으로 계산한다.
execSync(`npm pack --pack-destination "${tmp}"`, {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});
const tarball = join(tmp, `${pkg.name}-${pkg.version}.tgz`);
if (!existsSync(tarball)) fail(`pack 산출물이 없습니다: ${tarball}`);

// 2) 임시 프로젝트에 설치
writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'smoke', private: true }));
execSync(`npm install "${tarball}" --no-audit --no-fund --no-save --loglevel=error`, {
  cwd: tmp,
  stdio: ['ignore', 'inherit', 'inherit'],
});

// 3) 설치본으로 서버 기동 — 키 없는 신규 설치 조건 (HOME/USERPROFILE 을 임시 디렉터리로)
const cli = join(tmp, 'node_modules', 'gongsi-mcp', 'dist', 'src', 'cli.js');
const env = { ...process.env, HOME: tmp, USERPROFILE: tmp };
delete env['DART_API_KEY'];
delete env['EGROUP_API_KEY'];
// 개발 PC 의 실캐시를 가리키지 않게 한다 (신규 설치는 캐시가 비어 있다)
delete env['GONGSI_CACHE_DB'];
const client = startStdioServer({
  cli,
  cwd: tmp,
  env,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  stderrTailInTimeout: 500,
  exitWaitMs: SERVER_EXIT_WAIT_MS,
  onNonJson: (line) => fail(`stdout 에 JSON 아닌 출력이 섞였습니다 (프로토콜 오염): ${line.slice(0, 200)}`),
});
server = client.proc;
log(`서버 기동 pid=${server.pid}`);

// 4) JSON-RPC 왕복 (stdio, 줄 단위 JSON) — scripts/lib/stdio-client.mjs
const { request, notify, callTool } = client;
const bodyOf = resultBody;

/**
 * 스키마 단계 거절인가 — SDK 버전에 따라 JSON-RPC error(-32602) 로 오거나 isError 결과로 온다.
 * 어느 쪽이든 **판정 결과(verdict)가 나오면 안 된다.**
 */
async function expectSchemaRejection(name, args, label) {
  try {
    const res = await callTool(name, args);
    const body = bodyOf(res);
    if (res.isError && !(body && typeof body === 'object' && 'verdict' in body)) {
      return `isError 결과 (${String(res.content?.[0]?.text ?? '').slice(0, 80).replace(/\s+/g, ' ')})`;
    }
    fail(`${label}: 거절돼야 하는데 정상 응답이 왔습니다 — ${String(res.content?.[0]?.text ?? '').slice(0, 200)}`);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/-32602|invalid/i.test(m)) return `JSON-RPC 오류 (${m.slice(0, 80)})`;
    throw e;
  }
  return 'unreachable';
}

const passed = [];
function ok(name, detail) {
  passed.push(name);
  log(`✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-tarball', version: '0.0.0' },
  });
  if (init.serverInfo?.name !== pkg.name) {
    fail(`serverInfo.name 불일치: ${init.serverInfo?.name} ≠ ${pkg.name}`);
  }
  if (init.serverInfo?.version !== pkg.version) {
    fail(`serverInfo.version 불일치: ${init.serverInfo?.version} ≠ package.json ${pkg.version}`);
  }
  notify('notifications/initialized');

  // ── 도구 등록 ──
  const tools = (await request('tools/list', {})).tools ?? [];
  const names = new Set(tools.map((t) => t.name));
  if (tools.length !== EXPECTED_TOOL_COUNT) {
    fail(`도구 수 ${tools.length} ≠ ${EXPECTED_TOOL_COUNT} — README 의 도구 수와 함께 확인하세요`);
  }
  for (const t of REQUIRED_TOOLS) {
    if (!names.has(t)) fail(`필수 도구 누락: ${t}`);
  }
  const readTool = tools.find((t) => t.name === 'read_detection_result');
  const idPattern = readTool?.inputSchema?.properties?.result_id?.pattern;
  if (typeof idPattern !== 'string' || !new RegExp(idPattern).test('0'.repeat(32)) || new RegExp(idPattern).test('../x')) {
    fail(`read_detection_result.result_id 스키마 패턴이 32자리 16진수가 아닙니다: ${idPattern}`);
  }
  ok('도구 등록', `${tools.length}개, read_detection_result result_id 패턴 ${idPattern}`);

  // ── 키 격리 ──
  const info = bodyOf(await callTool('server_info', {})) ?? {};
  if (info.version !== pkg.version) {
    fail(`server_info.version 불일치: ${info.version} ≠ ${pkg.version}`);
  }
  if (info.keys?.dart_api_key_set !== false) {
    fail(`키 없는 환경인데 dart_api_key_set=${info.keys?.dart_api_key_set} — 환경 격리 실패 (개발 키가 새어 들어왔을 수 있음)`);
  }
  ok('키 격리', 'dart_api_key_set=false');

  // ── 회사명·키·의결일 없는 대상 판정 ──
  const dutyRes = await callTool('check_disclosure_duty', {
    duty: 'large_internal_transaction',
    amount: 8_000_000_000,
    totalEquity: 120_000_000_000,
    amountBasis: 'actual',
  });
  const duty = bodyOf(dutyRes);
  if (dutyRes.isError || !duty || 'error' in duty) {
    fail(`의결일 없는 대상 판정이 오류로 끝났습니다: ${String(dutyRes.content?.[0]?.text).slice(0, 300)}`);
  }
  const deadlineMissing = duty.components?.deadline?.missing_fields ?? [];
  if (
    duty.verdict !== 'required' ||
    duty.threshold?.amount !== 6_000_000_000 ||
    duty.components?.duty?.status !== 'evaluated' ||
    duty.components?.deadline?.status !== 'insufficient_data' ||
    !deadlineMissing.includes('boardDate') ||
    !deadlineMissing.includes('listing') ||
    duty.deadline !== undefined ||
    duty.compliance !== undefined ||
    duty.penalty !== undefined ||
    duty.selfCorrection !== undefined ||
    typeof duty.review?.conclusion !== 'string'
  ) {
    fail(`의결일 없는 대상 판정 계약 불일치: ${JSON.stringify({
      verdict: duty.verdict,
      threshold: duty.threshold?.amount,
      components: duty.components,
      deadline: duty.deadline,
      penalty: duty.penalty,
    })}`);
  }
  ok('의결일 없는 대상 판정', `verdict=required, 기준금액 60억, 기한 미확정(${deadlineMissing.join(',')}), 과태료·지연 없음`);

  // ── 날짜 없는 미공시 상태: 가짜 기한·과태료를 만들지 않는다 ──
  const nd = bodyOf(
    await callTool('check_disclosure_duty', {
      duty: 'large_internal_transaction',
      amount: 8_000_000_000,
      totalEquity: 120_000_000_000,
      disclosureStatus: 'not_disclosed',
      today: '20260901',
    }),
  );
  if (!nd || 'error' in nd || nd.penalty !== undefined || nd.selfCorrection !== undefined || nd.deadline !== undefined) {
    fail(`날짜 없는 미공시 상태에 기한·과태료가 만들어졌습니다: ${JSON.stringify(nd).slice(0, 300)}`);
  }
  ok('날짜 없는 미공시', 'deadline·penalty·selfCorrection 없음');

  // ── 잘못된 입력은 여전히 거절 ──
  const how = await expectSchemaRejection(
    'check_disclosure_duty',
    { duty: 'large_internal_transaction', boardDate: '20260231', listing: 'listed' },
    '실존하지 않는 날짜 20260231',
  );
  ok('실존하지 않는 날짜 거절', how);

  const qe = await callTool('check_disclosure_duty', { duty: 'omnibus_financial', quarterEnd: '20260731' });
  const qeBody = bodyOf(qe);
  if (qeBody?.error !== 'invalid_argument') {
    fail(`분기말 아닌 quarterEnd 가 거절되지 않았습니다: ${String(qe.content?.[0]?.text).slice(0, 200)}`);
  }
  ok('분기말 아닌 quarterEnd 거절', `본문 error=invalid_argument (isError=${qe.isError === true})`);

  // ── 상세 읽기: 없는·잘못된 result_id ──
  const unknown = await callTool('read_detection_result', { result_id: '0'.repeat(32) });
  if (!unknown.isError || bodyOf(unknown)?.error !== 'result_unavailable') {
    fail(`없는 result_id 가 result_unavailable 로 거절되지 않았습니다: ${String(unknown.content?.[0]?.text).slice(0, 200)}`);
  }
  ok('없는 result_id 거절', 'isError + result_unavailable');

  const malformed = await expectSchemaRejection(
    'read_detection_result',
    { result_id: '../../etc/passwd' },
    '경로형 result_id',
  );
  ok('경로형 result_id 거절', malformed);

  const pathSection = await callTool('read_detection_result', { result_id: 'a'.repeat(32), section: '../x' });
  if (!pathSection.isError || bodyOf(pathSection)?.error !== 'invalid_argument') {
    fail(`경로형 section 이 거절되지 않았습니다: ${String(pathSection.content?.[0]?.text).slice(0, 200)}`);
  }
  ok('경로형 section 거절', 'isError + invalid_argument');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

// 서버를 멈추고 **실제로 종료됐는지** 확인한다 (로그만으로는 종료를 증명하지 못한다)
const exit = await client.stop();
if (!exit) fail(`서버 프로세스(pid=${server.pid})가 ${SERVER_EXIT_WAIT_MS / 1000}초 안에 종료되지 않았습니다`);
log(`서버 종료 확인 pid=${server.pid} code=${exit.code} signal=${exit.signal}`);
if (client.pendingCount() > 0) fail(`응답을 받지 못한 요청 ${client.pendingCount()}건이 남았습니다`);

log(
  `통과 — ${pkg.name}@${pkg.version}, 검사 ${passed.length}종 (${passed.join(' · ')}), ` +
    `stdout 오염 없음, ${((Date.now() - started) / 1000).toFixed(1)}초`,
);
process.exitCode = 0;
