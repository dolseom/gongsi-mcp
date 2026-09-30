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
const FLOOR_5 = 5 * 억;
/** 령 §33①2호 — 자본 대비 비율 */
const CAPITAL_RATE = 0.05;

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

/**
 * 원 단위 금액 표기 — 모든 도구가 이 하나를 쓴다 (도구마다 자릿수가 달라 같은 금액이 달리 보였다).
 * 1억 이상은 소수 둘째 자리까지 **내림**하고 끝의 0은 지운다. 반올림하면 99.996억이 "100억원"으로
 * 보여 "100억 미만"이라는 같은 판정의 사유와 모순된다. 백만원 단위 정수로 잘라 부동소수 오차를 피한다.
 */
export function formatWon(n: number): string {
  if (n >= 억) return `${Math.floor(n / 1_000_000) / 100}억원`;
  return `${n.toLocaleString('ko-KR')}원`;
}

const fmt = formatWon;

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
  // ⚠️ 한쪽이 미입력이면 **입력된 쪽만으로** 계산한다. 미입력을 0 으로 표기하면 "자본금 0원"이라는
  //    존재하지 않는 사실이 산식에 박힌다. 미입력 쪽이 더 크면 실제 기준금액은 이보다 **높을 수만**
  //    있다(max) — 그래서 이 값은 기준금액의 하한이다. 결론이 뒤집히는지는 호출자가 판단한다.
  const base = Math.max(totalEquity ?? 0, paidInCapital ?? 0);
  const byRate = base * CAPITAL_RATE;
  const rateApplied = Math.max(FLOOR_5, byRate);
  const threshold = Math.min(CAP_100, rateApplied);

  const equityLabel = isPic ? '순자산총계' : '자본총계';
  const capitalLabel = isPic ? '기본순자산' : '자본금';
  const show = (v: number | undefined) => (v === undefined ? '미입력' : fmt(v));
  const missingSide: ThresholdResult['missingSide'] =
    totalEquity === undefined ? 'totalEquity' : paidInCapital === undefined ? 'paidInCapital' : undefined;

  const parts: string[] = [];
  parts.push(
    `max(${equityLabel} ${show(totalEquity)}, ${capitalLabel} ${show(paidInCapital)}) = ${fmt(base)}` +
      (missingSide ? ' (입력된 값만으로 계산)' : ''),
  );
  parts.push(`× 5% = ${fmt(byRate)}`);
  if (byRate < FLOOR_5) parts.push(`→ 5억원 미만이므로 하한 적용 = ${fmt(FLOOR_5)}`);
  parts.push(`min(100억원, ${fmt(rateApplied)}) = ${fmt(threshold)}`);
  if (missingSide) {
    parts.push(
      `※ ${missingSide === 'totalEquity' ? equityLabel : capitalLabel} 미입력 — 그 값이 더 크면 기준금액은 이보다 높아질 수 있습니다(하한값)`,
    );
  }

  return {
    threshold,
    formula: parts.join('  '),
    inputs: { totalEquity, paidInCapital },
    legalBasis: isPic ? REF_PIC : REF_LIT,
    ...(missingSide ? { missingSide } : {}),
  };
}

/**
 * 자본총계·자본금 중 한쪽만 입력된 상태에서 **결론이 미입력 값에 따라 뒤집힐 수 있는가.**
 *
 * 기준금액 = min(100억, max(5억, max(A, B) × 5%)) 이므로 미입력 쪽은 기준금액을 **올리기만** 한다.
 *  - 거래금액 < 계산된 기준금액  → 미입력 값이 무엇이든 대상 아님 (확정)
 *  - 거래금액 ≥ 100억원          → 미입력 값이 무엇이든 대상 (확정)
 *  - 그 사이                     → 미입력 값 × 5% 가 거래금액을 넘으면(= 미입력 값 > 거래금액 × 20) 뒤집힌다
 *
 * @returns 뒤집힐 수 있으면 그 경계값(미입력 값이 이 금액을 **초과**하면 대상 아님), 아니면 null
 */
export function incompleteCapitalFlipPoint(
  amount: number,
  t: ThresholdResult,
): number | null {
  if (!t.missingSide) return null;
  if (amount < t.threshold) return null;
  if (amount >= CAP_100) return null;
  return amount / CAPITAL_RATE;
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
  // ★ 관리비·부가세 제외 — lit26-046 "부가가치세와 관리비는 포함되지 않음 다만, 해당 부동산임대차 거래가 거래상대방 중
  //   일방에게 상품ㆍ용역거래에 해당하는 경우에는 기업회계기준에 따라 관리비가 매출로 인식이 된다면 거래금액에 포함해야 함"
  //   / 매뉴얼(2026-04) 거래유형별 거래금액 산정 기준 "부동산임대차거래금액에 관리비는 포함되지 않음"
  lease_annualized:
    '연간임대료 + 계약기간 보증금을 「부가가치세법 시행규칙」 제47조 이율로 환산한 연간임대료의 합산액. ' +
    '관리비·부가가치세는 거래금액에 포함하지 않습니다 (공정위 문답 lit26-046, 매뉴얼 "부동산임대차거래금액에 관리비는 ' +
    '포함되지 않음") — 단 이 임대차가 거래당사자 한쪽에게 상품·용역거래이고 관리비를 기업회계기준상 매출로 인식하면 ' +
    '관리비도 포함합니다 (같은 문답)',
  // ★ 퇴직연금 등 총액 약정 없는 보험 — lit26-032 "…회계연도 동안의 보험료 납입금액의 누적액이 100억 원 이상 또는 …
  //   5% 이상 … 납입할 시점 이전에 이사회 의결 및 공시를 해야 함" / lit26-039 "개인부담금액을 제외하고 회사부담금액을
  //   기준으로" / 매뉴얼 "단체보험중개인과 회사가 공동으로 보험금을 부담하는 경우는 개인부담금액을 제외하고 회사부담금액을 기준"
  insurance_premium_total:
    '보험료총액 (고시 제4조제3항제1호). 보험료 총액 약정이 없는 퇴직연금 등은 가입 회사의 회계연도 동안 납입하는 ' +
    '보험료 누적액이 거래금액이며, 그 누적액이 기준금액에 이르는 시점 **이전에** 이사회 의결·공시해야 합니다 (공정위 ' +
    '문답 lit26-032, 매뉴얼 거래금액 산정 기준) — 기준은 회사가 납입하는 보험료이지 퇴직금 지급액이 아닙니다. 개인과 ' +
    '회사가 함께 부담하는 보험(개인연금·단체보험 등)은 개인부담금액을 제외한 회사부담금액 기준입니다 (lit26-039, 매뉴얼). ' +
    'IRP(개인형 퇴직연금)로의 이전이 공시 대상인지는 원문 미확인입니다',
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
