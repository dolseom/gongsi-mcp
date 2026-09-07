/**
 * 환경설정 로딩
 *
 * 원칙 두 가지 (docs/absorbed-from-dart-mcp.md §2-6):
 * 1. 운영 파라미터 접두사는 `GONGSI_` 로 통일한다.
 * 2. 인식하지 못한 `GONGSI_*` 변수는 **기동 시 경고**한다.
 *    참고 MCP는 config와 코드의 변수명이 달라 설정 3개가 조용히 무시되고 있었다.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 프로젝트 루트 = `package.json` 이 있는 최상위 디렉터리.
 *
 * 개발 시엔 `src/lib/` 에서, 빌드 후엔 `dist/src/lib/` 에서 실행되므로
 * 고정 상대경로(`../..`)로는 루트를 못 찾는다. `.env` 를 조용히 놓치면
 * "키를 넣었는데 인식이 안 된다"는 진단하기 어려운 증상이 된다.
 */
function findProjectRoot(): string {
  let dir = HERE;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(HERE, '..', '..');
}

const PROJECT_ROOT = findProjectRoot();

/**
 * 패키지 버전 — package.json 에서 한 번만 읽는다.
 * 하드코딩 금지: 0.1.0 때 서버 선언·User-Agent 4곳에 흩어져 있어 범프 시
 * 불일치 위험이 있었다 (참고 MCP 도 같은 사고를 실제로 겪음 — 피드백 §2-2 ⑦).
 */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** HTTP 요청 공통 User-Agent */
export const USER_AGENT = `gongsi-mcp/${VERSION}`;

/**
 * `.env` 를 읽어 process.env 에 채운다. Node 21.7+ 내장 — 의존성 없음.
 * 이미 설정된 환경변수를 덮어쓰지는 않는다.
 *
 * 순서: 프로젝트 `.env` → `~/.gongsi-mcp/.env` (setup 마법사가 npx 설치 시 쓰는 위치).
 * loadEnvFile 은 기존 값을 덮지 않으므로 먼저 읽힌 쪽이 우선한다.
 */
export function loadDotEnv(): void {
  const candidates = [
    join(PROJECT_ROOT, '.env'),
    join(homedir(), '.gongsi-mcp', '.env'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      process.loadEnvFile(path);
    } catch (err) {
      // 파일은 있는데 읽기 실패 — 조용히 삼키면 "키를 넣었는데 인식이 안 된다"는
      // 진단 불가 증상이 된다 (Codex 3차 백로그). stderr 로만 알린다 (stdout 은 프로토콜 전용).
      // logger 는 이 모듈을 import 하므로 여기서 쓸 수 없다 (순환).
      process.stderr.write(
        `[gongsi-mcp] .env 읽기 실패 — 이 파일의 값은 적용되지 않습니다: ${path} ` +
          `(${err instanceof Error ? err.message : String(err)})\n`,
      );
    }
  }
}

/** 진단용 — 어느 경로를 루트로 잡았는지 */
export function projectRoot(): string {
  return PROJECT_ROOT;
}

/** 인식하는 운영 파라미터 전체. 여기 없는 `GONGSI_*` 는 경고 대상이다. */
const KNOWN = [
  'GONGSI_RATE_WARN',
  'GONGSI_RATE_HARD_STOP',
  'GONGSI_CONCURRENCY',
  'GONGSI_HTTP_CONNECT_TIMEOUT',
  'GONGSI_HTTP_READ_TIMEOUT',
  'GONGSI_PER_TASK_TIMEOUT',
  'GONGSI_MAX_PAGES',
  'GONGSI_LAST_REPORT_ONLY',
  'GONGSI_ADAPTIVE_THRESHOLD',
  'GONGSI_ADAPTIVE_MIN_DAYS',
  'GONGSI_ADAPTIVE_FALLBACK_DAYS',
  'GONGSI_ADAPTIVE_MEASURE_CONCURRENCY',
  'GONGSI_ADAPTIVE_MAX_MEASURE_CALLS',
  'GONGSI_BODY_FETCH_LIMIT',
  'GONGSI_CACHE_DB',
  'GONGSI_LOG_LEVEL',
  'GONGSI_TIME_BUDGET_MS',
] as const;

