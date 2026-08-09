/**
 * `find_precedents` — 타사 선례·문안 참고 (축 1)
 *
 * "다른 회사는 이 항목을 어떻게 썼나"에 답한다. 키워드로 같은 유형의 최근 공시를
 * 찾아 회사당 1건씩 고르고, 원문을 표 구조 보존 마크다운으로 동봉한다.
 *
 * ⚠️ 이 도구만 예외적으로 **최종보고서(Y) 기준**이다 — 문안 참고에는 정정이 반영된
 * 최종 텍스트가 모범 답안이다. 지연 판정용 검색(기본 N)과 목적이 정반대다.
 *
 * 검색은 최신부터 30일 창으로 거슬러 내려가며, 후보가 충분히 모이면 멈춘다 —
 * 전수 수집이 아니므로 range_too_large 없이 항상 60초 안에 끝난다.
 *
 * ★ 다년 선례 (lookback_days > 365): 실무에서 "○○한 공시 3년치·5년치 찾아줘"는 회사를
 * 지정하지 않는 질문이고, 전수 수집으로는 60초 벽에 막힌다(실측: 전체시장 J 3년 90,820건
 * 243초 / J001 3년 26,467건 73초). 그러나 이 질문의 목적은 전수가 아니라 **문안 참고용 사례**다.
 * 그래서 1년을 넘는 요청은 창을 90일로 넓히고 창당 페이지 수를 제한한 **표본 스캔**으로 바꾼다.
 * 5년 전 구간을 훑으면서도 호출 수가 선형으로 유지되고, 응답에는 표본이라는 사실과
 * 실제로 훑은 구간(coverage)을 반드시 함께 돌려준다 — 조용히 일부만 보고 전부인 척하지 않는다.
 */

import { z } from 'zod';
import { DartClient, viewerUrl, type Disclosure } from '../clients/dart.js';
import { resolveCorp } from '../resolver/corp-index.js';
import { readDisclosure } from './read-disclosure.js';
import { PRESETS, PRESET_NAMES, type PresetSpec } from '../search/presets.js';
import { ToolError } from '../lib/errors.js';
import { getLogger } from '../lib/logger.js';

const log = getLogger('find-precedents');

/** 한 번에 거슬러 내려가는 검색 창 (전체시장 검색 3개월 제한보다 작게) */
const WINDOW_DAYS = 30;

/** 이 일수를 넘는 요청은 다년 표본 스캔으로 전환한다 */
const LONG_SCAN_OVER_DAYS = 365;
/** 다년 표본 스캔의 창 — DART 전체시장 3개월 제한의 상한선 */
const LONG_WINDOW_DAYS = 90;
/**
 * 다년 표본 스캔에서 창당 최대 페이지. 목록은 접수일 내림차순이라 앞쪽 페이지가
 * 그 창의 최신 건이다. 문안 참고에는 창마다 300건 표본이면 충분하고,
 * 이 상한이 없으면 5년 스캔이 수백 페이지로 불어나 60초 벽에 막힌다.
 */
const LONG_PAGES_PER_WINDOW = 3;
/** 스캔에 쓸 시간 예산(초). 남은 시간은 선례 원문 다운로드에 쓴다 */
const SCAN_BUDGET_SECONDS = 32;

export const findPrecedentsInput = z.object({
  report_name_contains: z
    .string()
    .min(1)
    .describe('찾을 유형 키워드 — 보고서명 부분일치 (예: "자금차입", "담보제공", "수익증권", "부동산임차")'),
  preset: z
    .enum(PRESET_NAMES)
    .optional()
    .describe('검색 범위 프리셋 (기본 internal_transaction=대규모내부거래)'),
  count: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('가져올 선례 수 (기본 3). 건당 원문 다운로드 1회를 소비합니다'),
  lookback_days: z
    .number()
    .int()
    .min(7)
    .max(1825)
    .optional()
    .describe(
      '최대 며칠 전까지 거슬러 찾을지 (기본 180일, 최대 1825일=5년). 후보가 모이면 더 내려가지 않습니다. ' +
        '365일을 넘기면 창을 90일로 넓히고 창당 300건 표본만 훑는 다년 스캔으로 바뀝니다 — ' +
        '"3년치·5년치 사례" 질문에 쓰되, 결과는 전수가 아닌 표본이며 coverage 로 실제 훑은 구간을 확인하세요',
    ),
  corp_cls: z
    .enum(['Y', 'K', 'N', 'E'])
    .optional()
    .describe('법인구분 필터 — 자사와 같은 구분(상장/비상장)의 문안만 보려면 지정'),
  exclude_corp: z
    .string()
    .min(1)
    .optional()
    .describe('제외할 회사 (corp_code 8자리 또는 회사명) — 보통 자사'),
  one_per_company: z
    .boolean()
    .optional()
    .describe('회사당 1건만 골라 표현을 다양하게 (기본 true). false 면 최신순 그대로'),
  max_chars_per_doc: z
    .number()
    .int()
    .min(1000)
    .max(30_000)
    .optional()
    .describe('선례당 본문 최대 길이 (기본 8,000자)'),
});

