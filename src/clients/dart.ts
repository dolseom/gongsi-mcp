/**
 * OpenDART 클라이언트
 *
 * 참고 MCP(`dart_api.py`)의 검증된 설계를 옮기되 두 가지를 바꾼다:
 *  1. `last_reprt_at` 기본값 Y → **N**. Y는 정정으로 대체된 원본 제출분을 지워
 *     "의결일 대비 기한 초과" 판정을 불가능하게 만든다. (docs §3-4c)
 *  2. 페이지 상한에 걸려 잘리면 **`truncated` 로 알린다.** 참고 MCP는 상한만 올렸을 뿐
 *     여전히 조용히 자른다 — recall 사고의 본질은 상한값이 아니라 무고지였다. (docs §3-5)
 */

import { getConfig, USER_AGENT } from '../lib/config.js';
import type { DeadlineLike } from '../lib/deadline.js';
import { getLogger } from '../lib/logger.js';
import { getStore, nextKstMidnightIso } from '../lib/store.js';
import {
  DartApiError,
  MissingApiKeyError,
  RateLimitError,
  ToolError,
} from '../lib/errors.js';

const log = getLogger('dart');

const BASE_URL = 'https://opendart.fss.or.kr/api';
export const DAILY_LIMIT = 20_000;

export function viewerUrl(rceptNo: string): string {
  return `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rceptNo}`;
}

/** DART status 코드별 조치 안내 (PRD §6.3) */
const STATUS_HINT: Record<string, string> = {
  '010': '등록되지 않은 인증키입니다. opendart.fss.or.kr 에서 발급받은 키인지 확인하세요.',
  '011': '사용할 수 없는 인증키입니다. 메일로 받은 인증 링크를 클릭했는지 확인하세요.',
  '012': '접근할 수 없는 IP입니다.',
  '013': '조회된 데이터가 없습니다.',
  '014': '파일이 존재하지 않습니다.',
  '020': '일일 요청 한도(20,000건)를 초과했습니다. 한국시간 자정에 리셋됩니다.',
  '021': '조회 가능한 회사 개수를 초과했습니다. 회사 수를 줄여 다시 요청하세요.',
  '100': '요청 파라미터 값이 부적절합니다.',
  '101': '부적절한 접근입니다.',
  '800': 'DART 시스템 점검 중입니다. 잠시 후 다시 시도하세요.',
  '900': 'DART 서버에서 정의되지 않은 오류가 발생했습니다.',
  '901': '인증키 사용자 계정의 개인정보 보유기간이 만료되었습니다. 계정을 갱신하세요.',
};

/** 공시 목록 한 건 */
export interface Disclosure {
  corp_code: string;
  corp_name: string;
  corp_cls: string;
  report_nm: string;
  rcept_no: string;
  flr_nm: string;
  rcept_dt: string;
  /** 비고. 공정위 제출분은 '공' 을 포함한다 ('공정' 처럼 복합 마커도 있으므로 포함 검사) */
  rm: string;
}

export interface ListParams {
  corpCode?: string;
  bgnDe?: string;
  endDe?: string;
  pblntfTy?: string;
  pblntfDetailTy?: string;
  corpCls?: string;
  pageNo?: number;
  pageCount?: number;
  /** 미지정 시 설정값(기본 false = 전수) */
  lastReportOnly?: boolean;
}

export interface ListPage {
  status: string;
  totalCount: number;
  totalPage: number;
  pageNo: number;
  list: Disclosure[];
}

export interface CollectResult {
  rows: Disclosure[];
  /** 페이지 상한에 걸려 잘렸는지 — 절대 조용히 넘기지 않는다 */
  truncated: boolean;
  /** 서버가 알려준 실제 전체 페이지 수 */
  totalPage: number;
  totalCount: number;
  /** 소비한 API 호출 수 */
  calls: number;
}

export interface DartClientOptions {
  /**
   * 남은 시간 예산 — **주는 도구에만** 적용된다 (현재는 detect_undisclosed_transactions 뿐).
   *
   * 주면 두 가지가 달라진다: ① 요청 타임아웃이 `min(설정값, 남은 예산)` 으로 좁혀지고
   * ② 남은 예산이 한 번의 요청도 감당하지 못하면 **아예 시작하지 않고** 즉시 실패한다.
   * 주지 않으면 종전 동작 그대로다 — audit·search 등 다른 도구의 타임아웃·재시도를 바꾸면
   * 회귀 범위가 이 작업의 목적(시간 관리)을 넘어선다.
   */
  deadline?: DeadlineLike;
}

