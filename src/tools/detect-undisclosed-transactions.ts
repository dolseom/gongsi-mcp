/**
 * `detect_undisclosed_transactions` — J004 거래내역 ↔ J001 공시 교차탐지 (미공시 후보)
 *
 * audit_group_disclosures(J001) 는 DART 접수분만 보므로 **아예 공시하지 않은 거래(미공시)를
 * 원리상 탐지하지 못한다.** 그런데 J004(기업집단현황공시) 대표회사 연1회 서식에는 계열회사 간
 * 실제 거래가 상대방·금액 단위로 실려 있고, 같은 문서의 재무현황 표에 계열사별 자본금·자본총계가
 * 있어 기준금액까지 한 문서로 계산된다. 이 둘을 대조하면 "실제로 거래했는데 J001 공시가 없는 건"을
 * **후보**로 뽑을 수 있다 — 이 프로젝트에서 미공시 신호를 얻는 유일한 경로다.
 *
 * 파이프라인:
 *  ① 원천 문서 확정 — rcept_no 직접 지정 또는 group+year 로 대표회사 연1회 J004 를 찾는다
 *     (정정 반영 **최신 접수분**을 읽는다 — 내용을 읽는 도구라 최종본이 옳다. 지연 판정과 반대)
 *  ② 파싱 — 자금 차입(차입일 있음 = 높은 신뢰도) / 주요 상품·용역(연간 합계 = 제한적 신호) / 자본
 *  ③ 회사별 기준금액 계산 — min(100억, max(5억, max(자본총계, 자본금)×5%))
 *     ⚠️ J004 자본은 "당해 사업연도말" 스냅샷이라 고시 §2③의 정확한 기준(주총 승인 최근
 *     사업연도말 자본총계 + 의결일 직전일 자본금)과 **시점이 다르다** — 근사치로만 쓴다.
 *     거래금액이 100억(령 §33①1호 상한) 이상이면 자본과 무관하게 확실하다.
 *  ④ 기준 초과 거래의 차입회사를 corp_code 로 조인 → 그 회사의 J001 목록을 거래일 주변
 *     넓은 창으로 수집 → 해당 유형 공시가 하나도 없으면 **미공시 후보**
 *
 * ★ 이 도구의 출력은 전부 "후보"다. 확정하면 안 되는 이유가 구조적으로 여럿 있다:
 *  - 이사회 의결은 **한도**로 미리 해 둘 수 있다 — 연초 한도 의결 공시 1건이 연중 여러 차입을
 *    커버한다. 검색창을 거래일 이전 400일까지 열지만 그 밖일 수 있다.
 *  - 상대방이 계열 금융회사면 약관특례(고시 §9, 트랙 B)로 분기 일괄공시에 실릴 수 있다.
 *  - 상품·용역 기준은 분기 합계액(§4③)인데 J004 는 연간 합계뿐이다 — 연간 ≥ 4×기준금액일 때만
 *    (비둘기집: 어느 분기 하나는 반드시 기준금액 이상) 신호로 쓴다.
 */

import { z } from 'zod';
import { DartClient, viewerUrl, type Disclosure } from '../clients/dart.js';
import { collectAdaptive, type BatchResult } from '../search/batch.js';
import { loadDocument, type DocMeta } from './read-disclosure.js';
import {
  resolvePopulation,
  type Population,
  type PopulationInput,
} from './audit-group-disclosures.js';
import { classifyReportName, isCorrection } from './audit-periodic-disclosures.js';
import {
  extractCapitals,
  extractFundBorrowings,
  extractMajorGoodsServices,
  diagnose,
  type FundBorrowing,
  type GoodsServiceRow,
} from '../parsers/j004-transactions.js';
import { normalizeCompanyName } from '../parsers/md-table.js';
import { calcThreshold, CAP_100, 억 } from '../rules/thresholds.js';
import { getStore } from '../lib/store.js';
import { getLogger } from '../lib/logger.js';
import { ToolError } from '../lib/errors.js';
import { isValidYMD, toYMD } from '../rules/business-days.js';

const log = getLogger('detect-undisclosed');

const YMD = z
  .string()
  .regex(/^\d{8}$/, 'YYYYMMDD 형식이어야 합니다')
  .refine(isValidYMD, '실존하지 않는 날짜입니다');
const RCEPT = z.string().regex(/^\d{14}$/, '접수번호는 14자리 숫자입니다');

export const detectUndisclosedTransactionsInput = z.object({
  group: z
    .string()
    .min(1)
    .optional()
    .describe('기업집단명 — 대표회사 연1회 J004 를 자동으로 찾는다 (rcept_no 와 동시 사용 불가)'),
  year: z
    .number()
    .int()
    .min(2021)
    .max(2100)
    .optional()
    .describe(
      '연1회 J004 가 **제출된** 연도 (기본: 올해). 거래내역은 통상 그 전년도(직전 사업연도) 것이다',
    ),
  rcept_no: RCEPT.optional().describe(
    '점검할 J004 접수번호 직접 지정 (group 없이 단독 사용). 거래현황 표가 있는 ' +
      '**대표회사 연1회 서식**이어야 한다 — 분기 개별 서식에는 거래내역이 없다',
  ),
  today: YMD.optional().describe('오늘 날짜 (기본: 시스템 날짜). J001 검색창 상한'),
});

export type DetectUndisclosedTransactionsInput = z.infer<
  typeof detectUndisclosedTransactionsInput
>;

