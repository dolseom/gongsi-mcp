/**
 * 공시기한 계산
 *
 * ⚠️ 웹에 널리 퍼진 "상장 1일 이내"는 오정보다. 고시 원문은 3영업일이며 단위도 영업일이다.
 */

import {
  addBusinessDays,
  addCalendarDays,
  countCalendarDays,
  hasHolidayData,
  isBusinessDay,
  isHolidayDataVerified,
  nextBusinessDay,
  toDate,
} from './business-days.js';
import type { DeadlineResult, LegalRef, ListingStatus, YMD } from './types.js';

const REF_LIT_DEADLINE: LegalRef[] = [
  {
    source: '대규모내부거래 등에 대한 이사회 의결 및 공시에 관한 규정 제6조제1항',
    summary:
      '상장회사는 이사회 의결 후 3영업일 이내에, 상장회사가 아니거나 공익법인인 경우에는 7영업일 이내에 공시하여야 한다.',
  },
  {
    source: '같은 규정 제6조제2항',
    summary: '공시 마지막 날이 해당 회사의 영업일이 아닌 때에는 다음의 최초 영업일까지 공시하여야 한다.',
  },
];

const REF_UNLISTED: LegalRef[] = [
  {
    source: '공시대상기업집단 소속회사 등의 중요사항 공시에 관한 규정 제5조의2제4항',
    summary: '중요사항은 사유 발생일부터 7영업일 이내에 공시하여야 한다.',
  },
];

// ★ 제9조제3항(의무)과 제5항(선택)은 **적용 대상이 다르다** — 한 문장으로 합치면 "약관 금융거래는 전부
//   분기 모아 익월 10영업일" 이라는 거짓 안심이 된다(비금융사의 일반 약관거래는 거래 후 3·7영업일, 제9조제4항).
const REF_OMNIBUS_ART9_3: LegalRef[] = [
  {
    source: '대규모내부거래 등에 대한 이사회 의결 및 공시에 관한 규정 제9조제1항·제3항',
    summary:
      '금융업 또는 보험업을 영위하는 내부거래공시대상회사(계열 금융회사)가 해당 회사가 영위하는 금융업·보험업과 ' +
      '관련한 일상적인 거래분야에서 약관에 따라 대규모내부거래를 한 경우(이사회 의결 생략 가능), 분기별로 ' +
      '해당 분기 종료 후 익월 10영업일까지 주요내용을 공시하여야 한다.',
  },
];

const REF_OMNIBUS_ART9_5: LegalRef[] = [
  {
    source: '대규모내부거래 등에 대한 이사회 의결 및 공시에 관한 규정 제9조제5항',
    summary:
      '제9조제2항에 따른 약관에 의한 금융거래행위(계열 금융회사와의 약관거래) 중 만기와 중도환매수수료가 없고 ' +
      '수시입출금이 가능한 단기금융상품의 거래행위는 해당 분기 종료 후 익월 10영업일까지 분기별로 일괄하여 ' +
      '공시할 수 있다 (선택 — 거래 후 3·7영업일 공시도 가능).',
  },
];

const REF_OMNIBUS_ART9_4: LegalRef[] = [
  {
    source: '대규모내부거래 등에 대한 이사회 의결 및 공시에 관한 규정 제9조제4항',
    summary:
      '제9조제2항에 따른 약관에 의한 금융거래행위를 한 경우에는 해당 행위 후 3영업일 이내에 공시하여야 한다. ' +
      '다만, 상장회사가 아닌 내부거래공시대상회사등은 해당 금융거래행위 후 7영업일 이내에 공시할 수 있다.',
  },
  {
    source: '같은 규정 제9조제6항 (제6조제2항 준용)',
    summary: '공시 마지막 날이 영업일이 아닌 때에는 다음의 최초 영업일까지 공시한다.',
  },
];

