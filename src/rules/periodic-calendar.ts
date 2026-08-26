/**
 * 정기(주기) 공시 캘린더 — 기한이 달력으로 고정된 공시만 나열한다.
 *
 * 왜 필요한가: 대규모내부거래 위반의 94~95%가 2년 연속 '기한' 유형이고, 공정위가 밝힌
 * 원인은 "신규 담당자 업무 미숙"이다. 그런데 기존 도구는 전부 "이 건" 단위라
 * "올해 우리가 언제 무엇을 공시해야 하나"에 답하는 경로가 없었다.
 *
 * 설계 원칙 두 가지:
 *  ① **기한 도래 기준**으로 담는다. 즉 "2026년 캘린더" = 2026년 중 마감일이 오는 것.
 *     전년도 4분기분(기한 2/28 등)이 포함되고, 당해 4분기분(기한 익년 2/28)은 빠진다.
 *     담당자가 실제로 처리하는 단위가 마감일이기 때문이다. 혼동을 막으려고 각 항목에
 *     대상 기간(period)을 항상 함께 싣는다.
 *  ② **사유 발생형 공시는 넣지 않는다.** 대규모내부거래 개별거래(3/7영업일),
 *     비상장회사 중요사항(7영업일)은 사유가 언제 생길지 알 수 없어 달력에 올릴 수 없다.
 *     이걸 빼먹었다고 오해하지 않도록 도구가 명시적으로 고지한다.
 *
 * 항목 구분(연1회 / 분기별)과 기준일은 추정이 아니라 고시 원문이다 —
 * 근거는 `data/periodic-disclosures.json` 의 `_meta.verification` 참조.
 */

import {
  groupStatusAnnualDeadline,
  groupStatusQuarterlyDeadline,
  omnibusQuarterlyDeadline,
  goodsServicesReducedDeadline,
  subcontractPaymentDeadline,
} from './deadlines.js';
import { loadPeriodicDuties, type PeriodicDuty } from './periodic-duties.js';
import type { DeadlineResult, LegalRef, YMD } from './types.js';

/** 캘린더 한 줄 */
export interface CalendarEntry {
  /** 의무 키 (periodic-disclosures.json 의 key) */
  duty: string;
  label: string;
  /** DART 공시유형 코드 */
  dart_type: string;
  frequency: 'annual' | 'quarterly' | 'semiannual';
  /** unconditional = 해당 회사면 무조건 / conditional = 해당 사유가 있을 때만 */
  obligation: 'unconditional' | 'conditional';
  /** 대상 기간 (사람이 읽는 표현) — 기한과 헷갈리지 않도록 항상 동봉 */
  period: string;
  /** 분기말·반기말 (해당 없으면 null) */
  period_end: YMD | null;
  /** 법정 기한일 (영업일 조정 전) */
  statutory_date: YMD;
  /** 실제 기한 (마지막 날이 비영업일이면 다음 최초 영업일) */
  deadline: YMD;
  adjusted_to_next_business_day: boolean;
  rule: string;
  applies_to?: string;
  applies_when?: string;
  /** 그 날 실제로 무엇을 쓰는가 + 각 항목의 기준일 */
  items: PeriodicDuty['items'];
  legal_basis: LegalRef[];
  /** 공휴일 데이터 미검증·부재 경고 (연도가 미래면 여기 뜬다) */
  warnings: string[];
}

/** 분기 종료일 */
function quarterEnd(year: number, q: 1 | 2 | 3 | 4): YMD {
  const mmdd = { 1: '0331', 2: '0630', 3: '0930', 4: '1231' }[q];
  return `${year}${mmdd}`;
}

/** 반기 종료일 */
function halfEnd(year: number, h: 1 | 2): YMD {
  return h === 1 ? `${year}0630` : `${year}1231`;
}

/**
 * 법정일(조정 전)을 되돌린다.
 * DeadlineResult 는 조정 **후** 날짜만 주므로, 조정 여부를 사용자에게 보이려면
 * 조정 전 날짜를 따로 계산해 둬야 한다.
 */
interface RawDeadline {
  statutory: YMD;
  result: DeadlineResult;
}

function entryOf(
  duty: PeriodicDuty,
  raw: RawDeadline,
  period: string,
  periodEnd: YMD | null,
): CalendarEntry {
  return {
    duty: duty.key,
    label: duty.label,
    dart_type: duty.dartType,
    frequency: duty.frequency,
    obligation: duty.obligation,
    period,
    period_end: periodEnd,
    statutory_date: raw.statutory,
    deadline: raw.result.deadline,
    adjusted_to_next_business_day: raw.result.adjustedToNextBusinessDay,
    rule: raw.result.rule,
    ...(duty.appliesTo ? { applies_to: duty.appliesTo } : {}),
    ...(duty.appliesWhen ? { applies_when: duty.appliesWhen } : {}),
    items: duty.items,
    legal_basis: duty.legalBasis,
    warnings: raw.result.warnings,
  };
}

