/**
 * `dart-ftc-mcp setup` — 설치 마법사
 *
 * API 키 입력 → 실호출 검증 → .env 생성 → 룰 엔진 자가검증 → claude mcp add 안내.
 *
 * ⚠️ 이 파일은 MCP 서버가 아니라 대화형 CLI 다 — stdout 사용이 허용되는 유일한 진입점.
 *    (서버 경로인 index.ts 는 stdout 이 프로토콜 전용이다)
 *
 * .env 위치 결정:
 *  - 개발 클론(cwd 의 package.json name 이 dart-ftc-mcp)  → ./​.env
 *  - 그 외(npx 설치 등)                                    → ~/.dart-ftc-mcp/.env
 *    npx 설치본의 패키지 디렉터리는 npm 캐시 안이라 사용자 설정을 둘 곳이 못 된다.
 *    config.ts 가 프로젝트 .env → 홈 .env 순서로 읽는다 (먼저 설정된 값이 우선).
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

const DART_GUIDE = 'https://opendart.fss.or.kr/ → 인증키 신청 (즉시 발급)';
const EGROUP_GUIDE =
  'https://www.data.go.kr/ → "공정거래위원회 기업집단포털" 검색 → 4개 API 각각 활용신청' +
  ' (publicYmList·appnGroupSttusList·appnGroupAffiList·financeCompSttusList)';

export interface KeyCheck {
  ok: boolean;
  message: string;
}

/** DART 인증키 실호출 검증 — list.json 1건 조회 */
export async function validateDartKey(key: string): Promise<KeyCheck> {
  try {
    const url = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${encodeURIComponent(key)}&page_count=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const json = (await res.json()) as { status?: string; message?: string };
    switch (json.status) {
      case '000':
      case '013': // 조회 결과 없음 — 키는 정상
        return { ok: true, message: '정상 (실호출 확인)' };
      case '020':
        return { ok: true, message: '키는 정상이나 오늘 호출 한도를 초과한 상태입니다 (내일 초기화)' };
      case '010':
        return { ok: false, message: '등록되지 않은 인증키입니다. 발급받은 키를 다시 확인하세요.' };
      case '011':
        return { ok: false, message: '사용할 수 없는 키입니다 (기간 만료 등). 재발급이 필요합니다.' };
      default:
        return { ok: false, message: `DART 응답 [${json.status}] ${json.message ?? ''}` };
    }
  } catch (err) {
    return {
      ok: false,
      message: `네트워크 오류로 검증하지 못했습니다 (${err instanceof Error ? err.name : '알 수 없음'}).`,
    };
  }
}

/**
 * 기업집단포털 인증키 실호출 검증 — publicYmList 1건.
 * ⚠️ HTTP 403 은 키 오류가 아니라 **해당 서비스 활용신청 미완**이 대부분이다 (함정 3번).
 */
export async function validateEgroupKey(key: string): Promise<KeyCheck> {
  try {
    const sp = new URLSearchParams({
      serviceKey: key,
      pageNo: '1',
      numOfRows: '1',
      jobSeCode: '0001',
    });
    const url = `https://apis.data.go.kr/1130000/publicYmList/publicYmListApi?${sp}`;
    const res = await fetch(url, {
      // 이 헤더가 없으면 무조건 403 이다 — 검증 결과를 오염시키지 않도록 반드시 붙인다
      headers: { 'User-Agent': 'dart-ftc-mcp/0.1.0' },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (res.status === 403 || text.includes('SERVICE_KEY_IS_NOT_REGISTERED_ERROR')) {
      return {
        ok: false,
        message:
          '포털이 403 을 반환했습니다. 키 오류보다 활용신청 미완일 가능성이 높습니다 — ' +
          'data.go.kr 에서 기업집단포털 4개 API 의 활용신청 상태를 확인하세요 (신청은 API 별로 따로).',
      };
    }
    if (!res.ok) return { ok: false, message: `포털이 HTTP ${res.status} 를 반환했습니다.` };
    const codeMatch = /<resultCode>\s*(\d+)\s*<\/resultCode>/.exec(text);
    if (codeMatch && codeMatch[1] === '00') return { ok: true, message: '정상 (실호출 확인)' };
    const msgMatch = /<resultMsg>([^<]*)<\/resultMsg>/.exec(text);
    return {
      ok: false,
      message: `포털 오류 [${codeMatch?.[1] ?? '?'}] ${msgMatch?.[1] ?? '(메시지 없음)'}`,
    };
  } catch (err) {
    return {
      ok: false,
      message: `네트워크 오류로 검증하지 못했습니다 (${err instanceof Error ? err.name : '알 수 없음'}).`,
    };
  }
}

/** 기존 .env 내용에 키를 갱신·추가한다. 다른 줄(주석 포함)은 건드리지 않는다. */
export function upsertEnvContent(existing: string, updates: Record<string, string>): string {
  const pending = new Map(Object.entries(updates));
  const lines = existing === '' ? [] : existing.split(/\r?\n/);
  const out = lines.map((line) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && m[1] !== undefined && pending.has(m[1])) {
      const v = pending.get(m[1])!;
      pending.delete(m[1]);
      return `${m[1]}=${v}`;
    }
    return line;
  });
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  for (const [k, v] of pending) out.push(`${k}=${v}`);
  return out.join('\n') + '\n';
}