/**
 * `detect_undisclosed_transactions` 시간 예산의 **상한**.
 *
 * 같은 값이 detect 쪽 `TIME_BUDGET_MS` 에도 있다 (그쪽이 근거 주석의 원본이다). detect 가
 * 이 모듈을 import 하므로 반대 방향 import 는 순환이라 값을 한 벌 더 둔다 —
 * 대신 두 값이 어긋나면 테스트가 실패한다 (`test/config-time-budget.test.ts`).
 */
const DETECT_TIME_BUDGET_CEILING_MS = 50_000;
/**
 * 같은 예산의 **하한**.
 *
 * 5초 = 원천 문서(≈0.1초) + 목록 수집 최소 시작 시간 3초(detect `MIN_LIST_CALL_MS`)
 * + 준비 예산 2초(전체의 40%)가 소형 호출 1.5초(`MIN_SMALL_CALL_MS`)를 감당하는 최소값이다.
 *
 * ⚠️ 3초로는 **실측상 검색을 한 건도 시작하지 못했다** (2026-09-07, 웜 DB): 73ms 만에 끝나고
 * J001 검색 미시작 13개사 · 워밍 미대조 1건. 3,000 = `MIN_LIST_CALL_MS` 라 목록 수집이
 * 임계에 걸리고, 준비 예산 1,200 < 1,500 이라 워밍도 못 한다. "원천 문서는 받는다"는
 * 하한이 실제로는 아무 판정도 만들지 못하는 값이었다.
 * (참고 실측: 4,000 이면 6개사 검색 후 5개사 미시작으로 정상 절단 — 1.1초)
 */
const DETECT_TIME_BUDGET_FLOOR_MS = 5_000;