/**
 * 예산이 붙은 요청의 **최소 시도 시간**. 이보다 적게 남았으면 시작하지 않는다 —
 * 남은 100ms 로 요청을 걸면 실패가 확정된 호출에 예산과 재시도만 쓴다.
 * 근거: 목록 측정 호출 실측 0.4초(`search/batch.ts` SECONDS_PER_MEASURE)의 두 배 남짓.
 */
const MIN_REQUEST_MS = 1_000;

/** 요청 최대 시도 횟수 (최초 1회 + 재시도 2회). 백오프는 시도 사이에만 — 1초, 2초 */
const MAX_ATTEMPTS = 3;

/**
 * 429 `Retry-After` 를 따를 최대 대기(ms). 이보다 길면 기다리지 않고 실패로 돌려준다 — 60초 벽 안에서
 * 수십 초를 자는 것보다 "상류가 늦추라고 했다"를 알리는 편이 낫다.
 */
const MAX_RETRY_AFTER_MS = 10_000;

/**
 * ★ 프로세스 전역 송신 제어 (외부 검토 2026-09-30 §3-1, Codex astra 교차검토로 재설계).
 * OpenDART 과호출 차단은 **IP 단위**라 클라이언트 인스턴스가 아니라 프로세스 전체를 묶어야 한다 — 도구 호출마다
 * DartClient 를 새로 만들므로 인스턴스 필드로 두면 동시에 도는 도구끼리 간격을 모른다.
 *  - queue: 송신 대기열. 요청은 한 줄로 서서 **앞 요청이 실제로 시작한 시각(lastStart)** + 간격 뒤에 나간다.
 *    예약 시각만 나눠 주면 이벤트 루프가 밀렸을 때 타이머가 한꺼번에 깨어 몰려 나간다(재현: 50ms 간격 5건이 4ms 안에).
 *  - 차단기: 응답을 하나도 못 받는 접속 실패가 연속 N회면 쿨다운 동안 호출을 시작하지 않는다. 대기열에서
 *    **송신 직전에** 다시 확인하므로 슬롯을 기다리던 요청도 막힌다. 차단 중 증상은 모든 호출이 연결 리셋이라
 *    재시도가 곧 차단 연장이다.
 *  - blockedUntil: 429 Retry-After 로 상류가 요구한 대기 — 그 요청만이 아니라 **모든** 요청에 적용한다.
 */
const gate = {
  lastStart: Number.NEGATIVE_INFINITY,
  queue: Promise.resolve() as Promise<void>,
  consecutiveNetFails: 0,
  openUntil: 0,
  blockedUntil: 0,
};

/** 테스트용 — 송신 제어 상태를 비운다 */
export function __resetDartGate(): void {
  gate.lastStart = Number.NEGATIVE_INFINITY;
  gate.queue = Promise.resolve();
  gate.consecutiveNetFails = 0;
  gate.openUntil = 0;
  gate.blockedUntil = 0;
}

function breakerOpenError(path: string): ToolError | undefined {
  const waitMs = gate.openUntil - Date.now();
  if (waitMs <= 0) return undefined;
  return new ToolError(
    'upstream_unavailable',
    `OpenDART 접속이 연속으로 실패해 호출을 ${Math.ceil(waitMs / 1000)}초 동안 멈췄습니다. ` +
      '과호출에 따른 IP 단위 차단일 수 있어 재시도를 계속하면 차단이 길어집니다 — 잠시 뒤 다시 시도하세요.',
    { path, retry_after_ms: waitMs },
  );
}

function retryAfterTooLongError(path: string, waitMs: number): ToolError {
  return new ToolError(
    'dart_api_error',
    `DART 가 요청을 늦추라고 응답했습니다(429, Retry-After 남은 ${Math.ceil(waitMs / 1000)}초). ` +
      '잠시 뒤 다시 시도하세요 — 지금 재시도하면 차단이 길어질 수 있습니다.',
    { path, status: 429, retry_after_ms: waitMs },
  );
}

