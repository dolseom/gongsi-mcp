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
 * ★ 다년 선례 (최대 5년): 실무에서 "○○한 공시 3년치·5년치 찾아줘"는 회사를 지정하지 않는
 * 질문이다. 기간 전체를 한 번에 전수 수집하는 건 불가능하다 — 실측으로 전체시장 J 3년은
 * 90,820건·243초, J001 로 좁혀도 3년 26,467건·73초로 60초 벽을 넘는다.
 *
 * 그래서 **기간을 줄이는 대신 밀도를 지킨다**: 최신부터 30일 창을 전수로 훑어 내려가며,
 * 사례가 충분히 모이거나 시간 예산에 걸리면 멈춘다. 흔한 유형은 첫 창에서 끝나고,
 * 희귀 유형은 예산이 허용하는 만큼(대략 1년 반) 거슬러 간다.
 *
 * 창당 페이지를 잘라 "5년을 얇게" 훑는 방식은 **일부러 버렸다** — 자세한 이유는
 * SCAN_BUDGET_SECONDS 주석에 있다. 요약하면 5년에 10건뿐인 희귀 유형에서 표본은
 * 0건을 반환해 "그런 공시는 없다"는 거짓 확신을 만든다.
 *
 * 응답의 `coverage` 는 어디까지 훑었는지와 **그 구간이 전수인지**를 함께 알린다.
 * 조용히 일부만 보고 전부인 척하지 않는 것이 이 도구의 핵심 계약이다.
 */

import { z } from 'zod';
import { DartClient, viewerUrl, type Disclosure } from '../clients/dart.js';
import { resolveCorp } from '../resolver/corp-index.js';
import { readDisclosure } from './read-disclosure.js';
import { PRESETS, PRESET_NAMES, type PresetSpec } from '../search/presets.js';
import { ToolError } from '../lib/errors.js';
import { getLogger } from '../lib/logger.js';
import { countCalendarDays } from '../rules/business-days.js';

const log = getLogger('find-precedents');

/**
 * 한 번에 거슬러 내려가는 검색 창 (전체시장 검색 3개월 제한보다 작게).
 * 창 안은 **항상 전수**로 훑는다 — 페이지를 잘라 표본만 보면 안 된다. 아래 주석 참조.
 */
const WINDOW_DAYS = 30;

