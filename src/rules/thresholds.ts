/**
 * 기준금액 판정
 *
 * 대규모내부거래 (법 §26 / 령 §33① / 고시 §2③):
 *   기준금액 = min(100억원, max(5억원, max(자본총계, 자본금) × 5%))
 *
 * ⚠️ 흔히 통용되는 "50억원 기준"은 폐지된 옛 기준이다. 현행은 100억원.
 */

import type { AmountBasis, LegalRef, ThresholdResult } from './types.js';

export const 억 = 100_000_000;
/** 령 §33①1호 — 절대 상한 */
export const CAP_100 = 100 * 억;
/** 령 §33①2호 단서 — 하한 */
export const FLOOR_5 = 5 * 억;
/** 령 §33①2호 — 자본 대비 비율 */
export const CAPITAL_RATE = 0.05;

const REF_LIT: LegalRef[] = [
  {
    source: '독점규제 및 공정거래에 관한 법률 시행령 제33조제1항',
    summary:
      '대규모내부거래의 규모는 거래금액이 ①100억원 ②자본총계 또는 자본금 중 큰 금액의 5%(5억원 미만이면 5억원) 중 낮은 금액 이상인 것으로 한다.',
  },
  {
    source: '대규모내부거래 등에 대한 이사회 의결 및 공시에 관한 규정 제2조제3항',
    summary:
      '자본총계는 주주총회에서 승인된 최근 사업연도말 재무제표상 자본총계를, 자본금은 이사회 의결일 직전일의 자본금을 말한다.',
  },
];

const REF_PIC: LegalRef[] = [
  {
    source: '독점규제 및 공정거래에 관한 법률 시행령 제36조제1항',
    summary:
      '공익법인의 거래행위 규모는 ①100억원 ②순자산총계 또는 기본순자산 중 큰 금액의 5%(5억원 미만이면 5억원) 중 낮은 금액 이상인 것으로 한다.',
  },
];

export interface CapitalInput {
  /** 자본총계 (공익법인은 순자산총계). 주총 승인된 최근 사업연도말 재무제표 기준 */
  totalEquity?: number;
  /** 자본금 (공익법인은 기본순자산). 이사회 의결일 직전일 기준 */
  paidInCapital?: number;
}

function fmt(n: number): string {
  if (n >= 억) {
    const v = n / 억;
    return `${Number.isInteger(v) ? v : v.toFixed(2)}억원`;
  }
  return `${n.toLocaleString('ko-KR')}원`;
}

/**
 * 대규모내부거래 기준금액을 계산한다.
 * 자본총계·자본금이 모두 없으면 null 을 반환한다 (추정하지 않는다).
 */
export function calcThreshold(
  input: CapitalInput,
  opts: { entity?: 'company' | 'public_interest_corp' } = {},
): ThresholdResult | null {
  const { totalEquity, paidInCapital } = input;
  if (totalEquity === undefined && paidInCapital === undefined) return null;

  const isPic = opts.entity === 'public_interest_corp';
  const base = Math.max(totalEquity ?? 0, paidInCapital ?? 0);
  const byRate = base * CAPITAL_RATE;
  const rateApplied = Math.max(FLOOR_5, byRate);
  const threshold = Math.min(CAP_100, rateApplied);

  const equityLabel = isPic ? '순자산총계' : '자본총계';
  const capitalLabel = isPic ? '기본순자산' : '자본금';

  const parts: string[] = [];
  parts.push(`max(${equityLabel} ${fmt(totalEquity ?? 0)}, ${capitalLabel} ${fmt(paidInCapital ?? 0)}) = ${fmt(base)}`);
  parts.push(`× 5% = ${fmt(byRate)}`);
  if (byRate < FLOOR_5) parts.push(`→ 5억원 미만이므로 하한 적용 = ${fmt(FLOOR_5)}`);
  parts.push(`min(100억원, ${fmt(rateApplied)}) = ${fmt(threshold)}`);

  return {
    threshold,
    formula: parts.join('  '),
    inputs: { totalEquity, paidInCapital },
    legalBasis: isPic ? REF_PIC : REF_LIT,
  };
}

/**
 * 거래금액이 기준금액 이상인지 판정한다.
 * 고시 §4③ — 산정 방식이 거래유형별로 다르므로 basis 를 함께 받는다.
 */
export function isLargeInternalTransaction(
  amount: number,
  threshold: number,
): boolean {
  return amount >= threshold;
}

/** 거래금액 산정 방식 설명 — 고시 §4③ */
export const AMOUNT_BASIS_GUIDE: Record<AmountBasis, string> = {
  actual: '실제 거래금액',
  collateral_limit: '담보한도액 (담보금액이 아님)',
  lease_annualized:
    '연간임대료 + 계약기간 보증금을 「부가가치세법 시행규칙」 제47조 이율로 환산한 연간임대료의 합산액',
  insurance_premium_total: '보험료총액',
  quarterly_sum: '분기에 이루어질 거래금액의 합계액',
};

/**
 * 비상장회사 중요사항 공시 임계값 (법 §27 / 령 §34④ / 고시 §5의2①)
 * 값은 기준이 되는 재무수치에 곱할 비율이다.
 */
export const UNLISTED_MATERIAL_THRESHOLDS = {
  /** 고정자산(실무 서식은 "비유동자산") 취득·처분: 자산총액의 10% */
  fixed_asset: { rate: 0.1, base: 'totalAssets', label: '고정자산 취득 또는 처분' },
  /** 타법인(계열 제외) 주식·출자증권 취득·처분: 자기자본의 5% */
  other_corp_stock: { rate: 0.05, base: 'equity', label: '다른 법인의 주식 및 출자증권 취득 또는 처분' },
  /** 증여(수증 포함): 자기자본의 1% */
  gift: { rate: 0.01, base: 'equity', label: '증여' },
  /** 타인을 위한 담보제공·채무보증: 자기자본의 5% */
  guarantee: { rate: 0.05, base: 'equity', label: '타인을 위한 담보제공 또는 채무보증' },
  /** 채무 면제·인수: 자기자본의 5% */
  debt_relief: { rate: 0.05, base: 'equity', label: '채무 면제 또는 인수' },
  /** 최대주주·주요주주 지분 변동: 발행주식총수의 1% */
  shareholding_change: { rate: 0.01, base: 'shares', label: '최대주주·주요주주 주식보유비율 변동' },
} as const;

/** 금액 무관 — 결정 시 공시 대상 */
export const UNLISTED_MATERIAL_UNCONDITIONAL = [
  '증자 또는 감자에 관한 결정',
  '전환사채·신주인수권부사채 발행에 관한 결정',
  '영업양도·양수·임대, 합병, 간이합병, 소규모합병, 분할·분할합병 결정',
  '주식의 포괄적 교환·이전 결정',
  '해산사유 발생',
  '회생절차 개시·종결·폐지 결정',
  '기업구조조정 촉진법상 관리절차 개시·중단·종료 결정',
] as const;

/**
 * 비상장회사 중요사항 공시에서 쓰는 자기자본.
 * 고시 §5의2③ — 자기자본이 자본금에 미달하면 최근 자본금을 자기자본으로 본다.
 */
export function effectiveEquity(equity: number, paidInCapital: number): number {
  return equity < paidInCapital ? paidInCapital : equity;
}