export interface EnvTarget {
  path: string;
  kind: 'project' | 'home';
}

/** .env 를 쓸 위치 — 개발 클론이면 프로젝트, 아니면 홈 디렉터리 */
export function defaultEnvTarget(cwd: string): EnvTarget {
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string };
      if (pkg.name === 'dart-ftc-mcp') return { path: join(cwd, '.env'), kind: 'project' };
    } catch {
      // package.json 이 깨져 있으면 홈으로
    }
  }
  return { path: join(homedir(), '.dart-ftc-mcp', '.env'), kind: 'home' };
}

/** 덮어쓰기 전 타임스탬프 백업. 백업 파일 경로를 반환한다 (원본 없으면 null). */
function backupIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const bak = `${path}.bak.${stamp}`;
  copyFileSync(path, bak);
  restrictPermissions(bak);
  return bak;
}

/** 인증키 파일 권한을 소유자 전용(0600)으로 좁힌다. Windows 에선 사실상 무시된다 — 베스트에포트. */
function restrictPermissions(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // 권한 조정 실패는 치명이 아니다
  }
}

/** 심볼릭 링크면 true — 링크를 통해 쓰면 키가 의도치 않은 곳으로 흘러갈 수 있어 거부한다. */
export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}…${key.slice(-4)} (${key.length}자)`;
}

interface SetupArgs {
  dartKey?: string;
  egroupKey?: string;
  envPath?: string;
  noInput: boolean;
  help: boolean;
}

export function parseSetupArgs(argv: string[]): SetupArgs {
  const out: SetupArgs = { noInput: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const grab = (name: string): string | undefined => {
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
      if (a === name) return argv[++i];
      return undefined;
    };
    const dart = grab('--dart-key');
    if (dart !== undefined) {
      out.dartKey = dart;
      continue;
    }
    const egroup = grab('--egroup-key');
    if (egroup !== undefined) {
      out.egroupKey = egroup;
      continue;
    }
    const env = grab('--env-path');
    if (env !== undefined) {
      out.envPath = env;
      continue;
    }
    if (a === '--no-input') out.noInput = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const USAGE = `dart-ftc-mcp setup — 설치 마법사

사용법:
  npx dart-ftc-mcp setup                     대화형 설정
  npx dart-ftc-mcp setup --dart-key <키> [--egroup-key <키>] [--env-path <경로>] [--no-input]

옵션:
  --dart-key <키>     DART 인증키 (${DART_GUIDE})
  --egroup-key <키>   공공데이터포털 인증키 (선택 — 기업집단 도구용)
  --env-path <경로>   .env 를 쓸 위치를 직접 지정
  --no-input          프롬프트 없이 실행 (키는 플래그로만 받음)