const REF_OMNIBUS_ART9_2: LegalRef[] = [
  {
    source: '대규모내부거래 등에 대한 이사회 의결 및 공시에 관한 규정 제9조제2항',
    summary:
      '내부거래공시대상회사등이 제1항에 해당하지 않는 사유로 계열 금융회사와 약관에 의한 금융거래행위를 하고자 ' +
      '하는 때에는 이사회 의결을 분기별로 일괄하여 할 수 있다(수익증권은 1년 이내의 거래기간을 정하여 일괄 가능). ' +
      '의결내용에는 거래한도·거래대상·거래조건 등 주요내용이 포함되어야 한다.',
  },
  {
    source: '같은 규정 제9조제6항 (제6조제1항·제2항 준용)',
    summary:
      '의결내용은 이사회 의결 후 상장회사 3영업일, 상장회사가 아니거나 공익법인은 7영업일 이내에 공시한다 ' +
      '(공정위 매뉴얼 2026-04 "의결 후 상장 3영업일, 비상장회사 및 공익법인 7영업일 이내").',
  },
];

const REF_GOODS_45: LegalRef[] = [
  {
    source: '같은 규정 제9조의2제2항',
    summary:
      '상품·용역의 실제 거래금액이 이사회 의결금액의 20% 이상 감소된 경우 이사회 의결 없이 분기 종료 후 45일 이내에 실제 거래금액을 공시해야 한다.',
  },
];

const REF_GROUP_STATUS: LegalRef[] = [
  {
    source: '공시대상기업집단 소속회사 등의 중요사항 공시에 관한 규정 제5조제2항',
    summary: '연1회 공시기한은 매년 5월 31일, 분기별 공시기한은 매 분기 종료 후 2개월이다.',
  },
  {
    // b2a c05: 이월 근거를 못 받은 모델이 민법을 끌어왔다 — 이 고시 자체에 단서가 있다
    source: '같은 규정 제5조제2항 단서',
    summary: '공시를 하여야 하는 마지막 날이 해당 회사의 영업일이 아닌 때에는 다음의 최초 영업일까지 공시한다.',
  },
];

function warnIfUnverified(ymd: YMD): string[] {
  const year = ymd.slice(0, 4);
  if (!hasHolidayData(year)) {
    return [`${year}년 공휴일 데이터가 없어 주말만 반영했습니다. 결과가 부정확할 수 있습니다.`];
  }
  if (!isHolidayDataVerified(year)) {
    return [
      `${year}년 공휴일 데이터가 미검증 상태입니다(음력 공휴일·대체공휴일 확인 필요). 기한이 하루 이상 어긋날 수 있으니 반드시 확인하세요.`,
    ];
  }
  return [];
}

function finalize(
  raw: YMD,
  rule: string,
  businessDays: number,
  legalBasis: LegalRef[],
): DeadlineResult {
  const adjusted = nextBusinessDay(raw);
  return {
    deadline: adjusted,
    rule,
    businessDays,
    adjustedToNextBusinessDay: adjusted !== raw,
    warnings: warnIfUnverified(adjusted),
    legalBasis,
  };
}

/**
 * 대규모내부거래 공시기한 — 고시 §6①
 * 상장 3영업일 / 비상장·공익법인 7영업일
 */
export function litDeadline(
  boardDate: YMD,
  listing: ListingStatus | 'public_interest_corp',
): DeadlineResult {
  // ★ 공익법인은 상장 여부와 무관하게 7영업일 — 고시 제6조제1항 "상장회사가 아니거나 공익법인인 경우에는 … 7영업일 이내"
  const n = listing === 'listed' ? 3 : 7;
  const label =
    listing === 'listed' ? '상장회사' : listing === 'public_interest_corp' ? '공익법인' : '비상장회사·공익법인';
  const raw = addBusinessDays(boardDate, n);
  return finalize(
    raw,
    `${label}: 이사회 의결일(${boardDate}) 다음 날부터 ${n}영업일 이내`,
    n,
    REF_LIT_DEADLINE,
  );
}

/**
 * 비상장회사 중요사항 공시기한 — 고시 §5의2④
 * 사유 발생일부터 7영업일
 */
