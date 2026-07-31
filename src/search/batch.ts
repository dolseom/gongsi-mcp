/**
 * 적응형 날짜 분할 전수 수집 — `search_disclosures` mode:"batch" 의 심장
 *
 * 설계 근거 (docs/absorbed-from-dart-mcp.md §1-2, §2-1):
 * - **균등 90일 분할 금지.** 신고는 2월·8월(결산·주총)에 집중되므로 균등 분할은
 *   시즌 청크에서 구조적으로 timeout 난다. 측정 호출로 건수를 재며 이진 분할한다.
 * - **측정 호출 예산 가드.** 예산 소진 시 남은 구간은 균등 fallback 으로 나눈다
 *   (원청크 유지가 아니다 — 유지하면 폭주가 재발한다).
 * - **60초 벽 사전 예측.** MCP 클라이언트가 ~60초에 끊으므로, 첫 측정 1회로
 *   규모를 재고 초과 예상이면 즉시 `range_too_large` + 분할 안내를 반환한다.
 * - **부분 결과 보존.** 청크 실패는 전체를 죽이지 않고 `partial_results` 로 알린다.
 * - **dedup 키는 `rcept_no` 단일.** 복합키는 정당한 다중 제출을 잘라먹는다(실증).
 */

import { getConfig, measureCallBudget } from '../lib/config.js';
import { getLogger } from '../lib/logger.js';
import { RangeTooLargeError } from '../lib/errors.js';
import type { CollectResult, Disclosure, ListParams } from '../clients/dart.js';

const log = getLogger('search-batch');

/** 참고 MCP 실측: 16페이지 27.34초 → 목록 호출당 ~1.7초 */
const SECONDS_PER_CALL = 1.7;
/** 측정 호출(page_count=1)은 페이로드가 작다 */
const SECONDS_PER_MEASURE = 0.4;
/** 클라이언트가 ~60초에 끊으므로 여유를 두고 45초를 상한으로 잡는다 */
const DEFAULT_MAX_TOOL_SECONDS = 45;
/**
 * corp_code 없는 전체시장 검색의 청크 일수 상한.
 * ⚠️ 실측(2026-07-31): DART는 corp_code 없는 검색에서 3개월 초과 기간을
 * status 100("corp_code가 없는 경우 검색기간은 3개월만 가능합니다")으로 거부한다.
 * 측정 호출부터 이 제한에 걸리므로 90일 창으로 나눠 측정·수집한다.
 */
const MAX_MARKET_CHUNK_DAYS = 90;

/** 목록 수집에 필요한 최소 인터페이스 — 테스트에서 가짜로 치환한다 */
export interface SearchClient {
  measure(p: ListParams): Promise<number>;
  collect(p: ListParams, maxPages?: number): Promise<CollectResult>;
}

export interface DateChunk {
  from: string;
  to: string;
  /** 계획 시점의 측정 건수. 미측정이면 -1 */
  count: number;
}

export interface ChunkOutcome extends DateChunk {
  /** 수집 후 서버가 신고한 실제 페이지 수 */
  pages?: number;
  truncated?: boolean;
  /** 실패한 청크의 사유 — 있으면 이 청크의 결과는 비어 있다 */
  error?: string;
}

export interface BatchDiagnostics {
  measure_calls: number;
  collect_calls: number;
  measure_budget_exhausted: boolean;
  /** 분할 결과 — 조건에 따라 달라지므로 재현 가능하게 노출한다 (docs §3-5) */
  date_chunks: ChunkOutcome[];
  chunks_failed: number;
  /** 하나라도 실패했으면 true — 이 위에서 "누락 없음"을 결론내면 안 된다 */
  partial_results: boolean;
  /** 페이지 상한 절단이 하나라도 있었는지 */
  truncated: boolean;
  dedup_dropped: number;
  /** 계획 시점 측정한 전체 건수 */
  total_count_reported: number;
}

export interface BatchResult {
  rows: Disclosure[];
  diagnostics: BatchDiagnostics;
}

export interface AdaptiveOptions {
  /** 청크당 목표 최대 건수 (기본: 설정 DARTFTC_ADAPTIVE_THRESHOLD = 1000) */
  threshold?: number;
  /** 이 이하로는 쪼개지 않는다 (기본 3일) */
  minDays?: number;
  /** 측정 예산 소진 시 균등 분할 일수 (기본 30일) */
  fallbackDays?: number;
  maxPages?: number;
  concurrency?: number;
  measureBudget?: number;
  perChunkTimeoutMs?: number;
  maxToolSeconds?: number;
}

// ── 날짜 유틸 (YYYYMMDD, UTC 고정) ──────────────────────────────

function ymdToMs(ymd: string): number {
  return Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
}

