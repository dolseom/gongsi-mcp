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
 *  ② 파싱 — 자금 차입(차입일 있음 = 높은 신뢰도) / 주요 상품·용역(연간 합계 = 제한적 신호) /
 *     유가증권 총괄 매트릭스(상대방별 연간 총액 — 고시 §4③상 개별 거래로 분해되지 않아 가장
 *     약한 신호. 총액이 기준 미만일 때 "개별도 미만"만 확실하다) / 자본
 *  ③ 회사별 기준금액 계산 — min(100억, max(5억, max(자본총계, 자본금)×5%))
 *     ⚠️ J004 자본은 "당해 사업연도말" 스냅샷이라 고시 §2③의 정확한 기준(주총 승인 최근
 *     사업연도말 자본총계 + 의결일 직전일 자본금)과 **시점이 다르다** — 근사치로만 쓴다.
 *     거래금액이 100억(령 §33①1호 상한) 이상이면 자본과 무관하게 확실하다.
 *  ④ 기준 초과 거래의 차입회사를 corp_code 로 조인 → 그 회사의 J001 목록을
 *     [거래일·사업연도초 −400일 ~ 오늘] 창으로 수집 → 해당 유형 공시가 하나도 없으면 **미공시 후보**,
 *     있으면 **건별 차입일 근접도**(−90~+30일)로 filing_near_date / filing_in_window_only 를 가른다
 *     — 창 전체에 공시 1건만 있어도 그 회사의 모든 차입이 "공시됨"으로 둔갑하는 것(부분 공시
 *     은폐 = 최악 방향의 거짓 안심)을 막기 위해서다 (교차검토 C-1).
 *
 * ★ 이 도구의 출력은 전부 "후보"다. 확정하면 안 되는 이유가 구조적으로 여럿 있다:
 *  - 이사회 의결은 **한도**로 미리 해 둘 수 있다 — 연초 한도 의결 공시 1건이 연중 여러 차입을
 *    커버한다. 검색창을 거래일 이전 400일까지 열지만 그 밖일 수 있다.
 *  - 상대방이 계열 금융회사면 약관특례(고시 §9, 트랙 B)로 분기 일괄공시에 실릴 수 있다.
 *  - 상품·용역 기준은 분기 합계액(§4③)인데 J004 는 연간 합계뿐이다 — (판매회사, 상대방) 연간
 *    합산이 ≥ 4×기준금액일 때만(비둘기집: 어느 분기 하나는 반드시 기준금액 이상) 신호로 쓴다.
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
  extractGroupName,
  extractMajorGoodsServices,
  diagnose,
  type FundBorrowing,
  type GoodsServiceRow,
} from '../parsers/j004-transactions.js';
import { extractGoodsServicesMatrix, extractSecuritiesMatrix } from '../parsers/j004-matrix.js';

/**
 * 이 매트릭스 열이 **국외 계열회사** 묶음인가 — 원문 그룹 헤더로만 판별한다.
 *
 * ★ 국외 계열회사와의 거래에는 대규모내부거래 공시의무가 **없다** (원문 3중 확인, 2026-09-04):
 *  - 법 §26① : "…에 속하는 국내 회사는 특수관계인(**국외 계열회사는 제외한다.** 이하 이 조에서
 *    같다)을 상대방으로 하거나 특수관계인을 위하여 …"
 *  - 고시 §2③2호 : "…특수관계인(**국외 계열회사는 제외한다.** 이하 이 호에서 같다)을 상대방으로
 *    하거나 …"
 *  - 공정위 공시 업무 매뉴얼(2026-04-27) : "공시대상회사와 공익법인이 해당 공시대상기업집단에
 *    속하는 국외 계열회사와 대규모내부거래 등을 하는 경우 이에 대한 **이사회 의결 및 공시의무
 *    없음**" (lit26-020)
 *
 * ⚠️ 회사명 모양(영문 상호 등)으로 추측하지 않는다 — 국내 법인도 영문 상호를 쓴다.
 * J004 (5) 총괄표가 열 묶음을 '국내계열사'/'해외계열사' 그룹 헤더로 스스로 구분하므로 그것만 쓴다.
 */
export function isForeignAffiliateColumn(colGroup: string): boolean {
  return /(해외|국외)계열/.test(colGroup.replace(/[\s ]+/g, ''));
}

/** 국외 계열회사 열로 분류한 신호에 붙이는 근거·한계 문구 (사용자에게 그대로 전달된다) */
function foreignAffiliateReason(colGroup: string): string {
  return (
    'not_applicable_foreign_affiliate — 원문 표가 이 열을 **국외(해외) 계열회사** 묶음으로 ' +
    `분류합니다(그룹 헤더: "${colGroup.replace(/\|+$/, '').replace(/\|/g, ' › ')}"). ` +
    '법 §26①은 "특수관계인(**국외 계열회사는 제외한다**. 이하 이 조에서 같다)"이라고 명시하고 ' +
    '고시 §2③2호도 같은 문언이며, 공정위 공시 업무 매뉴얼(2026-04-27)도 "국외 계열회사와 ' +
    '대규모내부거래 등을 하는 경우 이사회 의결 및 공시의무 없음"이라고 답합니다 — 따라서 ' +
    '미공시 후보가 아닙니다. ' +
    '⚠️ 다만 같은 매뉴얼은 "특수관계인이 발행한 주식 등을 **국외 계열회사를 통하여 간접적으로** ' +
    '매입하는 등 특수관계인을 **위한** 거래"에는 의무가 있다고 합니다 — 이 표는 상대방만 보여 ' +
    '그런 간접거래인지 구분하지 못하므로, 금액이 크면 거래 성격을 직접 확인하세요. ' +
    '또한 열 그룹은 병합 헤더를 왼쪽부터 이어받아 읽은 것이라 분류가 틀릴 수 있습니다'
  );
}
import { normalizeCompanyName } from '../parsers/md-table.js';
import { fetchJurirNo, type JurirNoFetch } from '../resolver/corp-index.js';
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

/**
 * 동명 1건을 확정하려고 기업개황을 조회할 **후보 수 상한**.
 * 후보가 이보다 많으면 대조하지 않고 ambiguous 로 남긴다 (한 이름이 콜을 독점하지 않게).
 */
const MAX_JURIR_CANDIDATES = 5;
/**
 * 이 도구 한 번의 실행에서 기업개황(법인등록번호) 조회 **총 상한** — 60초 벽 대비.
 * 결과는 캐시에 남으므로 다음 실행은 상한을 쓰지 않고도 조인된다.
 */
const MAX_JURIR_LOOKUPS = 20;

/** J001 검색을 수행할 회사 수 상한 — 회사당 측정 1 + 수집 1 콜이라 60초 벽 대비 */
const MAX_COMPANIES_TO_SEARCH = 20;
/** 거래일 이전으로 여는 검색창 (달력일) — 한도성 이사회 의결이 거래보다 훨씬 앞설 수 있다 */
const LOOKBACK_DAYS = 400;
/**
 * 건별 근접 대조 창 (달력일) — 공시(의결)는 통상 거래보다 앞서므로 앞을 넓게, 지연 공시를
 * 감안해 뒤를 좁게 연다. 실측: 160억 차입(2/19)의 공시는 2/14 접수 (−5일).
 */
const NEAR_BEFORE_DAYS = 90;
const NEAR_AFTER_DAYS = 30;
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
  /**
   * DART 기업개황으로 한 회사의 **법인등록번호**를 얻는다 (조회 1회 = API 콜 1회, 결과는 캐시).
   * 동명 2건 이상이라 이름으로 못 고르는 회사를 포털 `jurirno` 와 대조해 확정하는 데 쓴다.
   */
  fetchJurirNo: (corpCode: string) => Promise<JurirNoFetch>;
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
    fetchJurirNo: (corpCode) => fetchJurirNo(corpCode, client),
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

/** a − b 를 달력일 수로 (a 가 뒤면 양수) */
function daysBetween(a: string, b: string): number {
  const t = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  return Math.round((t(a) - t(b)) / 86_400_000);
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

/**
 * 자금 **대여** 거래를 커버할 수 있는 J001 보고서명인가 (대여회사 관점).
 *
 * 대규모내부거래 공시의무는 거래를 하는 계열회사 **각자에게** 있다 — 차입회사가
 * "특수관계인으로부터의 자금차입" 을 공시하는 것과 별개로, 자금을 대준 계열회사에는
 * "특수관계인에 대한 자금대여" 공시의무가 있다 (J001 ACODE 80719, 실측 보고서명
 * '특수관계인에대한자금대여'). 차입회사 쪽만 보면 대여회사의 미공시가 통째로 시야 밖이다.
 */
export function isLendingReport(reportNm: string): boolean {
  return normalizeReportNm(reportNm).includes('자금대여');
}

/**
 * 거래상대방 이름이 법인이 아니라 **자연인(동일인·친족)** 으로 보이는가 — 어디까지나
 * 이름 모양에 근거한 **추정**이다.
 *
 * 왜 필요한가: J004 §거래현황은 "계열회사와 **특수관계인**간 거래현황" 이라 자연인인
 * 동일인·친족이 거래상대방으로 실릴 수 있다. 자연인은 회사가 아니므로 J001 공시의무자가
 * 아니고, 그 이름으로 "대여회사 미공시 후보" 를 만들면 오경보다.
 *
 * 안전 방향: 이 추정이 틀려(짧은 상호의 실제 법인) 자연인으로 분류되더라도, 그 건은
 * 어차피 조인에 실패해 판정되지 않는 자리다 — 두 경우 모두 "판정하지 않음" 이므로
 * 오분류가 거짓 안심을 만들지 않는다. 그래서 호출부는 **조인·소속 확인이 모두 실패한
 * 뒤에만** 이 함수를 쓴다.
 */
export function looksLikeNaturalPerson(name: string): boolean {
  const n = name.replace(/[\s ]+/g, '');
  // 한글 2~4자만 (한국 성명 형태). 괄호·숫자·영문·법인격 표기가 섞이면 회사로 본다.
  if (!/^[가-힣]{2,4}$/.test(n)) return false;
  // 짧아도 조직임이 드러나는 어미는 제외한다
  return !/(회사|법인|재단|조합|은행|증권|보험|생명|화재|투자|공사|상사|산업|물산|건설|개발|기금|공단|협회|센터)$/.test(
    n,
  );
}

/** 상품·용역 거래를 커버할 수 있는 J001 보고서명인가 (변경 공시 포함) */
export function isGoodsServicesReport(reportNm: string): boolean {
  const n = normalizeReportNm(reportNm);
  return n.includes('상품') && n.includes('용역');
}

/**
 * 유가증권 거래를 커버할 수 있는 J001 보고서명인가.
 *
 * 넓게 잡는다 — 유가증권 거래는 서식이 여러 갈래이고(출자·유상증자참여·수익증권·채권·
 * 기타유가증권), 그중 상당수가 약관특례(고시 §9, 트랙 B)의 분기 일괄공시로 나간다.
 * 필터가 좁으면 정상 공시를 못 알아보고 **없는 미공시를 만들어낸다** — 이 신호는
 * 연간 총액 기반이라 애초에 약한 신호이므로, 오경보 억제 쪽으로 기울이고
 * 실제로 무엇에 걸렸는지는 `matching_filings` 로 그대로 보여준다.
 */
export function isSecuritiesReport(reportNm: string): boolean {
  const n = normalizeReportNm(reportNm);
  return [
    '유가증권',
    '수익증권',
    '출자',
    '유상증자',
    '채권',
    '사모사채',
    '단기금융상품',
    '주식',
  ].some((k) => n.includes(k));
}

/**
 * '[공시취소]' 접수분인가 — 취소 접수는 공시를 없앤 기록이지 공시가 존재한다는 근거가
 * 아니다 (교차검토 S-5). 취소된 원본 접수분은 목록에 별도 행으로 남으므로, 취소 행만
 * 근거에서 빼면 "원본은 있고 취소만 있는" 경우를 잘못 후보로 만들지 않는다.
 */
function isCancellationReport(reportNm: string): boolean {
  return normalizeReportNm(reportNm).includes('공시취소');
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
 * 정규화 동명이 **서로 다른 기준금액**으로 두 번 나오면 어느 쪽이 맞는지 알 수 없다 —
 * 둘 다 버리고 conflicts 로 보고한다 (첫 행 유지는 다른 회사의 자본을 쓰는 사고가 된다.
 * 교차검토 S-3).
 */
export function buildThresholdMap(capitals: ReturnType<typeof extractCapitals>): {
  map: Map<string, ApproxThreshold>;
  conflicts: string[];
} {
  const map = new Map<string, ApproxThreshold>();
  const conflicted = new Set<string>();
  for (const c of capitals) {
    if (c.totalEquity === null && c.paidInCapital === null) continue;
    const r = calcThreshold({
      ...(c.totalEquity !== null ? { totalEquity: c.totalEquity } : {}),
      ...(c.paidInCapital !== null ? { paidInCapital: c.paidInCapital } : {}),
    });
    if (!r) continue;
    const key = normalizeCompanyName(c.company);
    if (conflicted.has(key)) continue;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { value: r.threshold, formula: r.formula, source_row: c.company });
      continue;
    }
    // 같은 이름·같은 값이면 중복 행일 뿐이다 (표가 금융/비금융으로 갈릴 때) — 유지
    if (prev.value !== r.threshold) {
      map.delete(key);
      conflicted.add(key);
    }
  }
  return { map, conflicts: [...conflicted] };
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

type TxStatus =
  | 'undisclosed_candidate'
  /**
   * 상품·용역 전용 — J001 이 없어 후보이나, 공시의무의 전제(상대방이 동일인·친족 20%↑ 출자
   * 계열회사 또는 그 자회사 — 법 §26①4호·령 §33②·고시 §4①4호)를 확인할 데이터가 없다.
   * 요건 미충족 상대방과의 거래는 애초에 공시대상이 아니므로 "미공시 후보"로 단정하면
   * 오경보다 (Codex 4차 C1). 동일인이 법인인 집단은 이 유형의 의무 자체가 없다.
   */
  | 'candidate_if_counterparty_qualified'
  /** 차입일 근방(−90~+30일)에 같은 유형 공시가 있다 — 내용 대조는 아니다 */
  | 'j001_filing_near_date'
  /** 창 안 어딘가에만 있다 — 한도 의결 커버일 수도, 부분 공시 누락일 수도 있다 */
  | 'j001_filing_in_window_only'
  /** 날짜 개념이 없는 신호(상품·용역)의 존재 확인 */
  | 'j001_filing_exists'
  | 'below_threshold'
  /** 계열편입일 이전 거래 — 편입 전에는 공시의무가 없다 (포털 소속회사 목록을 불러온 경우) */
  | 'no_duty_before_joining'
  | 'not_judged';

/**
 * 대여회사(자금을 대준 계열회사) 관점의 판정 어휘.
 * 차입회사 쪽 어휘(TxStatus)를 그대로 쓰되, 상대방을 회사로 특정하지 못하는 두 경우를 더한다.
 */
type LenderStatus =
  | 'undisclosed_candidate'
  | 'j001_filing_near_date'
  | 'j001_filing_in_window_only'
  | 'below_threshold'
  | 'no_duty_before_joining'
  | 'not_judged'
  /** 상대방 이름을 DART corp_code 로 잇지 못했다 — 조회 자체가 불가능 */
  | 'counterparty_not_joined'
  /** 상대방이 자연인(동일인·친족)으로 **추정**된다 — 회사가 아니면 J001 의무자가 아니다 */
  | 'counterparty_not_company';

/**
 * 한 차입 건의 **대여회사 쪽** 공시의무 대조 결과.
 * 기준금액은 대여회사 자신의 자본으로 계산한다 (같은 J004 재무현황 표).
 */
interface LenderSide {
  /** 대여회사 = 이 차입 건의 거래상대방 */
  company: string;
  corp_code?: string;
  status: LenderStatus;
  reason?: string;
  threshold?: {
    value: number;
    value_display: string;
    formula: string;
    source_row: string;
  };
  certainty?: Certainty;
  joined_group_at?: string;
  j001_search?: { from: string; to: string; type_filter: string };
  matching_filings?: FilingRef[];
  matching_filings_total?: number;
  nearest_filing_gap_days?: number;
  same_counterparty_annual_total?: number;
  same_counterparty_annual_total_display?: string;
  cancellations_of_type_in_window?: number;
  search_partial?: boolean;
  other_j001_in_window?: number;
}

/**
 * 거래 **상대방 쪽** 공시의무 대조 결과 — 상품·용역의 매입회사, 유가증권의 매도회사.
 *
 * ★ 근거 (공정위 공시 업무 매뉴얼 2026-04-27 lit26-001): "거래규모가 거래당사자 **모두에게**
 * 대규모내부거래에 해당되는 경우 이사회 의결 및 공시의무는 **거래당사자 모두에게** 있음.
 * 만일 거래규모가 일방당사자에게만 해당되는 경우에는 해당되는 거래당사자에게만 있음."
 * → 기준금액을 **각자의 자본**으로 계산해 따로 판정한다 (차입의 lender_side 와 같은 원리).
 *
 * ⚠️ 상품·용역은 여기에 더해 **상대방 요건**이 걸린다 — 각 당사자의 의무는 *그 상대방*이
 * 동일인·친족 20%↑ 출자 계열회사인지에 달렸다(고시 §4①4호, 매뉴얼 lit26-065·066 실례).
 * 지분을 확인할 수 없으므로 양쪽 모두 candidate_if_counterparty_qualified 에 머문다.
 *
 * 날짜 개념이 없는 표(연간 총액)라 건별 근접 대조는 하지 않는다 — 존재 확인까지만 한다.
 */
interface CounterpartySide {
  /** 이 관점의 공시의무자 = 원래 신호의 거래상대방 (매입회사 또는 매도회사) */
  company: string;
  corp_code?: string;
  status:
    | 'candidate_if_counterparty_qualified'
    | 'candidate_aggregate_only'
    | 'j001_filing_exists'
    | 'below_threshold'
    | 'not_judged'
    /** 상대방을 DART corp_code 로 잇지 못했다 — 조회 자체가 불가능 */
    | 'counterparty_not_joined'
    /** 상대방이 자연인(동일인·친족)으로 **추정**된다 — 회사가 아니면 J001 의무자가 아니다 */
    | 'counterparty_not_company';
  reason?: string;
  threshold?: { value: number; value_display: string; formula: string; source_row: string };
  certainty?: Certainty;
  /** 상품·용역 전용 — 연간 총액이 이 회사 기준금액의 4배 이상이면 비둘기집이 선다 */
  quarterly_logic?: GoodsMatrixSignal['quarterly_logic'];
  /** 상품·용역 전용 — 상대방(= 원래 신호의 판매회사) 지분 요건을 확인하지 못했다 */
  counterparty_qualification?: 'not_verified';
  j001_search?: { from: string; to: string; type_filter: string };
  matching_filings?: FilingRef[];
  matching_filings_total?: number;
  cancellations_of_type_in_window?: number;
  search_partial?: boolean;
  other_j001_in_window?: number;
}

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
  joined_group_at?: string;
  j001_search?: { from: string; to: string; type_filter: string };
  matching_filings?: FilingRef[];
  /** matching_filings 가 10건에서 잘렸을 때의 전체 건수 */
  matching_filings_total?: number;
  /** 가장 가까운 같은 유형 공시와의 일수 차 (공시 접수일 − 차입일. 음수 = 공시가 앞) */
  nearest_filing_gap_days?: number;
  /**
   * 같은 상대방과의 연간 차입 합산 (원). 개별 건이 기준 미달이어도 §4③(동일 거래상대방·
   * 동일 거래대상 기준 판단)에 따라 합산 기준으로 공시대상일 수 있다 (Codex 4차 C2).
   */
  same_counterparty_annual_total?: number;
  same_counterparty_annual_total_display?: string;
  /** 창 안의 같은 유형 '[공시취소]' 접수분 수 — 매칭 공시가 취소된 원공시일 수 있다 */
  cancellations_of_type_in_window?: number;
  search_partial?: boolean;
  other_j001_in_window?: number;
  other_j001_sample?: FilingRef[];
  /** 자금을 대준 계열회사 쪽의 "자금대여" 공시의무 대조 (거래 한 건에 의무자가 둘이다) */
  lender_side?: LenderSide;
}