export type FindPrecedentsInput = z.infer<typeof findPrecedentsInput>;

export interface CandidateOptions {
  excludeCorpCode?: string;
  onePerCompany: boolean;
}

/**
 * 후보 선정 — 최신순 정렬 후 제외·회사당 1건 적용.
 * 순수 함수로 분리해 테스트한다.
 */
export function selectCandidates(rows: Disclosure[], opts: CandidateOptions): Disclosure[] {
  const sorted = [...rows].sort((a, b) =>
    a.rcept_dt !== b.rcept_dt ? (a.rcept_dt > b.rcept_dt ? -1 : 1) : a.rcept_no > b.rcept_no ? -1 : 1,
  );
  const seen = new Set<string>();
  const out: Disclosure[] = [];
  for (const r of sorted) {
    if (opts.excludeCorpCode && r.corp_code === opts.excludeCorpCode) continue;
    if (opts.onePerCompany) {
      if (seen.has(r.corp_code)) continue;
      seen.add(r.corp_code);
    }
    out.push(r);
  }
  return out;
}

function kstToday(): string {
  return new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, '');
}

function addDays(ymd: string, n: number): string {
  const ms = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
  return new Date(ms + n * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
}

export async function findPrecedents(input: FindPrecedentsInput): Promise<unknown> {
  const client = new DartClient();
  const preset: PresetSpec = PRESETS[input.preset ?? 'internal_transaction'];
  const count = input.count ?? 3;
  const lookbackDays = input.lookback_days ?? 180;
  const onePerCompany = input.one_per_company ?? true;
  const keyword = input.report_name_contains;

  // 제외 회사 특정 (이름이면 corp_code 로 풀어준다)
  let excludeCorpCode: string | undefined;
  if (input.exclude_corp) {
    const r = await resolveCorp(input.exclude_corp, client);
    if ('ambiguous' in r) {
      throw new ToolError('ambiguous_corp', `'${input.exclude_corp}' 후보가 여럿입니다.`);
    }
    excludeCorpCode = r.corpCode;
  }

  // 최신부터 창 단위로 거슬러 검색 — 후보가 넉넉해지면 중단
  const today = kstToday();
  const oldest = addDays(today, -(lookbackDays - 1));
  const wantBuffer = count * 3; // 파싱 불가·중복 대비 여유
  const matched: Disclosure[] = [];
  let windowsScanned = 0;
  let searchCalls = 0;
  let truncatedAny = false;

  // 다년 요청은 표본 스캔으로 — 창을 넓히고 창당 페이지를 제한한다 (파일 상단 주석 참조)
  const longScan = lookbackDays > LONG_SCAN_OVER_DAYS;
  const windowDays = longScan ? LONG_WINDOW_DAYS : WINDOW_DAYS;
  const pagesPerWindow = longScan ? LONG_PAGES_PER_WINDOW : undefined;

  const scanStartedAt = Date.now();
  let budgetExhausted = false;
  let reachedOldest = false;

  let winTo = today;
  let scannedFrom = today;
  while (winTo >= oldest) {
    if (windowsScanned > 0 && (Date.now() - scanStartedAt) / 1000 >= SCAN_BUDGET_SECONDS) {
      // 예산 초과 — 여기서 멈추고, 어디까지 훑었는지 정직하게 보고한다
      budgetExhausted = true;
      break;
    }
    const winFrom = addDays(winTo, -(windowDays - 1)) < oldest ? oldest : addDays(winTo, -(windowDays - 1));
    scannedFrom = winFrom;
    const r = await client.collect(
      {
        pblntfTy: preset.pblntfTy,
        pblntfDetailTy: preset.pblntfDetailTy,
        corpCls: input.corp_cls,
        bgnDe: winFrom,
        endDe: winTo,
        // 문안 참고는 정정 반영된 최종본이 정답이다 (지연 판정과 정반대 — 파일 상단 주석)
        lastReportOnly: true,
      },
      pagesPerWindow,
    );
    windowsScanned++;
    searchCalls += r.calls;
    // 다년 표본 스캔의 truncated 는 의도된 표본 추출이므로 경고로 올리지 않는다
    if (r.truncated && !longScan) truncatedAny = true;
    matched.push(...r.rows.filter((row) => row.report_nm.includes(keyword)));

    const candidatesSoFar = selectCandidates(matched, { excludeCorpCode, onePerCompany });
    if (candidatesSoFar.length >= wantBuffer) break;
    if (winFrom <= oldest) {
      reachedOldest = true;
      break;
    }
    winTo = addDays(winFrom, -1);
  }

  /** 실제로 훑은 구간 — 요청 구간과 다를 수 있다(조기 중단·예산 초과) */
  const coverage = {
    requested_from: oldest,
    scanned_from: scannedFrom,
    scanned_to: today,
    windows_scanned: windowsScanned,
    /** 요청한 구간 끝까지 실제로 내려갔는지 */
    reached_requested_start: reachedOldest,
    /** 창당 페이지를 제한한 표본 스캔인지 */
    sampled: longScan,
    ...(longScan ? { pages_per_window: LONG_PAGES_PER_WINDOW, window_days: windowDays } : {}),
    budget_exhausted: budgetExhausted,
  };

  const candidates = selectCandidates(matched, { excludeCorpCode, onePerCompany });
  if (candidates.length === 0) {
    // ★ 훑지 못한 구간을 훑은 것처럼 말하면 "그 유형은 없다"는 잘못된 확신을 준다.
    //   실제 스캔 구간(scannedFrom)으로 안내하고, 왜 거기서 멈췄는지도 밝힌다.
    const hint = budgetExhausted
      ? `시간 예산(${SCAN_BUDGET_SECONDS}초)이 다 되어 ${scannedFrom} 이전은 훑지 못했습니다. ` +
        `date 구간을 나눠 다시 조회하거나 키워드를 짧게 해보세요.`
      : `키워드를 짧게 하거나 lookback_days 를 늘려보세요.`;
    throw new ToolError(
      'document_not_found',
      `${scannedFrom}~${today} 구간의 ${preset.label} 공시에서 ` +
        `보고서명에 '${keyword}' 가 들어간 건을 찾지 못했습니다` +
        `${longScan ? ' (창당 상위 ' + LONG_PAGES_PER_WINDOW * 100 + '건 표본 스캔)' : ''}. ${hint}`,
      { keyword, preset: preset.label, coverage },
    );
  }

  // 원문 수집 — HWP 첨부만 있는 건은 건너뛰고 다음 후보로
  const precedents: Array<Record<string, unknown>> = [];
  const skipped: Array<{ rcept_no: string; corp_name: string; reason: string }> = [];
  let bodyCalls = 0;
  for (const c of candidates) {
    if (precedents.length >= count) break;
    try {
      const doc = (await readDisclosure({
        rcept_no: c.rcept_no,
        max_chars: input.max_chars_per_doc ?? 8_000,
      })) as Record<string, unknown>;
      if (!doc['cached']) bodyCalls++;
      precedents.push({
        rcept_no: c.rcept_no,
        rcept_dt: c.rcept_dt,
        corp_code: c.corp_code,
        corp_name: c.corp_name,
        corp_cls: c.corp_cls,
        report_nm: c.report_nm,
        viewer_url: viewerUrl(c.rcept_no),
        board_date: doc['board_date'],
        acode: doc['acode'],
        body_truncated: doc['truncated'],
        body: doc['body'],
      });
    } catch (err) {
      const reason = err instanceof ToolError ? err.code : 'unknown';
      skipped.push({ rcept_no: c.rcept_no, corp_name: c.corp_name, reason });
      log.warn('선례 원문 수집 실패, 다음 후보로', { rcept_no: c.rcept_no, reason });
    }
  }

  if (precedents.length === 0) {
    throw new ToolError(
      'body_unparsable',
      `'${keyword}' 선례 ${candidates.length}건을 찾았으나 원문을 파싱할 수 있는 건이 없었습니다. ` +
        `viewer_url 로 직접 확인하세요.`,
      { candidates: candidates.slice(0, 5).map((c) => ({ rcept_no: c.rcept_no, corp_name: c.corp_name, viewer_url: viewerUrl(c.rcept_no) })) },
    );
  }

  const notes: string[] = [];
  if (precedents.length < count) {
    notes.push(
      `요청 ${count}건 중 ${precedents.length}건만 확보했습니다. lookback_days 를 늘리거나 키워드를 넓혀보세요.`,
    );
  }
  if (longScan) {
    notes.push(
      `다년 표본 스캔입니다 — ${windowDays}일 창마다 최신 ${LONG_PAGES_PER_WINDOW * 100}건까지만 훑었으므로 ` +
        `total_matched 는 그 기간의 전체 건수가 아닙니다. 문안 참고용 사례 수집에는 충분하지만, ` +
        `누락 여부 판정(전수 필요)에는 audit_group_disclosures 나 search_disclosures(mode:batch)를 쓰세요.`,
    );
  }
  if (budgetExhausted) {
    notes.push(
      `시간 예산(${SCAN_BUDGET_SECONDS}초)에 걸려 ${scannedFrom} 이전 구간은 훑지 않았습니다 ` +
        `(요청 시작일 ${oldest}). 더 과거를 보려면 그 구간을 따로 조회하세요.`,
    );
  }

  return {
    keyword,
    preset: preset.label,
    searched_from: scannedFrom,
    searched_to: today,
    coverage,
    total_matched: candidates.length,
    returned: precedents.length,
    ...(notes.length ? { notes } : {}),
    precedents,
    ...(skipped.length ? { skipped_unparsable: skipped } : {}),
    diagnostics: {
      // 문안 참고 목적이라 최종본(Y) 기준 — 원본 접수분 필요 시 search_disclosures 사용
      last_reprt_at: 'Y',
      windows_scanned: windowsScanned,
      search_calls: searchCalls,
      body_downloads: bodyCalls,
      truncated: truncatedAny,
    },
  };
}