/** 연1회 기업집단현황 — 법정일은 항상 5/31 */
function annualEntry(duty: PeriodicDuty, year: number): CalendarEntry {
  const result = groupStatusAnnualDeadline(year);
  return entryOf(
    duty,
    { statutory: `${year}0531`, result },
    `${year}년 기업집단지정일 및 직전 사업연도 기준 (항목별 기준일은 items 참조)`,
    null,
  );
}

/** 분기 기한 — 분기 종료 후 2개월 (기업집단현황 분기 / 비상장 주요주주 지분변동 준용) */
function quarterlyTwoMonthEntry(
  duty: PeriodicDuty,
  year: number,
  q: 1 | 2 | 3 | 4,
): CalendarEntry {
  const result = groupStatusQuarterlyDeadline(year, q);
  const endMonth = q * 3;
  const targetMonth = endMonth + 2;
  const ty = targetMonth > 12 ? year + 1 : year;
  const tm = targetMonth > 12 ? targetMonth - 12 : targetMonth;
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  const statutory: YMD = `${ty}${String(tm).padStart(2, '0')}${String(lastDay).padStart(2, '0')}`;
  return entryOf(duty, { statutory, result }, `${year}년 ${q}분기`, quarterEnd(year, q));
}

/** 약관 금융거래 — 분기 종료 후 익월 10영업일 (법정일 자체가 영업일 계산이라 조정 개념이 다르다) */
function omnibusEntry(duty: PeriodicDuty, year: number, q: 1 | 2 | 3 | 4): CalendarEntry {
  const qe = quarterEnd(year, q);
  const result = omnibusQuarterlyDeadline(qe);
  return entryOf(duty, { statutory: result.deadline, result }, `${year}년 ${q}분기`, qe);
}

/** 상품·용역 20% 이상 감소 — 분기 종료 후 45일(달력일) */
function goodsReducedEntry(duty: PeriodicDuty, year: number, q: 1 | 2 | 3 | 4): CalendarEntry {
  const qe = quarterEnd(year, q);
  const result = goodsServicesReducedDeadline(qe);
  const statutory = toYmdPlusDays(qe, 45);
  return entryOf(duty, { statutory, result }, `${year}년 ${q}분기`, qe);
}

/** 하도급대금 결제조건 — 반기 종료 다음 날부터 45일(달력일) */
function subcontractEntry(duty: PeriodicDuty, year: number, h: 1 | 2): CalendarEntry {
  const he = halfEnd(year, h);
  const result = subcontractPaymentDeadline(he);
  const statutory = toYmdPlusDays(he, 45);
  return entryOf(duty, { statutory, result }, `${year}년 ${h === 1 ? '상' : '하'}반기`, he);
}

function toYmdPlusDays(ymd: YMD, days: number): YMD {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, '0')}${String(
    dt.getUTCDate(),
  ).padStart(2, '0')}`;
}

/**
 * 지정 연도에 **기한이 도래하는** 정기 공시를 전부 만든다.
 *
 * 전년도 분기·반기분이 당해 연도로 넘어오므로 (year-1) 부터 생성한 뒤 기한 연도로 거른다.
 */
export function buildPeriodicCalendar(year: number): CalendarEntry[] {
  const duties = loadPeriodicDuties();
  const byKey = new Map(duties.map((d) => [d.key, d]));
  const need = (key: string): PeriodicDuty => {
    const d = byKey.get(key);
    if (!d) throw new Error(`정기공시 정의가 없습니다: ${key}`);
    return d;
  };

  const out: CalendarEntry[] = [];
  const quarters: (1 | 2 | 3 | 4)[] = [1, 2, 3, 4];

  out.push(annualEntry(need('group_status_annual'), year));

  // 전년도분이 당해로 넘어오는 경우가 있어 두 해를 생성한 뒤 기한 연도로 거른다
  for (const y of [year - 1, year]) {
    for (const q of quarters) {
      out.push(quarterlyTwoMonthEntry(need('group_status_quarterly'), y, q));
      out.push(quarterlyTwoMonthEntry(need('unlisted_major_shareholder'), y, q));
      out.push(omnibusEntry(need('omnibus_financial'), y, q));
      out.push(goodsReducedEntry(need('goods_services_reduced'), y, q));
    }
    for (const h of [1, 2] as (1 | 2)[]) {
      out.push(subcontractEntry(need('subcontract_payment_terms'), y, h));
    }
  }

  return out
    .filter((e) => e.deadline.slice(0, 4) === String(year))
    .sort((a, b) =>
      a.deadline !== b.deadline ? (a.deadline < b.deadline ? -1 : 1) : a.duty < b.duty ? -1 : 1,
    );
}
