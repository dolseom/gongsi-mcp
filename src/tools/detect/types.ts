/**
 * detect_undisclosed_transactions 의 주입점·신호 타입 (런타임 코드 없음)
 */

import type { Disclosure } from '../../clients/dart.js';
import type { BatchResult } from '../../search/batch.js';
import type { DocMeta } from '../read-disclosure.js';
import type { Population, PopulationInput } from '../audit-group-disclosures.js';
import type { JurirNoFetch } from '../../resolver/corp-index.js';
import type { AmbiguousSubjectClass } from './filing-doc.js';
import type { Certainty, ThresholdView } from './threshold.js';

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
   * 상호 **부분일치** 검색 (상한 `WARM_SEARCH_LIMIT`건). 자동 워밍에서 완전일치가 0건인
   * 이름의 후보를 찾는 데만 쓴다 — 로컬 인덱스 조회라 API 콜이 아니다.
   *
   * ★ 여기서 찾은 후보는 **후보일 뿐이다.** 조인 확정은 언제나 법인등록번호 1건 일치로만 한다
   *   (이름 유사도로 고르면 합병 전 옛 법인을 잡는다 — `disambiguateByJurirNo` 주석 참조).
   */
  searchCorps: (fragment: string) => Array<{ corpCode: string; corpName: string }>;
  /**
   * DART 기업개황으로 한 회사의 **법인등록번호**를 얻는다 (조회 1회 = API 콜 1회, 결과는 캐시).
   * 동명 2건 이상이라 이름으로 못 고르는 회사를 포털 `jurirno` 와 대조해 확정하는 데 쓴다.
   */
  fetchJurirNo: (corpCode: string) => Promise<JurirNoFetch>;
  /**
   * 이 접수번호의 원문이 **이미 캐시에 있는가** — 원문 열기 예산을 콜이 실제로 나가는 건에만
   * 쓰기 위한 사전 확인이다 (캐시 히트는 60초 벽과 무관하다).
   */
  isDocCached: (rceptNo: string) => boolean;
  /**
   * 이 법인의 법인등록번호가 **이미 저장소에 있는가** — 조회 **횟수** 예산(`MAX_JURIR_LOOKUPS`·
   * `MAX_WARM_LOOKUPS`)을 콜이 실제로 나가는 건에만 쓰기 위한 사전 확인이다.
   *
   * ★ 없으면 "전부 비캐시"로 본다(종전 동작). 주입 테스트는 이 값을 주지 않으므로 카운터
   *   기대값이 그대로 유지된다.
   * ⚠️ 이 확인이 없으면 **이어보기가 제자리를 돈다**: 캐시 히트가 예산을 먹으므로 다시
   *   호출해도 같은 이름들이 같은 예산을 다시 먹고, 뒤쪽 이름은 영원히 대조되지 않는다.
   */
  isJurirCached?: (corpCode: string) => boolean;
  /**
   * 시계 주입점 — **시간 예산 테스트를 실제 sleep 없이** 돌리기 위한 것이다 (기본 Date.now).
   * 판정에는 쓰지 않는다 (판정 기준일은 `input.today`).
   */
  now?: () => number;
  /**
   * ── 이어보기(continuation) 저장소 3종 ──
   *
   * ★ **이 저장소는 토큰이 있는 호출에서만 읽는다.** "공시 목록은 캐시하지 않는다"는 설계
   *   불변식은 신규 호출에 그대로 성립한다 — 토큰 없이 부르면 목록은 언제나 새로 받는다.
   *   이어보기 캐시는 **한 논리적 실행 안에서만** 쓰는 예외다: 같은 실행의 이어보기에서
   *   앞 호출이 이미 받은 목록을 또 받으면 예산만 쓰고 진전이 없다 (이어보기 자체가 성립하지
   *   않는다). 수명은 `CONTINUATION_TTL_MS`(6시간)로 끊는다.
   */
  kvGet: (key: string) => string | null;
  kvSet: (key: string, value: string) => void;
  /** 접두사가 같은 키를 통째로 지운다 (완주·만료한 토큰의 뒷정리) */
  kvDeletePrefix: (prefix: string) => void;
}