/** 인식 못 한 GONGSI_* 변수명 목록. 기동 시 경고용. */
export function unknownEnvVars(): string[] {
  const known = new Set<string>(KNOWN);
  return Object.keys(process.env)
    .filter((k) => k.startsWith('GONGSI_') && !known.has(k))
    .sort();
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * `GONGSI_TIME_BUDGET_MS` — detect 시간 예산을 **낮추기만** 하는 검증·운영용 손잡이.
 *
 * 없거나 숫자가 아니면 `undefined`(= 기본값 사용). 값이 있으면
 * `min(50_000, max(5_000, 값))` 으로 가둔다.
 * - **올릴 수 없다**: 60초 벽은 MCP 클라이언트의 성질이라 예산을 올려도 클라이언트가 끊는다.
 *   끊기면 결과가 통째로 사라지므로 올리는 방향은 손해만 있다.
 * - **5초 미만은 5초**: 그 아래로는 J001 검색을 한 건도 시작하지 못해 "부분 결과"조차
 *   만들지 못한다 (근거는 `DETECT_TIME_BUDGET_FLOOR_MS` 주석의 실측).
 *
 * 도구 **입력**으로는 일부러 열지 않았다 — 60초 벽은 질문의 성질이 아니라 클라이언트의
 * 성질이라 질문마다 다른 값을 줄 이유가 없다 (detect 의 `TIME_BUDGET_MS` 주석 참조).
 */
function envTimeBudgetMs(): number | undefined {
  const raw = process.env['GONGSI_TIME_BUDGET_MS'];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(
    DETECT_TIME_BUDGET_CEILING_MS,
    Math.max(DETECT_TIME_BUDGET_FLOOR_MS, Math.trunc(n)),
  );
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

export interface Config {
  dartApiKey: string | undefined;
  egroupApiKey: string | undefined;

  /** 일일 호출 경고 임계 */
  rateWarn: number;
  /** 하드스톱 임계 — 원문 다운로드만 거부하고 목록 조회는 허용한다 */
  rateHardStop: number;

  concurrency: number;
  connectTimeoutMs: number;
  readTimeoutMs: number;
  perTaskTimeoutMs: number;

  /**
   * 페이지네이션 상한.
   * ⚠️ 낮추면 결과가 조용히 잘린다. 상한값보다 중요한 건 절단을 `truncated` 로 알리는 것.
   */
  maxPages: number;

  /**
   * 최종보고서만 조회할지 (DART `last_reprt_at`).
   * ⚠️ 반드시 false 기본. true 면 정정으로 대체된 **원본 제출분이 사라져**
   * "의결일 대비 기한 초과" 판정이 원천적으로 불가능해진다.
   * 실측: 전체 N=14,597 / Y=12,794, J는 N=3,505 / Y=3,430 (Y ⊂ N, Y에만 있는 건 0)
   */
  lastReportOnly: boolean;

  adaptiveThreshold: number;
  adaptiveMinDays: number;
  adaptiveFallbackDays: number;
  adaptiveMeasureConcurrency: number;
  /** 미지정 시 코드 수 비례로 계산한다 (100 + 50 × 코드수) */
  adaptiveMaxMeasureCalls: number | undefined;

  bodyFetchLimit: number;
  cacheDbPath: string;
  logLevel: string;

  /**
   * `detect_undisclosed_transactions` 의 전체 시간 예산 override (ms).
   * `undefined` 면 도구 기본값(50초)을 쓴다. 자세한 규칙은 `envTimeBudgetMs()` 주석.
   */
  detectTimeBudgetMs: number | undefined;
}

let cached: Config | null = null;

export function getConfig(): Config {
  if (cached) return cached;
  const concurrency = Math.max(1, envInt('GONGSI_CONCURRENCY', 10));
  const explicitMeasureCalls = process.env['GONGSI_ADAPTIVE_MAX_MEASURE_CALLS'];

  cached = {
    dartApiKey: process.env['DART_API_KEY'],
    egroupApiKey: process.env['EGROUP_API_KEY'],

    rateWarn: envInt('GONGSI_RATE_WARN', 18_000),
    rateHardStop: envInt('GONGSI_RATE_HARD_STOP', 19_000),

    concurrency,
    connectTimeoutMs: envInt('GONGSI_HTTP_CONNECT_TIMEOUT', 10) * 1000,
    readTimeoutMs: envInt('GONGSI_HTTP_READ_TIMEOUT', 100) * 1000,
    perTaskTimeoutMs: envInt('GONGSI_PER_TASK_TIMEOUT', 180) * 1000,

    maxPages: Math.max(1, envInt('GONGSI_MAX_PAGES', 100)),
    lastReportOnly: envBool('GONGSI_LAST_REPORT_ONLY', false),

    adaptiveThreshold: Math.max(1, envInt('GONGSI_ADAPTIVE_THRESHOLD', 1000)),
    adaptiveMinDays: Math.max(1, envInt('GONGSI_ADAPTIVE_MIN_DAYS', 3)),
    adaptiveFallbackDays: Math.max(1, envInt('GONGSI_ADAPTIVE_FALLBACK_DAYS', 30)),
    // 측정 동시성은 검색 동시성을 넘지 않는다
    adaptiveMeasureConcurrency: Math.min(
      Math.max(1, envInt('GONGSI_ADAPTIVE_MEASURE_CONCURRENCY', 5)),
      concurrency,
    ),
    adaptiveMaxMeasureCalls:
      explicitMeasureCalls === undefined || explicitMeasureCalls === ''
        ? undefined
        : Math.max(1, envInt('GONGSI_ADAPTIVE_MAX_MEASURE_CALLS', 150)),

    bodyFetchLimit: Math.max(1, envInt('GONGSI_BODY_FETCH_LIMIT', 50)),
    cacheDbPath: process.env['GONGSI_CACHE_DB'] || join(PROJECT_ROOT, 'data', 'cache.db'),
    logLevel: (process.env['GONGSI_LOG_LEVEL'] || 'INFO').toUpperCase(),

    detectTimeBudgetMs: envTimeBudgetMs(),
  };
  return cached;
}

/** 테스트용 — 캐시된 설정을 버린다 */
export function __resetConfig(): void {
  cached = null;
}

/** 측정 호출 예산. env 명시가 있으면 그 값이 우선한다. */
export function measureCallBudget(codeCount: number): number {
  const cfg = getConfig();
  if (cfg.adaptiveMaxMeasureCalls !== undefined) return cfg.adaptiveMaxMeasureCalls;
  return 100 + 50 * Math.max(1, codeCount);
}