`;

/** 마법사 본체. 종료 코드를 반환한다. */
export async function runSetup(argv: string[]): Promise<number> {
  const args = parseSetupArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  console.log('── dart-ftc-mcp 설치 마법사 ──\n');

  const rl = args.noInput
    ? null
    : createInterface({ input: process.stdin, output: process.stdout });
  try {
    // 1) DART 키 (필수)
    let dartKey = args.dartKey?.trim() ?? '';
    if (!dartKey && rl) {
      console.log(`DART 인증키가 필요합니다 — ${DART_GUIDE}`);
      dartKey = (await rl.question('DART_API_KEY: ')).trim();
    }
    if (!dartKey) {
      console.error('DART_API_KEY 가 없습니다. --dart-key 로 전달하거나 대화형으로 입력하세요.');
      return 1;
    }
    process.stdout.write(`DART 키 검증 중 (${maskKey(dartKey)}) … `);
    const dartCheck = await validateDartKey(dartKey);
    console.log(dartCheck.ok ? `✅ ${dartCheck.message}` : `❌ ${dartCheck.message}`);
    if (!dartCheck.ok) return 1;

    // 2) 기업집단포털 키 (선택)
    let egroupKey = args.egroupKey?.trim() ?? '';
    if (!egroupKey && rl) {
      console.log(`\n기업집단포털 키(선택) — 기업집단 구조·감사 도구에 필요합니다.\n  ${EGROUP_GUIDE}`);
      egroupKey = (await rl.question('EGROUP_API_KEY (없으면 Enter): ')).trim();
    }
    let egroupOk = false;
    if (egroupKey) {
      process.stdout.write(`포털 키 검증 중 (${maskKey(egroupKey)}) … `);
      const egroupCheck = await validateEgroupKey(egroupKey);
      console.log(egroupCheck.ok ? `✅ ${egroupCheck.message}` : `⚠️ ${egroupCheck.message}`);
      // 포털 키 실패는 치명 아님 — 저장은 하되 안내만 한다 (활용신청 승인 후 그대로 동작)
      egroupOk = egroupCheck.ok;
    } else {
      console.log('\n포털 키 생략 — DART 단독 도구(판정·검색·원문·재무)는 전부 동작합니다.');
    }

    // 3) .env 기록
    const target = args.envPath
      ? { path: resolve(args.envPath), kind: 'project' as const }
      : defaultEnvTarget(process.cwd());
    if (isSymlink(target.path)) {
      console.error(
        `대상이 심볼릭 링크입니다: ${target.path}\n` +
          '링크를 통해 인증키를 쓰면 의도치 않은 위치로 흘러갈 수 있어 중단합니다. 실제 파일 경로를 지정하세요.',
      );
      return 1;
    }
    const updates: Record<string, string> = { DART_API_KEY: dartKey };
    if (egroupKey) updates['EGROUP_API_KEY'] = egroupKey;
    if (target.kind === 'home') {
      // npx 설치본의 패키지 디렉터리는 npm 캐시라 언제든 지워진다 — 원문 영구 캐시를 홈에 둔다
      updates['DARTFTC_CACHE_DB'] = join(dirname(target.path), 'cache.db');
    }
    mkdirSync(dirname(target.path), { recursive: true });
    const existing = existsSync(target.path) ? readFileSync(target.path, 'utf-8') : '';
    const bak = backupIfExists(target.path);
    writeFileSync(target.path, upsertEnvContent(existing, updates), { encoding: 'utf-8', mode: 0o600 });
    restrictPermissions(target.path);
    console.log(`\n.env 기록: ${target.path}${bak ? ` (기존 파일 백업: ${bak})` : ''}`);

    // 서버(config.ts)는 패키지 루트 .env 와 ~/.dart-ftc-mcp/.env 만 자동으로 읽는다 —
    // --env-path 로 다른 곳에 쓰면 "키를 넣었는데 인식이 안 된다"가 된다 (Codex 3차 백로그)
    let customPathNotAutoLoaded = false;
    if (args.envPath) {
      const autoLoaded = new Set(
        [defaultEnvTarget(process.cwd()).path, join(homedir(), '.dart-ftc-mcp', '.env')].map((p) =>
          resolve(p),
        ),
      );
      customPathNotAutoLoaded = !autoLoaded.has(target.path);
      if (customPathNotAutoLoaded) {
        console.log(
          '\n⚠️ 이 경로는 서버가 자동으로 읽는 위치가 아닙니다.\n' +
            '   서버는 패키지 루트의 .env 와 ~/.dart-ftc-mcp/.env 만 자동 로드합니다.\n' +
            '   등록 시 환경변수로 직접 넘기세요:\n' +
            '   claude mcp add dart-ftc-mcp --env DART_API_KEY=<키> -- npx -y dart-ftc-mcp',
        );
      }
    }

    // 4) 룰 엔진 자가검증 — 검증된 실제 사례 (소노스테이션, rcept_no 20260728000484)
    const { litDeadline } = await import('./rules/deadlines.js');
    const smoke = litDeadline('20260722', 'unlisted');
    const smokeOk = smoke.deadline === '20260731' && smoke.warnings.length === 0;
    console.log(
      smokeOk
        ? '룰 엔진 자가검증 ✅ (비상장 7영업일: 의결 2026-07-22 → 기한 2026-07-31, 공휴일 데이터 검증됨)'
        : `룰 엔진 자가검증 ❌ — 기한 ${smoke.deadline}, 경고 ${JSON.stringify(smoke.warnings)}. 설치가 손상됐을 수 있습니다.`,
    );
    if (!smokeOk) return 1;

    // 5) 다음 단계 안내
    console.log('\n── 다음 단계 ──');
    // --env-path 사용자는 개발 클론이 아닐 수 있다 — cwd 기준 dist 경로를 안내하면 틀린다
    if (args.envPath) {
      console.log(
        [
          'Claude Code 에 등록:',
          customPathNotAutoLoaded
            ? '  claude mcp add dart-ftc-mcp --env DART_API_KEY=<키> -- npx -y dart-ftc-mcp\n' +
              '  (위 경고대로, 지정한 .env 경로는 서버가 자동으로 읽지 않습니다)'
            : '  claude mcp add dart-ftc-mcp -- npx -y dart-ftc-mcp',
        ].join('\n'),
      );
    } else if (target.kind === 'project') {
      console.log(
        [
          'Claude Code 에 등록 (프로젝트 클론 기준):',
          '  npm run build',
          `  claude mcp add dart-ftc-mcp -- node "${resolve('dist', 'src', 'cli.js')}"`,
        ].join('\n'),
      );
    } else {
      console.log(
        [
          'Claude Code 에 등록:',
          '  claude mcp add dart-ftc-mcp -- npx -y dart-ftc-mcp',
          '(키는 방금 기록한 홈 .env 에서 자동으로 읽습니다)',
        ].join('\n'),
      );
    }
    if (egroupKey && !egroupOk) {
      console.log(
        '\n⚠️ 포털 키는 검증에 실패한 상태로 저장했습니다. data.go.kr 활용신청 승인 후 별도 조치 없이 동작합니다.',
      );
    }
    console.log('\n설치 완료. Claude 에서 "소노인터내셔널 공시 의무 확인해줘" 같은 질문으로 시작하세요.');
    return 0;
  } finally {
    rl?.close();
  }
}