export interface FilingRef {
  rcept_no: string;
  rcept_dt: string;
  report_nm: string;
  viewer_url: string;
  /** 이 공시의 원문을 열었는가 (유형 미상 공시 + 보고서명으로 유형이 확정된 매칭 공시 공통) */
  doc_read?: 'ok' | 'error' | 'budget_exceeded' | 'deadline_exceeded' | 'no_counterparty_field';
  /** 원문 '거래상대방' (정정본은 정정전·정정후가 함께) — 이 거래의 상대방과 대조한 값 */
  doc_counterparties?: string[];
  /** 원문 '거래대상'/'거래목적물' — 유형 참고 */
  doc_subjects?: string[];
  /** 원문 '거래금액' 텍스트 그대로 (단위 혼재: '217 억원' / '12,226'[백만원]) */
  doc_amount_text?: string;
  doc_acode?: string | null;
  doc_error?: string;
  /** 이 공시의 원문 상대방이 이 거래의 상대방과 정규화 일치했다 */
  covers_this_counterparty?: boolean;
  /** 정정본의 정정전 상대방 (대조에 쓰지 않음) */
  doc_superseded_counterparties?: string[];
  /** 원문 거래대상을 판정 유형으로 분류한 값 — 상대방 일치 + 이 분류 일치일 때만 "공시 존재" */
  doc_subject_class?: AmbiguousSubjectClass;
  /**
   * 이 공시가 이 거래를 커버한다고 볼 근거가 됐다.
   * 유형 미상 경로는 **상대방 + 거래대상 분류**가 모두 맞을 때, 보고서명 경로는 유형이 이미
   * 이름으로 확정돼 있어 **상대방**만 맞으면 true 다.
   */
  covers_this_transaction?: boolean;
}

export type TxStatus =
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
export type LenderStatus =
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
 * J001 대조 결과 필드 — 신호 6종(차입·대여·(6)·(5)·유가증권·상대방 관점)이 공유한다.
 * 값은 판정 확정 단계의 `applyCommon` 이 한곳에서 채운다 (타입만의 묶음 — 출력 키 순서는
 * 객체에 값을 넣는 순서가 정한다).
 */
export interface J001CheckFields {
  corp_code?: string;
  j001_search?: { from: string; to: string; type_filter: string };
  matching_filings?: FilingRef[];
  /** matching_filings 가 10건에서 잘렸을 때의 전체 건수 */
  matching_filings_total?: number;
  /** 창 안의 같은 유형 '[공시취소]' 접수분 수 — 매칭 공시가 취소된 원공시일 수 있다 */
  cancellations_of_type_in_window?: number;
  search_partial?: boolean;
  other_j001_in_window?: number;
  /**
   * 같은 유형·같은 창의 공시이지만 **원문 거래상대방이 이 거래 상대방과 달랐던** 건 (최대 5).
   * "공시 없음"이 아니라 "이 거래의 공시로 확인되지 않은 공시"다 — doc_counterparties 를 직접
   * 대조하라는 뜻으로 함께 낸다.
   */
  matching_filings_unconfirmed?: FilingRef[];
  /** matching_filings 의 **원문 거래상대방**까지 이 거래 상대방과 일치함을 확인했다 */
  counterparty_confirmed_by_document?: true;
  /**
   * 상대방이 확인돼 판정이 끝났거나(또는 원문 예산이 소진돼) **열어 보지 않은** 매칭 공시 수.
   * ⚠️ "상대방이 다른 공시"가 아니라 **보지 않은 공시**다 — 확인된 건이 있으면 더 볼 필요가
   * 없어서, 없으면 예산이 없어서다(후자는 reason 에 명시된다).
   */
  matching_filings_not_examined_total?: number;
  /** 이름만으로 유형을 알 수 없어 판정을 보류시킨 공시 — "공시 있음" 확인이 아니다 */
  type_ambiguous_filings?: FilingRef[];
  /** 유형 미상 공시의 **원문 거래상대방**이 이 거래 상대방과 일치해 "공시 존재"로 확정했다 */
  type_ambiguous_resolved_by_document?: true;
}

/**
 * 한 차입 건의 **대여회사 쪽** 공시의무 대조 결과.
 * 기준금액은 대여회사 자신의 자본으로 계산한다 (같은 J004 재무현황 표).
 */