interface GoodsItem {
  item: string;
  annual_amount: number;
  annual_amount_display: string;
  label: string;
}

/**
 * (판매회사, 거래상대방) 연간 합산 단위의 상품·용역 신호.
 * §4③2호의 판정 단위는 상대방별 분기 합계이지 품목별이 아니다 — 품목 행 단위로 판정하면
 * 같은 상대방에게 품목 A 30억 + B 15억(합계 45억, 4×기준 40억)인 케이스가 각각 미달로
 * 빠져 탐지 가능한 신호가 유실된다 (교차검토 M-4).
 */
interface GoodsSignal {
  company: string;
  corp_code?: string;
  counterparty: string;
  /** 어느 표에서 왔는가 — (6) 주요 내역은 품목·금액이 명시된 강한 원천이다 */
  source: '(6)주요내역';
  annual_amount_total: number;
  annual_amount_total_display: string;
  items: GoodsItem[];
  threshold?: { value: number; value_display: string; formula: string; source_row: string };
  certainty?: Certainty;
  /** 연간 합산 ≥ 4×기준금액 ⇒ 어느 분기 하나는 반드시 기준금액 이상 (비둘기집 논증) */
  quarterly_logic:
    | 'annual_geq_4x_threshold'
    | 'annual_below_4x_threshold'
    | 'threshold_unknown';
  status?: TxStatus;
  reason?: string;
  /**
   * 상품·용역 공시의무는 상대방이 동일인(자연인)·친족 합계 20%↑ 출자 계열회사(또는 그
   * 상법 §342의2 자회사)일 때만 성립한다(법 §26①4호·령 §33②·고시 §4①4호·§2④) —
   * 이 도구는 지분 데이터가 없어 그 요건을 확인하지 못한다.
   */
  counterparty_qualification?: 'not_verified';
  j001_search?: { from: string; to: string; type_filter: string };
  matching_filings?: FilingRef[];
  matching_filings_total?: number;
  cancellations_of_type_in_window?: number;
  search_partial?: boolean;
  other_j001_in_window?: number;
  /** 매입(구매)회사 쪽 의무 — 거래 한 건에 의무자가 둘이다 (매뉴얼 lit26-001) */
  buyer_side?: CounterpartySide;
}

/**
 * 계열회사 간 유가증권 거래 신호 — J004 총괄 **매트릭스**의 (매입회사, 매도회사) 한 칸.
 *
 * ⚠️ 이 신호의 한계를 status 이름에 박아 둔다: 값이 **직전 사업연도 1년 총액**이고
 * 개별 거래 건으로 분해되지 않는다. 고시 §4③은 유가증권 거래의 해당 여부를
 * "동일 거래상대방과의 **동일 거래대상**에 대한 거래행위" 기준으로 판단하므로,
 * 연간 총액이 기준금액 이상이어도 거래대상별로 쪼개면 전부 기준 미만일 수 있다 —
 * 상품·용역의 비둘기집 논증(연간 ≥ 4×기준 ⇒ 어느 분기 하나는 반드시 초과)이
 * **여기서는 성립하지 않는다.** 반대 방향은 확실하다: 연간 총액이 기준 미만이면
 * 그 상대방과의 어떤 개별 거래도 기준 미만이다.
 */
interface SecuritySignal {
  /** 매입회사 (매트릭스 행) — 이 회사의 J001 을 대조한다 */
  company: string;
  corp_code?: string;
  /** 매도회사 (매트릭스 열) */
  counterparty: string;
  /** 직전 사업연도 1년 합계 (원) */
  annual_amount: number;
  annual_amount_display: string;
  threshold?: { value: number; value_display: string; formula: string; source_row: string };
  certainty?: Certainty;
  /**
   * 거래상대방 이름이 이 문서의 회사 목록(재무현황·포털 소속회사·매트릭스 행)에서
   * 확인되지 않았다. 같은 회사의 표기 흔들림일 수도, 국외 계열사일 수도 있다 —
   * 판정에서 빼지는 않되 상대방 확인이 필요함을 알린다.
   */
  counterparty_in_known_list?: false;
  /** 원문이 이 열을 국외(해외) 계열회사로 분류했는가 — 판정 근거를 사용자가 보게 남긴다 */
  column_group?: string;
  status?:
    | 'below_threshold'
    | 'candidate_aggregate_only'
    | 'j001_filing_exists'
    /** 국외 계열회사 상대 거래 — 법 §26①·고시 §2③2호가 특수관계인에서 제외한다 */
    | 'not_applicable_foreign_affiliate'
    | 'not_judged';
  reason?: string;
  j001_search?: { from: string; to: string; type_filter: string };
  matching_filings?: FilingRef[];
  matching_filings_total?: number;
  cancellations_of_type_in_window?: number;
  search_partial?: boolean;
  other_j001_in_window?: number;
  /** 매도회사 쪽 의무 — 유가증권은 상대방 지분 요건이 없어 각자의 기준금액만 본다 */
  seller_side?: CounterpartySide;
}

/**
 * 상품·용역 **총괄표 (5)** 의 (매출회사, 매입회사) 한 칸 — (6) 주요 내역에 없는 쌍의 보완 신호.
 *
 * 왜 필요한가: 판정의 주 원천인 (6) '주요 상품ㆍ용역거래 **내역**' 은 서식 설명 그대로
 * "거래한 금액이 **일정 규모 이상**인 경우"만 싣는다. 그 규모 기준은 우리가 계산하는
 * 기준금액(령 §33①)과 다르므로, **(6)에 없는데 공시대상인 쌍**이 존재할 수 있다.
 * (5) 총괄표는 같은 문서 안에서 **전 쌍**을 담으므로 그 구멍을 메운다.
 *
 * ⚠️ 다만 (5)는 상대방별 **연간 총액**뿐이다. 상품·용역의 기준금액 판단 단위는 §4③2호상
 * **분기 합계액**이라, 연간 총액이 기준 이상이라고 해서 어느 분기가 기준을 넘었다고 단정할 수
 * 없다. 비둘기집 논증(연간 ≥ 4×기준 ⇒ 네 분기가 전부 미만일 수는 없다)이 성립할 때만
 * (6) 경로와 같은 강도의 후보로 올리고, 그 미만은 `candidate_aggregate_only`(확인 대상)다.
 * 반대 방향(연간 총액 < 기준 ⇒ 어느 분기도 미달)은 확실하므로 below_threshold 로 확정한다.
 *
 * ⚠️ (5)에는 (6)과 달리 **품목이 없다.** 실측(미래에셋 20260819000341)상 (5)에는 배당금수익이
 * 실리지 않지만, 품목을 볼 수 없으므로 item_caveat(배당·이자·임대차 분리)을 적용하지 못한다.
 */
interface GoodsMatrixSignal {
  /** 매출회사 (매트릭스 행) — 이 회사의 J001 을 대조한다 */
  company: string;
  corp_code?: string;
  /** 매입회사 (매트릭스 열) */
  counterparty: string;
  source: '(5)총괄';
  /** 직전 사업연도 1년 합계 (원) */
  annual_amount: number;
  annual_amount_display: string;
  threshold?: { value: number; value_display: string; formula: string; source_row: string };
  certainty?: Certainty;
  /**
   * 연간 총액과 기준금액의 관계. `annual_geq_4x_threshold` 만 비둘기집 논증이 성립한다.
   * `annual_geq_threshold` 는 "연간 총액은 넘었으나 분기 하한을 알 수 없음" 이다.
   */
  quarterly_logic:
    | 'annual_geq_4x_threshold'
    | 'annual_geq_threshold'
    | 'annual_below_threshold'
    | 'threshold_unknown';
  /** 거래상대방 이름이 이 문서·포털의 회사 목록에서 확인되지 않았다 (표기 흔들림·국외 계열사 등) */
  counterparty_in_known_list?: false;
  /**
   * (6) 주요 내역에 **같은 매출회사·같은 금액**의 행이 다른 상대방 이름으로 있다 —
   * 두 표가 같은 회사를 다르게 적은 같은 거래일 가능성이 높다는 표시다 (실물에서 확인:
   * (6) '미래에셋생명(주)' vs (5) '미래에셋 생명보험(주)'). 버리지 않고 표시만 한다.
   */
  possible_duplicate_of_major_detail?: {
    major_detail_counterparty: string;
    amount_display: string;
    note: string;
  };
  /** (6) 주요 내역과 같은 상대방 요건 미확인 한계가 그대로 적용된다 */
  counterparty_qualification?: 'not_verified';
  /** (5)만의 한계를 사용자에게 그대로 전달한다 */
  caveat: string;
  /** 원문이 이 열을 국외(해외) 계열회사로 분류했는가 — 판정 근거를 사용자가 보게 남긴다 */
  column_group?: string;
  status?:
    | 'candidate_if_counterparty_qualified'
    | 'candidate_aggregate_only'
    | 'j001_filing_exists'
    | 'below_threshold'
    /** 국외 계열회사 상대 거래 — 법 §26①·고시 §2③2호가 특수관계인에서 제외한다 */
    | 'not_applicable_foreign_affiliate'
    | 'not_judged';
  reason?: string;
  j001_search?: { from: string; to: string; type_filter: string };
  matching_filings?: FilingRef[];
  matching_filings_total?: number;
  cancellations_of_type_in_window?: number;
  search_partial?: boolean;
  other_j001_in_window?: number;
  /** 매입(구매)회사 쪽 의무 — 거래 한 건에 의무자가 둘이다 (매뉴얼 lit26-001) */
  buyer_side?: CounterpartySide;
}

/** 품목 성격상 미공시 후보 경로에서 제외한 행 — 합산에도 넣지 않는다 (배당이 합계를 부풀린다) */
interface GoodsCaveatRow {
  company: string;
  counterparty: string;
  item: string;
  annual_amount: number;
  annual_amount_display: string;
  item_caveat: string;
  threshold?: { value: number; value_display: string; formula: string; source_row: string };
  certainty?: Certainty;
  quarterly_logic: GoodsSignal['quarterly_logic'];
  /** 회사가 다른 신호로 이미 검색된 경우에 한해, 참고용 J001 존재 정보를 동봉 (교차검토 S-9) */
  related_j001?: { goods_type_filings_in_window: number; from: string; to: string };
}

/**
 * 상품·용역 거래의 대가가 아닐 가능성이 높은 품목 (교차검토 S-6 확장).
 * 실측(미래에셋 실물): J004 상품·용역 표에 "배당금수익" 이 실려 있다 — 배당은 주주 지위에 따른
 * 이익 분배이지 법 §26①의 거래유형(자금·유가증권·자산·상품용역) 어디에도 해당하지 않으므로,
 * 이를 미공시 후보로 올리면 오경보다. 단정하지 않고 별도 바구니로 분리한다.
 */