/** J001 검색을 수행할 회사 수 상한 — 회사당 측정 1 + 수집 1 콜이라 60초 벽 대비 */
const MAX_COMPANIES_TO_SEARCH = 20;
/** 거래일 이전으로 여는 검색창 (달력일) — 한도성 이사회 의결이 거래보다 훨씬 앞설 수 있다 */
const LOOKBACK_DAYS = 400;
/** 거래일 이후로 여는 검색창 (달력일) — 지연 공시까지 잡는다 */
const LOOKAHEAD_DAYS = 90;
/** J004 계열 서식코드 (실측: 80621 분기 개별 / 80622 연1회 대표 / 80623 연1회 개별) */
const J004_ACODES = new Set(['80620', '80621', '80622', '80623', '80624', '80625']);

/** 테스트 주입점 — 실제 API 없이 판정 로직을 검증한다 */
export interface DetectDeps {
  loadDoc: (rceptNo: string) => Promise<{ markdown: string; meta: DocMeta }>;
  collectList: (
    corpCode: string,
    detailTy: 'J001' | 'J004',
    from: string,
    to: string,
  ) => Promise<BatchResult>;
  resolvePop: (input: PopulationInput) => Promise<Population>;
  findCorps: (name: string) => Array<{ corpCode: string; corpName: string }>;
}

function realDeps(client: DartClient): DetectDeps {
  return {
    loadDoc: (rceptNo) => loadDocument(rceptNo, client),
    collectList: (corpCode, pblntfDetailTy, from, to) =>
      collectAdaptive(
        client,
        {
          pblntfDetailTy,
          corpCode,
          // 전수(N) 고정. J004 최신본 선택은 코드에서 접수일 최대값으로 고르고,
          // J001 존재 확인은 원본·정정 어느 쪽이 남아 있어도 "공시가 존재한다"이므로
          // 전수 조회가 어느 쪽 판정도 왜곡하지 않는다.
          lastReportOnly: false,
        },
        from,
        to,
      ),
    resolvePop: (input) => resolvePopulation(input),
    findCorps: (name) =>
      getStore()
        .findCorpsByName(name)
        .map((c) => ({ corpCode: c.corpCode, corpName: c.corpName })),
  };
}

function addDaysYmd(ymd: string, days: number): string {
  const t =
    Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) + days * 86_400_000;
  const d = new Date(t);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}

function fmtWon(n: number): string {
  if (n >= 억) {
    const v = n / 억;
    return `${Number.isInteger(v) ? v : v.toFixed(1)}억원`;
  }
  return `${n.toLocaleString('ko-KR')}원`;
}

/** 보고서명 정규화 — 공백·가운뎃점·괄호 표기 차이를 무시하고 유형 키워드를 찾는다 */
function normalizeReportNm(nm: string): string {
  return nm.replace(/[\s·ㆍ・()[\],]/g, '');
}

/** 자금 차입 거래를 커버할 수 있는 J001 보고서명인가 */
export function isBorrowingReport(reportNm: string): boolean {
  return normalizeReportNm(reportNm).includes('자금차입');
}

/** 상품·용역 거래를 커버할 수 있는 J001 보고서명인가 (변경 공시 포함) */
export function isGoodsServicesReport(reportNm: string): boolean {
  const n = normalizeReportNm(reportNm);
  return n.includes('상품') && n.includes('용역');
}

/** 회사별 기준금액 (J004 재무현황 기반 근사치) */
export interface ApproxThreshold {
  value: number;
  formula: string;
  /** 재무현황 표에서 매칭된 원문 회사명 */
  source_row: string;
}

/**
 * 재무현황 자본으로 회사별 기준금액을 계산한다.
 * 자본총계·자본금이 둘 다 없는 회사는 넣지 않는다 (추정 금지).
 */
export function buildThresholdMap(
  capitals: ReturnType<typeof extractCapitals>,
): Map<string, ApproxThreshold> {
  const map = new Map<string, ApproxThreshold>();
  for (const c of capitals) {
    if (c.totalEquity === null && c.paidInCapital === null) continue;
    const r = calcThreshold({
      ...(c.totalEquity !== null ? { totalEquity: c.totalEquity } : {}),
      ...(c.paidInCapital !== null ? { paidInCapital: c.paidInCapital } : {}),
    });
    if (!r) continue;
    const key = normalizeCompanyName(c.company);
    // 같은 이름이 두 번 나오면 (표가 금융/비금융으로 갈릴 때) 첫 행을 유지한다 —
    // 정규화 충돌로 다른 회사의 자본을 덮어쓰는 쪽이 더 위험하다
    if (!map.has(key)) {
      map.set(key, { value: r.threshold, formula: r.formula, source_row: c.company });
    }
  }
  return map;
}

type Certainty = 'certain_by_cap' | 'approx_from_j004';

/** 거래 1건의 기준금액 판정 */
export function judgeOverThreshold(
  amount: number,
  threshold: ApproxThreshold | undefined,
): { over: boolean | null; certainty?: Certainty } {
  // 령 §33①1호 상한: 기준금액은 어떤 자본에서도 100억을 넘지 못한다 —
  // 거래금액이 100억 이상이면 자본을 몰라도 기준 이상이 확실하다
  if (amount >= CAP_100) return { over: true, certainty: 'certain_by_cap' };
  if (!threshold) return { over: null };
  return amount >= threshold.value
    ? { over: true, certainty: 'approx_from_j004' }
    : { over: false };
}

interface FilingRef {
  rcept_no: string;
  rcept_dt: string;
  report_nm: string;
  viewer_url: string;
}

