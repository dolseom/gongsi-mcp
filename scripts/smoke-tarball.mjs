#!/usr/bin/env node
/**
 * 타르볼 설치 스모크 — 배포 산출물이 "설치한 그대로" 동작하는지 검증한다.
 *
 * npm pack → 임시 디렉터리에 설치 → stdio 로 MCP 서버 기동 →
 * initialize / tools/list / server_info 를 실제 프로토콜로 왕복 확인.
 *
 * API 키 없이 검증 가능한 범위만 본다 (HOME 을 임시 디렉터리로 바꿔
 * ~/.gongsi-mcp/.env 가 있는 개발 PC에서도 키 없는 신규 설치와 동일 조건).
 * 사전 조건: dist 가 빌드되어 있을 것 (npm run build).
 */
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const REQUIRED_TOOLS = ['check_disclosure_duty', 'search_disclosures', 'server_info'];
const MIN_TOOL_COUNT = 13;

function fail(msg) {
  console.error(`[smoke-tarball] 실패: ${msg}`);
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'gongsi-smoke-'));
let server = null;
process.on('exit', () => {
  if (server && !server.killed) server.kill();
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
server = spawn(process.execPath, [cli], { cwd: tmp, env, stdio: ['pipe', 'pipe', 'pipe'] });

let stderrBuf = '';
server.stderr.on('data', (d) => (stderrBuf += d));

// 4) JSON-RPC 왕복 (stdio, 줄 단위 JSON)
const pending = new Map();
let lineBuf = '';
server.stdout.on('data', (d) => {
  lineBuf += d;
  let nl;
  while ((nl = lineBuf.indexOf('\n')) >= 0) {
    const line = lineBuf.slice(0, nl).trim();
    lineBuf = lineBuf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(`stdout 에 JSON 아닌 출력이 섞였습니다 (프로토콜 오염): ${line.slice(0, 200)}`);
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  const p = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} 30초 응답 없음. stderr: ${stderrBuf.slice(-500)}`));
      }
    }, 30_000);
  });
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return p;
}
function notify(method) {
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
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

  const tools = (await request('tools/list', {})).tools ?? [];
  const names = new Set(tools.map((t) => t.name));
  if (tools.length < MIN_TOOL_COUNT) {
    fail(`도구 수 ${tools.length} < 최소 ${MIN_TOOL_COUNT}`);
  }
  for (const t of REQUIRED_TOOLS) {
    if (!names.has(t)) fail(`필수 도구 누락: ${t}`);
  }

  const infoRes = await request('tools/call', { name: 'server_info', arguments: {} });
  const info = JSON.parse(infoRes.content?.[0]?.text ?? '{}');
  if (info.version !== pkg.version) {
    fail(`server_info.version 불일치: ${info.version} ≠ ${pkg.version}`);
  }
  if (info.keys?.dart_api_key_set !== false) {
    fail(`키 없는 환경인데 dart_api_key_set=${info.keys?.dart_api_key_set} — 환경 격리 실패 (개발 키가 새어 들어왔을 수 있음)`);
  }

  console.error(
    `[smoke-tarball] 통과 — ${pkg.name}@${pkg.version}, 도구 ${tools.length}개, stdout 오염 없음, 키 격리 확인`,
  );
  process.exitCode = 0;
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  server.kill();
}