/**
 * 호출부가 취소한 요청(청크 시간 초과 등). 결과에 실리지 못하므로 재시도하지 않고, 차단기에도 세지 않는다.
 * ★ 취소 신호가 없던 때는 청크 제한시간(Promise.race)이 져도 진행 중 수집이 페이지를 계속 요청했다 —
 *   버려질 요청이 송신 대기열 자리까지 차지했다 (Codex astra 교차검토 2026-09-30).
 */
function cancelledError(path: string): ToolError {
  return new ToolError(
    'deadline_exceeded',
    '호출부가 이 DART 요청을 취소했습니다(청크 시간 초과 등) — 결과에 실리지 않으므로 중단했습니다.',
    { path, cancelled: true },
  );
}

/**
 * 송신 대기열에 서서 요청을 시작해도 되는 순간까지 기다린다. 줄 맨 앞에 온 뒤에야 대기 시간을 계산하고,
 * 자고 난 뒤에는 차단기·Retry-After·남은 예산을 **다시** 확인한다. 시작이 확정되면 그 실제 시각을 lastStart 로 남긴다.
 * 예산이 모자라 포기하는 요청은 lastStart 를 건드리지 않는다 — 못 쓴 슬롯이 뒤 요청의 간격을 밀지 않게.
 */
function takeSendSlot(
  path: string,
  attempt: number,
  deadline: DeadlineLike | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const interval = getConfig().dartMinIntervalMs;
  const run = gate.queue.then(async () => {
    for (;;) {
      if (signal?.aborted) throw cancelledError(path);
      const now = Date.now();
      const open = breakerOpenError(path);
      if (open) throw open;
      const blockWait = gate.blockedUntil - now;
      if (blockWait > MAX_RETRY_AFTER_MS) throw retryAfterTooLongError(path, blockWait);
      const wait = Math.max(0, blockWait, interval > 0 ? gate.lastStart + interval - now : 0);
      const remaining = deadline?.remainingMs();
      if (remaining !== undefined && remaining < wait + MIN_REQUEST_MS) {
        throw new ToolError(
          'deadline_exceeded',
          `남은 시간 예산(${remaining}ms)으로는 송신 간격(${wait}ms 대기)을 지키고 DART 요청을 끝낼 수 없어 ` +
            `시작하지 않았습니다 (60초 벽 대비 — 시도 ${attempt + 1}회차).`,
          { path, remaining_ms: remaining, wait_ms: wait },
        );
      }
      if (wait <= 0) break;
      await sleep(wait, signal).catch(() => {
        throw cancelledError(path);
      });
    }
    gate.lastStart = Date.now();
  });
  gate.queue = run.catch(() => undefined);
  return run;
}

/** `Retry-After` (초 또는 HTTP 날짜) → ms. 해석 불가면 undefined */
function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const sec = Number(v);
  if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

export class DartClient {
  private readonly apiKey: string;
  private readonly store = getStore();
  private readonly deadline: DeadlineLike | undefined;

  constructor(apiKey?: string, opts?: DartClientOptions) {
    const key = apiKey ?? getConfig().dartApiKey;
    if (!key) {
      throw new MissingApiKeyError('DART_API_KEY', 'DART 전자공시 조회에 필요합니다.');
    }
    this.apiKey = key;
    this.deadline = opts?.deadline;
  }

  /** 오늘 사용한 호출 수 */
  todayCalls(): number {
    return this.store.todayCallCount('dart');
  }

  /**
   * 한도 확인.
   * 하드스톱은 **원문 다운로드만** 막는다. 목록 조회까지 막으면 도구가 통째로 죽는다.
   */
  private checkRateLimit(requiresBodyFetch: boolean): void {
    const cfg = getConfig();
    const today = this.todayCalls();
    if (requiresBodyFetch && today >= cfg.rateHardStop) {
      throw new RateLimitError(today, DAILY_LIMIT, nextKstMidnightIso());
    }
    if (today >= cfg.rateWarn) {
      log.warn('일일 호출 한도 임박', { today, warn: cfg.rateWarn, limit: DAILY_LIMIT });
    }
  }