function toFilingRef(d: Disclosure): FilingRef {
  return {
    rcept_no: d.rcept_no,
    rcept_dt: d.rcept_dt,
    report_nm: d.report_nm,
    viewer_url: viewerUrl(d.rcept_no),
  };
}

type TxStatus = 'undisclosed_candidate' | 'j001_filing_exists' | 'below_threshold' | 'not_judged';

interface JudgedBorrowing {
  company: string;
  corp_code?: string;
  counterparty: string;
  amount: number;
  amount_display: string;
  date: string | null;
  raw_date?: string;
  table_label: string;
  threshold?: {
    value: number;
    value_display: string;
    formula: string;
    source_row: string;
  };
  certainty?: Certainty;
  status: TxStatus;
  reason?: string;
  j001_search?: { from: string; to: string; type_filter: string };
  matching_filings?: FilingRef[];
  other_j001_in_window?: number;
  other_j001_sample?: FilingRef[];
}

interface GoodsSignal {
  company: string;
  corp_code?: string;
  counterparty: string;
  item: string;
  annual_amount: number;
  annual_amount_display: string;
  threshold?: { value: number; value_display: string; formula: string; source_row: string };
  certainty?: Certainty;
  /** 연간 ≥ 4×기준금액 ⇒ 어느 분기 하나는 반드시 기준금액 이상 (비둘기집 논증) */
  quarterly_logic:
    | 'annual_geq_4x_threshold'
    | 'annual_below_4x_threshold'
    | 'threshold_unknown';
  /** 품목이 상품·용역 거래의 대가가 아닐 가능성 — 걸리면 미공시 후보로 올리지 않는다 */
  item_caveat?: string;
  status?: TxStatus;
  reason?: string;
  j001_search?: { from: string; to: string; type_filter: string };
  matching_filings?: FilingRef[];
  other_j001_in_window?: number;
}

/**
 * 상품·용역 거래의 대가가 아닐 가능성이 높은 품목.
 * 실측(미래에셋 실물): J004 상품·용역 표에 "배당금수익" 이 실려 있다 — 배당은 주주 지위에 따른
 * 이익 분배이지 법 §26①의 거래유형(자금·유가증권·자산·상품용역) 어디에도 해당하지 않으므로,
 * 이를 미공시 후보로 올리면 오경보다. 단정하지 않고 별도 바구니로 분리한다.
 */
export function itemLikelyNotGoodsService(item: string): string | null {
  const n = item.replace(/[\s ]+/g, '');
  if (n.includes('배당')) {
    return (
      '품목이 "배당" 성격입니다 — 배당금은 주주 지위에 따른 이익 분배로, 대규모내부거래의 ' +
      '상품·용역 거래에 해당하지 않을 가능성이 높습니다. 공시 대상 여부를 별도로 판단하세요'
    );
  }
  return null;
}

/** 회사 하나의 J001 검색 결과 (회사당 1회만 수집한다) */
interface CompanySearch {
  corp_code: string;
  from: string;
  to: string;
  rows: Disclosure[];
  partial: boolean;
  error?: string;
}

