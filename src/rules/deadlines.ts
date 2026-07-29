/**
 * 공시기한 계산
 *
 * ⚠️ 웹에 널리 퍼진 "상장 1일 이내"는 오정보다. 고시 원문은 3영업일이며 단위도 영업일이다.
 */

import {
  addBusinessDays,
  countCalendarDays,
  hasHolidayData,
  isBusinessDay,
  isHolidayDataVerified,
  nextBusinessDay,
  toDate,
  toYMD,
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

const REF_OMNIBUS: LegalRef[] = [
  {
    source: '대규모내부거래 등에 대한 이사회 의결 및 공시에 관한 규정 제9조제3항·제5항',
    summary:
      '약관에 의한 금융거래행위는 분기별로 해당 분기 종료 후 익월 10영업일까지 공시하여야 한다.',
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
export function litDeadline(boardDate: YMD, listing: ListingStatus): DeadlineResult {
  const n = listing === 'listed' ? 3 : 7;
  const label = listing === 'listed' ? '상장회사' : '비상장회사·공익법인';
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

/**
 * 약관에 의한 금융거래 분기별 공시기한 — 고시 §9③⑤
 * 해당 분기 종료 후 익월 10영업일까지
 *
 * @param quarterEnd 분기 종료일 (예: '20260630')
 */
export function omnibusQuarterlyDeadline(quarterEnd: YMD): DeadlineResult {
  // 분기 종료일 다음 날부터 세면 익월 1일부터의 영업일 카운트와 같아진다.
  const raw = addBusinessDays(quarterEnd, 10);
  return finalize(
    raw,
    `분기 종료(${quarterEnd}) 후 익월 10영업일까지`,
    10,
    REF_OMNIBUS,
  );
}

/**
 * 상품·용역 거래금액 20% 이상 감소 시 공시기한 — 고시 §9의2②
 * 분기 종료 후 45일 (달력일)
 */
export function goodsServicesReducedDeadline(quarterEnd: YMD): DeadlineResult {
  const raw = toYMD(new Date(toDate(quarterEnd).getTime() + 45 * 86_400_000));
  return finalize(raw, `분기 종료(${quarterEnd}) 후 45일 이내 (달력일)`, 0, REF_GOODS_45);
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

/** 기한까지 남은 영업일 수 (음수면 이미 경과) */
export function businessDaysRemaining(today: YMD, deadline: YMD): number {
  let cur = today;
  let count = 0;
  if (toDate(deadline) < toDate(today)) {
    return -countCalendarDays(deadline, today);
  }
  while (cur !== deadline) {
    cur = toYMD(new Date(toDate(cur).getTime() + 86_400_000));
    if (isBusinessDay(cur)) count++;
  }
  return count;
}
