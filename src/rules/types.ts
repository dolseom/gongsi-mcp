/**
 * 공정거래법상 공시의무 판정 룰 엔진 — 공통 타입
 *
 * 모든 판정 결과는 근거(legalBasis)와 계산식(formula)을 반드시 동봉한다.
 * 불확실하면 추정하지 않고 insufficient_data 를 반환한다.
 */

/** YYYYMMDD 형식 날짜 문자열 */
export type YMD = string;

/** 공시의무 유형 */
export type DutyType =
  /** 대규모내부거래 — 법 §26 / 령 §33 */
  | 'large_internal_transaction'
  /** 비상장회사 등의 중요사항 — 법 §27 / 령 §34 */
  | 'unlisted_material'
  /** 기업집단현황 — 법 §28 / 령 §35 */
  | 'group_status'
  /** 특수관계인인 공익법인 — 법 §29 / 령 §36 */
  | 'public_interest_corp'
  /** 약관에 의한 금융거래 특례 — 고시 §9 */
  | 'omnibus_financial'
  /** 하도급대금 결제조건 (J009) — 하도급법 §13의3 / 하도급법 시행령 §8의2 */
  | 'subcontract_payment_terms';

/** 상장 여부 — 공시기한이 갈린다 */
export type ListingStatus = 'listed' | 'unlisted';

/** 대규모내부거래 거래유형 — 고시 §4① */
export type TransactionType =
  /** 1호: 가지급금·대여금 등 자금 */
  | 'fund'
  /** 2호: 주식·회사채 등 유가증권 (담보 제공/수취 포함) */
  | 'securities'
  /** 3호: 부동산·무체재산권 등 자산 (담보, 부동산임대차 포함) */
  | 'asset'
  /** 4호: 동일인 등 출자 계열회사와의 상품·용역 */
  | 'goods_services';

/**
 * 거래금액 산정 방식 — 고시 §4③
 * 단순 거래금액이 아닌 경우가 있어 별도로 받는다.
 */
export type AmountBasis =
  /** 실제 거래금액 */
  | 'actual'
  /** 담보제공: 담보한도액 (담보금액이 아님) */
  | 'collateral_limit'
  /** 부동산임대차: 연간임대료 + 보증금 환산액 */
  | 'lease_annualized'
  /** 보험계약: 보험료총액 */
  | 'insurance_premium_total'
  /** 상품·용역: 분기 거래금액 합계액 */
  | 'quarterly_sum';

/** 판정 결과 */
export type Verdict = 'required' | 'not_required' | 'insufficient_data';

/** 법령 근거 */
export interface LegalRef {
  /** 예: "독점규제 및 공정거래에 관한 법률 제26조제1항" */
  source: string;
  /** 해당 조문의 요지 */
  summary: string;
}

/** 기준금액 계산 결과 */
export interface ThresholdResult {
  /** 적용된 기준금액 (원) */
  threshold: number;
  /** 사람이 읽는 계산식 */
  formula: string;
  /** 계산에 쓰인 입력값 */
  inputs: {
    totalEquity?: number;
    paidInCapital?: number;
  };
  legalBasis: LegalRef[];
}

/** 기한 계산 결과 */
export interface DeadlineResult {
  /** 공시 기한 (YYYYMMDD) */
  deadline: YMD;
  /** 적용 규칙 설명 */
  rule: string;
  /** 영업일 며칠인지 */
  businessDays: number;
  /** 만료일이 비영업일이라 다음 영업일로 밀렸는지 */
  adjustedToNextBusinessDay: boolean;
  /** 공휴일 데이터가 미검증이면 경고 */
  warnings: string[];
  legalBasis: LegalRef[];
}

/** 과태료 산정 결과 */
export interface PenaltyResult {
  /** 최종 예상 과태료 (원) */
  amount: number;
  /** 기본금액 (원) */
  baseAmount: number;
  /** 일수 가산액 (원) */
  dailySurcharge: number;
  /** 적용된 가중 (비율) */
  aggravations: Array<{ reason: string; rate: number }>;
  /** 적용된 감경 (비율) */
  mitigations: Array<{ reason: string; rate: number }>;
  /** 상한 적용 여부 */
  capApplied: boolean;
  formula: string;
  /** 다음 감경 구간 경계 — "3일 뒤면 얼마" 를 보여주기 위함 */
  nextThreshold?: { delayDays: number; amountIfDelayed: number; note: string };
  legalBasis: LegalRef[];
  disclaimer: string;
}