/**
 * 스캔에 쓸 시간 예산(초). 남은 시간은 선례 원문 다운로드에 쓴다.
 *
 * ★ 창당 페이지를 잘라 "넓고 얇게" 훑던 설계를 폐기하고 "좁고 전수"로 되돌린 이유:
 * 예산 안에서 볼 수 있는 총 건수는 전략과 무관하게 비슷하다(실측 약 380건/초).
 * 5년을 14% 표본으로 훑든 최근 1.4년을 전수로 훑든 기대 적발 건수는 같다.
 * 그런데 표본은 "5년 중 일부를 봤고 3건 나왔다"는 못 쓰는 답을 주고,
 * 전수는 "이 구간은 빠짐없이 확인했고 3건이다"는 쓸 수 있는 답을 준다.
 * **특히 5년에 10건뿐인 희귀 유형에서 표본은 0건을 반환해 "그런 공시는 없다"는
 * 거짓 확신을 만든다** — 이 도구가 가장 피해야 하는 실패 형태다.
 */
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
        '훑은 구간 안에서는 항상 전수로 확인하며, 사례가 모이거나 시간 예산에 걸리면 멈춥니다 — ' +
        '"3년치·5년치 사례" 질문에 쓰세요. coverage 로 실제 훑은 구간과 그 구간이 전수인지 확인하세요',
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

  const windowDays = WINDOW_DAYS;
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
    // 창 안은 전수로 — maxPages 를 주지 않는다. 상한에 걸리면 truncated 로 올라온다.
    const r = await client.collect({
      pblntfTy: preset.pblntfTy,
      pblntfDetailTy: preset.pblntfDetailTy,
      corpCls: input.corp_cls,
      bgnDe: winFrom,
      endDe: winTo,
      // 문안 참고는 정정 반영된 최종본이 정답이다 (지연 판정과 정반대 — 파일 상단 주석)
      lastReportOnly: true,
    });
    windowsScanned++;
    searchCalls += r.calls;
    if (r.truncated) truncatedAny = true;
    matched.push(...r.rows.filter((row) => row.report_nm.includes(keyword)));

    const candidatesSoFar = selectCandidates(matched, { excludeCorpCode, onePerCompany });
    if (candidatesSoFar.length >= wantBuffer) break;
    if (winFrom <= oldest) {
      reachedOldest = true;
      break;
    }
    winTo = addDays(winFrom, -1);
  }

  /**
   * 실제로 훑은 구간 — 요청 구간과 다를 수 있다(조기 중단·예산 초과).
   * `exhaustive_within_scanned` 가 true 면 **훑은 구간 안에서는 빠짐없이 확인**했다는 뜻이다.
   * "5년간 10건뿐인 유형" 같은 질문에서 이 구분이 답의 성격을 바꾼다.
   */
  const coverage = {
    requested_from: oldest,
    scanned_from: scannedFrom,
    scanned_to: today,
    days_scanned: countCalendarDays(scannedFrom, today) + 1,
    windows_scanned: windowsScanned,
    /** 요청한 구간 끝까지 실제로 내려갔는지 */
    reached_requested_start: reachedOldest,
    /** 훑은 구간 안에서는 전수인가 — 페이지 상한에 걸린 창이 있으면 false */
    exhaustive_within_scanned: !truncatedAny,
    budget_exhausted: budgetExhausted,
    /** 조기 중단 여부 — 사례가 충분히 모여서 멈췄다면 그 이전 구간은 안 봤다 */
    stopped_early_on_enough_matches: !reachedOldest && !budgetExhausted,
  };

  const candidates = selectCandidates(matched, { excludeCorpCode, onePerCompany });
  if (candidates.length === 0) {
    // ★ 훑지 못한 구간을 훑은 것처럼 말하면 "그 유형은 없다"는 잘못된 확신을 준다.
    //   실제 스캔 구간(scannedFrom)으로 안내하고, 왜 거기서 멈췄는지도 밝힌다.
    const scope = truncatedAny
      ? '이 구간은 페이지 상한에 걸려 일부만 확인했습니다'
      : '이 구간은 전수로 확인했습니다';
    const hint = budgetExhausted
      ? `시간 예산(${SCAN_BUDGET_SECONDS}초)이 다 되어 ${scannedFrom} 이전(요청 시작일 ${oldest})은 ` +
        `훑지 못했습니다 — "그런 공시가 없다"는 뜻이 아닙니다. 더 과거까지 빠짐없이 확인해야 한다면 ` +
        `search_disclosures(mode:"batch", report_name_contains, date_from·date_to를 3개월 이하로) 로 ` +
        `구간을 나눠 훑으세요. 키워드를 짧게 하는 것도 방법입니다(보고서명 부분일치).`
      : reachedOldest
        ? `요청한 ${oldest}까지 모두 확인했습니다. 키워드를 짧게 해보세요 (보고서명 부분일치입니다).`
        : `키워드를 짧게 하거나 lookback_days 를 늘려보세요.`;
    throw new ToolError(
      'document_not_found',
      `${scannedFrom}~${today} 구간의 ${preset.label} 공시에서 ` +
        `보고서명에 '${keyword}' 가 들어간 건을 찾지 못했습니다 (${scope}). ${hint}`,
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
  const exhaustiveHint =
    '요청 기간 전체의 정확한 건수가 필요하면 search_disclosures(mode:"batch", report_name_contains, ' +
    'date_from·date_to를 3개월 이하로)로 구간을 나눠 훑으세요.';
  if (coverage.stopped_early_on_enough_matches) {
    notes.push(
      `사례가 충분히 모여 ${scannedFrom} 에서 멈췄습니다 — ${scannedFrom}~${today} 구간은 전수로 확인했지만 ` +
        `그 이전(요청 시작일 ${oldest})은 보지 않았으므로 total_matched 는 요청 기간 전체의 건수가 아닙니다. ` +
        exhaustiveHint,
    );
  }
  if (budgetExhausted) {
    notes.push(
      `시간 예산(${SCAN_BUDGET_SECONDS}초)에 걸려 ${scannedFrom} 이전 구간은 훑지 않았습니다 ` +
        `(요청 시작일 ${oldest}). ${scannedFrom}~${today} 구간은 전수로 확인했습니다 — ` +
        `이 결과로 "그 이전에는 없다"고 결론내지 마세요. ${exhaustiveHint}`,
    );
  }
  if (reachedOldest && !truncatedAny) {
    notes.push(
      `요청 구간(${oldest}~${today}) 전체를 전수로 확인했습니다 — total_matched ${candidates.length}건이 ` +
        `이 기간의 전부입니다(보고서명 부분일치 기준, 최종보고서 기준).`,
    );
  }
  if (truncatedAny) {
    notes.push(
      '⚠️ 일부 창이 페이지 상한에 걸려 그 창은 전수가 아닙니다 (diagnostics.truncated). ' +
        'max_pages 설정을 확인하거나 기간을 좁혀 다시 조회하세요.',
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