export interface LenderSide extends J001CheckFields {
  /** 대여회사 = 이 차입 건의 거래상대방 */
  company: string;
  status: LenderStatus;
  reason?: string;
  threshold?: ThresholdView;
  certainty?: Certainty;
  joined_group_at?: string;
  nearest_filing_gap_days?: number;
  same_counterparty_annual_total?: number;
  same_counterparty_annual_total_display?: string;
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
export interface CounterpartySide extends J001CheckFields {
  /** 이 관점의 공시의무자 = 원래 신호의 거래상대방 (매입회사 또는 매도회사) */
  company: string;
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
  threshold?: ThresholdView;
  certainty?: Certainty;
  /** 상품·용역 전용 — 연간 총액이 이 회사 기준금액의 4배 이상이면 비둘기집이 선다 */
  quarterly_logic?: GoodsMatrixSignal['quarterly_logic'];
  /** 상품·용역 전용 — 상대방(= 원래 신호의 판매회사) 지분 요건을 확인하지 못했다 */
  counterparty_qualification?: 'not_verified';
}

export interface JudgedBorrowing extends J001CheckFields {
  company: string;
  counterparty: string;
  amount: number;
  amount_display: string;
  date: string | null;
  raw_date?: string;
  table_label: string;
  threshold?: ThresholdView;
  certainty?: Certainty;
  status: TxStatus;
  reason?: string;
  joined_group_at?: string;
  /** 가장 가까운 같은 유형 공시와의 일수 차 (공시 접수일 − 차입일. 음수 = 공시가 앞) */
  nearest_filing_gap_days?: number;
  /**
   * 같은 상대방과의 연간 차입 합산 (원). 개별 건이 기준 미달이어도 §4③(동일 거래상대방·
   * 동일 거래대상 기준 판단)에 따라 합산 기준으로 공시대상일 수 있다 (Codex 4차 C2).
   */
  same_counterparty_annual_total?: number;
  same_counterparty_annual_total_display?: string;
  other_j001_sample?: FilingRef[];
  /** 자금을 대준 계열회사 쪽의 "자금대여" 공시의무 대조 (거래 한 건에 의무자가 둘이다) */
  lender_side?: LenderSide;
}

export interface GoodsItem {
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
export interface GoodsSignal extends J001CheckFields {
  company: string;
  counterparty: string;
  /** 어느 표에서 왔는가 — (6) 주요 내역은 품목·금액이 명시된 강한 원천이다 */
  source: '(6)주요내역';
  annual_amount_total: number;
  annual_amount_total_display: string;
  items: GoodsItem[];
  /**
   * 같은 쌍을 **(5) 총괄표**가 더 크게 적었을 때 그 값 — 판정은 이 값으로 한다.
   *
   * ★ 왜 필요한가 (실물 40문서 측정, 2026-09-08): (6)은 서식상 "거래한 금액이 **일정 규모
   * 이상**인 경우"의 내역만 싣고 그 규모 기준은 우리가 계산하는 기준금액(령 §33①)과 다르다.
   * 그래서 같은 쌍이라도 (5) 총괄표의 연간 총액이 (6) 합산보다 클 수 있다 — 겹친 149쌍 중
   * **30쌍**이 그랬고, 최대는 ㈜케이티 → ㈜케이티에스테이트의 (5) 664.90억 vs (6) 4.04억
   * (164배)다. 종전에는 (6)에 쌍이 있으면 (5) 값을 **비교 없이 버려서**, 그 664.90억이
   * 4.04억으로 판정돼 후보가 통째로 사라졌다.
   */
  matrix_annual_total?: number;
  matrix_annual_total_display?: string;
  /** (5) 총괄 − (6) 합산. (6)이 담지 못한 부분의 크기다 */
  matrix_excess_display?: string;
  /** 판정에 쓴 금액의 출처 — `(5)총괄` 이면 위 승격이 일어났다는 뜻이다 */
  judged_on?: '(6)합산' | '(5)총괄';
  /** (5) 값을 판정에 쓸 때 함께 지는 한계 (품목 부재 등) */
  matrix_caveat?: string;
  /**
   * 같은 쌍이 (6)의 '가.(분기)' 표와 '나.(연1회)' 표에 **모두** 실렸다 — 한쪽이 다른 쪽의
   * 부분기간이라 **더하면 이중 계상**이다. 합산하지 않고 큰 쪽만 썼다.
   * (실물: ㈜케이뱅크 → 비씨카드㈜ 분기 89.39억 + 연1회 244.69억 = 334.08억으로 계상되던
   * 것이, (5) 총괄표의 244.69억과 대조하면 연1회 값만이 연간 총액임이 확인된다.)
   */
  label_overlap?: {
    quarterly_display: string;
    annual_display: string;
    note: string;
  };
  threshold?: ThresholdView;
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
export interface SecuritySignal extends J001CheckFields {
  /** 매입회사 (매트릭스 행) — 이 회사의 J001 을 대조한다 */
  company: string;
  /** 매도회사 (매트릭스 열) */
  counterparty: string;
  /** 직전 사업연도 1년 합계 (원) */
  annual_amount: number;
  annual_amount_display: string;
  threshold?: ThresholdView;
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
export interface GoodsMatrixSignal extends J001CheckFields {
  /** 매출회사 (매트릭스 행) — 이 회사의 J001 을 대조한다 */
  company: string;
  /** 매입회사 (매트릭스 열) */
  counterparty: string;
  source: '(5)총괄';
  /** 직전 사업연도 1년 합계 (원) */
  annual_amount: number;
  annual_amount_display: string;
  threshold?: ThresholdView;
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
  /** 매입(구매)회사 쪽 의무 — 거래 한 건에 의무자가 둘이다 (매뉴얼 lit26-001) */
  buyer_side?: CounterpartySide;
}

/** 품목 성격상 미공시 후보 경로에서 제외한 행 — 합산에도 넣지 않는다 (배당이 합계를 부풀린다) */
export interface GoodsCaveatRow {
  company: string;
  counterparty: string;
  item: string;
  annual_amount: number;
  annual_amount_display: string;
  item_caveat: string;
  threshold?: ThresholdView;
  certainty?: Certainty;
  quarterly_logic: GoodsSignal['quarterly_logic'];
  /** 회사가 다른 신호로 이미 검색된 경우에 한해, 참고용 J001 존재 정보를 동봉 (교차검토 S-9) */
  related_j001?: { goods_type_filings_in_window: number; from: string; to: string };
}

/** 회사 하나의 J001 검색 결과 (회사당 1회만 수집한다) */
export interface CompanySearch {
  corp_code: string;
  from: string;
  to: string;
  rows: Disclosure[];
  partial: boolean;
  error?: string;
}

/**
 * 이어보기 토큰의 메타 — `cont:<token>:meta` 에 JSON 으로 저장한다.
 *
 * ★ **토큰에는 판정 결과를 싣지 않는다.** 토큰은 불투명한 실행 ID 하나이고, 결과는 서버
 *   저장소에만 있다. 클라이언트가 토큰을 손으로 고쳐도 남의 실행을 들여다볼 수 없고
 *   (16바이트 = 128비트 난수, 32자리 16진수), 인자가 어긋나면 아래 검증이 거절한다.
 */
export interface ContinuationMeta {
  /** 이 실행이 읽은 **원천 J004 접수번호** — 다른 문서의 캐시를 섞어 쓰지 않게 하는 열쇠다 */
  rcept_no: string;
  /**
   * 앞 호출의 판정 기준일. 이어보기 호출이 `today` 를 생략하면 **이 값을 쓴다** —
   * 검색창 상한이 호출마다 밀리면 앞 호출과 창이 달라져 한 실행의 결과가 아니게 된다.
   */
  today: string;
  fiscal_year: number;
  /** ISO — TTL 검사 기준 */
  created_at: string;
  /** 이 토큰으로 몇 번 불렸는지 (1부터) */
  calls: number;
}

/** 이 실행에서 재호출로 풀리는 미완주 사유 — 하나라도 있으면 `complete:false` */
export type IncompleteReason =
  | 'companies_over_count_budget'
  | 'companies_over_time_budget'
  | 'company_search_failed_retryable'
  | 'filing_docs_over_fetch_budget'
  | 'filing_docs_over_time_budget'
  | 'warming_over_budget'
  | 'corp_index_not_loaded'
  | 'jurir_disambiguation_skipped';