export function unlistedMaterialDeadline(occurredDate: YMD): DeadlineResult {
  const raw = addBusinessDays(occurredDate, 7);
  return finalize(
    raw,
    `사유 발생일(${occurredDate}) 다음 날부터 7영업일 이내`,
    7,
    REF_UNLISTED,
  );
}

const REF_UNLISTED_MAJOR: LegalRef[] = [
  {
    source: '공시대상기업집단 소속회사 등의 중요사항 공시에 관한 규정 제5조의2제4항 단서',
    summary:
      '주요주주의 주식보유비율 변동은 분기마다 공시한다. 이 경우 분기별 공시기한(매 분기 종료 후 2개월, ' +
      '제5조제2항제2호)을 준용한다.',
  },
];

/**
 * 비상장회사 중요사항 중 **주요주주** 지분변동의 분기별 공시기한 — 고시 §5의2④ 단서
 * 사유 발생일이 속한 분기 종료 후 2개월 (최대주주 변동은 7영업일 — unlistedMaterialDeadline 사용)
 */
export function unlistedMajorShareholderDeadline(occurredDate: YMD): DeadlineResult {
  const y = Number(occurredDate.slice(0, 4));
  const m = Number(occurredDate.slice(4, 6));
  const quarterEndMonth = Math.ceil(m / 3) * 3;
  const targetMonth = quarterEndMonth + 2;
  const ty = targetMonth > 12 ? y + 1 : y;
  const tm = targetMonth > 12 ? targetMonth - 12 : targetMonth;
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  const raw: YMD = `${ty}${String(tm).padStart(2, '0')}${String(lastDay).padStart(2, '0')}`;
  return finalize(
    raw,
    `주요주주 지분변동 분기공시: 사유 발생일(${occurredDate})이 속한 분기(${y}년 ${quarterEndMonth}월 말) 종료 후 2개월`,
    0,
    REF_UNLISTED_MAJOR,
  );
}

/**
 * 분기 종료일 검증 — "2분기니까 7월 말" 같은 흔한 착각을 그대로 받으면
 * 기한이 통째로 밀려 30일 지연이 "적법"으로 뒤집힌다 (subcontractPaymentDeadline 과 같은 패턴).
 */
function assertQuarterEnd(quarterEnd: YMD): void {
  const mmdd = quarterEnd.slice(4);
  if (mmdd !== '0331' && mmdd !== '0630' && mmdd !== '0930' && mmdd !== '1231') {
    throw new Error(
      `분기 종료일은 3월 31일·6월 30일·9월 30일·12월 31일 중 하나여야 합니다: ${quarterEnd}`,
    );
  }
}

/**
 * 약관에 의한 금융거래 분기별 공시기한 — 고시 제9조제3항(의무) / 제9조제5항(선택)
 * 해당 분기 종료 후 익월 10영업일까지
 *
 * ⚠️ 날짜 산식은 같지만 **적용 대상이 다르다**:
 *   - `financial_routine` (기본) — 계열 금융회사의 일상적 금융·보험업무 약관거래. 공시 **의무** 기한.
 *   - `short_term_option` — 계열 금융회사와의 약관거래(제9조제2항) 중 만기·중도환매수수료 없고 수시입출금
 *     가능한 단기금융상품. 거래 후 3·7영업일 대신 분기 일괄로 **할 수 있는** 선택지.
 *   그 밖의 제9조제2항 거래는 이 기한이 아니라 `omnibusTransactionDeadline`(거래 후 3·7영업일)이다.
 *
 * @param quarterEnd 분기 종료일 (예: '20260630')
 */