  private buildUrl(path: string, params: Record<string, unknown>): string {
    const sp = new URLSearchParams({ crtfc_key: this.apiKey });
    for (const [k, v] of Object.entries(params)) {
      // 빈 값은 키 자체를 빼야 한다 — OpenDART 는 빈값에 거동이 불안정하다
      if (v === undefined || v === null || v === '') continue;
      sp.set(k, String(v));
    }
    return `${BASE_URL}/${path}?${sp}`;
  }

  /**
   * 재시도 포함 요청. **본문 수신까지** 재시도 범위에 넣는다 —
   * 헤더만 받고 반환하면 body 읽기 중의 timeout/절단이 재시도되지 않는다(Codex 지적).
   * 대상: 네트워크 오류 · 429 · 5xx. 최대 3회 시도, 백오프 min(2^n, 8)초는 시도 사이에만(1초·2초).
   *
   * ⚠️ 예외 메시지에 URL을 절대 넣지 않는다 — 쿼리스트링에 인증키가 들어 있다.
   *
   * ★ 시간 예산(`opts.deadline`)이 붙어 있으면 **타임아웃·백오프를 남은 예산 안으로 좁힌다.**
   *   좁히지 않으면 타임아웃 100초 × 재시도 3회 + 백오프 3초 = 최악 303초라, 한 번의 상류
   *   지연만으로 60초 벽을 그대로 넘긴다(Codex ③).
   *   **진행 중인 요청은 `AbortSignal` 이 끊는다** — 이 클래스가 유일하게 진행 중인 일을
   *   중단하는 지점이다. 예산이 끝난 뒤 도착하는 응답은 어차피 결과에 실리지 못하고,
   *   붙잡고 있으면 뒤 단계가 시작조차 못 하기 때문이다.
   */
  private async request(
    path: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ status: number; contentType: string; bytes: Uint8Array }> {
    const cfg = getConfig();
    const url = this.buildUrl(path, params);
    let lastErrName = '';

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // 마지막 시도가 실패하면 기다리지 않고 바로 던진다 — 다음 시도가 없는데 백오프로
      // 최대 4초를 더 쓰던 결함 (60초 벽 안에서 그 4초는 다른 회사 하나를 조회할 시간이다)
      const isLastAttempt = attempt === MAX_ATTEMPTS - 1;
      if (signal?.aborted) throw cancelledError(path);
      const remaining = this.deadline?.remainingMs();
      if (remaining !== undefined && remaining < MIN_REQUEST_MS) {
        throw new ToolError(
          'deadline_exceeded',
          `남은 시간 예산(${remaining}ms)으로는 DART 요청을 끝낼 수 없어 시작하지 않았습니다 ` +
            `(60초 벽 대비 — 시도 ${attempt + 1}회차).`,
          { path, remaining_ms: remaining },
        );
      }
      await takeSendSlot(path, attempt, this.deadline, signal);
      const remainingAfterSlot = this.deadline?.remainingMs();
      const timeoutMs =
        remainingAfterSlot === undefined ? cfg.readTimeoutMs : Math.min(cfg.readTimeoutMs, remainingAfterSlot);
      // 응답(헤더)을 받기 전 실패만 차단기에 센다 — 본문 읽기 중 끊김은 접속 차단의 증상이 아니다
      let gotResponse = false;
      try {
        // NOTE: connect/read 타임아웃 분리는 undici Agent 가 필요하다.
        // 지금은 전체 타임아웃만 적용한다. (TODO: dispatcher 도입 시 분리)
        const res = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT },
          signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
        });

        // 상태코드가 무엇이든 응답을 받았으면 접속 자체는 살아 있다
        gotResponse = true;
        gate.consecutiveNetFails = 0;

        if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
          log.warn('재시도 가능한 상태코드', { path, status: res.status, attempt: attempt + 1 });
          // Retry-After 는 이 요청만이 아니라 대기열 전체에 건다 — 마지막 시도여도 기록한다
          const retryAfterMs = res.status === 429 ? parseRetryAfter(res.headers.get('retry-after')) : undefined;
          if (retryAfterMs !== undefined) {
            gate.blockedUntil = Math.max(gate.blockedUntil, Date.now() + retryAfterMs);
            if (retryAfterMs > MAX_RETRY_AFTER_MS) throw retryAfterTooLongError(path, retryAfterMs);
          }
          if (isLastAttempt) break;
          if (!(await this.backoff(attempt, path, signal))) {
            throw new ToolError(
              'deadline_exceeded',
              `DART 가 재시도 가능한 상태코드(${res.status})를 줬으나 남은 시간 예산으로는 ` +
                '재시도할 수 없어 중단했습니다.',
              { path, status: res.status },
            );
          }
          continue;
        }

        const bytes = new Uint8Array(await res.arrayBuffer());
        // 본문까지 온전히 받은 시점에만 카운트한다 (재시도는 성공분만)
        this.store.incrementCall('dart', 1);
        return {
          status: res.status,
          contentType: res.headers.get('content-type')?.toLowerCase() ?? '',
          bytes,
        };
      } catch (err) {
        // 우리가 던진 것(예산·429 Retry-After)은 재시도 대상이 아니다 — 그대로 올린다
        if (err instanceof ToolError) throw err;
        // 호출부 취소는 실패가 아니다 — 재시도·차단기 집계 없이 끝낸다
        if (signal?.aborted) throw cancelledError(path);
        lastErrName = err instanceof Error ? err.name : 'UnknownError';
        log.warn('요청 실패', { path, error: lastErrName, attempt: attempt + 1 });
        // 시간초과(우리 예산·읽기 타임아웃)는 느린 망에서도 난다 — 세면 정상 예산 만료가 프로세스 전체를 막는다
        if (!gotResponse && lastErrName !== 'TimeoutError' && lastErrName !== 'AbortError') {
          this.recordNetFailure(path, lastErrName);
        }
        if (isLastAttempt) break;
        if (!(await this.backoff(attempt, path, signal))) {
          throw new ToolError(
            'deadline_exceeded',
            `DART 요청이 실패했고(${lastErrName}) 남은 시간 예산으로는 재시도할 수 없어 중단했습니다.`,
            { path },
          );
        }
      }
    }
    throw new ToolError('dart_api_error', `DART 요청이 ${MAX_ATTEMPTS}회 재시도 후에도 실패했습니다 (${lastErrName || 'HTTP 오류'}).`, {
      path,
    });
  }

  /**
   * 응답을 못 받은 접속 실패를 센다 — 임계에 이르면 차단기를 열고 이번 요청도 중단한다.
   * 이미 열린 동안 도착하는 실패(차단 전에 나간 요청들)는 세지 않는다 — 세면 쿨다운이 계속 연장된다.
   */
  private recordNetFailure(path: string, errName: string): void {
    const already = breakerOpenError(path);
    if (already) throw already;
    const cfg = getConfig();
    gate.consecutiveNetFails++;
    if (gate.consecutiveNetFails >= cfg.dartBreakerThreshold) {
      gate.openUntil = Date.now() + cfg.dartBreakerCooldownMs;
      gate.consecutiveNetFails = 0;
      log.warn('OpenDART 차단기 열림', { path, error: errName, cooldown_ms: cfg.dartBreakerCooldownMs });
      const opened = breakerOpenError(path);
      if (opened) throw opened;
    }
  }

  /**
   * 재시도 백오프. 시간 예산이 붙어 있으면 **백오프 + 다음 시도 최소시간**이 남아 있을 때만
   * 기다린다 — 남은 예산을 sleep 으로 다 태우고 나서 시작도 못 하는 것이 가장 나쁘다.
   * @returns 재시도해도 되면 true, 예산이 모자라 포기해야 하면 false
   */
  private async backoff(attempt: number, path: string, signal?: AbortSignal): Promise<boolean> {
    const waitMs = Math.min(2 ** attempt, 8) * 1000;
    const remaining = this.deadline?.remainingMs();
    if (remaining !== undefined && remaining < waitMs + MIN_REQUEST_MS) return false;
    await sleep(waitMs, signal).catch(() => {
      throw cancelledError(path);
    });
    return true;
  }

  /** 응답 바이트 → JSON. 파싱 실패는 규격 에러로 바꾼다. */
  private parseJson(bytes: Uint8Array): Record<string, unknown> {
    try {
      const data: unknown = JSON.parse(new TextDecoder('utf-8').decode(bytes));
      if (data && typeof data === 'object') return data as Record<string, unknown>;
    } catch {
      // 아래로
    }
    throw new DartApiError('invalid_json', 'DART 응답이 JSON 형식이 아닙니다.');
  }

  /**
   * 외부에서 온 메시지를 응답에 싣기 전 인증키 흔적을 걷어낸다.
   * 프록시·서버가 요청 URL 을 메시지에 반사하는 경우를 대비한 방어다(Codex 지적).
   */
  private sanitize(message: string): string {
    let out = message.split(this.apiKey).join('***');
    out = out.replace(/crtfc_key=[^&\s"']+/g, 'crtfc_key=***');
    return out;
  }

  private handleStatus(status: string, message: string, allowEmpty: boolean): void {
    if (status === '000') return;
    if (status === '013' && allowEmpty) return;
    if (status === '020') {
      throw new RateLimitError(this.todayCalls(), DAILY_LIMIT, nextKstMidnightIso());
    }
    throw new DartApiError(status, this.sanitize(message || '(메시지 없음)'), STATUS_HINT[status]);
  }

  /** 공시 목록 한 페이지 */
  async listPage(p: ListParams, signal?: AbortSignal): Promise<ListPage> {
    this.checkRateLimit(false);
    const cfg = getConfig();
    const lastOnly = p.lastReportOnly ?? cfg.lastReportOnly;

    const { bytes } = await this.request('list.json', {
      corp_code: p.corpCode,
      bgn_de: p.bgnDe,
      end_de: p.endDe,
      pblntf_ty: p.pblntfTy,
      pblntf_detail_ty: p.pblntfDetailTy,
      corp_cls: p.corpCls,
      // ⚠️ 기본 N. Y로 바꾸면 정정 이전 원본이 사라져 지연 판정이 불가능해진다.
      last_reprt_at: lastOnly ? 'Y' : 'N',
      page_no: p.pageNo ?? 1,
      page_count: p.pageCount ?? 100,
      sort: 'date',
      sort_mth: 'desc',
    }, signal);

    const data = this.parseJson(bytes);
    const status = String(data['status'] ?? '');
    this.handleStatus(status, String(data['message'] ?? ''), true);

    if (status === '013') {
      return { status, totalCount: 0, totalPage: 0, pageNo: p.pageNo ?? 1, list: [] };
    }
    // 카운트 필드는 유한 비음수만 통과시킨다 (Codex 7차 중간 4) — NaN 은 모든 비교(> limit,
    // rows.length < totalCount)에서 false 라 절단·불완전 수집이 collection_complete 로 둔갑한다
    const toCount = (v: unknown, field: string): number => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        throw new DartApiError(
          status,
          `응답의 ${field} 가 올바른 숫자가 아닙니다 ('${String(v).slice(0, 30)}')`,
          '응답 형식 이상 — 이 호출은 실패로 처리해 조용한 불완전 수집을 막습니다',
        );
      }
      return Math.floor(n);
    };
    return {
      status,
      totalCount: toCount(data['total_count'] ?? 0, 'total_count'),
      totalPage: toCount(data['total_page'] ?? 1, 'total_page'),
      pageNo: toCount(data['page_no'] ?? p.pageNo ?? 1, 'page_no'),
      list: (data['list'] as Disclosure[] | undefined) ?? [],
    };
  }

  /**
   * 총 건수만 재는 1회 호출. 적응형 분할과 범위 사전 예측에 쓴다.
   * `page_count=1` 로 최소 페이로드만 받는다.
   */
  async measure(p: ListParams): Promise<number> {
    const page = await this.listPage({ ...p, pageNo: 1, pageCount: 1 });
    return page.totalCount;
  }

  /**
   * 페이지네이션 전체 수집.
   * `total_page` 를 보고 자동 종료하므로 상한을 올려도 불필요한 호출은 생기지 않는다.
   * 상한에 걸리면 `truncated: true` 와 실제 `totalPage` 를 함께 돌려준다.
   */
  /** @param signal 호출부 취소 신호 — 끊기면 다음 페이지를 요청하지 않고 진행 중 요청도 끊는다 */
  async collect(p: ListParams, maxPages?: number, signal?: AbortSignal): Promise<CollectResult> {
    const limit = Math.max(1, maxPages ?? getConfig().maxPages);
    const rows: Disclosure[] = [];
    let pageNo = 1;
    let totalPage = 1;
    let totalCount = 0;
    let calls = 0;

    do {
      if (signal?.aborted) throw cancelledError('list.json');
      const page = await this.listPage({ ...p, pageNo }, signal);
      calls++;
      rows.push(...page.list);
      totalPage = page.totalPage;
      totalCount = page.totalCount;
      if (page.list.length === 0) break;
      pageNo++;
    } while (pageNo <= Math.min(totalPage, limit));

    // 상한 초과만 보면 중간 빈 페이지로 인한 조기 종료를 놓친다(Codex 지적) —
    // 수집 건수가 서버 신고 총건수에 못 미치면 그것도 절단이다.
    const truncated = totalPage > limit || rows.length < totalCount;
    if (truncated) {
      log.warn('결과가 완전하지 않습니다 (페이지 상한 또는 조기 종료)', {
        totalPage,
        maxPages: limit,
        collected: rows.length,
        totalCount,
      });
    }
    return { rows, truncated, totalPage, totalCount, calls };
  }

  /**
   * 공시 원문 ZIP 다운로드.
   * DART 는 오류도 HTTP 200 + JSON 으로 주므로 **`PK` 매직을 먼저 검사**한다.
   */
  async downloadDocument(rceptNo: string): Promise<Uint8Array> {
    this.checkRateLimit(true);
    const { bytes } = await this.request('document.xml', { rcept_no: rceptNo });

    if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return bytes; // 'PK'

    // ZIP 이 아니면 오류 페이로드다
    const text = new TextDecoder('utf-8').decode(bytes.slice(0, 2000));
    const m = /"status"\s*:\s*"(\d+)"/.exec(text);
    const msg = /"message"\s*:\s*"([^"]*)"/.exec(text);
    if (m?.[1]) this.handleStatus(m[1], msg?.[1] ?? '', false);
    throw new DartApiError(
      'invalid_payload',
      `원문이 ZIP 형식이 아닙니다 (${bytes.length} bytes)`,
      `접수번호 ${rceptNo} 를 확인하세요.`,
    );
  }

  /** 법인코드 전체 ZIP (CORPCODE.xml) */
  async downloadCorpCode(): Promise<Uint8Array> {
    this.checkRateLimit(false);
    const { bytes } = await this.request('corpCode.xml', {});
    if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return bytes;

    const text = new TextDecoder('utf-8').decode(bytes.slice(0, 2000));
    const m = /"status"\s*:\s*"(\d+)"/.exec(text);
    const msg = /"message"\s*:\s*"([^"]*)"/.exec(text);
    if (m?.[1]) this.handleStatus(m[1], msg?.[1] ?? '', false);
    throw new DartApiError('invalid_payload', '법인코드 응답이 ZIP 형식이 아닙니다.');
  }

  /**
   * 단일회사 전체 재무제표 (fnlttSinglAcntAll).
   * reprt_code: 11011 사업 / 11012 반기 / 11013 1분기 / 11014 3분기
   * 데이터 없음(013)은 빈 배열로 돌려준다 — CFS→OFS 폴백 판단은 호출부가 한다.
   */
  async financialStatements(p: {
    corpCode: string;
    bsnsYear: string;
    reprtCode: string;
    fsDiv: 'CFS' | 'OFS';
  }): Promise<Array<Record<string, unknown>>> {
    this.checkRateLimit(false);
    const { bytes } = await this.request('fnlttSinglAcntAll.json', {
      corp_code: p.corpCode,
      bsns_year: p.bsnsYear,
      reprt_code: p.reprtCode,
      fs_div: p.fsDiv,
    });
    const data = this.parseJson(bytes);
    const status = String(data['status'] ?? '');
    this.handleStatus(status, String(data['message'] ?? ''), true);
    if (status === '013') return [];
    return (data['list'] as Array<Record<string, unknown>> | undefined) ?? [];
  }

  /** 기업개황 — `jurir_no`(법인등록번호)를 얻는 유일한 경로다 */
  async companyProfile(corpCode: string): Promise<Record<string, unknown>> {
    this.checkRateLimit(false);
    const { bytes } = await this.request('company.json', { corp_code: corpCode });
    const data = this.parseJson(bytes);
    this.handleStatus(String(data['status'] ?? ''), String(data['message'] ?? ''), false);
    return data;
  }
}

/** 취소 신호가 오면 즉시 reject 하는 sleep (신호가 없으면 일반 sleep) */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