function msToYmd(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

function addDays(ymd: string, n: number): string {
  return msToYmd(ymdToMs(ymd) + n * 86_400_000);
}

/** from~to 포함 일수 */
function daySpan(from: string, to: string): number {
  return Math.round((ymdToMs(to) - ymdToMs(from)) / 86_400_000) + 1;
}

function minYmd(a: string, b: string): string {
  return a <= b ? a : b;
}

// ── 예측 ────────────────────────────────────────────────────────

/**
 * 수집 소요시간 추정 (초).
 * 청크 수 = ceil(건수/threshold), 측정은 이진 분할 내부 노드 포함 ~2×청크 근사.
 */
export function estimateSeconds(totalRows: number, concurrency: number, threshold: number): number {
  if (totalRows <= 0) return 0;
  const chunks = Math.max(1, Math.ceil(totalRows / threshold));
  const waves = Math.ceil(chunks / Math.max(1, concurrency));
  const pagesPerChunk = Math.ceil(Math.min(totalRows, threshold) / 100);
  return 2 * chunks * SECONDS_PER_MEASURE + waves * pagesPerChunk * SECONDS_PER_CALL;
}

/**
 * 한 호출이 감당할 수 있는 최대 건수를 기준으로 균등 밀도 가정 분할을 제안한다.
 * ⚠️ 시즌(2·8월) 집중 구간은 실제 밀도가 훨씬 높으므로 안내 문구에 명시할 것.
 */
export function suggestSplits(
  from: string,
  to: string,
  totalRows: number,
  concurrency: number,
  threshold: number,
  maxSeconds: number,
): Array<{ from: string; to: string }> {
  let targetRows = threshold;
  for (let rows = threshold; rows <= totalRows + threshold; rows += threshold) {
    if (estimateSeconds(rows, concurrency, threshold) > maxSeconds) break;
    targetRows = rows;
  }
  const days = daySpan(from, to);
  const rowsPerDay = totalRows / days;
  const daysPerSplit = Math.max(1, Math.floor(targetRows / Math.max(rowsPerDay, 1e-9)));

  const splits: Array<{ from: string; to: string }> = [];
  let cur = from;
  while (cur <= to) {
    const end = minYmd(addDays(cur, daysPerSplit - 1), to);
    splits.push({ from: cur, to: end });
    cur = addDays(end, 1);
  }
  return splits;
}

// ── 본체 ────────────────────────────────────────────────────────

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`청크 수집이 ${Math.round(ms / 1000)}초를 넘겨 중단했습니다.`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function emptyResult(totalCount: number, measureCalls: number): BatchResult {
  return {
    rows: [],
    diagnostics: {
      measure_calls: measureCalls,
      collect_calls: 0,
      measure_budget_exhausted: false,
      date_chunks: [],
      chunks_failed: 0,
      partial_results: false,
      truncated: false,
      dedup_dropped: 0,
      total_count_reported: totalCount,
    },
  };
}

/**
 * 적응형 분할 전수 수집.
 * `base` 의 bgnDe/endDe 는 무시하고 `from`/`to` 를 쓴다.
 */
export async function collectAdaptive(
  client: SearchClient,
  base: ListParams,
  from: string,
  to: string,
  o: AdaptiveOptions = {},
): Promise<BatchResult> {
  const cfg = getConfig();
  const threshold = o.threshold ?? cfg.adaptiveThreshold;
  const minDays = o.minDays ?? cfg.adaptiveMinDays;
  const fallbackDays = o.fallbackDays ?? cfg.adaptiveFallbackDays;
  const concurrency = Math.max(1, o.concurrency ?? cfg.concurrency);
  const budget = o.measureBudget ?? measureCallBudget(1);
  const maxSeconds = o.maxToolSeconds ?? DEFAULT_MAX_TOOL_SECONDS;
  const perChunkTimeoutMs = o.perChunkTimeoutMs ?? Math.min(cfg.perTaskTimeoutMs, 50_000);
  // corp_code 지정 검색은 결과가 그 회사로 한정되므로 장기 구간도 안전하다
  const maxChunkDays = base.corpCode ? Number.POSITIVE_INFINITY : MAX_MARKET_CHUNK_DAYS;

  let measureCalls = 0;

  // ① 범위 측정 → 60초 벽 사전 예측
  //    전체시장 검색은 DART의 3개월 제한 때문에 처음부터 90일 창으로 나눠 측정한다.
  const windows: DateChunk[] = [];
  if (Number.isFinite(maxChunkDays)) {
    let cur = from;
    while (cur <= to) {
      const end = minYmd(addDays(cur, maxChunkDays - 1), to);
      windows.push({ from: cur, to: end, count: -1 });
      cur = addDays(end, 1);
    }
  } else {
    windows.push({ from, to, count: -1 });
  }

  let total = 0;
  let anyUnmeasured = false;
  for (const w of windows) {
    try {
      w.count = await client.measure({ ...base, bgnDe: w.from, endDe: w.to });
      measureCalls++;
      total += w.count;
    } catch (err) {
      // 측정 실패 창은 미측정(-1) 그대로 수집 대상으로 남긴다 (docs §1-2 B3)
      anyUnmeasured = true;
      log.warn('측정 실패, 창을 미측정 상태로 수집', {
        from: w.from,
        to: w.to,
        error: err instanceof Error ? err.name : String(err),
      });
    }
  }
  if (total === 0 && !anyUnmeasured) return emptyResult(0, measureCalls);

  const estimated = estimateSeconds(total, concurrency, threshold);
  if (estimated > maxSeconds) {
    const splits = suggestSplits(from, to, total, concurrency, threshold, maxSeconds);
    throw new RangeTooLargeError(
      `기간 ${from}~${to} 의 ${total.toLocaleString()}건 수집` +
        ` (분할은 균등 밀도 가정입니다 — 결산·주총 시즌(2·8월)이 낀 구간은 더 잘게 나누세요)`,
      Math.round(estimated),
      splits,
    );
  }

  // ② 적응형 분할 계획 — 이진 분할, 오른쪽 건수는 부모-왼쪽 차로 재사용해 호출을 아낀다
  const chunks: DateChunk[] = [];
  let budgetExhausted = false;
  const stack: DateChunk[] = [...windows].reverse();

  while (stack.length) {
    const c = stack.pop()!;
    const days = daySpan(c.from, c.to);
    const smallEnough = c.count >= 0 && c.count <= threshold && days <= maxChunkDays;
    if (smallEnough || days <= minDays) {
      chunks.push(c);
      continue;
    }
    if (measureCalls >= budget) {
      // 예산 소진 — 남은 구간은 균등 fallback (원청크 유지 금지: 폭주 재발)
      budgetExhausted = true;
      let cur = c.from;
      while (cur <= c.to) {
        const end = minYmd(addDays(cur, fallbackDays - 1), c.to);
        chunks.push({ from: cur, to: end, count: -1 });
        cur = addDays(end, 1);
      }
      continue;
    }
    const mid = addDays(c.from, Math.floor(days / 2) - 1);
    let leftCount: number;
    try {
      leftCount = await client.measure({ ...base, bgnDe: c.from, endDe: mid });
      measureCalls++;
    } catch (err) {
      // 측정 실패 시 원청크 유지 — 더 쪼개면 호출만 늘어난다 (docs §1-2 B3)
      log.warn('측정 실패, 청크 분할 중단', {
        from: c.from,
        to: c.to,
        error: err instanceof Error ? err.name : String(err),
      });
      chunks.push(c);
      continue;
    }
    const rightCount = c.count >= 0 ? Math.max(0, c.count - leftCount) : -1;
    stack.push({ from: addDays(mid, 1), to: c.to, count: rightCount });
    stack.push({ from: c.from, to: mid, count: leftCount });
  }
  chunks.sort((a, b) => (a.from < b.from ? -1 : 1));

  // ③ 수집 — 세마포어 + per-chunk 타임아웃, 실패해도 나머지는 보존
  const outcomes: ChunkOutcome[] = [];
  const byRcept = new Map<string, Disclosure>();
  let dedupDropped = 0;
  let collectCalls = 0;
  let truncatedAny = false;
  let failed = 0;

  let next = 0;
  async function worker(): Promise<void> {
    while (next < chunks.length) {
      const c = chunks[next++]!;
      if (c.count === 0) {
        outcomes.push({ ...c, pages: 0 });
        continue;
      }
      try {
        const r = await withTimeout(
          client.collect({ ...base, bgnDe: c.from, endDe: c.to }, o.maxPages),
          perChunkTimeoutMs,
        );
        collectCalls += r.calls;
        if (r.truncated) truncatedAny = true;
        for (const row of r.rows) {
          if (byRcept.has(row.rcept_no)) dedupDropped++;
          else byRcept.set(row.rcept_no, row);
        }
        outcomes.push({
          from: c.from,
          to: c.to,
          count: r.totalCount,
          pages: r.totalPage,
          truncated: r.truncated,
        });
      } catch (err) {
        failed++;
        outcomes.push({ ...c, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker()),
  );
  outcomes.sort((a, b) => (a.from < b.from ? -1 : 1));

  const rows = [...byRcept.values()].sort((a, b) =>
    a.rcept_dt !== b.rcept_dt ? (a.rcept_dt > b.rcept_dt ? -1 : 1) : a.rcept_no > b.rcept_no ? -1 : 1,
  );

  return {
    rows,
    diagnostics: {
      measure_calls: measureCalls,
      collect_calls: collectCalls,
      measure_budget_exhausted: budgetExhausted,
      date_chunks: outcomes,
      chunks_failed: failed,
      partial_results: failed > 0,
      truncated: truncatedAny,
      dedup_dropped: dedupDropped,
      total_count_reported: total,
    },
  };
}