export function omnibusQuarterlyDeadline(
  quarterEnd: YMD,
  basis: 'financial_routine' | 'short_term_option' = 'financial_routine',
): DeadlineResult {
  assertQuarterEnd(quarterEnd);
  // 분기 종료일 다음 날부터 세면 익월 1일부터의 영업일 카운트와 같아진다.
  const raw = addBusinessDays(quarterEnd, 10);
  return finalize(
    raw,
    basis === 'financial_routine'
      ? `계열 금융회사의 일상적 약관거래: 분기 종료(${quarterEnd}) 후 익월 10영업일까지 (제9조제3항)`
      : `단기금융상품 분기 일괄 공시(선택): 분기 종료(${quarterEnd}) 후 익월 10영업일까지 (제9조제5항)`,
    10,
    basis === 'financial_routine' ? REF_OMNIBUS_ART9_3 : REF_OMNIBUS_ART9_5,
  );
}

/**
 * 계열 금융회사와의 약관거래(고시 제9조제2항) — **사전 의결내용** 공시기한.
 * 분기별(수익증권은 1년 이내) 일괄 의결 또는 건별 의결 후 상장 3영업일 / 비상장·공익법인 7영업일 (제9조제6항 → 제6조제1항).
 */
export function omnibusResolutionDeadline(boardDate: YMD, listing: ListingStatus): DeadlineResult {
  const n = listing === 'listed' ? 3 : 7;
  const label = listing === 'listed' ? '상장회사' : '비상장회사·공익법인';
  const raw = addBusinessDays(boardDate, n);
  return finalize(
    raw,
    `약관거래 사전 의결내용 공시 — ${label}: 이사회 의결일(${boardDate}) 다음 날부터 ${n}영업일 이내`,
    n,
    REF_OMNIBUS_ART9_2,
  );
}

/**
 * 계열 금융회사와의 약관거래(고시 제9조제2항) — **실제 거래내역** 공시기한 (제9조제4항).
 * 거래 후 상장 3영업일 / 비상장 7영업일("할 수 있다").
 * 단기금융상품(제9조제5항 세 요건 충족)이면 `omnibusQuarterlyDeadline(qe, 'short_term_option')` 도 선택 가능.
 */
export function omnibusTransactionDeadline(transactionDate: YMD, listing: ListingStatus): DeadlineResult {
  const n = listing === 'listed' ? 3 : 7;
  const label = listing === 'listed' ? '상장회사' : '비상장회사';
  const raw = addBusinessDays(transactionDate, n);
  return finalize(
    raw,
    `약관거래 실제 거래내역 공시 — ${label}: 거래일(${transactionDate}) 다음 날부터 ${n}영업일 이내 (제9조제4항)`,
    n,
    REF_OMNIBUS_ART9_4,
  );
}

/** 날짜가 속한 분기의 종료일 — 거래일로 분기말을 **계산**할 때만 쓴다(추정 아님) */
export function quarterEndOf(ymd: YMD): YMD {
  const y = ymd.slice(0, 4);
  const m = Number(ymd.slice(4, 6));
  const qm = Math.ceil(m / 3) * 3;
  const dd = qm === 3 || qm === 12 ? '31' : '30';
  return `${y}${String(qm).padStart(2, '0')}${dd}`;
}

/**
 * 상품·용역 거래금액 20% 이상 감소 시 공시기한 — 고시 §9의2②
 * 분기 종료 후 45일 (달력일)
 */
export function goodsServicesReducedDeadline(quarterEnd: YMD): DeadlineResult {
  assertQuarterEnd(quarterEnd);
  const raw = addCalendarDays(quarterEnd, 45);
  return finalize(raw, `분기 종료(${quarterEnd}) 후 45일 이내 (달력일)`, 0, REF_GOODS_45);
}

const REF_SUBCONTRACT: LegalRef[] = [
  {
    source: '하도급거래 공정화에 관한 법률 제13조의3제1항',
    summary:
      '공시대상기업집단 소속 원사업자는 하도급대금 지급수단·지급기간·분쟁조정기구 등 결제조건을 공시하여야 한다.',
  },
  {
    source: '하도급거래 공정화에 관한 법률 시행령 제8조의2제2항',
    summary:
      '매 반기가 끝난 날의 다음 날부터 45일 이내에 공정거래위원회가 고시하는 정보시스템을 통해 공시해야 한다.',
  },
];