export async function detectUndisclosedTransactions(
  input: DetectUndisclosedTransactionsInput,
  depsOverride?: DetectDeps,
): Promise<unknown> {
  if (!input.rcept_no && !input.group) {
    throw new ToolError('invalid_argument', 'rcept_no 또는 group 중 하나는 필수입니다.');
  }
  if (input.rcept_no && input.group) {
    throw new ToolError('invalid_argument', 'rcept_no 와 group 은 동시에 쓸 수 없습니다.');
  }
  if (input.rcept_no && input.year !== undefined) {
    throw new ToolError(
      'invalid_argument',
      'year 는 group 경로에서만 씁니다 — rcept_no 를 지정하면 그 문서를 그대로 읽습니다.',
    );
  }

  const today = input.today ?? toYMD(new Date());
  const deps = depsOverride ?? realDeps(new DartClient());
  const notes: string[] = [];
  let listCalls = 0;
  let partialLists = false;

  // ── ① 원천 문서 확정 ──
  let sourceRceptNo: string;
  let sourceReportNm: string | null = null;
  let sourceIsCorrection = false;
  let population: Population | null = null;
  let filingYear: number;

  if (input.group) {
    const year = input.year ?? Number(today.slice(0, 4));
    filingYear = year;
    // 포털 스냅샷은 매년 5/1 기준 — 점검 연도의 5월로 맞춘다 (audit_periodic 과 같은 이유)
    population = await deps.resolvePop({ group: input.group, year_month: `${year}05` });

    // 대표회사 corp_code — 포털 대표회사명을 소속회사 목록과 정규화 이름으로 조인
    const repName = String(
      (population.group as Record<string, unknown>)?.['representative_company'] ?? '',
    );
    const repKey = normalizeCompanyName(repName);
    let repCode: string | undefined;
    for (const [code, name] of population.corpCodes) {
      if (normalizeCompanyName(name) === repKey) {
        repCode = code;
        break;
      }
    }
    if (!repName || !repCode) {
      throw new ToolError(
        'corp_not_found',
        `'${input.group}' 대표회사(${repName || '이름 미상'})의 DART corp_code 를 찾지 못했습니다 — ` +
          'resolve_entity(fetchJurirNo=true) 로 대표회사를 조회해 조인 캐시를 채우거나, ' +
          '대표회사 연1회 J004 의 rcept_no 를 직접 지정하세요.',
        { representative_company: repName },
      );
    }

    // 연1회 대표회사 서식 탐색 — 4/1 부터 이듬해 3/31 까지 (해 넘긴 지연 제출 포함)
    const from = `${year}0401`;
    const to = today < `${year + 1}0331` ? today : `${year + 1}0331`;
    if (from > to) {
      throw new ToolError(
        'invalid_argument',
        `${year}년 연1회 공시 창(${from}~)이 아직 열리지 않았습니다 — year 를 확인하세요.`,
      );
    }
    const r = await deps.collectList(repCode, 'J004', from, to);
    listCalls++;
    if (r.diagnostics.partial_results || r.diagnostics.truncated) partialLists = true;
    const candidates = r.rows.filter((row) => {
      const c = classifyReportName(row.report_nm);
      return c.kind === 'annual_q1' && c.representative;
    });
    if (candidates.length === 0) {
      throw new ToolError(
        'document_not_found',
        `${year}년 창(${from}~${to})에서 대표회사(${repName})의 연1회 J004 를 찾지 못했습니다 — ` +
          '아직 제출 전(기한 5/31)이거나 대표회사가 바뀌었을 수 있습니다. ' +
          'search_disclosures(preset:"group_status") 로 직접 찾아 rcept_no 로 지정하세요.',
        { representative_company: repName, corp_code: repCode, window: { from, to } },
      );
    }
    // 정정 반영 **최신 접수분** — 내용을 읽는 도구라 최종본이 옳다 (J004 정정률 91% 실측).
    // 지연 판정 도구들이 원본을 고집하는 것과 반대 방향이고, 그 반대가 여기선 정답이다.
    // 같은 날 원본+정정이 함께 접수되면 접수일이 같다 — 접수번호(일련 증가)로 뒤를 고른다.
    const latest = candidates.reduce((a, b) =>
      a.rcept_dt !== b.rcept_dt
        ? a.rcept_dt > b.rcept_dt
          ? a
          : b
        : a.rcept_no > b.rcept_no
          ? a
          : b,
    );
    sourceRceptNo = latest.rcept_no;
    sourceReportNm = latest.report_nm;
    sourceIsCorrection = isCorrection(latest.report_nm);
  } else {
    sourceRceptNo = input.rcept_no!;
    const y = Number(sourceRceptNo.slice(0, 4));
    const m = Number(sourceRceptNo.slice(4, 6));
    // 1~3월 접수는 전년도 의무분의 해 넘긴 제출일 가능성이 높다 — 직전 사업연도를 한 해 더 당긴다
    filingYear = m >= 4 ? y : y - 1;
  }
  /** 거래가 속한 직전 사업연도 (12월 결산 가정 — 변칙 회계연도는 어긋날 수 있다) */
  const fiscalYear = filingYear - 1;

  const { markdown, meta } = await deps.loadDoc(sourceRceptNo);
  if (!markdown) {
    throw new ToolError(
      'body_unparsable',
      '원문 본문을 파싱할 수 없습니다 (HWP 첨부만 있는 공시일 수 있습니다).',
      { rcept_no: sourceRceptNo, viewer_url: viewerUrl(sourceRceptNo) },
    );
  }
  if (meta.acode && !J004_ACODES.has(meta.acode)) {
    notes.push(
      `⚠️ 서식코드 ${meta.acode}는 기업집단현황공시 계열(8062x)이 아닐 수 있습니다 — ` +
        '거래현황 표가 없으면 아래 추출이 전부 0건이 됩니다.',
    );
  }

  // ── ② 파싱 ──
  const parseDiag = diagnose(markdown);
  const capitals = extractCapitals(markdown);
  const borrowings = extractFundBorrowings(markdown);
  const goods = extractMajorGoodsServices(markdown);

  if (parseDiag.sections_missing.length > 0) {
    notes.push(
      `⚠️ 원문에서 절을 찾지 못했습니다: ${parseDiag.sections_missing.join(', ')} — ` +
        '해당 유형의 점검은 **수행되지 않은 것**이지 "거래 없음"이 아닙니다. ' +
        '대표회사 연1회 서식(예: ACODE 80622)이 맞는지 확인하세요.',
    );
  }
  if (parseDiag.tables_without_unit > 0) {
    notes.push(
      `⚠️ 단위 캡션을 읽지 못해 통째로 건너뛴 표가 ${parseDiag.tables_without_unit}개 있습니다 — ` +
        '금액을 추측하지 않으므로 그 표의 거래는 점검되지 않았습니다.',
    );
  }

  // ── ③ 회사별 기준금액 (근사) ──
  const thresholds = buildThresholdMap(capitals);

  // ── ④ 거래 판정 1차 — 기준 초과 여부 ──
  const judgedBorrowings: JudgedBorrowing[] = borrowings.map((b: FundBorrowing) => {
    const th = thresholds.get(normalizeCompanyName(b.company));
    const j = judgeOverThreshold(b.amount, th);
    const base: JudgedBorrowing = {
      company: b.company,
      counterparty: b.counterparty,
      amount: b.amount,
      amount_display: fmtWon(b.amount),
      date: b.date,
      ...(b.rawDate && !b.date ? { raw_date: b.rawDate } : {}),
      table_label: b.label,
      ...(th
        ? {
            threshold: {
              value: th.value,
              value_display: fmtWon(th.value),
              formula: th.formula,
              source_row: th.source_row,
            },
          }
        : {}),
      ...(j.certainty ? { certainty: j.certainty } : {}),
      status: 'not_judged',
    };
    if (j.over === false) return { ...base, status: 'below_threshold' };
    if (j.over === null) {
      return {
        ...base,
        status: 'not_judged',
        reason:
          'threshold_unknown — 재무현황 표에서 이 회사의 자본을 찾지 못했고 거래금액이 100억원 미만이라 ' +
          '기준금액 초과 여부를 판정할 수 없습니다',
      };
    }
    return base; // over — 상태는 J001 대조 후 확정
  });

  const judgedGoods: GoodsSignal[] = goods.map((g: GoodsServiceRow) => {
    const th = thresholds.get(normalizeCompanyName(g.company));
    const itemCaveat = itemLikelyNotGoodsService(g.item);
    const base: GoodsSignal = {
      company: g.company,
      counterparty: g.counterparty,
      item: g.item,
      annual_amount: g.annualAmount,
      annual_amount_display: fmtWon(g.annualAmount),
      ...(th
        ? {
            threshold: {
              value: th.value,
              value_display: fmtWon(th.value),
              formula: th.formula,
              source_row: th.source_row,
            },
          }
        : {}),
      quarterly_logic: 'threshold_unknown',
      ...(itemCaveat ? { item_caveat: itemCaveat } : {}),
    };
    // 비둘기집: 연간 합계 ≥ 4×기준금액이면 네 분기 전부가 기준금액 미만일 수 없다.
    // 그 미만이면 분기 집중 여부를 알 수 없어 **원리상 판정 불가**다 (놓치는 것이 아니라 못 보는 것).
    if (g.annualAmount >= 4 * CAP_100) {
      return { ...base, quarterly_logic: 'annual_geq_4x_threshold', certainty: 'certain_by_cap' };
    }
    if (!th) return base;
    if (g.annualAmount >= 4 * th.value) {
      return {
        ...base,
        quarterly_logic: 'annual_geq_4x_threshold',
        certainty: 'approx_from_j004',
      };
    }
    return { ...base, quarterly_logic: 'annual_below_4x_threshold' };
  });

  // ── ⑤ J001 대조 대상 회사 확정 (조인 + 예산) ──
  const needsSearch = new Map<string, { maxAmount: number; dates: string[] }>();
  const overBorrowings = judgedBorrowings.filter(
    (b) => b.status === 'not_judged' && !b.reason,
  );
  for (const b of overBorrowings) {
    const k = normalizeCompanyName(b.company);
    const e = needsSearch.get(k) ?? { maxAmount: 0, dates: [] };
    e.maxAmount = Math.max(e.maxAmount, b.amount);
    if (b.date) e.dates.push(b.date);
    needsSearch.set(k, e);
  }
  // 품목이 거래 성격이 아닐 가능성(item_caveat)이 걸린 행은 미공시 후보 경로에 올리지 않는다
  const signalGoods = judgedGoods.filter(
    (g) => g.quarterly_logic === 'annual_geq_4x_threshold' && !g.item_caveat,
  );
  for (const g of signalGoods) {
    const k = normalizeCompanyName(g.company);
    const e = needsSearch.get(k) ?? { maxAmount: 0, dates: [] };
    e.maxAmount = Math.max(e.maxAmount, g.annual_amount);
    needsSearch.set(k, e);
  }

  // 예산: 금액 큰 회사부터. 넘치는 회사의 거래는 판정하지 않고 그렇다고 말한다.
  const ranked = [...needsSearch.entries()].sort((a, b) => b[1].maxAmount - a[1].maxAmount);
  const withinBudget = ranked.slice(0, MAX_COMPANIES_TO_SEARCH);
  const overBudgetKeys = new Set(ranked.slice(MAX_COMPANIES_TO_SEARCH).map(([k]) => k));

  // 조인: ① 집단 소속회사(포털 이름) 정규화 매칭 ② DART 법인 인덱스 상호 완전일치
  const joinFailures: Array<{ company: string; reason: string }> = [];
  const popByName = new Map<string, string>();
  if (population) {
    for (const [code, name] of population.corpCodes) {
      popByName.set(normalizeCompanyName(name), code);
    }
  }
  function joinCorpCode(rawName: string): { code?: string; reason?: string } {
    const key = normalizeCompanyName(rawName);
    const fromPop = popByName.get(key);
    if (fromPop) return { code: fromPop };
    const exact = deps.findCorps(rawName.trim());
    if (exact.length === 1) return { code: exact[0]!.corpCode };
    if (exact.length > 1) return { reason: `동명 법인 ${exact.length}건 — 자동 선택하지 않습니다` };
    // 법인격 표기((주)·㈜ 등)를 뗀 이름으로 재시도
    const stripped = rawName
      .replace(/\(주\)|\(유\)|㈜|주식회사|유한회사|유한책임회사|합자회사|합명회사/g, '')
      .trim();
    if (stripped && stripped !== rawName.trim()) {
      const retry = deps.findCorps(stripped);
      if (retry.length === 1) return { code: retry[0]!.corpCode };
      if (retry.length > 1) return { reason: `동명 법인 ${retry.length}건 — 자동 선택하지 않습니다` };
    }
    return {
      reason:
        population === null
          ? 'DART 법인 인덱스에서 상호 일치 없음'
          : '집단 소속회사 목록·DART 법인 인덱스 어디에서도 조인 실패',
    };
  }

  // ── ⑥ 회사당 1회 J001 수집 ──
  const fyStart = `${fiscalYear}0101`;
  const fyEnd = `${fiscalYear}1231`;
  const searches = new Map<string, CompanySearch>(); // 정규화 이름 → 검색 결과
  for (const [key, info] of withinBudget) {
    // 대표 원문 이름 하나를 찾는다 (조인 시도용)
    const rawName =
      overBorrowings.find((b) => normalizeCompanyName(b.company) === key)?.company ??
      signalGoods.find((g) => normalizeCompanyName(g.company) === key)?.company ??
      key;
    const joined = joinCorpCode(rawName);
    if (!joined.code) {
      joinFailures.push({ company: rawName, reason: joined.reason ?? '조인 실패' });
      continue;
    }
    const earliest = [fyStart, ...info.dates].reduce((a, b) => (a <= b ? a : b));
    const latest = [fyEnd, ...info.dates].reduce((a, b) => (a >= b ? a : b));
    const from = addDaysYmd(earliest, -LOOKBACK_DAYS);
    const toRaw = addDaysYmd(latest, LOOKAHEAD_DAYS);
    const to = toRaw < today ? toRaw : today;
    try {
      const r = await deps.collectList(joined.code, 'J001', from, to);
      listCalls++;
      if (r.diagnostics.partial_results || r.diagnostics.truncated) partialLists = true;
      searches.set(key, {
        corp_code: joined.code,
        from,
        to,
        rows: r.rows,
        partial: r.diagnostics.partial_results || r.diagnostics.truncated,
      });
    } catch (err) {
      searches.set(key, {
        corp_code: joined.code,
        from,
        to,
        rows: [],
        partial: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const joinFailedKeys = new Set(joinFailures.map((f) => normalizeCompanyName(f.company)));

  // ── ⑦ 상태 확정 ──
  function settle(
    key: string,
    typeFilter: (nm: string) => boolean,
    typeLabel: string,
  ): Pick<
    JudgedBorrowing,
    | 'status'
    | 'reason'
    | 'corp_code'
    | 'j001_search'
    | 'matching_filings'
    | 'other_j001_in_window'
    | 'other_j001_sample'
  > {
    if (overBudgetKeys.has(key)) {
      return {
        status: 'not_judged',
        reason:
          `company_budget_exceeded — J001 검색 대상이 ${ranked.length}개사여서 금액 상위 ` +
          `${MAX_COMPANIES_TO_SEARCH}개사만 대조했습니다. 이 회사는 rcept_no 없이 개별 확인이 필요합니다`,
      };
    }
    if (joinFailedKeys.has(key)) {
      return {
        status: 'not_judged',
        reason:
          'join_failed — 회사명을 DART corp_code 로 잇지 못해 J001 을 조회할 수 없었습니다 ' +
          '(join_failures 참조). resolve_entity 로 corp_code 를 확인하세요',
      };
    }
    const s = searches.get(key);
    if (!s) {
      return { status: 'not_judged', reason: 'internal — 검색 대상에 오르지 않았습니다' };
    }
    if (s.error) {
      return {
        status: 'not_judged',
        corp_code: s.corp_code,
        reason: `list_error — J001 목록 조회 실패: ${s.error}`,
      };
    }
    const matching = s.rows.filter((r) => typeFilter(r.report_nm));
    const others = s.rows.filter((r) => !typeFilter(r.report_nm));
    const common = {
      corp_code: s.corp_code,
      j001_search: { from: s.from, to: s.to, type_filter: typeLabel },
      other_j001_in_window: others.length,
    };
    if (matching.length > 0) {
      return {
        ...common,
        status: 'j001_filing_exists',
        matching_filings: matching.slice(0, 10).map(toFilingRef),
      };
    }
    return {
      ...common,
      status: 'undisclosed_candidate',
      ...(others.length > 0 ? { other_j001_sample: others.slice(0, 5).map(toFilingRef) } : {}),
    };
  }

  for (const b of judgedBorrowings) {
    if (b.status !== 'not_judged' || b.reason) continue; // over 만 남아 있다
    Object.assign(b, settle(normalizeCompanyName(b.company), isBorrowingReport, '자금차입'));
  }
  for (const g of signalGoods) {
    Object.assign(
      g,
      settle(normalizeCompanyName(g.company), isGoodsServicesReport, '상품·용역'),
    );
  }

  // ── ⑧ 집계·정직성 장치 ──
  const undisclosed = judgedBorrowings.filter((b) => b.status === 'undisclosed_candidate');
  const filingExists = judgedBorrowings.filter((b) => b.status === 'j001_filing_exists');
  const below = judgedBorrowings.filter((b) => b.status === 'below_threshold');
  const notJudged = judgedBorrowings.filter((b) => b.status === 'not_judged');
  const goodsCandidates = judgedGoods.filter((g) => g.status === 'undisclosed_candidate');
  const goodsFilingExists = judgedGoods.filter((g) => g.status === 'j001_filing_exists');
  // 조인 실패·예산 초과로 J001 대조를 못 한 신호 — 출력에서 빠지면 "후보 아님"으로 읽힌다
  const goodsNotJudged = judgedGoods.filter((g) => g.status === 'not_judged');
  const goodsUnjudgeable = judgedGoods.filter(
    (g) => g.quarterly_logic !== 'annual_geq_4x_threshold' || g.item_caveat,
  );
  const goodsItemCaveats = goodsUnjudgeable.filter(
    (g) => g.item_caveat && g.quarterly_logic === 'annual_geq_4x_threshold',
  );

  const scopeCaveats: string[] = [
    '★ 모든 결과는 **후보**입니다. undisclosed_candidate 를 "미공시 확정"으로 읽으면 안 되는 구조적 이유: ' +
      '① 이사회 의결은 **한도**로 미리 해 둘 수 있어(연초 한도 의결 → 연중 분할 인출) 그 공시가 ' +
      `검색창(거래일 이전 ${LOOKBACK_DAYS}일)보다 앞설 수 있고, 반대로 검색창 상한` +
      `(사업연도 말 +${LOOKAHEAD_DAYS}일과 오늘 중 이른 쪽) 이후에야 이뤄진 아주 늦은 사후 공시는 ` +
      '잡히지 않아 후보로 남을 수 있습니다 ② 상대방이 계열 금융회사면 ' +
      '약관특례(고시 §9, 트랙 B) 분기 일괄공시에 실릴 수 있는데 그 서식은 보고서명이 달라 ' +
      '유형 필터에 걸리지 않을 수 있습니다 ③ 보고서명 유형 분류가 원문 표기와 어긋날 수 있습니다 — ' +
      'other_j001_in_window 가 0 이 아니면 그 공시들을 먼저 확인하세요.',
    '기준금액은 **J004 재무현황(당해 사업연도말 자본) 기반 근사치**입니다. 고시 §2③의 정확한 기준은 ' +
      '자본총계=주주총회 승인된 최근 사업연도말 재무제표, 자본금=이사회 의결일 직전일 — 거래 시점에 ' +
      '유효한 자본총계는 통상 **그 전년도말** 것이라 이 근사는 양방향으로 어긋날 수 있습니다. ' +
      '거래금액 100억원 이상(certainty:"certain_by_cap")만 자본과 무관하게 확실합니다(령 §33①1호 상한).',
    'below_threshold 도 같은 근사 기준입니다 — **"기준 미달 = 공시의무 없음 확정"이 아닙니다.** ' +
      '경계(±수억) 거래는 정확한 자본(주총 승인 재무제표)으로 check_disclosure_duty 재판정이 필요합니다.',
    '이 도구가 보는 거래유형은 **자금 차입**(차입일 단위)과 **주요 상품·용역**(연간 합계)뿐입니다. ' +
      '유가증권 거래·상품용역 매입/매출 총괄 **매트릭스 표는 파싱하지 않으며**, 담보·채무보증·임대차· ' +
      '출자 등 다른 유형과 "주요" 기준에 못 미쳐 표에 실리지 않은 상품·용역 거래는 보지 않습니다.',
    '차입 거래는 **차입회사의 "자금차입" 공시**만 확인합니다 — 자금을 대준 계열회사의 "자금대여" ' +
      '공시의무는 별개이고 이 도구는 확인하지 않습니다.',
    '상품·용역의 기준은 분기 합계액(고시 §4③)인데 J004 는 연간 합계뿐입니다 — 연간 ≥ 4×기준금액인 ' +
      '경우만(어느 분기 하나는 반드시 기준 이상이라는 산술) 신호로 쓰고, 그 미만은 분기 집중 여부를 ' +
      '알 수 없어 **원리상 판정하지 않습니다** (goods_services_not_judgeable).',
    'J004 원문 자체가 부정확하거나 늦게 제출됐을 수 있습니다 (J004 정정률 91% 실측) — 정정 반영 ' +
      '최신본을 읽지만 원천 기재 오류·누락은 판별하지 못합니다. J001 대사의 원천이 J004 하나뿐이라 ' +
      'J004 에 안 실린 거래는 애초에 이 도구의 시야 밖입니다.',
    'j001_filing_exists 는 **그 유형의 J001 공시가 존재한다**는 뜻이지 그 공시가 이 거래를 실제로 ' +
      '커버함을 대조한 것이 아닙니다 — matching_filings 를 read_disclosure 로 열어 거래상대방·금액· ' +
      '의결일을 확인해야 "공시됨"이 확정됩니다.',
    '각 회사가 실제로 공시의무자인지(소속·청산·휴업 등)는 판정하지 않습니다.',
  ];

  const totalCandidates = undisclosed.length + goodsCandidates.length;
  if (totalCandidates > 0) {
    notes.push(
      `⚠️ 미공시 후보 ${totalCandidates}건 (자금차입 ${undisclosed.length} + 상품·용역 ${goodsCandidates.length}). ` +
        '**반드시 scope_caveats 와 함께 전달하세요** — 미공시의 과태료 기본금액(의결 있음 5,000만 / 없음 ' +
        '7,000만원)은 지연(500만+1일 10만)보다 훨씬 무거워, 단정이 틀렸을 때의 대가도 그만큼 큽니다. ' +
        '각 건은 해당 회사 담당자 확인 → 필요 시 check_disclosure_duty(정확한 자본 입력) 재판정 순서로 검증하세요.',
    );
  } else {
    notes.push(
      'ℹ️ 미공시 후보 0건은 "미공시 없음"의 확인이 아닙니다 — 이 도구가 보는 유형(자금차입·주요 상품·용역)과 ' +
        '이 문서에 실린 거래의 범위 안에서 후보를 찾지 못했다는 뜻입니다 (scope_caveats 참조).',
    );
  }
  if (joinFailures.length > 0) {
    notes.push(
      `⚠️ 기준 초과 거래가 있는 ${joinFailures.length}개사는 회사명→corp_code 조인 실패로 J001 대조를 ` +
        '하지 못했습니다 (join_failures) — "후보 아님"이 아니라 **확인하지 못한 것**입니다.',
    );
  }
  if (overBudgetKeys.size > 0) {
    notes.push(
      `⚠️ J001 검색 예산(${MAX_COMPANIES_TO_SEARCH}개사) 초과로 ${overBudgetKeys.size}개사는 대조하지 ` +
        '않았습니다 — 금액 상위 회사부터 대조했고, 나머지는 not_judged 로 남아 있습니다.',
    );
  }
  if (goodsUnjudgeable.length > 0) {
    notes.push(
      `ℹ️ 상품·용역 ${goodsUnjudgeable.length}건은 미공시 후보 판정에 올리지 않았습니다 ` +
        '(goods_services_not_judgeable) — 연간 합계가 4×기준금액 미만이면 분기 기준 초과 여부를 ' +
        '원리상 판정할 수 없고(분기별 합계는 각 사 내부 데이터로만 확인됩니다), ' +
        'item_caveat 이 붙은 행은 품목이 거래 성격이 아닐 수 있습니다.',
    );
  }
  if (goodsItemCaveats.length > 0) {
    notes.push(
      `ℹ️ 연간 금액이 4×기준금액 이상인데도 후보로 올리지 않은 행이 ${goodsItemCaveats.length}건 있습니다 — ` +
        '품목이 배당 등 **거래의 대가가 아닐 가능성**이 높아서입니다 (item_caveat 참조). ' +
        '실제로 상품·용역 거래라면 후보에 준해 확인이 필요합니다.',
    );
  }
  if (goodsNotJudged.length > 0) {
    notes.push(
      `⚠️ 상품·용역 신호 ${goodsNotJudged.length}건은 조인 실패·예산 초과로 J001 대조를 하지 못했습니다 ` +
        '(goods_services_signals 중 status:"not_judged") — "후보 아님"이 아니라 확인하지 못한 것입니다.',
    );
  }
  if (partialLists) {
    notes.push(
      '⚠️ 일부 목록 수집이 불완전합니다 (측정 실패·절단·부분결과) — "공시 없음" 판정이 수집 누락일 수 ' +
        '있으니 diagnostics 를 확인하세요.',
    );
  }
  if (borrowings.length === 0 && parseDiag.sections_found.includes('자금거래')) {
    notes.push(
      'ℹ️ 자금거래 절은 있으나 추출된 차입 건이 0건입니다 — 실제로 차입이 없거나("해당사항 없음"), ' +
        '표 구조가 실측 서식과 달라 파서가 못 읽은 것일 수 있습니다.',
    );
  }
  if (sourceIsCorrection) {
    notes.push('ℹ️ 정정 접수분(최신본)을 읽었습니다 — 원본이 아니라 정정 반영 내용 기준입니다.');
  }

  log.info('미공시 교차탐지 완료', {
    rcept_no: sourceRceptNo,
    borrowings: borrowings.length,
    goods: goods.length,
    candidates: totalCandidates,
    listCalls,
  });

  return {
    scope: {
      source_rcept_no: sourceRceptNo,
      source_viewer_url: viewerUrl(sourceRceptNo),
      ...(sourceReportNm ? { source_report_nm: sourceReportNm } : {}),
      ...(meta.acode ? { source_acode: meta.acode } : {}),
      ...(input.group ? { group: input.group, filing_year: filingYear } : {}),
      /** 거래내역이 속한 직전 사업연도 (12월 결산 가정) */
      fiscal_year: fiscalYear,
      judged_at: today,
    },
    summary: {
      capitals_extracted: capitals.length,
      borrowings_extracted: borrowings.length,
      goods_services_extracted: goods.length,
      undisclosed_candidates: undisclosed.length,
      j001_filing_exists: filingExists.length,
      below_threshold: below.length,
      not_judged: notJudged.length,
      goods_services_candidates: goodsCandidates.length,
      goods_services_filing_exists: goodsFilingExists.length,
      goods_services_not_judged: goodsNotJudged.length,
      goods_services_not_judgeable: goodsUnjudgeable.length,
    },
    /** 자금 차입 — 차입일 단위 대조라 신뢰도가 가장 높다 */
    undisclosed_candidates: undisclosed,
    j001_filing_exists: filingExists,
    below_threshold: below,
    ...(notJudged.length ? { not_judged: notJudged } : {}),
    /** 상품·용역 — 연간 합계 기반 제한적 신호 (quarterly_logic 참조) */
    goods_services_signals: [...goodsCandidates, ...goodsFilingExists, ...goodsNotJudged],
    ...(goodsUnjudgeable.length
      ? { goods_services_not_judgeable: goodsUnjudgeable }
      : {}),
    ...(joinFailures.length ? { join_failures: joinFailures } : {}),
    coverage: {
      transaction_types_checked: ['자금 차입 (차입일 단위)', '주요 상품·용역 (연간 합계, 4×기준금액 이상만)'],
      undetectable: {
        /** 매입회사×매도회사 매트릭스 표 (다중 페이지) — 파서 미구현 */
        matrix_tables: ['유가증권 거래 총괄', '상품·용역 매입/매출 총괄'],
        other_transaction_types: ['담보 제공·수취', '채무보증', '부동산 임대차', '출자·유상증자', '자금 대여(상대방 관점)'],
        /** "주요" 기준 미달로 J004 표에 실리지 않은 상품·용역 거래 */
        non_major_goods_services: true,
        /** J004 에 기재 자체가 누락된 거래 — 이 도구의 원천이 J004 하나뿐이다 */
        transactions_missing_from_j004: true,
      },
    },
    scope_caveats: scopeCaveats,
    notes,
    diagnostics: {
      parse: parseDiag,
      list_calls: listCalls,
      companies_searched: searches.size,
      companies_over_budget: overBudgetKeys.size,
      partial_results: partialLists,
      lookback_days: LOOKBACK_DAYS,
      lookahead_days: LOOKAHEAD_DAYS,
    },
  };
}