export function itemLikelyNotGoodsService(item: string): string | null {
  // 키워드가 품목의 **어미(성격 서술부)**일 때만 분리한다 — '배당전산시스템 구축용역' 같은
  // 진짜 용역을 부분문자열 일치로 빼면 합산이 줄어 후보 판정이 통째로 빠진다 (Codex 4차 M6).
  const n = item.replace(/[\s ]+/g, '');
  if (/배당(금)?(수익|수입)?$/.test(n)) {
    return (
      '품목이 "배당" 성격입니다 — 배당금은 주주 지위에 따른 이익 분배로, 대규모내부거래의 ' +
      '상품·용역 거래에 해당하지 않을 가능성이 높습니다. 공시 대상 여부를 별도로 판단하세요'
    );
  }
  if (/이자(수익|수입|비용)?$/.test(n)) {
    return (
      '품목이 "이자" 성격입니다 — 이자는 자금거래의 과실(대가)로, 상품·용역 거래가 아닐 ' +
      '가능성이 높습니다. 원본 자금 차입·대여의 공시 여부를 자금거래 쪽에서 별도로 확인하세요'
    );
  }
  if (/(임대|임차)(료)?$/.test(n)) {
    return (
      '품목이 임대차 성격일 수 있습니다 — 부동산 임대차는 상품·용역이 아니라 자산 거래 유형' +
      '(고시 §4①3호)으로 공시되므로, 이 도구의 상품·용역 보고서명 필터로는 그 공시를 ' +
      '찾지 못합니다. 공시가 실제로 있는지는 J001 부동산·자산 유형 공시에서 별도로 확인하세요'
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
  /** 포털 소속회사 목록을 실제로 불러왔는가 (rcept_no 경로는 문서의 기업집단명으로 시도한다) */
  let populationSource: 'portal' | 'none' = 'none';
  let populationGroup: string | null = null;
  let populationYearMonth: string | null = null;
  let populationReason: string | null = null;
  let filingYear: number;

  if (input.group) {
    const year = input.year ?? Number(today.slice(0, 4));
    filingYear = year;
    // 포털 스냅샷은 매년 5/1 기준 — 점검 연도의 5월로 맞춘다 (audit_periodic 과 같은 이유)
    populationYearMonth = `${year}05`;
    population = await deps.resolvePop({ group: input.group, year_month: populationYearMonth });
    populationSource = 'portal';
    populationGroup = input.group;

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

  // today 가 원천 문서 접수일보다 앞서면 창이 통째로 어긋난다 — 오타를 잡는다 (교차검토 S-1)
  const sourceFiledYmd = sourceRceptNo.slice(0, 8);
  if (today < sourceFiledYmd) {
    throw new ToolError(
      'invalid_argument',
      `today(${today})가 원천 J004 접수일(${sourceFiledYmd})보다 앞섭니다 — ` +
        'today 오타이거나 rcept_no 가 잘못 지정됐습니다.',
    );
  }

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

  // ── ①-b rcept_no 경로: 문서가 밝힌 기업집단명으로 포털 소속회사 목록을 불러온다 ──
  //
  // 종전에는 rcept_no 경로에 모집단 자체가 없어 조인이 "DART 상호 완전일치" 한 갈래뿐이었다.
  // 그 결과 ① 동명 비계열 회사로 오조인될 위험을 걸러내지 못하고 ② 계열편입일(편입 전 거래는
  // 의무 없음) 대조를 못 하며 ③ 유가증권 매트릭스의 거래상대방이 계열사인지 확인할 목록이
  // 재무현황 표뿐이었다. 문서 표지의 '기업집단명' 행 하나면 group 경로와 같은 모집단을 쓸 수 있다.
  //
  // ★ 실패는 전부 폴백이다 — EGROUP 키가 없어도(README 약속: DART 키 하나면 동작) 집단명을
  //   못 읽어도 포털이 죽어도, 종전 동작(DART 상호 매칭)으로 조용히 되돌아가고 사유만 남긴다.
  if (!input.group) {
    const docGroup = extractGroupName(markdown);
    if (!docGroup) {
      populationReason =
        'group_name_not_found — 문서에서 "기업집단명" 행을 찾지 못했습니다 (서식 변형 가능)';
    } else {
      // group 경로와 같은 규칙: 포털 스냅샷은 매년 5/1 기준이고 연1회 J004 기한은 5/31이라,
      // **그 문서가 제출된 해의 5월** 스냅샷이 문서 시점의 소속 상태에 가장 가깝다.
      populationYearMonth = `${filingYear}05`;
      try {
        population = await deps.resolvePop({
          group: docGroup,
          year_month: populationYearMonth,
        });
        populationSource = 'portal';
        populationGroup = docGroup;
      } catch (err) {
        population = null;
        populationYearMonth = null;
        populationReason =
          `portal_unavailable — 문서의 기업집단명 '${docGroup}' 으로 포털 소속회사 목록을 ` +
          `불러오지 못했습니다 (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`;
      }
    }
    if (populationSource === 'portal') {
      notes.push(
        `ℹ️ 문서의 기업집단명('${populationGroup}')으로 포털 소속회사 목록(${populationYearMonth} 기준, ` +
          `조인 ${population!.corpCodes.size}개사·미조인 ${population!.unjoined.length}개사)을 불러와 ` +
          '회사명 조인과 계열사 확인에 사용했습니다.',
      );
    } else {
      notes.push(
        `ℹ️ 포털 소속회사 목록 없이 DART 상호 완전일치만으로 조인했습니다 (${populationReason}) — ` +
          '동명 비계열 회사 오조인·계열편입일 대조 불가 등 조인 품질이 낮습니다. ' +
          'group 경로로 호출하면 같은 문서를 포털 목록과 함께 점검합니다.',
      );
    }
  }

  // ── ② 파싱 ──
  const parseDiag = diagnose(markdown);
  const capitals = extractCapitals(markdown);
  const borrowings = extractFundBorrowings(markdown);
  const goods = extractMajorGoodsServices(markdown);
  // 유가증권 총괄 매트릭스. 집계 열('소계'·'계'·'국내 매출액' 등)이 거래상대방으로 새면
  // **없는 거래**가 후보로 오르므로, 이름 블랙리스트에 더해 회사명 화이트리스트를 2차 방어선으로
  // 준다. 화이트리스트는 ① 재무현황 표의 계열사 ② (group 경로면) 포털 소속회사
  // ③ 매트릭스 자신의 **행** 회사 — 행은 집계 행이 이미 제거돼 있어 회사만 남는다.
  const securitiesSeed = extractSecuritiesMatrix(markdown);
  // 상품·용역 **총괄** 매트릭스 (5). (6) '주요 내역' 은 일정 규모 이상만 실리므로 그것만 보면
  // 규모 미달로 빠진 공시대상 쌍을 못 본다 — (5)는 전 쌍을 담아 그 구멍을 메운다.
  // 화이트리스트는 유가증권과 같은 이유로 **필터가 아니다** (표기 흔들림으로 진짜 거래가
  // 사라지는 쪽이 더 위험하다). 집계 열 방어는 파서의 isAggregateLabel 이 맡는다.
  const goodsMatrixSeed = extractGoodsServicesMatrix(markdown);

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
  if (parseDiag.rows_amount_unparsable > 0) {
    notes.push(
      `⚠️ 거래상대방은 있는데 금액을 읽지 못한 행이 ${parseDiag.rows_amount_unparsable}건 있습니다 ` +
        "(각주 '16,000 (주1)'·무액 '-' 표기 등 — 실물에서 '-' 기재 실측됨) — 금액을 추측하지 " +
        '않으므로 그 거래는 **점검되지 않았습니다**. 원문(source_viewer_url)에서 해당 행을 직접 확인하세요.',
    );
  }
  if (parseDiag.rows_company_equals_counterparty > 0) {
    notes.push(
      `⚠️ 회사와 거래상대방이 같은 이름으로 읽힌 행이 ${parseDiag.rows_company_equals_counterparty}건 ` +
        '있습니다 — 표 열 배치가 실측 서식과 달라 열을 오인했을 수 있어 그 행은 쓰지 않았습니다. ' +
        '원문 확인이 필요합니다.',
    );
  }

  // ── ③ 회사별 기준금액 (근사) ──
  const { map: thresholds, conflicts: thresholdConflicts } = buildThresholdMap(capitals);
  if (thresholdConflicts.length > 0) {
    notes.push(
      `⚠️ 재무현황 표에 정규화 동명인데 자본이 다른 이름이 ${thresholdConflicts.length}건 있어 ` +
        `기준금액 계산에서 제외했습니다 (${thresholdConflicts.join(', ')}) — 해당 회사의 100억 미만 ` +
        '거래는 threshold_unknown 으로 남습니다.',
    );
  }

  // group 경로 조인 맵 — 같은 정규화 이름이 서로 다른 corp_code 로 두 번 나오면 조인하지 않는다
  const popByName = new Map<string, string>();
  const popNameConflicts = new Set<string>();
  if (population) {
    for (const [code, name] of population.corpCodes) {
      const key = normalizeCompanyName(name);
      const prev = popByName.get(key);
      if (prev !== undefined && prev !== code) {
        popByName.delete(key);
        popNameConflicts.add(key);
        continue;
      }
      if (!popNameConflicts.has(key)) popByName.set(key, code);
    }
  }

  // ── ③-b 회사명 → corp_code 조인 ──
  // ① 집단 소속회사(포털 이름) 정규화 매칭 ② DART 법인 인덱스 상호 완전일치.
  // ★ ② 폴백으로 찾은 corp_code 가 집단 목록 어디에도 없으면 **비계열 동명 회사일 수 있다** —
  // 그 회사의 J001 로 filing_exists 를 만들면 오조인이 거짓 안심으로 직결되므로 조인 실패로
  // 처리한다 (Codex 4차 M7). 포털 목록을 못 불러온 경우(population === null)에는 이 검증이
  // 불가능하다 — scope_caveats 로 밝힌다.
  //
  // 판정 순서상 **차입 판정보다 앞에** 둔다: 대여회사 쪽 의무를 판정하려면 검색 예산을 짜기
  // 전에 상대방이 조인되는 계열회사인지 알아야 한다.
  const joinFailures: Array<{ company: string; reason: string }> = [];
  /** 기업개황(법인등록번호) 조회 횟수 — 예산 상한 대비 */
  let jurirLookups = 0;
  /** 동명 2건 이상을 법인등록번호로 확정한 건 — 근거를 진단에 남긴다 */
  const jurirResolved: Array<{
    company: string;
    corp_code: string;
    jurir_no: string;
    candidates: number;
  }> = [];
  // 포털이 소속을 보증하는 이름들 — jurir 미조인이라 corp_code 는 없지만 계열사임은 확실하다
  const popUnjoinedKeys = new Set(
    (population?.unjoined ?? []).map((n) => normalizeCompanyName(n)),
  );
  /** 포털이 소속을 보증하는 이름인가 (조인분·미조인분 모두) */
  function isKnownAffiliateName(rawName: string): boolean {
    if (population === null) return false;
    const key = normalizeCompanyName(rawName);
    return popByName.has(key) || popNameConflicts.has(key) || popUnjoinedKeys.has(key);
  }
  /** 이 문서 재무현황 표(계열회사별 자본)에 실린 이름 — 자본을 못 읽은 행도 포함한다 */
  const capitalNameKeys = new Set(capitals.map((c) => normalizeCompanyName(c.company)));
  /**
   * 이름의 주인이 **회사임이 문서·포털로 확인되는가.**
   * corp_code 조인과는 독립이다 — 조인은 DART 인덱스 캐시 사정으로도 실패하지만,
   * 재무현황 표(계열회사별 자본)나 포털 소속회사 목록에 실린 이름은 그 자체로 계열 '회사'다.
   */
  function isConfirmedCompanyName(rawName: string): boolean {
    return isKnownAffiliateName(rawName) || capitalNameKeys.has(normalizeCompanyName(rawName));
  }
  function verifyMembership(code: string, rawName: string): { code?: string; reason?: string } {
    if (population === null) return { code };
    if (population.corpCodes.has(code)) return { code };
    // 미조인 계열사: 포털 소속 목록에 같은 이름이 있고 DART 완전일치가 유일하면 그 회사다
    // (동명 법인이 실존하면 findCorps 가 2건 이상을 돌려줘 여기 오기 전에 거부된다)
    if (popUnjoinedKeys.has(normalizeCompanyName(rawName))) return { code };
    return {
      reason:
        'dart_join_unverified — DART 에 상호가 일치하는 회사는 있으나 집단 소속회사 목록 ' +
        '어디에도 없습니다. 비계열 동명 회사일 수 있어 그 회사의 공시로 판정하지 않습니다 ' +
        '(실제 계열사라면 resolve_entity(fetchJurirNo=true) 로 조인 캐시를 채우세요)',
    };
  }
  /** 포털이 계열사로 확인해 준 이름인데 DART 쪽에서 못 이은 경우의 안내를 덧붙인다 */
  function withAffiliateHint(rawName: string, reason: string): string {
    if (!isKnownAffiliateName(rawName)) return reason;
    return (
      `${reason}. 다만 이 이름은 포털 소속회사 목록에 있는 **계열회사**입니다 — ` +
      'resolve_entity(fetchJurirNo=true) 로 법인등록번호 조인 캐시를 채우면 대조할 수 있습니다'
    );
  }
  /**
   * DART 상호 동명 2건 이상을 **법인등록번호로** 확정한다 (이름으로는 못 고른다).
   *
   * 이 프로젝트의 원래 조인 설계가 법인등록번호 직접 조인이다 — 포털은 한글 음차,
   * DART 는 영문 약어라 이름 매칭이 성립하지 않기 때문이다. 포털 소속회사 목록에 그 회사의
   * `jurirno` 가 있으므로, 후보들의 기업개황 `jurir_no` 를 받아 대조하면 **추측 없이** 하나로
   * 좁혀진다 (실측: 미래에셋증권은 DART 상호 동명 2건이라 이 경로가 없으면 영원히 미조인).
   *
   * ★ 정확히 1건 일치일 때만 확정한다. 0건이면 후보 중에 그 계열사가 없다는 뜻이고,
   *   2건 이상이면 같은 법인등록번호에 corp_code 가 여럿이라는 뜻이라 어느 쪽도 고르지 않는다.
   * ★ 조회 실패(error)를 "불일치"로 뭉개지 않는다 — 실패 건수를 사유에 남긴다.
   */
  async function disambiguateByJurirNo(
    rawName: string,
    hits: Array<{ corpCode: string; corpName: string }>,
  ): Promise<{ code?: string; reason?: string }> {
    const key = normalizeCompanyName(rawName);
    const list = hits.map((h) => `${h.corpName}(${h.corpCode})`).join(', ');
    const ambiguous = (extra: string): { reason: string } => ({
      reason: withAffiliateHint(rawName, `동명 법인 ${hits.length}건 [${list}] — ${extra}`),
    });

    const portalJurir = population?.jurirNoByName?.get(key);
    if (!portalJurir) {
      return ambiguous(
        population === null
          ? '자동 선택하지 않습니다 (포털 소속회사 목록이 없어 법인등록번호로 확정할 수 없습니다 — ' +
              'group 경로로 호출하면 대조합니다)'
          : '자동 선택하지 않습니다 (포털 소속회사 목록에서 이 이름의 법인등록번호를 찾지 못했습니다 — ' +
              '표기가 다르거나 포털에도 동명이 있습니다)',
      );
    }
    if (hits.length > MAX_JURIR_CANDIDATES) {
      return ambiguous(
        `후보가 상한 ${MAX_JURIR_CANDIDATES}개를 넘어 법인등록번호를 대조하지 않았습니다`,
      );
    }
    if (jurirLookups + hits.length > MAX_JURIR_LOOKUPS) {
      return ambiguous(
        `법인등록번호 조회 예산(${MAX_JURIR_LOOKUPS}회)을 넘어 대조하지 않았습니다 — ` +
          'resolve_entity(fetchJurirNo=true) 로 미리 캐시를 채우면 대조합니다',
      );
    }

    const matched: Array<{ corpCode: string; corpName: string }> = [];
    let failures = 0;
    for (const h of hits) {
      jurirLookups++;
      const r = await deps.fetchJurirNo(h.corpCode);
      if (r.status === 'ok') {
        if (r.jurirNo === portalJurir) matched.push(h);
      } else if (r.status === 'error') {
        failures++;
      }
      // 'absent' = 확인된 부재 — 이 후보는 그 계열사가 아니다
    }
    if (matched.length === 1) {
      jurirResolved.push({
        company: rawName,
        corp_code: matched[0]!.corpCode,
        jurir_no: portalJurir,
        candidates: hits.length,
      });
      // 법인등록번호 일치는 소속 검증(verifyMembership)보다 강한 근거다 — 포털이 그 번호를
      // 이 집단 소속회사로 싣고 있으므로 비계열 동명 회사일 수 없다.
      return { code: matched[0]!.corpCode };
    }
    return ambiguous(
      `법인등록번호(${portalJurir}) 일치 ${matched.length}건` +
        (failures > 0 ? `·조회 실패 ${failures}건` : '') +
        ' — 정확히 1건일 때만 확정합니다',
    );
  }

  async function joinCorpCodeUncached(
    rawName: string,
  ): Promise<{ code?: string; reason?: string }> {
    const key = normalizeCompanyName(rawName);
    if (popNameConflicts.has(key)) {
      // 포털 목록 안에서조차 동명이라 어느 쪽인지 알 수 없다 — DART 완전일치로만 재시도
      const exactOnly = deps.findCorps(rawName.trim());
      if (exactOnly.length === 1) return verifyMembership(exactOnly[0]!.corpCode, rawName);
      return { reason: '집단 소속회사 목록에 정규화 동명 2건 이상 — 자동 선택하지 않습니다' };
    }
    const fromPop = popByName.get(key);
    if (fromPop) return { code: fromPop };
    // 이름 변형을 순서대로 시도한다.
    // ★ 매트릭스 표의 회사명에는 열 폭 때문에 줄바꿈에서 온 **공백이 섞인다**
    //   ('미래에셋 자산운용(주)'). 공백을 그대로 두면 DART 상호 완전일치가 전부 실패해
    //   신호가 통째로 join_failed 로 빠진다 (실측: 유가증권 신호 11건 전원 조인 실패).
    const base = rawName.trim();
    const stripLegal = (n: string): string =>
      n.replace(/\(주\)|\(유\)|㈜|주식회사|유한회사|유한책임회사|합자회사|합명회사/g, '').trim();
    const noSpace = base.replace(/[\s ]+/g, '');
    const tried = new Set<string>();
    for (const variant of [base, noSpace, stripLegal(base), stripLegal(noSpace)]) {
      if (!variant || tried.has(variant)) continue;
      tried.add(variant);
      const hits = deps.findCorps(variant);
      if (hits.length === 1) return verifyMembership(hits[0]!.corpCode, rawName);
      if (hits.length > 1) return disambiguateByJurirNo(rawName, hits);
    }
    return {
      reason: withAffiliateHint(
        rawName,
        population === null
          ? 'DART 법인 인덱스에서 상호 일치 없음'
          : '집단 소속회사 목록·DART 법인 인덱스 어디에서도 조인 실패',
      ),
    };
  }
  // 같은 회사가 차입회사·대여회사·매트릭스 행으로 여러 번 나온다 — 인덱스 조회도 기업개황
  // 호출도 이름당 한 번만 한다 (호출은 전부 순차라 경합이 없다)
  const joinCache = new Map<string, { code?: string; reason?: string }>();
  async function joinCorpCode(rawName: string): Promise<{ code?: string; reason?: string }> {
    const key = normalizeCompanyName(rawName);
    const hit = joinCache.get(key);
    if (hit) return hit;
    const r = await joinCorpCodeUncached(rawName);
    joinCache.set(key, r);
    return r;
  }

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
    // 차입일이 오늘 이후면 원문 기재 오류이거나 예정 거래다 — J001 부재가 당연하므로
    // 후보로 만들면 오경보다 (Codex 4차 S2)
    if (b.date && b.date > today) {
      return {
        ...base,
        status: 'not_judged',
        reason:
          `future_transaction_date — 차입일(${b.date})이 오늘(${today}) 이후입니다. ` +
          '원문 기재 오류이거나 예정 거래일 수 있어 판정하지 않습니다',
      };
    }
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

  // ④-0. 같은 상대방과의 연간 합산 재점검 — §4③은 자금거래의 대규모내부거래 해당 여부를
  // "동일 거래상대방과의 동일 거래대상에 대한 거래행위" 기준으로 판단한다. 개별 인출이
  // 기준 미달이어도 같은 약정(동일 거래대상)의 분할 인출 합산이 기준 이상이면 공시대상일 수
  // 있는데, J004 로는 동일 거래대상 여부를 알 수 없다 — below_threshold 로 안심시키지 않고
  // not_judged 로 내린다 (Codex 4차 C2. 분할 차입 4억×4회가 전부 "기준 미달"로 빠지는
  // 거짓 안심 경로).
  {
    const pairTotals = new Map<string, number>();
    for (const b of judgedBorrowings) {
      const k = `${normalizeCompanyName(b.company)} ${normalizeCompanyName(b.counterparty)}`;
      pairTotals.set(k, (pairTotals.get(k) ?? 0) + b.amount);
    }
    for (const b of judgedBorrowings) {
      if (b.status !== 'below_threshold') continue;
      const total = pairTotals.get(
        `${normalizeCompanyName(b.company)} ${normalizeCompanyName(b.counterparty)}`,
      )!;
      const overByCap = total >= CAP_100;
      const overByThreshold = b.threshold !== undefined && total >= b.threshold.value;
      if (!overByCap && !overByThreshold) continue;
      b.status = 'not_judged';
      b.same_counterparty_annual_total = total;
      b.same_counterparty_annual_total_display = fmtWon(total);
      b.reason =
        `aggregation_unknown — 이 건(${b.amount_display})은 기준 미달이지만 같은 상대방과의 ` +
        `연간 차입 합산이 ${fmtWon(total)}로 기준 이상입니다. 고시 §4③은 자금거래를 ` +
        '동일 거래상대방과의 **동일 거래대상** 기준으로 판단하므로, 같은 약정의 분할 인출이면 ' +
        '합산 기준으로 공시대상일 수 있습니다 — J004 로는 동일 거래대상 여부를 알 수 없어 ' +
        '"기준 미달"로 단정하지 않습니다. 약정 단위를 원문으로 확인하세요';
    }
  }

  // ④-1. 계열편입일 이전 거래 분리 — 편입 전에는 공시의무 자체가 없다.
  // audit_periodic 이 같은 오탐(신규 편입사의 과거 기한이 통째로 "미제출")을 겪고 도입한
  // joinedGroupAt(포털 grinil)을 여기서도 쓴다 (교차검토 M-6).
  if (population?.joinedGroupAt) {
    for (const b of judgedBorrowings) {
      if (b.status !== 'not_judged' || b.reason) continue; // 기준 초과 건만
      const code = popByName.get(normalizeCompanyName(b.company));
      const joinedAt = code ? population.joinedGroupAt.get(code) : undefined;
      if (b.date && joinedAt && b.date < joinedAt) {
        b.status = 'no_duty_before_joining';
        b.corp_code = code!;
        b.joined_group_at = joinedAt;
        b.reason =
          `차입일(${b.date})이 계열편입일(${joinedAt}, 포털 grinil)보다 앞섭니다 — 편입 전 거래에는 ` +
          '대규모내부거래 공시의무가 없습니다. 단 편입일 데이터의 정확성·재편입 여부는 확인하지 않았습니다';
      }
    }
  } else if (population) {
    notes.push(
      'ℹ️ 포털에서 계열편입일(grinil)을 얻지 못해 "편입 전 거래 = 의무 없음" 분리를 하지 않았습니다 — ' +
        '신규 편입 회사의 편입 전 거래가 후보로 나올 수 있습니다.',
    );
  }

  // ── ④-2. 대여회사(자금을 대준 계열회사) 관점 1차 판정 ──
  //
  // 대규모내부거래 공시의무는 거래를 하는 계열회사 **각자에게** 있다. 차입 한 건에 의무자가
  // 둘이고(차입회사 = 자금차입 / 대여회사 = 특수관계인에 대한 자금대여), 기준금액은 **각자의
  // 자본**으로 계산한다. 종전에는 차입회사 쪽만 봐서, 자본이 작은 대여회사의 미공시가 통째로
  // 시야 밖이었다 (반대로 차입회사가 기준 미달이라 below_threshold 로 빠진 건이라도 대여회사
  // 기준으로는 초과일 수 있다 — 그래서 차입회사 판정과 **독립적으로** 계산한다).
  //
  // 여기서는 조인·기준금액까지만 확정하고(순수 계산), J001 조회가 필요한 대여회사는 아래
  // 검색 예산(⑤)에 함께 올린다. 상태는 ⑦에서 차입회사와 같은 함수·창·근접 규칙으로 확정한다.
  /** 대여회사 정규화 이름 → 원문 이름 (검색 단계에서 조인에 쓴다) */
  const lenderRawNames = new Map<string, string>();
  /** J001 조회가 필요한 대여회사 키 → 이 대여회사가 관련된 차입일 목록 */
  const lenderNeedsSearch = new Map<string, string[]>();
  {
    // (대여회사, 차입회사) 연간 합산 — §4③ 판단 단위는 차입회사 쪽과 같은 쌍이다
    const pairTotals = new Map<string, number>();
    for (const b of judgedBorrowings) {
      const k = `${normalizeCompanyName(b.counterparty)} ${normalizeCompanyName(b.company)}`;
      pairTotals.set(k, (pairTotals.get(k) ?? 0) + b.amount);
    }
    for (const b of judgedBorrowings) {
      const lender = b.counterparty;
      const key = normalizeCompanyName(lender);
      const side: LenderSide = { company: lender, status: 'not_judged' };
      b.lender_side = side;

      // 차입회사 쪽과 같은 이유로 미래 일자는 판정하지 않는다
      if (b.date && b.date > today) {
        side.reason =
          `future_transaction_date — 차입일(${b.date})이 오늘(${today}) 이후입니다 — ` +
          '대여회사 쪽도 판정하지 않습니다';
        continue;
      }

      const joined = await joinCorpCode(lender);
      if (!joined.code) {
        // 자연인 추정은 **조인 실패 + 소속 확인 실패**가 모두 성립한 뒤에만 쓴다.
        // ★ 조인 실패만으로 자연인 추정을 돌리면 안 된다: 한글 2~4자 상호가 실재하고
        //   (예: '한샘'), 조인은 DART 인덱스 캐시 사정만으로도 실패한다. 재무현황 표나
        //   포털 소속회사 목록이 회사임을 보증하는 이름을 자연인으로 분류하면 그 계열사의
        //   자금대여 미공시가 counterparty_not_company 로 조용히 사라진다 — 거짓 안심이다.
        if (!isConfirmedCompanyName(lender) && looksLikeNaturalPerson(lender)) {
          side.status = 'counterparty_not_company';
          side.reason =
            'counterparty_looks_like_natural_person — 거래상대방 이름이 자연인(동일인·친족) 형태로 ' +
            '보입니다. 자연인은 회사가 아니어서 J001 공시의무자가 아니므로 대조하지 않았습니다 — ' +
            '**이름 모양에 근거한 추정**이니 실제로 법인이라면 그 회사의 자금대여 공시를 직접 확인하세요';
        } else {
          side.status = 'counterparty_not_joined';
          side.reason =
            `counterparty_not_joined — 대여회사 이름을 DART corp_code 로 잇지 못해 자금대여 공시를 ` +
            `조회할 수 없었습니다 (${joined.reason ?? '조인 실패'}) — "공시 없음"이 아니라 확인하지 못한 것입니다` +
            (capitalNameKeys.has(key)
              ? '. 이 이름은 같은 문서의 재무현황 표에 있는 **계열회사**입니다 — ' +
                'resolve_entity 로 corp_code 를 확인해 직접 대조하세요'
              : '');
        }
        continue;
      }
      side.corp_code = joined.code;
      lenderRawNames.set(key, lender);

      // 대여회사도 편입 전에는 의무가 없다 (차입회사와 같은 근거·같은 한계)
      const joinedAt = population?.joinedGroupAt?.get(joined.code);
      if (b.date && joinedAt && b.date < joinedAt) {
        side.status = 'no_duty_before_joining';
        side.joined_group_at = joinedAt;
        side.reason =
          `차입일(${b.date})이 대여회사의 계열편입일(${joinedAt}, 포털 grinil)보다 앞섭니다 — ` +
          '편입 전 거래에는 공시의무가 없습니다';
        continue;
      }

      // 기준금액은 **대여회사 자신의 자본**으로 (같은 J004 재무현황 표)
      const th = thresholds.get(key);
      if (th) {
        side.threshold = {
          value: th.value,
          value_display: fmtWon(th.value),
          formula: th.formula,
          source_row: th.source_row,
        };
      }
      const j = judgeOverThreshold(b.amount, th);
      if (j.certainty) side.certainty = j.certainty;
      if (j.over === null) {
        side.reason =
          'threshold_unknown — 재무현황 표에서 대여회사의 자본을 찾지 못했고 거래금액이 100억원 ' +
          '미만이라 기준금액 초과 여부를 판정할 수 없습니다';
        continue;
      }
      if (j.over === false) {
        const total = pairTotals.get(`${key} ${normalizeCompanyName(b.company)}`)!;
        if (total >= CAP_100 || total >= th!.value) {
          // 차입회사 쪽 aggregation_unknown 과 같은 근거 (고시 §4③ 동일 거래대상)
          side.same_counterparty_annual_total = total;
          side.same_counterparty_annual_total_display = fmtWon(total);
          side.reason =
            `aggregation_unknown — 이 건(${b.amount_display})은 대여회사 기준금액 미달이지만 같은 ` +
            `상대방과의 연간 대여 합산이 ${fmtWon(total)}로 기준 이상입니다 — 같은 약정의 분할 ` +
            '실행이면 합산 기준으로 공시대상일 수 있어 "기준 미달"로 단정하지 않습니다';
          continue;
        }
        side.status = 'below_threshold';
        continue;
      }
      // 기준 초과 — J001 자금대여 공시를 대조해야 한다
      const dates = lenderNeedsSearch.get(key) ?? [];
      if (b.date) dates.push(b.date);
      lenderNeedsSearch.set(key, dates);
    }
  }

  // 상품·용역 — 품목 성격상 제외할 행을 먼저 갈라내고, 나머지를 (회사, 상대방) 단위로 합산한다.
  const caveatRows: GoodsCaveatRow[] = [];
  const aggregates = new Map<
    string,
    { company: string; counterparty: string; total: number; items: GoodsItem[] }
  >();
  for (const g of goods as GoodsServiceRow[]) {
    const itemCaveat = itemLikelyNotGoodsService(g.item);
    if (itemCaveat) {
      const th = thresholds.get(normalizeCompanyName(g.company));
      const jl: GoodsSignal['quarterly_logic'] =
        g.annualAmount >= 4 * CAP_100
          ? 'annual_geq_4x_threshold'
          : th
            ? g.annualAmount >= 4 * th.value
              ? 'annual_geq_4x_threshold'
              : 'annual_below_4x_threshold'
            : 'threshold_unknown';
      caveatRows.push({
        company: g.company,
        counterparty: g.counterparty,
        item: g.item,
        annual_amount: g.annualAmount,
        annual_amount_display: fmtWon(g.annualAmount),
        item_caveat: itemCaveat,
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
        ...(jl === 'annual_geq_4x_threshold'
          ? {
              certainty: (g.annualAmount >= 4 * CAP_100
                ? 'certain_by_cap'
                : 'approx_from_j004') as Certainty,
            }
          : {}),
        quarterly_logic: jl,
      });
      continue;
    }
    const key = `${normalizeCompanyName(g.company)} ${normalizeCompanyName(g.counterparty)}`;
    const agg = aggregates.get(key) ?? {
      company: g.company,
      counterparty: g.counterparty,
      total: 0,
      items: [],
    };
    agg.total += g.annualAmount;
    agg.items.push({
      item: g.item,
      annual_amount: g.annualAmount,
      annual_amount_display: fmtWon(g.annualAmount),
      label: g.label,
    });
    aggregates.set(key, agg);
  }

  const judgedGoods: GoodsSignal[] = [...aggregates.values()].map((a) => {
    const th = thresholds.get(normalizeCompanyName(a.company));
    const base: GoodsSignal = {
      company: a.company,
      counterparty: a.counterparty,
      source: '(6)주요내역',
      annual_amount_total: a.total,
      annual_amount_total_display: fmtWon(a.total),
      items: a.items,
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
    };
    // 비둘기집: 연간 합산 ≥ 4×기준금액이면 네 분기 전부가 기준금액 미만일 수 없다.
    // 그 미만이면 분기 집중 여부를 알 수 없어 **원리상 판정 불가**다 (놓치는 것이 아니라 못 보는 것).
    if (a.total >= 4 * CAP_100) {
      return { ...base, quarterly_logic: 'annual_geq_4x_threshold', certainty: 'certain_by_cap' };
    }
    if (!th) return base;
    if (a.total >= 4 * th.value) {
      return {
        ...base,
        quarterly_logic: 'annual_geq_4x_threshold',
        certainty: 'approx_from_j004',
      };
    }
    return { ...base, quarterly_logic: 'annual_below_4x_threshold' };
  });

  // ④-3. 유가증권 총괄 매트릭스 판정 (Codex 4차 M1 — 종전에는 이 표를 파싱하지 못해
  // "유가증권 형태 자금조달 미검토"를 coverage 에 적어두는 것이 전부였다).
  const knownCompanyNames = new Set<string>([
    ...capitals.map((c) => c.company),
    // 포털 소속회사는 **조인분(corpCodes)과 미조인분(unjoined)을 모두** 넣는다 —
    // jurir 캐시가 비어 미조인일 뿐 소속은 포털이 보증한다. 조인분만 넣으면 캐시 상태에 따라
    // 같은 계열사가 "목록 밖 상대방"으로 표시돼 확인 우선순위가 흔들린다.
    ...(population ? [...population.corpCodes.values(), ...population.unjoined] : []),
    ...securitiesSeed.cells.map((c) => c.rowCompany),
    ...goodsMatrixSeed.cells.map((c) => c.rowCompany),
  ]);
  // ★ 화이트리스트를 **필터로 쓰지 않는다.** 같은 회사가 표마다 다르게 적히기 때문이다
  //   (실측: 열 '미래에셋 파트너스 제9호…' vs 행 '미래에셋 파트너스 제구호…').
  //   목록 밖이라고 버리면 진짜 거래가 조용히 사라져 거짓 안심이 된다 — 대신 상대방이
  //   확인된 계열사인지 신호마다 표시하고, 판정은 그대로 진행한다.
  const securitiesMatrix = securitiesSeed;
  const knownKeys = new Set([...knownCompanyNames].map((n) => normalizeCompanyName(n)));
  const judgedSecurities: SecuritySignal[] = securitiesMatrix.cells.map((c) => {
    const th = thresholds.get(normalizeCompanyName(c.rowCompany));
    const j = judgeOverThreshold(c.amount, th);
    const base: SecuritySignal = {
      company: c.rowCompany,
      counterparty: c.colCompany,
      annual_amount: c.amount,
      annual_amount_display: fmtWon(c.amount),
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
      ...(knownKeys.has(normalizeCompanyName(c.colCompany))
        ? {}
        : { counterparty_in_known_list: false }),
      status: 'not_judged',
    };
    // 국외 계열회사는 법 §26①·고시 §2③2호가 특수관계인에서 제외한다 — 후보가 될 수 없다.
    // 버리지 않고 근거와 함께 남긴다 (그룹 헤더 판독이 틀렸을 수 있다).
    if (isForeignAffiliateColumn(c.colGroup)) {
      return {
        ...base,
        column_group: c.colGroup,
        status: 'not_applicable_foreign_affiliate' as const,
        reason: foreignAffiliateReason(c.colGroup),
      };
    }
    if (j.over === false) {
      // ★ 이 방향만 확실하다 — 상대방별 **연간 총액**이 기준 미만이면 그 상대방과의
      //   어떤 개별 거래도 기준 미만이다 (부분은 합계를 넘지 못한다).
      return {
        ...base,
        status: 'below_threshold' as const,
        reason:
          'annual_total_below_threshold — 이 상대방과의 연간 총액이 기준금액 미만이므로 개별 ' +
          '거래도 전부 기준 미만입니다. 다만 기준금액은 J004 자본 스냅샷 기반 근사치입니다',
      };
    }
    if (j.over === null) {
      return {
        ...base,
        status: 'not_judged' as const,
        reason:
          'threshold_unknown — 재무현황 표에서 이 회사의 자본을 찾지 못했고 연간 총액이 100억원 ' +
          '미만이라 기준금액 초과 여부를 판정할 수 없습니다',
      };
    }
    return base; // over — 상태는 J001 대조 후 확정
  });

  // ④-4. 상품·용역 **총괄표 (5)** 로 (6) 주요 내역의 구멍을 메운다.
  //
  // ★ 중복을 만들지 않는 것이 제1 요건이다 — 같은 거래가 두 바구니에 서로 다른 강도로 실리면
  //   사용자가 같은 건을 두 번 확인하게 되고, 무엇이 진짜 신호인지 흐려진다. 쌍 키는
  //   (6) 합산과 **완전히 같은 형식**(정규화된 매출회사·매입회사)이라 표기 차이를 흡수한다
  //   (실측: (5)의 '와이케이 디벨롭먼트(주)'·'미래에셋 증권(주)' ↔ (6)의 '와이케이디벨롭먼트(주)'·
  //   '미래에셋증권' — 공백·법인격 표기가 다르지만 같은 쌍이다).
  //
  // ⚠️ 품목 성격상 (6)에서 분리한 행(배당·이자·임대차)만 있는 쌍은 `aggregates` 에 없다.
  //   그 쌍은 (5)에서 보완 신호로 낸다 — 실측상 (5)에는 배당금수익이 실리지 않으므로
  //   (5)의 값은 그 caveat 행과 다른 거래일 개연성이 크고, 조용히 버리면 누락이 된다.
  const goodsPairKeys = new Set(aggregates.keys());
  // ★ 실물에서 **쌍 키 정규화가 못 잡는 표기 차이**가 확인됐다 (미래에셋 20260819000341):
  //   같은 205,454백만 보험판매 거래를 (6)은 '미래에셋생명(주)', (5)는 '미래에셋 생명보험(주)'
  //   로 적는다. 공백·법인격을 지워도 '미래에셋생명' ≠ '미래에셋생명보험' 이라 중복 제거를
  //   비껴가 같은 거래가 양쪽에 후보로 올랐다. 이름만으로 같은 회사인지 알 방법이 없다
  //   (DART↔포털 표기 체계가 다르다는 이 프로젝트의 오래된 전제와 같은 문제다).
  // ★ 그렇다고 "같은 매출회사 + 같은 금액"으로 **버리면** 우연히 금액이 같은 별개 거래가
  //   조용히 사라진다 — 이 프로젝트가 반복해서 금지한 거짓 안심 방향이다. 그래서 버리지 않고
  //   **표시만 한다** (화이트리스트를 필터가 아니라 표시로 쓰는 것과 같은 규칙).
  const majorByCompanyAmount = new Map<string, string>();
  for (const a of aggregates.values()) {
    // 금액 0 은 우연 일치가 흔해 힌트로 쓰지 않는다
    if (a.total > 0) {
      majorByCompanyAmount.set(`${normalizeCompanyName(a.company)} ${a.total}`, a.counterparty);
    }
  }
  const GOODS5_CAVEAT =
    '(5) 계열회사간 상품ㆍ용역거래 **총괄표**에서 온 값입니다 — ① 상대방별 **연간 총액**이라 ' +
    '기준금액 판단 단위인 **분기 합계액**(고시 §4③2호)으로 분해되지 않습니다 ② 총괄표에는 ' +
    '**품목이 없어** 배당·이자·임대차처럼 상품·용역이 아닌 항목을 가려내지 못합니다 ' +
    '(실측상 총괄표에 배당금수익은 실리지 않았습니다) ③ (6) 주요 내역과 **회사명이 정규화 ' +
    '일치하는 쌍**은 제외했습니다. 다만 두 표가 같은 회사를 다르게 적으면(실측: (6) ' +
    "'미래에셋생명(주)' vs (5) '미래에셋 생명보험(주)') 같은 거래가 양쪽에 남습니다 — " +
    '그 가능성이 보이면 possible_duplicate_of_major_detail 로 표시하니 확인 전에 먼저 보세요.';
  let goodsMatrixPairsAlsoInDetail = 0;
  let goodsMatrixPossibleDuplicates = 0;
  const judgedGoodsMatrix: GoodsMatrixSignal[] = [];
  for (const c of goodsMatrixSeed.cells) {
    const key = `${normalizeCompanyName(c.rowCompany)} ${normalizeCompanyName(c.colCompany)}`;
    if (goodsPairKeys.has(key)) {
      goodsMatrixPairsAlsoInDetail++;
      continue;
    }
    // 같은 매출회사가 (6)에서 **원 단위까지 같은 금액**을 다른 이름의 상대방에게 적었다면
    // 같은 거래일 가능성이 높다 — 판정은 그대로 두고 표시만 한다
    const dupCounterparty = majorByCompanyAmount.get(
      `${normalizeCompanyName(c.rowCompany)} ${c.amount}`,
    );
    if (dupCounterparty !== undefined) goodsMatrixPossibleDuplicates++;
    const th = thresholds.get(normalizeCompanyName(c.rowCompany));
    const j = judgeOverThreshold(c.amount, th);
    const base: GoodsMatrixSignal = {
      company: c.rowCompany,
      counterparty: c.colCompany,
      source: '(5)총괄',
      annual_amount: c.amount,
      annual_amount_display: fmtWon(c.amount),
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
      ...(knownKeys.has(normalizeCompanyName(c.colCompany))
        ? {}
        : { counterparty_in_known_list: false }),
      ...(dupCounterparty !== undefined
        ? {
            possible_duplicate_of_major_detail: {
              major_detail_counterparty: dupCounterparty,
              amount_display: fmtWon(c.amount),
              note:
                `(6) 주요 내역에도 같은 매출회사가 **같은 금액**(${fmtWon(c.amount)})을 ` +
                `'${dupCounterparty}' 에게 적은 행이 있습니다 — 두 표가 같은 회사를 다르게 ` +
                '적은 **같은 거래**일 가능성이 높습니다. 그 경우 (6) 쪽 신호와 이 신호는 하나로 ' +
                '세어야 합니다. 우연히 금액이 같은 별개 거래일 수도 있어 버리지 않고 표시만 합니다',
            },
          }
        : {}),
      quarterly_logic: 'threshold_unknown',
      caveat: GOODS5_CAVEAT,
      status: 'not_judged',
    };
    // 국외 계열회사 열은 후보가 될 수 없다 (법 §26①·고시 §2③2호). 버리지 않고 근거와 함께 남긴다.
    if (isForeignAffiliateColumn(c.colGroup)) {
      judgedGoodsMatrix.push({
        ...base,
        column_group: c.colGroup,
        status: 'not_applicable_foreign_affiliate',
        reason: foreignAffiliateReason(c.colGroup),
      });
      continue;
    }
    if (j.over === false) {
      // ★ 이 방향만 확실하다 — 분기 합계는 연간 총액을 넘지 못하므로, 연간 총액이 기준 미만이면
      //   네 분기 전부 기준 미만이다. (기준금액 자체는 J004 자본 스냅샷 기반 근사치다.)
      judgedGoodsMatrix.push({
        ...base,
        quarterly_logic: 'annual_below_threshold',
        status: 'below_threshold',
        reason:
          'annual_total_below_threshold — 이 상대방과의 연간 총액이 기준금액 미만이므로 어느 ' +
          '분기 합계도 기준 미만입니다. 다만 기준금액은 J004 자본 스냅샷 기반 근사치입니다',
      });
      continue;
    }
    if (j.over === null) {
      judgedGoodsMatrix.push({
        ...base,
        status: 'not_judged',
        reason:
          'threshold_unknown — 재무현황 표에서 이 회사의 자본을 찾지 못했고 연간 총액이 100억원 ' +
          '미만이라 기준금액 초과 여부를 판정할 수 없습니다',
      });
      continue;
    }
    // 기준 초과 — 비둘기집이 서는지로 신호 강도를 가른다. 상태는 J001 대조 후 확정한다.
    const fourX = c.amount >= 4 * CAP_100 || (th !== undefined && c.amount >= 4 * th.value);
    judgedGoodsMatrix.push({
      ...base,
      quarterly_logic: fourX ? 'annual_geq_4x_threshold' : 'annual_geq_threshold',
    });
  }

  // ── ④-5. 거래 **상대방 쪽** 관점 (상품·용역 매입회사 / 유가증권 매도회사) ──
  //
  // ★ 근거: 매뉴얼 lit26-001 "거래규모가 거래당사자 **모두에게** 대규모내부거래에 해당되는
  //   경우 이사회 의결 및 공시의무는 거래당사자 모두에게 있음" — 차입의 lender_side 와 같은
  //   원리이고, 기준금액은 **각자의 자본**으로 계산한다.
  // ★ 어휘·검색 예산·유형 필터를 전부 재사용한다. 실측 J001 보고서명이 방향 중립이라
  //   (`특수관계인과의수익증권거래`·`계열금융회사의약관에의한금융거래-[유가증권-채권]`·
  //   `상품ㆍ용역거래`) 매도/매입 어느 쪽이든 같은 필터로 찾는다.
  /** 상대방 관점 판정 대상 — 상태는 ⑦에서 차입·판매 쪽과 같은 함수로 확정한다 */
  const counterSides: Array<{
    side: CounterpartySide;
    kind: 'goods' | 'securities';
    /** 검색 예산 우선순위용 거래금액 (연간 총액) */
    amount: number;
  }> = [];
  /** 상대방 관점 때문에 새로 검색이 필요해진 회사 (정규화 이름 → 원문 이름) */
  const counterRawNames = new Map<string, string>();

  /**
   * 상대방 쪽 1차 판정 — 조인·기준금액까지만 확정하고 J001 조회는 ⑤ 예산에 올린다.
   * 판정 강도 규칙은 원래 신호와 **완전히 같다** (상품·용역 비둘기집 / 유가증권 총액 한계).
   */
  async function judgeCounterSide(
    counterparty: string,
    amount: number,
    kind: 'goods' | 'securities',
  ): Promise<CounterpartySide> {
    const key = normalizeCompanyName(counterparty);
    const side: CounterpartySide = { company: counterparty, status: 'not_judged' };
    counterSides.push({ side, kind, amount });
    if (kind === 'goods') side.counterparty_qualification = 'not_verified';

    const joined = await joinCorpCode(counterparty);
    if (!joined.code) {
      // 차입 쪽과 같은 순서 — 조인 실패 + 소속 확인 실패 뒤에만 자연인 추정을 쓴다
      if (!isConfirmedCompanyName(counterparty) && looksLikeNaturalPerson(counterparty)) {
        side.status = 'counterparty_not_company';
        side.reason =
          'counterparty_looks_like_natural_person — 이름이 자연인(동일인·친족) 형태로 보입니다. ' +
          '자연인은 J001 공시의무자가 아니므로 대조하지 않았습니다 — **이름 모양에 근거한 ' +
          '추정**이니 실제로 법인이라면 그 회사의 공시를 직접 확인하세요';
      } else {
        side.status = 'counterparty_not_joined';
        side.reason =
          `counterparty_not_joined — 이 회사를 DART corp_code 로 잇지 못해 공시를 조회할 수 ` +
          `없었습니다 (${joined.reason ?? '조인 실패'}) — "공시 없음"이 아니라 확인하지 못한 것입니다`;
      }
      return side;
    }
    side.corp_code = joined.code;
    counterRawNames.set(key, counterparty);

    const th = thresholds.get(key);
    if (th) {
      side.threshold = {
        value: th.value,
        value_display: fmtWon(th.value),
        formula: th.formula,
        source_row: th.source_row,
      };
    }
    const j = judgeOverThreshold(amount, th);
    if (j.certainty) side.certainty = j.certainty;
    if (j.over === null) {
      if (kind === 'goods') side.quarterly_logic = 'threshold_unknown';
      side.reason =
        'threshold_unknown — 재무현황 표에서 이 회사의 자본을 찾지 못했고 연간 총액이 100억원 ' +
        '미만이라 기준금액 초과 여부를 판정할 수 없습니다';
      return side;
    }
    if (j.over === false) {
      // 분기 합계·개별 거래는 연간 총액을 넘지 못한다 — 이 방향만 확실하다
      if (kind === 'goods') side.quarterly_logic = 'annual_below_threshold';
      side.status = 'below_threshold';
      side.reason =
        'annual_total_below_threshold — 이 회사 기준으로도 연간 총액이 기준금액 미만이므로 ' +
        '분기 합계·개별 거래도 전부 기준 미만입니다 (기준금액은 J004 자본 스냅샷 기반 근사치)';
      return side;
    }
    if (kind === 'goods') {
      side.quarterly_logic =
        amount >= 4 * CAP_100 || (th !== undefined && amount >= 4 * th.value)
          ? 'annual_geq_4x_threshold'
          : 'annual_geq_threshold';
    }
    return side; // 기준 초과 — ⑤ 예산에 올려 ⑦에서 확정한다
  }

  for (const g of judgedGoods) {
    g.buyer_side = await judgeCounterSide(g.counterparty, g.annual_amount_total, 'goods');
  }
  for (const sec of judgedSecurities) {
    // 국외 계열회사는 양쪽 다 의무가 없다 (법 §26① 상대방 제외 + 국내 회사가 아니다)
    if (sec.status === 'not_applicable_foreign_affiliate') continue;
    sec.seller_side = await judgeCounterSide(sec.counterparty, sec.annual_amount, 'securities');
  }
  for (const m of judgedGoodsMatrix) {
    if (m.status === 'not_applicable_foreign_affiliate') continue;
    m.buyer_side = await judgeCounterSide(m.counterparty, m.annual_amount, 'goods');
  }

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
  const signalGoods = judgedGoods.filter((g) => g.quarterly_logic === 'annual_geq_4x_threshold');
  for (const g of signalGoods) {
    const k = normalizeCompanyName(g.company);
    const e = needsSearch.get(k) ?? { maxAmount: 0, dates: [] };
    e.maxAmount = Math.max(e.maxAmount, g.annual_amount_total);
    needsSearch.set(k, e);
  }

  // (5) 총괄 보완 신호 — 기준 초과분(비둘기집 성립 여부와 무관)만 J001 을 대조한다
  const signalGoodsMatrix = judgedGoodsMatrix.filter(
    (m) =>
      m.quarterly_logic === 'annual_geq_4x_threshold' ||
      m.quarterly_logic === 'annual_geq_threshold',
  );
  for (const m of signalGoodsMatrix) {
    const k = normalizeCompanyName(m.company);
    const e = needsSearch.get(k) ?? { maxAmount: 0, dates: [] };
    e.maxAmount = Math.max(e.maxAmount, m.annual_amount);
    needsSearch.set(k, e);
  }

  const signalSecurities = judgedSecurities.filter(
    (sec) => sec.status === 'not_judged' && !sec.reason,
  );
  for (const sec of signalSecurities) {
    const k = normalizeCompanyName(sec.company);
    const e = needsSearch.get(k) ?? { maxAmount: 0, dates: [] };
    e.maxAmount = Math.max(e.maxAmount, sec.annual_amount);
    needsSearch.set(k, e);
  }

  // 상대방 관점(매입회사·매도회사)도 같은 예산·같은 캐시를 쓴다 — 판매회사와 같은 회사면
  // J001 조회는 1회뿐이다 (유형 필터가 방향 중립이라 한 번의 수집을 양쪽이 나눠 쓴다).
  for (const { side, amount } of counterSides) {
    if (side.status !== 'not_judged' || side.reason || !side.corp_code) continue;
    const k = normalizeCompanyName(side.company);
    const e = needsSearch.get(k) ?? { maxAmount: 0, dates: [] };
    e.maxAmount = Math.max(e.maxAmount, amount);
    needsSearch.set(k, e);
  }

  // 대여회사도 같은 예산·같은 캐시를 쓴다 — 차입회사와 같은 회사면 J001 조회는 1회뿐이다
  // (유형 필터만 '자금대여'로 달리 적용한다).
  for (const [key, dates] of lenderNeedsSearch) {
    const maxAmount = judgedBorrowings
      .filter((b) => normalizeCompanyName(b.counterparty) === key)
      .reduce((m, b) => Math.max(m, b.amount), 0);
    const e = needsSearch.get(key) ?? { maxAmount: 0, dates: [] };
    e.maxAmount = Math.max(e.maxAmount, maxAmount);
    e.dates.push(...dates);
    needsSearch.set(key, e);
  }

  // 예산: 금액 큰 회사부터. 넘치는 회사의 거래는 판정하지 않고 그렇다고 말한다.
  const ranked = [...needsSearch.entries()].sort((a, b) => b[1].maxAmount - a[1].maxAmount);
  const withinBudget = ranked.slice(0, MAX_COMPANIES_TO_SEARCH);
  const overBudgetKeys = new Set(ranked.slice(MAX_COMPANIES_TO_SEARCH).map(([k]) => k));

  // ── ⑥ 회사당 1회 J001 수집 ──
  // 창 상한은 **오늘**이다. 종전의 "사업연도말 +90일" 상한은 J004 작성 중 누락을 발견해
  // 5~6월에 지연 공시(자진시정)한 건을 못 봐 "시정했는데 후보"를 만들었다 (교차검토 M-5).
  // corp_code 지정 검색은 장기 구간이 허용되므로(함정 10) 콜 수는 동일하다.
  const fyStart = `${fiscalYear}0101`;
  const searches = new Map<string, CompanySearch>(); // 정규화 이름 → 검색 결과
  for (const [key, info] of withinBudget) {
    // 대표 원문 이름 하나를 찾는다 (조인 시도용)
    const rawName =
      overBorrowings.find((b) => normalizeCompanyName(b.company) === key)?.company ??
      signalGoods.find((g) => normalizeCompanyName(g.company) === key)?.company ??
      signalSecurities.find((sec) => normalizeCompanyName(sec.company) === key)?.company ??
      signalGoodsMatrix.find((m) => normalizeCompanyName(m.company) === key)?.company ??
      lenderRawNames.get(key) ??
      counterRawNames.get(key) ??
      key;
    const joined = await joinCorpCode(rawName);
    if (!joined.code) {
      joinFailures.push({ company: rawName, reason: joined.reason ?? '조인 실패' });
      continue;
    }
    const earliest = [fyStart, ...info.dates].reduce((a, b) => (a <= b ? a : b));
    const from = addDaysYmd(earliest, -LOOKBACK_DAYS);
    const to = today;
    if (from > to) {
      // S-1 방어선 — today 검증을 통과했다면 도달할 수 없지만, 창 역전을 조용히 빈 결과로
      // 흘리면 후보 오경보가 된다
      searches.set(key, {
        corp_code: joined.code,
        from,
        to,
        rows: [],
        partial: false,
        error: `검색창 역전 (from ${from} > to ${to})`,
      });
      continue;
    }
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
  // 같은 회사를 거래 여러 건이 공유하므로 접수번호로 중복 없이 센다
  const cancelledMatchingSeen = new Set<string>();
  interface CompanyCheck {
    outcome: 'exists' | 'none' | 'not_judged';
    reason?: string;
    corp_code?: string;
    j001_search?: { from: string; to: string; type_filter: string };
    matching?: Disclosure[];
    others?: Disclosure[];
    search_partial?: boolean;
    cancelled_of_type?: number;
  }
  function checkCompany(
    key: string,
    typeFilter: (nm: string) => boolean,
    typeLabel: string,
  ): CompanyCheck {
    if (overBudgetKeys.has(key)) {
      return {
        outcome: 'not_judged',
        reason:
          `company_budget_exceeded — J001 검색 대상이 ${ranked.length}개사여서 금액 상위 ` +
          `${MAX_COMPANIES_TO_SEARCH}개사만 대조했습니다. 이 회사는 rcept_no 없이 개별 확인이 필요합니다`,
      };
    }
    if (joinFailedKeys.has(key)) {
      return {
        outcome: 'not_judged',
        reason:
          'join_failed — 회사명을 DART corp_code 로 잇지 못해 J001 을 조회할 수 없었습니다 ' +
          '(join_failures 참조). resolve_entity 로 corp_code 를 확인하세요',
      };
    }
    const s = searches.get(key);
    if (!s) {
      return { outcome: 'not_judged', reason: 'internal — 검색 대상에 오르지 않았습니다' };
    }
    if (s.error) {
      return {
        outcome: 'not_judged',
        corp_code: s.corp_code,
        reason: `list_error — J001 목록 조회 실패: ${s.error}`,
      };
    }
    const matching = s.rows.filter(
      (r) => typeFilter(r.report_nm) && !isCancellationReport(r.report_nm),
    );
    const cancelsOfType = s.rows.filter(
      (r) => typeFilter(r.report_nm) && isCancellationReport(r.report_nm),
    );
    for (const r of cancelsOfType) cancelledMatchingSeen.add(r.rcept_no);
    const others = s.rows.filter((r) => !typeFilter(r.report_nm) || isCancellationReport(r.report_nm));
    const common = {
      corp_code: s.corp_code,
      j001_search: { from: s.from, to: s.to, type_filter: typeLabel },
      ...(s.partial ? { search_partial: true } : {}),
      ...(cancelsOfType.length ? { cancelled_of_type: cancelsOfType.length } : {}),
    };
    if (matching.length > 0) {
      // 취소 접수분이 매칭 공시 수 이상이면 남은 매칭 공시 전부가 취소된 원공시일 수 있다 —
      // 목록만으로는 취소↔원공시를 연결할 수 없으므로 "공시 존재"로 단정하지 않는다 (Codex 4차 M2)
      if (cancelsOfType.length >= matching.length) {
        return {
          ...common,
          outcome: 'not_judged',
          reason:
            `filing_cancelled_status_unknown — 같은 유형 '[공시취소]' 접수분(${cancelsOfType.length}건)이 ` +
            `매칭 공시(${matching.length}건) 수 이상입니다. 매칭 공시가 취소된 원공시일 수 있어 ` +
            '"공시 존재"로 판정하지 않습니다 — matching_filings 와 취소 접수분을 열어 대조하세요',
          matching,
          others,
        };
      }
      return { ...common, outcome: 'exists', matching, others };
    }
    // 수집이 불완전한데 "공시 없음"이면 수집 누락일 수 있다 — 후보로 단정하지 않는다 (교차검토 M-7)
    if (s.partial) {
      return {
        ...common,
        outcome: 'not_judged',
        reason:
          'list_incomplete — 이 회사의 J001 수집이 불완전(절단·부분결과)해 "공시 없음"을 ' +
          '판정할 수 없습니다. 수집 범위를 좁혀 다시 확인하세요',
        others,
      };
    }
    return { ...common, outcome: 'none', others };
  }

  /** 존재/부재 공통 필드를 대상 객체에 옮겨 담는다 */
  function applyCommon(
    target:
      | JudgedBorrowing
      | GoodsSignal
      | GoodsMatrixSignal
      | SecuritySignal
      | LenderSide
      | CounterpartySide,
    chk: CompanyCheck,
  ): void {
    if (chk.corp_code) target.corp_code = chk.corp_code;
    if (chk.j001_search) target.j001_search = chk.j001_search;
    if (chk.search_partial) target.search_partial = true;
    if (chk.cancelled_of_type) target.cancellations_of_type_in_window = chk.cancelled_of_type;
    if (chk.others) target.other_j001_in_window = chk.others.length;
  }

  for (const b of judgedBorrowings) {
    if (b.status !== 'not_judged' || b.reason) continue; // over 만 남아 있다
    const chk = checkCompany(normalizeCompanyName(b.company), isBorrowingReport, '자금차입');
    applyCommon(b, chk);
    if (chk.outcome === 'not_judged') {
      b.status = 'not_judged';
      b.reason = chk.reason!;
      // 취소로 판정을 보류한 경우엔 대조할 매칭 공시를 함께 준다
      if (chk.matching && chk.matching.length > 0) {
        b.matching_filings = chk.matching.slice(0, 10).map(toFilingRef);
      }
      continue;
    }
    if (chk.outcome === 'none') {
      b.status = 'undisclosed_candidate';
      if (chk.others && chk.others.length > 0) {
        b.other_j001_sample = chk.others.slice(0, 5).map(toFilingRef);
      }
      continue;
    }
    // exists — 건별 차입일 근접도로 가른다 (교차검토 C-1)
    const matching = chk.matching!;
    b.matching_filings = matching.slice(0, 10).map(toFilingRef);
    if (matching.length > 10) b.matching_filings_total = matching.length;
    if (!b.date) {
      b.status = 'j001_filing_in_window_only';
      b.reason =
        'transaction_date_unknown — 차입일을 읽지 못해 건별 근접 대조를 할 수 없었습니다. ' +
        '창 안에 같은 유형 공시가 존재한다는 것까지만 확인됐습니다';
      continue;
    }
    const gaps = matching.map((f) => daysBetween(f.rcept_dt, b.date!));
    const nearest = gaps.reduce((a, g) => (Math.abs(g) < Math.abs(a) ? g : a));
    b.nearest_filing_gap_days = nearest;
    const near = gaps.some((g) => g >= -NEAR_BEFORE_DAYS && g <= NEAR_AFTER_DAYS);
    if (near) {
      b.status = 'j001_filing_near_date';
    } else {
      b.status = 'j001_filing_in_window_only';
      b.reason =
        `filing_far_from_date — 창 안에 같은 유형 공시는 있으나 차입일 근방(−${NEAR_BEFORE_DAYS}~` +
        `+${NEAR_AFTER_DAYS}일)에는 없습니다 (최근접 ${nearest}일). 연초 한도 의결이 커버하는 정상 ` +
        '케이스일 수도, **이 건만 공시가 누락된 부분 공시**일 수도 있습니다 — matching_filings 를 ' +
        '열어 이 거래가 실제로 포함되는지 확인하세요';
    }
  }

  // ⑦-b. 대여회사 쪽 상태 확정 — 차입회사와 **같은 함수·같은 창·같은 근접 규칙**을 쓰고
  //       보고서명 필터만 '자금대여' 계열로 바꾼다.
  for (const b of judgedBorrowings) {
    const side = b.lender_side;
    if (!side || side.status !== 'not_judged' || side.reason) continue; // 기준 초과 건만
    const chk = checkCompany(normalizeCompanyName(side.company), isLendingReport, '자금대여');
    applyCommon(side, chk);
    if (chk.outcome === 'not_judged') {
      side.reason = chk.reason!;
      if (chk.matching && chk.matching.length > 0) {
        side.matching_filings = chk.matching.slice(0, 10).map(toFilingRef);
      }
      continue;
    }
    if (chk.outcome === 'none') {
      side.status = 'undisclosed_candidate';
      side.reason =
        'j001_lending_absent — 대여회사의 창 안에 "특수관계인에 대한 자금대여" 유형 J001 공시가 ' +
        '없습니다. 대여회사에도 별도의 공시의무가 있으므로 미공시 후보입니다 — 다만 차입회사 쪽과 ' +
        '같은 구조적 한계(한도 의결·약관특례·유형 분류)가 그대로 적용됩니다';
      continue;
    }
    const matching = chk.matching!;
    side.matching_filings = matching.slice(0, 10).map(toFilingRef);
    if (matching.length > 10) side.matching_filings_total = matching.length;
    if (!b.date) {
      side.status = 'j001_filing_in_window_only';
      side.reason =
        'transaction_date_unknown — 거래일을 읽지 못해 건별 근접 대조를 할 수 없었습니다. ' +
        '창 안에 자금대여 공시가 존재한다는 것까지만 확인됐습니다';
      continue;
    }
    const gaps = matching.map((f) => daysBetween(f.rcept_dt, b.date!));
    const nearest = gaps.reduce((a, g) => (Math.abs(g) < Math.abs(a) ? g : a));
    side.nearest_filing_gap_days = nearest;
    if (gaps.some((g) => g >= -NEAR_BEFORE_DAYS && g <= NEAR_AFTER_DAYS)) {
      side.status = 'j001_filing_near_date';
    } else {
      side.status = 'j001_filing_in_window_only';
      side.reason =
        `filing_far_from_date — 창 안에 자금대여 공시는 있으나 거래일 근방(−${NEAR_BEFORE_DAYS}~` +
        `+${NEAR_AFTER_DAYS}일)에는 없습니다 (최근접 ${nearest}일) — matching_filings 를 열어 ` +
        '이 거래가 실제로 포함되는지 확인하세요';
    }
  }

  for (const g of signalGoods) {
    // 상품·용역 공시의무는 상대방 요건(동일인·친족 20%↑ 출자 계열사 등)이 전제인데
    // 이 도구는 지분 데이터가 없어 확인하지 못한다 — 모든 신호에 미확인을 명시 (Codex 4차 C1)
    g.counterparty_qualification = 'not_verified';
    const chk = checkCompany(normalizeCompanyName(g.company), isGoodsServicesReport, '상품·용역');
    applyCommon(g, chk);
    if (chk.outcome === 'not_judged') {
      g.status = 'not_judged';
      g.reason = chk.reason!;
      if (chk.matching && chk.matching.length > 0) {
        g.matching_filings = chk.matching.slice(0, 10).map(toFilingRef);
      }
      continue;
    }
    if (chk.outcome === 'none') {
      // "미공시 후보"가 아니라 **요건 충족 시 후보** — 요건 미충족 상대방과의 거래는 애초에
      // 공시대상이 아니므로(법 §26①4호 한정) 후보 단정은 오경보다
      g.status = 'candidate_if_counterparty_qualified';
      g.reason =
        'j001_absent_but_qualification_unknown — 이 유형의 J001 공시는 창 안에 없으나, ' +
        '상대방이 동일인(자연인)·친족 합계 20% 이상 출자 계열회사(또는 그 자회사)인지 확인하지 ' +
        '못했습니다. 요건을 충족하는 상대방일 때만 미공시 후보입니다 — 지분 구조를 먼저 확인하세요';
      continue;
    }
    const matching = chk.matching!;
    g.status = 'j001_filing_exists';
    g.matching_filings = matching.slice(0, 10).map(toFilingRef);
    if (matching.length > 10) g.matching_filings_total = matching.length;
  }

  // (5) 총괄 보완 신호 — (6) 경로와 **같은 유형 필터·같은 창**을 쓰고, 후보 어휘만
  // 비둘기집 성립 여부로 가른다.
  for (const m of signalGoodsMatrix) {
    // 상대방 요건(동일인·친족 20%↑ 출자) 미확인 한계는 (6)과 똑같이 적용된다
    m.counterparty_qualification = 'not_verified';
    const chk = checkCompany(normalizeCompanyName(m.company), isGoodsServicesReport, '상품·용역');
    applyCommon(m, chk);
    if (chk.outcome === 'not_judged') {
      m.status = 'not_judged';
      m.reason = chk.reason!;
      if (chk.matching && chk.matching.length > 0) {
        m.matching_filings = chk.matching.slice(0, 10).map(toFilingRef);
      }
      continue;
    }
    if (chk.outcome === 'none') {
      if (m.quarterly_logic === 'annual_geq_4x_threshold') {
        // 비둘기집이 선다 — (6) 경로와 같은 강도·같은 어휘의 조건부 후보
        m.status = 'candidate_if_counterparty_qualified';
        m.reason =
          'j001_absent_but_qualification_unknown — 연간 총액이 4×기준금액 이상이라 어느 분기 ' +
          '하나는 반드시 기준금액 이상인데(비둘기집) 창 안에 상품·용역 유형 J001 공시가 ' +
          '없습니다. 다만 상대방이 동일인(자연인)·친족 합계 20% 이상 출자 계열회사(또는 그 ' +
          '자회사)인지 확인하지 못했습니다 — 요건을 충족하는 상대방일 때만 미공시 후보입니다';
      } else {
        // ★ 총액만 넘었다 — 분기로 쪼개면 전부 미달일 수 있어 후보로 단정하지 않는다
        m.status = 'candidate_aggregate_only';
        m.reason =
          'j001_absent_for_annual_total — 이 상대방과의 연간 총액은 기준금액 이상인데 창 안에 ' +
          '상품·용역 유형 J001 공시가 없습니다. 다만 기준금액 판단 단위는 **분기 합계액**이고 ' +
          '연간 총액이 4×기준금액 미만이라, 네 분기로 나누면 전부 기준 미만일 수 있습니다 — ' +
          '이것만으로 미공시로 볼 수 없습니다. 분기별 거래액을 확인하세요';
      }
      continue;
    }
    const matching = chk.matching!;
    m.status = 'j001_filing_exists';
    m.matching_filings = matching.slice(0, 10).map(toFilingRef);
    if (matching.length > 10) m.matching_filings_total = matching.length;
  }

  for (const sec of signalSecurities) {
    const chk = checkCompany(normalizeCompanyName(sec.company), isSecuritiesReport, '유가증권');
    applyCommon(sec, chk);
    if (chk.outcome === 'not_judged') {
      sec.status = 'not_judged';
      sec.reason = chk.reason!;
      if (chk.matching && chk.matching.length > 0) {
        sec.matching_filings = chk.matching.slice(0, 10).map(toFilingRef);
      }
      continue;
    }
    if (chk.outcome === 'none') {
      // ★ "미공시 후보"라고 부르지 않는다 — 이 신호는 연간 총액뿐이라 개별 거래가 기준을
      //   넘었는지 자체를 모른다. 차입(건별 날짜)·상품용역(비둘기집)보다 한 단계 약하다.
      sec.status = 'candidate_aggregate_only';
      sec.reason =
        'j001_absent_for_annual_total — 이 상대방과의 연간 유가증권 거래 총액은 기준금액 ' +
        '이상인데 창 안에 유가증권 유형 J001 공시가 없습니다. 다만 고시 §4③은 유가증권 거래를 ' +
        '"동일 거래상대방과의 **동일 거래대상**에 대한 거래행위" 기준으로 판단하므로, 연간 ' +
        '총액이 기준 이상이어도 거래대상(종목)별로 나누면 개별 거래가 전부 기준 미만일 수 ' +
        '있습니다 — 이것만으로 미공시로 볼 수 없습니다. 개별 거래 내역을 확인하세요';
      continue;
    }
    const matching = chk.matching!;
    sec.status = 'j001_filing_exists';
    sec.matching_filings = matching.slice(0, 10).map(toFilingRef);
    if (matching.length > 10) sec.matching_filings_total = matching.length;
  }

  // ⑦-c. 상대방 관점 상태 확정 — 판매회사 쪽과 **같은 함수·같은 창·같은 유형 필터**를 쓴다.
  //       날짜가 없는 신호라 존재 확인까지만 하고 근접 대조는 하지 않는다.
  for (const { side, kind } of counterSides) {
    if (side.status !== 'not_judged' || side.reason) continue; // 기준 초과 건만
    const chk = checkCompany(
      normalizeCompanyName(side.company),
      kind === 'goods' ? isGoodsServicesReport : isSecuritiesReport,
      kind === 'goods' ? '상품·용역' : '유가증권',
    );
    applyCommon(side, chk);
    if (chk.outcome === 'not_judged') {
      side.reason = chk.reason!;
      if (chk.matching && chk.matching.length > 0) {
        side.matching_filings = chk.matching.slice(0, 10).map(toFilingRef);
      }
      continue;
    }
    if (chk.outcome === 'none') {
      if (kind === 'goods') {
        // 상품·용역은 **상대방 요건**이 전제다 — 이 관점에서 상대방은 원래 신호의 판매회사다
        side.status =
          side.quarterly_logic === 'annual_geq_4x_threshold'
            ? 'candidate_if_counterparty_qualified'
            : 'candidate_aggregate_only';
        side.reason =
          side.quarterly_logic === 'annual_geq_4x_threshold'
            ? 'j001_absent_but_qualification_unknown — 이 회사 기준으로도 연간 총액이 4×기준금액 ' +
              '이상이라 어느 분기 하나는 반드시 기준 이상인데(비둘기집) 창 안에 상품·용역 유형 ' +
              'J001 공시가 없습니다. 다만 이 회사의 의무는 **거래상대방**이 동일인·친족 20% 이상 ' +
              '출자 계열회사일 때만 성립하는데(고시 §4①4호) 지분을 확인하지 못했습니다'
            : 'j001_absent_for_annual_total — 이 회사 기준으로 연간 총액은 기준금액 이상이지만 ' +
              '4×에는 못 미쳐 분기로 나누면 전부 미달일 수 있습니다. 상대방 지분 요건도 확인하지 ' +
              '못했습니다 — 미공시로 볼 수 없는 **확인 대상**입니다';
      } else {
        side.status = 'candidate_aggregate_only';
        side.reason =
          'j001_absent_for_annual_total — 이 회사 기준으로도 연간 유가증권 거래 총액이 기준금액 ' +
          '이상인데 창 안에 유가증권 유형 J001 공시가 없습니다. 다만 고시 §4③은 "동일 거래상대방과의 ' +
          '**동일 거래대상**" 기준이라 종목별로 나누면 개별 거래가 전부 기준 미만일 수 있습니다';
      }
      continue;
    }
    side.status = 'j001_filing_exists';
    const matching = chk.matching!;
    side.matching_filings = matching.slice(0, 10).map(toFilingRef);
    if (matching.length > 10) side.matching_filings_total = matching.length;
  }

  // 품목 성격상 제외한 행 — 회사가 이미 검색됐으면 참고 정보만 동봉한다 (추가 콜 없음, S-9)
  for (const row of caveatRows) {
    const s = searches.get(normalizeCompanyName(row.company));
    if (!s || s.error) continue;
    row.related_j001 = {
      goods_type_filings_in_window: s.rows.filter(
        (r) => isGoodsServicesReport(r.report_nm) && !isCancellationReport(r.report_nm),
      ).length,
      from: s.from,
      to: s.to,
    };
  }

  // ── ⑧ 집계·정직성 장치 ──
  const undisclosed = judgedBorrowings.filter((b) => b.status === 'undisclosed_candidate');
  const nearDate = judgedBorrowings.filter((b) => b.status === 'j001_filing_near_date');
  const windowOnly = judgedBorrowings.filter((b) => b.status === 'j001_filing_in_window_only');
  const below = judgedBorrowings.filter((b) => b.status === 'below_threshold');
  const noDuty = judgedBorrowings.filter((b) => b.status === 'no_duty_before_joining');
  const notJudged = judgedBorrowings.filter((b) => b.status === 'not_judged');
  const goodsCandidates = judgedGoods.filter(
    (g) => g.status === 'candidate_if_counterparty_qualified',
  );
  const goodsFilingExists = judgedGoods.filter((g) => g.status === 'j001_filing_exists');
  // 조인 실패·예산 초과로 J001 대조를 못 한 신호 — 출력에서 빠지면 "후보 아님"으로 읽힌다
  const goodsNotJudged = judgedGoods.filter((g) => g.status === 'not_judged');
  const goodsUnjudgeable = judgedGoods.filter(
    (g) => g.quarterly_logic !== 'annual_geq_4x_threshold',
  );
  const goodsItemCaveats4x = caveatRows.filter(
    (r) => r.quarterly_logic === 'annual_geq_4x_threshold',
  );
  // (5) 총괄 보완 — 비둘기집이 서는 후보와 총액만 넘은 확인 대상을 끝까지 분리해 센다
  const gmCandidates = judgedGoodsMatrix.filter(
    (m) => m.status === 'candidate_if_counterparty_qualified',
  );
  const gmAggregateOnly = judgedGoodsMatrix.filter(
    (m) => m.status === 'candidate_aggregate_only',
  );
  const gmFilingExists = judgedGoodsMatrix.filter((m) => m.status === 'j001_filing_exists');
  const gmNotJudged = judgedGoodsMatrix.filter((m) => m.status === 'not_judged');
  const gmBelow = judgedGoodsMatrix.filter((m) => m.status === 'below_threshold');
  const gmForeign = judgedGoodsMatrix.filter(
    (m) => m.status === 'not_applicable_foreign_affiliate',
  );
  const secForeign = judgedSecurities.filter(
    (sec) => sec.status === 'not_applicable_foreign_affiliate',
  );

  const secCandidates = judgedSecurities.filter(
    (sec) => sec.status === 'candidate_aggregate_only',
  );
  const secFilingExists = judgedSecurities.filter((sec) => sec.status === 'j001_filing_exists');
  const secBelow = judgedSecurities.filter((sec) => sec.status === 'below_threshold');
  const secNotJudged = judgedSecurities.filter((sec) => sec.status === 'not_judged');

  // 대여회사 쪽 집계 — 차입 건 단위다 (한 대여회사가 여러 건에 걸릴 수 있다)
  const lenderSides = judgedBorrowings
    .map((b) => b.lender_side)
    .filter((s): s is LenderSide => s !== undefined);
  const lenderCounts: Record<LenderStatus, number> = {
    undisclosed_candidate: 0,
    j001_filing_near_date: 0,
    j001_filing_in_window_only: 0,
    below_threshold: 0,
    no_duty_before_joining: 0,
    not_judged: 0,
    counterparty_not_joined: 0,
    counterparty_not_company: 0,
  };
  for (const s of lenderSides) lenderCounts[s.status]++;
  const lenderCandidates = lenderSides.filter((s) => s.status === 'undisclosed_candidate');

  // 상대방 관점(상품·용역 매입회사 / 유가증권 매도회사) 집계 — 신호 단위다
  const counterCounts: Record<CounterpartySide['status'], number> = {
    candidate_if_counterparty_qualified: 0,
    candidate_aggregate_only: 0,
    j001_filing_exists: 0,
    below_threshold: 0,
    not_judged: 0,
    counterparty_not_joined: 0,
    counterparty_not_company: 0,
  };
  for (const { side } of counterSides) counterCounts[side.status]++;
  const counterCandidates = counterSides.filter(
    (c) =>
      c.side.status === 'candidate_if_counterparty_qualified' ||
      c.side.status === 'candidate_aggregate_only',
  );

  const scopeCaveats: string[] = [
    '★ 모든 결과는 **후보**입니다. undisclosed_candidate 를 "미공시 확정"으로 읽으면 안 되는 구조적 이유: ' +
      `① 이사회 의결은 **한도**로 미리 해 둘 수 있어(연초 한도 의결 → 연중 분할 인출) 그 공시가 ` +
      `검색창(거래일 이전 ${LOOKBACK_DAYS}일 ~ 오늘)보다 앞설 수 있습니다 ② 상대방이 계열 금융회사면 ` +
      '약관특례(고시 §9, 트랙 B) 분기 일괄공시에 실릴 수 있는데 그 서식은 보고서명이 달라 ' +
      '유형 필터에 걸리지 않을 수 있습니다 ③ 보고서명 유형 분류가 원문 표기와 어긋날 수 있습니다 — ' +
      'other_j001_in_window 가 0 이 아니면 그 공시들을 먼저 확인하세요.',
    `j001_filing_near_date 는 차입일 근방(−${NEAR_BEFORE_DAYS}~+${NEAR_AFTER_DAYS}일)에 같은 유형 ` +
      '공시가 있다는 뜻이고, j001_filing_in_window_only 는 검색창 안 어딘가에만 있다는 뜻입니다 — ' +
      '후자는 한도 의결이 커버하는 정상 케이스일 수도, **일부 차입만 공시한 부분 누락**일 수도 있습니다 ' +
      '(nearest_filing_gap_days 참조). 어느 쪽이든 **그 공시가 이 거래를 실제로 커버함을 대조한 것이 ' +
      '아닙니다** — matching_filings 를 read_disclosure 로 열어 거래상대방·금액·의결일을 확인해야 ' +
      '"공시됨"이 확정됩니다.',
    '기준금액은 **J004 재무현황(당해 사업연도말 자본) 기반 근사치**입니다. 고시 §2③의 정확한 기준은 ' +
      '자본총계=주주총회 승인된 최근 사업연도말 재무제표, 자본금=이사회 의결일 직전일 — 거래 시점에 ' +
      '유효한 자본총계는 통상 **그 전년도말** 것이라 이 근사는 양방향으로 어긋날 수 있습니다. ' +
      '거래금액 100억원 이상(certainty:"certain_by_cap")만 자본과 무관하게 확실합니다(령 §33①1호 상한).',
    'below_threshold 도 같은 근사 기준입니다 — **"기준 미달 = 공시의무 없음 확정"이 아닙니다.** ' +
      '경계(±수억) 거래는 정확한 자본(주총 승인 재무제표)으로 check_disclosure_duty 재판정이 필요합니다.',
    '이 도구가 보는 거래유형은 **자금 차입/대여**(차입일 단위)·**상품·용역**((6) 주요 내역 + ' +
      '(5) 총괄표 보완)·**유가증권 총괄**(상대방별 연간 총액)입니다. 담보·채무보증·부동산 임대차· ' +
      '기타자산 등 다른 유형은 보지 않습니다.',
    '★ 유가증권 신호는 **상대방별 연간 총액**뿐입니다 — 고시 §4③은 유가증권 거래의 해당 여부를 ' +
      '"동일 거래상대방과의 **동일 거래대상**에 대한 거래행위" 기준으로 판단하므로, 연간 총액이 ' +
      '기준금액 이상이어도 거래대상(종목)별로 나누면 개별 거래가 전부 기준 미만일 수 있습니다. ' +
      '상품·용역과 달리 **비둘기집 논증이 성립하지 않아**(연간 총액은 분기 하한을 주지 못한다) ' +
      '후보를 candidate_aggregate_only 로만 냅니다 — 미공시 후보가 아니라 "확인이 필요한 총액"입니다. ' +
      '반대 방향은 확실합니다: 연간 총액이 기준 미만이면 그 상대방과의 개별 거래도 전부 미만입니다. ' +
      '또한 계열 금융회사 간 유가증권 매매는 상당수가 약관특례(고시 §9, 트랙 B) 분기 일괄공시 ' +
      '대상이라, 정상 공시를 놓쳐 오경보를 내지 않도록 보고서명 필터를 넓게 잡았습니다 ' +
      '(matching_filings 로 실제 무엇에 걸렸는지 확인하세요).',
    '★ 자금 차입은 **양쪽 관점**을 봅니다 — 대규모내부거래 공시의무는 거래를 하는 계열회사 ' +
      '각자에게 있으므로, 차입회사의 "자금차입" 공시(항목 본문)와 대여회사의 "특수관계인에 대한 ' +
      '자금대여" 공시(lender_side)를 **각자의 자본으로 계산한 기준금액**으로 따로 판정합니다. ' +
      '대여회사가 DART corp_code 로 조인되지 않으면 counterparty_not_joined, 이름이 자연인(동일인·' +
      '친족) 형태면 counterparty_not_company 로 남으며 둘 다 "의무 없음"이 아니라 **확인하지 못한 ' +
      '것**입니다.',
    '★ 상품·용역과 유가증권도 **양쪽 관점**을 봅니다 — 공정위 매뉴얼(2026-04-27 lit26-001)은 ' +
      '"거래규모가 거래당사자 **모두에게** 대규모내부거래에 해당되는 경우 이사회 의결 및 공시의무는 ' +
      '거래당사자 모두에게 있음"이라고 합니다. 상품·용역은 판매회사(항목 본문)와 **매입회사**' +
      '(buyer_side), 유가증권은 매입회사(항목 본문)와 **매도회사**(seller_side)를 각자의 자본으로 ' +
      '계산한 기준금액으로 따로 판정합니다. 다만 **상품·용역은 양쪽 다 상대방 지분 요건이 전제**라 ' +
      '(고시 §4①4호 — 각 당사자의 의무는 *그 상대방*이 동일인·친족 20%↑ 출자 계열회사인지에 ' +
      '달렸습니다. 매뉴얼 lit26-065·066 이 그 비대칭 실례입니다) 어느 쪽도 후보로 단정하지 ' +
      '않습니다. 상대방 쪽은 **날짜가 없는 연간 총액**이라 존재 확인까지만 하고 건별 근접 대조는 ' +
      '하지 않습니다.',
    '★ 상품·용역의 공시의무는 **상대방 요건이 전제**입니다 — 법 §26①4호·령 §33②·고시 §4①4호는 ' +
      '상대방을 "자연인인 동일인이 단독으로 또는 친족과 합하여 20% 이상 출자한 계열회사 또는 그 ' +
      '상법 §342의2 자회사"로 한정합니다. 이 도구는 지분 데이터가 없어 요건을 확인하지 못하므로 ' +
      '상품·용역 신호는 전부 candidate_if_counterparty_qualified(조건부 후보)입니다 — 요건 미충족 ' +
      '상대방과의 거래는 애초에 공시대상이 아니고, **동일인이 법인인 집단은 이 유형의 공시의무 ' +
      '자체가 없습니다**. 자금·유가증권·자산 거래는 이 한정이 없습니다(특수관계인 전반).',
    '상품·용역의 기준은 분기 합계액(고시 §4③2호, 동일 거래상대방 기준)인데 J004 는 연간 합계뿐입니다 ' +
      '— **(판매회사, 거래상대방) 연간 합산**이 ≥ 4×기준금액인 경우만(어느 분기 하나는 반드시 기준 ' +
      '이상이라는 산술) 신호로 쓰고, 그 미만은 분기 집중 여부를 알 수 없어 **원리상 판정하지 ' +
      '않습니다** (goods_services_not_judgeable, 품목 행은 items 로 동봉). 또한 기준은 "이루어질" ' +
      '거래(사전 의결 시점 예상액)인데 J004 는 사후 실적이라 간극이 있을 수 있습니다 — 다만 사후에 ' +
      '해당이 예상되는 경우의 사전 의결·공시 경로(§9의2③)도 있으므로 후보 검토 가치는 있습니다.',
    '★ 상품·용역은 두 표를 함께 봅니다 — 판정의 주 원천인 (6) **주요** 상품ㆍ용역거래 내역은 ' +
      '서식상 "거래한 금액이 **일정 규모 이상**인 경우"만 싣고 그 규모 기준은 우리가 계산하는 ' +
      '기준금액과 다릅니다. 그래서 (5) 계열회사간 상품ㆍ용역거래 **총괄표**(전 쌍 수록)에서 ' +
      '**(6)에 없는 (매출회사, 매입회사) 쌍만** 보완 신호로 냅니다(goods_services_matrix_signals, ' +
      'source:"(5)총괄"). 중복은 정규화된 쌍 키로 제거하지만 **두 표가 같은 회사를 다르게 적으면 ' +
      '그 키가 듣지 않습니다** (실측: (6) "미래에셋생명(주)" vs (5) "미래에셋 생명보험(주)" — 같은 ' +
      '205,454백만 거래가 양쪽에 남았습니다). 같은 매출회사·같은 금액이면 ' +
      'possible_duplicate_of_major_detail 로 표시하니 후보 수를 셀 때 확인하세요. ' +
      '보완 신호는 연간 총액이 ≥ 4×기준금액일 때만 (6)과 같은 강도의 조건부 후보이고, 총액만 ' +
      '기준 이상이면 candidate_aggregate_only(분기로 나누면 전부 미달일 수 있음)입니다. ' +
      '또 총괄표에는 **품목이 없어** 배당·이자·임대차 분리를 적용하지 못합니다.',
    '★ **국외(해외) 계열회사 상대 거래에는 공시의무가 없습니다** — 법 §26①이 "특수관계인(**국외 ' +
      '계열회사는 제외한다**. 이하 이 조에서 같다)"이라 명시하고, 고시 §2③2호도 같은 문언이며, ' +
      '공정위 공시 업무 매뉴얼(2026-04-27)도 "국외 계열회사와 대규모내부거래 등을 하는 경우 ' +
      '이사회 의결 및 공시의무 없음"이라고 답합니다. 그래서 (5) 총괄표가 **그룹 헤더로 ' +
      '"해외계열사"라고 밝힌 열**은 not_applicable_foreign_affiliate 로 분리합니다 — 회사명 ' +
      '모양으로 추측하지 않고 원문 표의 분류만 씁니다(column_group 으로 근거를 함께 냅니다). ' +
      '⚠️ 두 가지 한계: ① 같은 매뉴얼은 "특수관계인이 발행한 주식 등을 **국외 계열회사를 통하여 ' +
      '간접적으로** 매입하는 등 특수관계인을 **위한** 거래"에는 의무가 있다고 하는데 이 표로는 ' +
      '그런 간접거래를 구분할 수 없습니다 ② 그룹 헤더는 병합 셀을 왼쪽부터 이어받아 읽으므로 ' +
      '분류가 틀릴 수 있어, 버리지 않고 금액·기준금액과 함께 출력에 남깁니다.',
    '자금 차입의 대규모내부거래 해당 여부는 고시 §4③에 따라 "동일 거래상대방과의 동일 거래대상" ' +
      '기준으로 판단합니다 — J004 로는 동일 거래대상(같은 약정) 여부를 알 수 없어, 개별 건이 기준 ' +
      '미달이어도 같은 상대방 연간 합산이 기준 이상이면 below_threshold 로 단정하지 않고 not_judged' +
      '(aggregation_unknown)로 남깁니다.',
    'J004 원문 자체가 부정확하거나 늦게 제출됐을 수 있습니다 (J004 정정률 91% 실측) — 정정 반영 ' +
      '최신본을 읽지만 원천 기재 오류·누락은 판별하지 못합니다. J001 대사의 원천이 J004 하나뿐이라 ' +
      'J004 에 안 실린 거래는 애초에 이 도구의 시야 밖입니다.',
    '각 회사가 실제로 공시의무자인지(소속·청산·휴업 등)와 **집단의 지정 연혁**은 판정하지 않습니다 — ' +
      '집단이 그 거래 연도에 공시대상으로 지정돼 있지 않았다면(신규 지정) 전년도 거래 전체가 의무 ' +
      '없음일 수 있습니다. 계열편입일(포털 grinil) 이전 차입만 no_duty_before_joining 으로 분리하며, ' +
      '이는 포털 소속회사 목록을 실제로 불러온 경우에만 가능합니다(diagnostics.population 참조). ' +
      '상품·용역은 연간 합계라 편입 시점 ' +
      '대조가 불가능합니다. 또한 **편입 전 체결 거래라도 편입 후 주요내용을 변경하면 의결·공시의무가 ' +
      '있습니다**(고시 §4④) — 이 도구는 변경 여부를 보지 못하므로 no_duty_before_joining 도 그 ' +
      '한도에서만 유효합니다.',
    populationSource === 'portal'
      ? `회사명 조인에 포털 소속회사 목록(${populationGroup}, ${populationYearMonth} 기준)을 썼습니다 — ` +
        'DART 폴백 조인 결과가 집단 목록 어디에도 없으면 비계열 동명 회사일 수 있어 판정하지 ' +
        '않습니다(dart_join_unverified). 포털 목록은 **연 1회(매년 5/1 기준) 스냅샷**이라 거래 시점의 ' +
        '소속과 다를 수 있고, 목록에는 있으나 DART 법인등록번호 조인 캐시가 비어 있으면 여전히 ' +
        '조인에 실패합니다(resolve_entity(fetchJurirNo=true) 로 채울 수 있습니다).'
      : `포털 소속회사 목록 없이 DART 상호 완전일치만으로 조인했습니다 (${populationReason ?? '사유 미상'}) — ` +
        '동명 비계열 회사로 오조인되면 그 회사의 공시가 근거로 잘못 붙을 수 있고, 계열편입일 ' +
        '대조(편입 전 거래 = 의무 없음)도 하지 못합니다.',
  ];

  if (undisclosed.length > 0) {
    notes.push(
      `⚠️ 자금차입 미공시 후보 ${undisclosed.length}건. **반드시 scope_caveats 와 함께 전달하세요** — ` +
        '미공시의 과태료 기본금액(의결 있음 5,000만 / 없음 7,000만원)은 지연(500만+1일 10만)보다 훨씬 ' +
        '무거워, 단정이 틀렸을 때의 대가도 그만큼 큽니다. 각 건은 해당 회사 담당자 확인 → 필요 시 ' +
        'check_disclosure_duty(정확한 자본 입력) 재판정 순서로 검증하세요.',
    );
  }
  if (goodsCandidates.length > 0) {
    notes.push(
      `⚠️ 상품·용역 **조건부 후보** ${goodsCandidates.length}건 (candidate_if_counterparty_qualified) — ` +
        'J001 은 없으나, 이 유형의 공시의무는 상대방이 동일인(자연인)·친족 합계 20% 이상 출자 ' +
        '계열회사(또는 그 자회사)일 때만 성립합니다(법 §26①4호·령 §33②). 이 도구는 지분을 확인하지 ' +
        '못하므로 **"미공시 후보"로 단정하지 마세요** — 상대방의 총수일가 지분 구조를 먼저 확인하고, ' +
        '동일인이 법인인 집단이면 이 유형의 의무 자체가 없습니다.',
    );
  }
  if (gmCandidates.length > 0 || gmAggregateOnly.length > 0) {
    notes.push(
      `⚠️ (5) 상품·용역 **총괄표 보완** 신호 — 조건부 후보 ${gmCandidates.length}건 · ` +
        `총액 확인 대상 ${gmAggregateOnly.length}건. (6) 주요 내역에는 없고 (5) 총괄표에만 있는 ` +
        '쌍입니다 ((6)은 일정 규모 이상만 싣습니다). 총괄표는 **연간 총액·품목 없음**이라 신호가 ' +
        '한 단계 약합니다 — 각 신호의 caveat 와 status 를 그대로 전달하고, 분기별 거래액과 ' +
        '상대방 지분 요건을 확인하세요.',
    );
  }
  if (jurirResolved.length > 0) {
    notes.push(
      `ℹ️ DART 상호가 동명 2건 이상이던 회사 ${jurirResolved.length}곳을 **법인등록번호**로 ` +
        `확정했습니다 (${jurirResolved.map((r) => `${r.company}→${r.corp_code}`).join(', ')}) — ` +
        '포털 소속회사 목록의 jurirno 와 DART 기업개황 jurir_no 를 대조한 결과이며, ' +
        '정확히 1건 일치한 경우만 확정했습니다 (diagnostics.jurir_disambiguation).',
    );
  }
  if (goodsMatrixPossibleDuplicates > 0) {
    const dups = judgedGoodsMatrix.filter((m) => m.possible_duplicate_of_major_detail);
    notes.push(
      `⚠️ (5) 보완 신호 ${goodsMatrixPossibleDuplicates}건은 (6) 주요 내역에 **같은 매출회사· ` +
        `같은 금액** 행이 다른 상대방 이름으로 있습니다 (${dups
          .map((m) => `${m.company}→${m.counterparty}/${m.annual_amount_display}`)
          .join(', ')}) — 두 표가 같은 회사를 다르게 적은 **같은 거래**일 가능성이 높습니다 ` +
        '(실측: (6) "미래에셋생명(주)" vs (5) "미래에셋 생명보험(주)"). 그 경우 양쪽 신호를 ' +
        '하나로 세세요. 우연히 금액이 같은 별개 거래일 수도 있어 버리지 않고 표시만 했습니다.',
    );
  }
  if (secCandidates.length > 0) {
    notes.push(
      `⚠️ 유가증권 **총액 확인 대상** ${secCandidates.length}건 (candidate_aggregate_only) — 상대방별 ` +
        '연간 총액이 기준금액 이상인데 창 안에 유가증권 유형 J001 이 없습니다. **미공시 후보로 단정하지 ' +
        '마세요**: 이 표는 연간 총액뿐이라 개별 거래가 기준을 넘었는지 자체를 모릅니다(고시 §4③은 ' +
        '동일 거래상대방과의 **동일 거래대상** 기준). 계열 금융회사 간 매매라면 약관특례(§9) 분기 ' +
        '일괄공시 대상일 수 있습니다 — 개별 거래 내역을 먼저 확인하세요.',
    );
  }
  if (counterCandidates.length > 0) {
    const names = [...new Set(counterCandidates.map((c) => c.side.company))];
    notes.push(
      `⚠️ **상대방 쪽**(상품·용역 매입회사·유가증권 매도회사) 확인 대상 ${counterCandidates.length}건 ` +
        `(${names.join(', ')}) — 공정위 매뉴얼(2026-04-27 lit26-001)은 "거래규모가 거래당사자 ` +
        '**모두에게** 대규모내부거래에 해당되면 공시의무도 거래당사자 모두에게 있다"고 합니다. ' +
        '기준금액은 그 회사 자신의 자본으로 계산했습니다 — buyer_side·seller_side 를 열어 ' +
        'status·matching_filings 를 확인하고 scope_caveats 와 함께 전달하세요.',
    );
  }
  if (lenderCandidates.length > 0) {
    const names = [...new Set(lenderCandidates.map((s) => s.company))];
    notes.push(
      `⚠️ **대여회사 쪽** 자금대여 미공시 후보 ${lenderCandidates.length}건 (${names.join(', ')}) — ` +
        '차입회사가 자금차입을 공시했더라도 자금을 대준 계열회사에는 "특수관계인에 대한 자금대여" ' +
        '공시의무가 **별도로** 있고, 기준금액도 그 회사 자신의 자본으로 계산합니다. ' +
        'lender_side 를 열어 matching_filings·기준금액을 확인하고, scope_caveats 와 함께 전달하세요.',
    );
  }
  if (lenderCounts.counterparty_not_joined + lenderCounts.counterparty_not_company > 0) {
    notes.push(
      `ℹ️ 대여회사 ${lenderCounts.counterparty_not_joined}건은 corp_code 조인 실패, ` +
        `${lenderCounts.counterparty_not_company}건은 자연인(동일인·친족) 추정으로 자금대여 공시를 ` +
        '대조하지 않았습니다 — 조인 실패는 "공시 없음"이 아니라 **확인하지 못한 것**이고, ' +
        '자연인 추정은 이름 모양에 근거한 추정입니다.',
    );
  }
  if (
    undisclosed.length === 0 &&
    goodsCandidates.length === 0 &&
    secCandidates.length === 0 &&
    lenderCandidates.length === 0 &&
    gmCandidates.length === 0 &&
    gmAggregateOnly.length === 0 &&
    counterCandidates.length === 0
  ) {
    notes.push(
      'ℹ️ 미공시 후보 0건은 "미공시 없음"의 확인이 아닙니다 — 이 도구가 보는 유형(자금차입·자금대여·' +
        '상품·용역((6) 주요 내역 + (5) 총괄 보완)·유가증권 총괄)과 이 문서에 실린 거래의 범위 안에서 ' +
        '후보를 찾지 못했다는 뜻입니다 (scope_caveats 참조).',
    );
  }
  if (windowOnly.length > 0) {
    notes.push(
      `⚠️ 창 안에 같은 유형 공시는 있으나 차입일 근방(−${NEAR_BEFORE_DAYS}~+${NEAR_AFTER_DAYS}일)에는 ` +
        `없는 차입이 ${windowOnly.length}건 있습니다 (j001_filing_in_window_only) — 연초 한도 의결이 ` +
        '커버하는 정상 케이스일 수도, **일부 차입만 공시한 부분 누락**일 수도 있습니다. ' +
        'nearest_filing_gap_days 와 matching_filings 내용 대조로 확인하세요.',
    );
    // 같은 회사에서 근접 공시가 있는 차입과 없는 차입이 갈리면 부분 공시 신호가 더 강하다
    const nearCompanies = new Set(nearDate.map((b) => normalizeCompanyName(b.company)));
    const mixed = [
      ...new Set(
        windowOnly
          .filter((b) => nearCompanies.has(normalizeCompanyName(b.company)))
          .map((b) => b.company),
      ),
    ];
    if (mixed.length > 0) {
      notes.push(
        `⚠️ ${mixed.join(', ')} 은(는) **일부 차입에만 근접 공시가 있습니다** — 건별로 공시했다면 ` +
          '나머지 차입의 공시가 누락됐을 가능성이 상대적으로 높은 패턴입니다. 우선 확인 대상입니다.',
      );
    }
  }
  if (noDuty.length > 0) {
    notes.push(
      `ℹ️ 차입 ${noDuty.length}건은 계열편입일(포털 grinil) 이전 거래라 no_duty_before_joining 으로 ` +
        '분리했습니다 — 편입 전에는 공시의무가 없습니다. 단 편입일 데이터 정확성·재편입 여부는 확인하지 않았습니다.',
    );
  }
  if (cancelledMatchingSeen.size > 0) {
    notes.push(
      `ℹ️ '[공시취소]' 접수분 ${cancelledMatchingSeen.size}건은 공시 존재의 근거로 쓰지 않았습니다 — ` +
        '취소는 공시를 없앤 기록입니다 (other_j001_in_window 로 집계).',
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
      `ℹ️ 상품·용역 ${goodsUnjudgeable.length}건(상대방별 합산 기준)은 미공시 후보 판정에 올리지 ` +
        '않았습니다 (goods_services_not_judgeable) — 연간 합산이 4×기준금액 미만이면 분기 기준 초과 ' +
        '여부를 원리상 판정할 수 없습니다 (분기별 합계는 각 사 내부 데이터로만 확인됩니다).',
    );
  }
  if (goodsItemCaveats4x.length > 0) {
    notes.push(
      `ℹ️ 연간 금액이 4×기준금액 이상인데도 후보로 올리지 않은 행이 ${goodsItemCaveats4x.length}건 ` +
        '있습니다 (goods_services_item_caveats) — 품목이 배당·이자·임대차 등 **상품·용역 거래의 대가가 ' +
        '아닐 가능성**이 높아서입니다 (item_caveat 참조). 실제로 상품·용역 거래라면 후보에 준해 확인이 필요합니다.',
    );
  }
  if (goodsNotJudged.length > 0) {
    notes.push(
      `⚠️ 상품·용역 신호 ${goodsNotJudged.length}건은 조인 실패·예산 초과·수집 불완전으로 J001 대조를 ` +
        '하지 못했습니다 (goods_services_signals 중 status:"not_judged") — "후보 아님"이 아니라 확인하지 못한 것입니다.',
    );
  }
  if (gmNotJudged.length > 0) {
    notes.push(
      `⚠️ (5) 총괄 보완 신호 ${gmNotJudged.length}건은 기준금액 미상(자본 미확인)·조인 실패·예산 초과· ` +
        '수집 불완전으로 판정하지 못했습니다 (goods_services_matrix_signals 중 status:"not_judged") — ' +
        '"후보 아님"이 아니라 확인하지 못한 것입니다.',
    );
  }
  if (partialLists) {
    notes.push(
      '⚠️ 일부 목록 수집이 불완전합니다 (측정 실패·절단·부분결과) — "공시 없음" 판정이 수집 누락일 수 ' +
        '있으니 diagnostics 를 확인하세요.',
    );
  }
  const zeroRowChecks: Array<[string, number, string]> = [
    ['재무현황', capitals.length, '자본 행'],
    ['자금거래', borrowings.length, '차입 건'],
    ['주요 상품·용역', goods.length, '거래 행'],
  ];
  for (const [section, count, unit] of zeroRowChecks) {
    if (count === 0 && parseDiag.sections_found.includes(section)) {
      notes.push(
        `ℹ️ ${section} 절은 있으나 추출된 ${unit}이 0건입니다 — 실제로 없거나("해당사항 없음"), ` +
          '표 구조가 실측 서식과 달라 파서가 못 읽은 것일 수 있습니다.',
      );
    }
  }
  if (!input.group) {
    notes.push(
      `ℹ️ rcept_no 경로의 fiscal_year(${fiscalYear})는 접수월 기반 추정입니다 — 4월 이후에 제출된 ` +
        '전년도 의무분(해 넘긴 지연 제출)이면 실제 거래 연도와 어긋날 수 있습니다. ' +
        '문서 표지의 대상 연도를 확인하세요.',
    );
  }
  if (sourceIsCorrection) {
    notes.push('ℹ️ 정정 접수분(최신본)을 읽었습니다 — 원본이 아니라 정정 반영 내용 기준입니다.');
  }

  log.info('미공시 교차탐지 완료', {
    rcept_no: sourceRceptNo,
    borrowings: borrowings.length,
    goods: goods.length,
    candidates: undisclosed.length,
    goodsConditionalCandidates: goodsCandidates.length,
    securitiesPairs: securitiesMatrix.cells.length,
    securitiesCandidates: secCandidates.length,
    goodsMatrixSupplemented: judgedGoodsMatrix.length,
    goodsMatrixCandidates: gmCandidates.length + gmAggregateOnly.length,
    lenderCandidates: lenderCandidates.length,
    populationSource,
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
      j001_filing_near_date: nearDate.length,
      j001_filing_in_window_only: windowOnly.length,
      below_threshold: below.length,
      no_duty_before_joining: noDuty.length,
      not_judged: notJudged.length,
      /** J001 부재 + 상대방 요건(총수일가 20%↑ 출자) 미확인 — "후보 확정"이 아니다 */
      goods_services_candidates_if_qualified: goodsCandidates.length,
      goods_services_filing_exists: goodsFilingExists.length,
      goods_services_not_judged: goodsNotJudged.length,
      goods_services_not_judgeable: goodsUnjudgeable.length,
      goods_services_item_caveats: caveatRows.length,
      /** (5) 총괄표에서 (6)에 없는 쌍만 뽑은 보완 신호 — 중복은 쌍 키로 제거했다 */
      goods_services_matrix_pairs_extracted: goodsMatrixSeed.cells.length,
      goods_services_matrix_pairs_supplemented: judgedGoodsMatrix.length,
      goods_services_matrix_pairs_also_in_major_detail: goodsMatrixPairsAlsoInDetail,
      /**
       * 회사명이 달라 중복 제거를 비껴갔지만 (6)에 **같은 매출회사·같은 금액** 행이 있는 쌍.
       * 같은 거래가 양쪽에 실렸을 수 있으니 후보 수를 셀 때 이 수를 빼고 세어야 할 수 있다.
       */
      goods_services_matrix_possible_duplicates: goodsMatrixPossibleDuplicates,
      /** 연간 총액 ≥ 4×기준금액(비둘기집 성립) + J001 부재 — (6) 경로와 같은 강도의 조건부 후보 */
      goods_services_matrix_candidates_if_qualified: gmCandidates.length,
      /** 총액만 기준 이상 — 분기로 나누면 전부 미달일 수 있어 "후보"가 아니라 확인 대상이다 */
      goods_services_matrix_candidates_aggregate_only: gmAggregateOnly.length,
      goods_services_matrix_filing_exists: gmFilingExists.length,
      goods_services_matrix_below_threshold: gmBelow.length,
      goods_services_matrix_not_judged: gmNotJudged.length,
      /** 국외 계열회사 상대 — 법 §26①·고시 §2③2호가 특수관계인에서 제외해 후보가 아니다 */
      goods_services_matrix_foreign_affiliate: gmForeign.length,
      securities_foreign_affiliate: secForeign.length,
      securities_pairs_extracted: securitiesMatrix.cells.length,
      /** 연간 총액이 기준금액 이상 + 유형 J001 부재 — "미공시 후보"가 아니라 확인 대상이다 */
      securities_candidates_aggregate_only: secCandidates.length,
      securities_filing_exists: secFilingExists.length,
      securities_below_threshold: secBelow.length,
      securities_not_judged: secNotJudged.length,
      /**
       * 대여회사(자금을 대준 계열회사) 쪽 판정 — 차입 **건 단위** 집계다.
       * 차입회사 쪽 판정과 독립적이다 (기준금액이 각자의 자본이라 한쪽만 초과일 수 있다).
       */
      lender_side: lenderCounts,
      /**
       * 거래 **상대방 쪽** 판정 (상품·용역 매입회사 / 유가증권 매도회사) — 신호 단위 집계다.
       * 판매·매입 쪽 판정과 독립적이다 (기준금액이 각자의 자본이라 한쪽만 초과일 수 있다).
       */
      counterparty_side: counterCounts,
    },
    /** 자금 차입 — 차입일 단위 대조라 신뢰도가 가장 높다 */
    undisclosed_candidates: undisclosed,
    j001_filing_near_date: nearDate,
    j001_filing_in_window_only: windowOnly,
    below_threshold: below,
    ...(noDuty.length ? { no_duty_before_joining: noDuty } : {}),
    ...(notJudged.length ? { not_judged: notJudged } : {}),
    /** 상품·용역 — (판매회사, 상대방) 연간 합산 기반 제한적 신호 (quarterly_logic 참조) */
    goods_services_signals: [...goodsCandidates, ...goodsFilingExists, ...goodsNotJudged],
    ...(goodsUnjudgeable.length
      ? { goods_services_not_judgeable: goodsUnjudgeable }
      : {}),
    ...(caveatRows.length ? { goods_services_item_caveats: caveatRows } : {}),
    /**
     * 상품·용역 (5) **총괄표** 보완 — (6) 주요 내역에 없는 쌍만 담는다.
     * 연간 총액 기반이고 품목이 없어 (6) 신호보다 한 단계 약하다 (각 항목의 caveat 참조).
     */
    ...(judgedGoodsMatrix.length
      ? {
          goods_services_matrix_signals: [
            ...gmCandidates,
            ...gmAggregateOnly,
            ...gmFilingExists,
            ...gmNotJudged,
          ],
          ...(gmBelow.length ? { goods_services_matrix_below_threshold: gmBelow } : {}),
          /** 국외 계열회사 상대 — 공시의무 자체가 없다 (버리지 않고 근거와 함께 남긴다) */
          ...(gmForeign.length ? { goods_services_matrix_foreign_affiliate: gmForeign } : {}),
        }
      : {}),
    /**
     * 유가증권 — 상대방별 **연간 총액** 기반. 개별 거래로 분해되지 않는다는 점에서
     * 차입·상품용역보다 약한 신호다 (scope_caveats 의 §4③ 항목 참조).
     */
    ...(judgedSecurities.length
      ? {
          securities_signals: [...secCandidates, ...secFilingExists, ...secNotJudged],
          ...(secBelow.length ? { securities_below_threshold: secBelow } : {}),
          ...(secForeign.length ? { securities_foreign_affiliate: secForeign } : {}),
        }
      : {}),
    ...(joinFailures.length ? { join_failures: joinFailures } : {}),
    coverage: {
      transaction_types_checked: [
        '자금 차입 — 차입회사 관점 (차입일 단위, 건별 근접 대조)',
        '자금 대여 — 대여회사(거래상대방) 관점 (같은 차입 건을 대여회사 자본 기준으로 재판정)',
        '주요 상품·용역 (6) (상대방별 연간 합산, 4×기준금액 이상만)',
        '상품·용역 총괄 (5) 매트릭스 — (6)에 없는 쌍만 보완 (상대방별 연간 총액)',
        '상품·용역 — 매입회사 관점 (buyer_side, 매입회사 자본 기준으로 재판정)',
        '유가증권 총괄 매트릭스 (상대방별 연간 총액 — 개별 거래로 분해되지 않음)',
        '유가증권 — 매도회사 관점 (seller_side, 매도회사 자본 기준으로 재판정)',
      ],
      undetectable: {
        other_transaction_types: [
          '담보 제공·수취',
          '채무보증',
          '부동산 임대차',
          '기타자산 거래',
        ],
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
      /** 포털 소속회사 목록을 실제로 썼는가 — 'none' 이면 DART 상호 완전일치만으로 조인했다 */
      population_source: populationSource,
      population: {
        ...(populationGroup ? { group: populationGroup } : {}),
        ...(populationYearMonth ? { year_month: populationYearMonth } : {}),
        ...(population
          ? {
              joined_companies: population.corpCodes.size,
              unjoined_companies: population.unjoined.length,
              joined_group_at_known: population.joinedGroupAt?.size ?? 0,
            }
          : {}),
        ...(populationReason ? { reason: populationReason } : {}),
        /** 문서에서 집단명을 읽어 포털을 조회했는가 (rcept_no 경로 전용) */
        from_document: !input.group && populationSource === 'portal',
      },
      list_calls: listCalls,
      /**
       * 동명 2건 이상을 **법인등록번호**(포털 jurirno ↔ DART 기업개황 jurir_no)로 확정한 건.
       * 이름으로는 고를 수 없던 회사이므로 근거를 남긴다.
       */
      jurir_disambiguation: {
        lookups: jurirLookups,
        lookup_budget: MAX_JURIR_LOOKUPS,
        max_candidates_per_name: MAX_JURIR_CANDIDATES,
        resolved: jurirResolved,
      },
      companies_searched: searches.size,
      companies_over_budget: overBudgetKeys.size,
      partial_results: partialLists,
      j001_window: { lookback_days: LOOKBACK_DAYS, to: 'today' },
      near_window: { before_days: NEAR_BEFORE_DAYS, after_days: NEAR_AFTER_DAYS },
      /** (5) 상품·용역 총괄 매트릭스 — 파서 진단 + (6)과의 중복 제거 결과 */
      goods_services_matrix: {
        tables: goodsMatrixSeed.tables,
        cells: goodsMatrixSeed.cells.length,
        tables_unrecognized: goodsMatrixSeed.tablesUnrecognized,
        tables_without_unit: goodsMatrixSeed.tablesWithoutUnit,
        unit_inherited_tables: goodsMatrixSeed.unitInheritedTables,
        duplicate_pairs: goodsMatrixSeed.duplicatePairs,
        /** (6) 주요 내역에 이미 있어 보완하지 않은 쌍 수 (중복 방지가 실제로 동작한 횟수) */
        pairs_also_in_major_detail: goodsMatrixPairsAlsoInDetail,
        /** 이름은 달랐지만 (6)에 같은 매출회사·같은 금액 행이 있어 중복 의심으로 표시한 쌍 수 */
        possible_duplicates: goodsMatrixPossibleDuplicates,
        /** 회사 목록에서 확인되지 않은 매입회사 이름 (표기 흔들림·국외 계열사 등) */
        counterparties_not_in_known_list: [
          ...new Set(
            judgedGoodsMatrix
              .filter((m) => m.counterparty_in_known_list === false)
              .map((m) => m.counterparty),
          ),
        ],
      },
      securities_matrix: {
        tables: securitiesMatrix.tables,
        cells: securitiesMatrix.cells.length,
        tables_unrecognized: securitiesMatrix.tablesUnrecognized,
        tables_without_unit: securitiesMatrix.tablesWithoutUnit,
        unit_inherited_tables: securitiesMatrix.unitInheritedTables,
        duplicate_pairs: securitiesMatrix.duplicatePairs,
        /** 회사 목록에서 확인되지 않은 거래상대방 이름 (표기 흔들림·국외 계열사 등) */
        counterparties_not_in_known_list: [
          ...new Set(
            judgedSecurities
              .filter((sec) => sec.counterparty_in_known_list === false)
              .map((sec) => sec.counterparty),
          ),
        ],
      },
    },
  };
}