/**
 * 하도급대금 결제조건 반기별 공시기한 (J009) — 하도급법 시행령 §8의2②
 * 매 반기가 끝난 날의 다음 날부터 45일 이내 (달력일)
 * 상반기(6/30 종료) → 8/14, 하반기(12/31 종료) → 익년 2/14
 *
 * @param halfEnd 반기 종료일 ('YYYY0630' 또는 'YYYY1231')
 */
export function subcontractPaymentDeadline(halfEnd: YMD): DeadlineResult {
  const mmdd = halfEnd.slice(4);
  if (mmdd !== '0630' && mmdd !== '1231') {
    throw new Error(`반기 종료일은 6월 30일 또는 12월 31일이어야 합니다: ${halfEnd}`);
  }
  const raw = addCalendarDays(halfEnd, 45);
  return finalize(
    raw,
    `반기 종료일(${halfEnd}) 다음 날부터 45일 이내 (달력일)`,
    0,
    REF_SUBCONTRACT,
  );
}

/** 기업집단현황공시 연1회 기한 — 매년 5월 31일 */
export function groupStatusAnnualDeadline(year: number): DeadlineResult {
  return finalize(`${year}0531`, `연1회 공시: 매년 5월 31일`, 0, REF_GROUP_STATUS);
}

/**
 * 기업집단현황공시 분기별 기한 — 매 분기 종료 후 2개월
 * 1Q(3/31)→5/31, 2Q(6/30)→8/31, 3Q(9/30)→11/30, 4Q(12/31)→익년 2/28
 */
export function groupStatusQuarterlyDeadline(year: number, quarter: 1 | 2 | 3 | 4): DeadlineResult {
  const ends: Record<number, [number, number]> = {
    1: [year, 3],
    2: [year, 6],
    3: [year, 9],
    4: [year, 12],
  };
  const entry = ends[quarter];
  if (!entry) throw new Error(`분기는 1~4 사이여야 합니다: ${quarter}`);
  const [y, m] = entry;
  // 분기말 + 2개월 = 그 달의 말일
  const targetMonth = m + 2;
  const ty = targetMonth > 12 ? y + 1 : y;
  const tm = targetMonth > 12 ? targetMonth - 12 : targetMonth;
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  const raw = `${ty}${String(tm).padStart(2, '0')}${String(lastDay).padStart(2, '0')}`;
  return finalize(
    raw,
    `${quarter}분기 종료 후 2개월 (${y}년 ${m}월 말 기준)`,
    0,
    REF_GROUP_STATUS,
  );
}

/**
 * 실제 공시일이 기한을 지켰는지 판정한다.
 * @returns delayDays 는 달력일 기준 지연일수 (과태료 산정에 사용). 0 이하면 적법.
 */
export function evaluateCompliance(
  deadline: YMD,
  actualDisclosureDate: YMD,
): { onTime: boolean; delayDays: number } {
  const delay = countCalendarDays(deadline, actualDisclosureDate);
  return { onTime: delay <= 0, delayDays: Math.max(0, delay) };
}

/** 기한까지 남은 영업일 수 (음수면 이미 경과 — 경과분도 **영업일** 기준) */
export function businessDaysRemaining(today: YMD, deadline: YMD): number {
  let cur = today;
  let count = 0;
  if (toDate(deadline) < toDate(today)) {
    // 미래는 영업일로 세면서 과거만 달력일로 세면 dDay 의 의미가 방향에 따라 갈린다
    // (검토 백로그: 과거 기한에서 달력일 음수가 dDay 로 노출) — 양방향 모두 영업일로 통일
    let back = deadline;
    let passed = 0;
    while (back !== today) {
      back = addCalendarDays(back, 1);
      if (isBusinessDay(back)) passed++;
    }
    return -passed;
  }
  while (cur !== deadline) {
    cur = addCalendarDays(cur, 1);
    if (isBusinessDay(cur)) count++;
  }
  return count;
}
