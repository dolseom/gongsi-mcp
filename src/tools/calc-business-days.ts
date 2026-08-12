/**
 * `calc_business_days` — 영업일·공휴일·기한 날짜 계산
 *
 * 실사용 테스트 #52에서 확인된 구멍을 막는 도구다: "2027-05-01이 기한이면 언제까지?" 같은
 * 자유 날짜 질문은 check_disclosure_duty(공시유형·의결일 필요)로 이어지지 않아, LLM이
 * 자체 달력 지식으로 계산하다 최신 공휴일 개정(2027 노동절 신설 등)을 놓친다.
 * 검증된 holidays.json 을 그대로 노출해 근거(공휴일 명칭·건너뛴 날짜)와 함께 답한다.
 *
 * 로컬 데이터만 읽으므로 인증키 없이 동작한다.
 */

import { z } from 'zod';
import {
  addBusinessDays,
  countBusinessDays,
  countCalendarDays,
  dayOfWeek,
  hasHolidayData,
  holidayDataStatus,
  holidaysOn,
  isBusinessDay,
  isHolidayDataVerified,
  isValidYMD,
  nextBusinessDay,
  toDate,
  toYMD,
} from '../rules/business-days.js';
import type { LegalRef, YMD } from '../rules/types.js';
import { ToolError } from '../lib/errors.js';

const ymdField = (desc: string) =>
  z
    .string()
    .regex(/^\d{8}$/, '날짜는 YYYYMMDD 8자리여야 합니다')
    .refine(isValidYMD, '실존하지 않는 달력 날짜입니다 (예: 20270231은 2월 31일)')
    .describe(desc);

export const calcBusinessDaysInput = z
  .object({
    date: ymdField(
      '기준일 (YYYYMMDD). 단독으로 주면 이 날짜가 영업일인지, 아니라면 어느 공휴일인지와 ' +
        '다음 최초 영업일(기한 말일 조정 결과)을 돌려줍니다',
    ),
    add_business_days: z
      .number()
      .int()
      .min(1)
      .max(120)
      .optional()
      .describe(
        '기준일 다음 날부터 N영업일 후의 기한을 계산합니다 ' +
          '(예: 이사회 의결일 + 상장 3영업일 / 비상장·공익법인 7영업일)',
      ),
    add_calendar_days: z
      .number()
      .int()
      .min(1)
      .max(370)
      .optional()
      .describe(
        '기준일 다음 날부터 N일(달력일) 후의 기한을 계산합니다 (예: 분기 종료 후 45일). ' +
          '말일이 비영업일이면 다음 영업일로의 조정 결과를 함께 줍니다',
      ),
    count_business_days_to: ymdField(
      '기준일 다음 날부터 이 날짜까지의 영업일 수를 셉니다 (예: 오늘부터 기한까지 남은 영업일)',
    ).optional(),
  });
// ⚠️ 옵션 상호배타 검사는 핸들러 안에서 한다 — MCP SDK 등록이 .shape(필드만)를 받으므로
//    객체 수준 refine 은 서버 경유 호출에서 조용히 유실된다.

export type CalcBusinessDaysInput = z.infer<typeof calcBusinessDaysInput>;

const DOW_KO = ['일', '월', '화', '수', '목', '금', '토'] as const;

/** 노동절(5/1)이 관공서 공휴일로 편입된 개정 규정의 시행일 */
const LABOR_DAY_OFFICIAL_FROM = '20260511';

const REF_BUSINESS_DAY: LegalRef = {
  source:
    '대규모내부거래 등에 대한 이사회 의결 및 공시에 관한 규정 제2조제8호 / 공시대상기업집단 소속회사 등의 중요사항 공시에 관한 규정 제2조제7호',
  summary:
    '영업일 = 공휴일, 토요일, 「근로자의 날 제정에 관한 법률」에 따른 근로자의 날을 제외한 날 (일요일은 공휴일에 포함)',
};

const REF_LAST_DAY: LegalRef = {
  source: '대규모내부거래 등에 대한 이사회 의결 및 공시에 관한 규정 제6조제2항',
  summary: '공시 마지막 날이 해당 회사의 영업일이 아닌 때에는 다음의 최초 영업일까지 공시하여야 한다.',
};

const REF_CIVIL_161: LegalRef = {
  source: '민법 제161조',
  summary:
    '기간의 말일이 토요일 또는 공휴일에 해당한 때에는 기간은 그 익일로 만료한다 (달력일 기한의 일반 원칙).',
};

const REF_LABOR_DAY_2027: LegalRef = {
  source: '관공서의 공휴일에 관한 규정 제2조제6호 (2026. 4. 30. 개정, 2026. 5. 11. 시행)',
  summary:
    '노동절(5월 1일)이 관공서 공휴일로 신설되었고 대체공휴일 대상이다. 2027년 5월 1일은 토요일이라 5월 3일(월)이 대체공휴일이다.',
};

interface DayInfo {
  date: YMD;
  dayOfWeek: (typeof DOW_KO)[number];
  isBusinessDay: boolean;
  /** 이 날짜에 해당하는 공휴일 명칭 (없으면 빈 배열) */
  holidays: string[];
}

interface SkippedDay extends DayInfo {
  reason: string;
}

interface CalcBusinessDaysResult {
  baseDate: DayInfo;
  operation: 'inspect' | 'add_business_days' | 'add_calendar_days' | 'count_business_days';
  result: Record<string, unknown>;
  /** 계산 과정에서 건너뛴 비영업일 — 근거 제시용 */
  skippedNonBusinessDays: SkippedDay[];
  dataStatus: { holidayDataYears: Record<string, boolean>; source: string };
  warnings: string[];
  notes: string[];
  legalBasis: LegalRef[];
}

function dayInfo(ymd: YMD): DayInfo {
  return {
    date: ymd,
    dayOfWeek: DOW_KO[dayOfWeek(ymd)]!,
    isBusinessDay: isBusinessDay(ymd),
    holidays: holidaysOn(ymd).map((h) => h.name),
  };
}

function nonBusinessReason(ymd: YMD): string {
  const names = holidaysOn(ymd).map((h) => h.name);
  const dow = dayOfWeek(ymd);
  const parts: string[] = [];
  if (dow === 6) parts.push('토요일');
  if (dow === 0) parts.push('일요일');
  parts.push(...names);
  return parts.join(', ');
}

function nextDay(ymd: YMD): YMD {
  return toYMD(new Date(toDate(ymd).getTime() + 86_400_000));
}

/** (from, to] 구간의 비영업일 목록. 근거 동봉용 — 상한을 넘으면 자른다. */
function collectSkipped(from: YMD, to: YMD, cap = 40): { days: SkippedDay[]; truncated: boolean } {
  const days: SkippedDay[] = [];
  let cur = from;
  let truncated = false;
  while (cur !== to) {
    cur = nextDay(cur);
    if (!isBusinessDay(cur)) {
      if (days.length >= cap) {
        truncated = true;
        break;
      }
      days.push({ ...dayInfo(cur), reason: nonBusinessReason(cur) });
    }
  }
  return { days, truncated };
}

/** 계산이 스친 연도 전부에 대해 데이터 없음·미검증 경고를 만든다 */
function yearWarnings(dates: YMD[]): string[] {
  const years = [...new Set(dates.map((d) => d.slice(0, 4)))].sort();
  const out: string[] = [];
  for (const year of years) {
    if (!hasHolidayData(year)) {
      out.push(
        `${year}년 공휴일 데이터가 없어 주말만 반영했습니다 — 이 연도의 결과는 공휴일만큼 어긋날 수 있으니 사용하지 마세요.`,
      );
    } else if (!isHolidayDataVerified(year)) {
      out.push(
        `${year}년 공휴일 데이터가 미검증 상태입니다(음력·대체공휴일 확인 필요). 기한이 하루 이상 어긋날 수 있습니다.`,
      );
    }
  }
  return out;
}

/**
 * 근로자의 날 특칙 안내.
 * 2026-05-11 시행 개정 전의 5/1은 관공서 공휴일이 아니어서 **민법 기간계산으로는 만료일이 밀리지 않는다**.
 * 고시 영업일 기준 공시(대규모내부거래 등)에서만 제외된다 — 달력일 기한이라면 안전하게 그 전 영업일까지.
 */
function laborDayNotes(touched: DayInfo[]): { notes: string[]; refs: LegalRef[] } {
  const notes = new Set<string>();
  let citeLaborDayAmendment = false;
  for (const d of touched) {
    const entries = holidaysOn(d.date);
    if (entries.some((h) => h.laborDay === true)) {
      if (d.date < LABOR_DAY_OFFICIAL_FROM) {
        notes.add(
          `${d.date} 근로자의 날은 관공서 공휴일이 아니므로, 달력일 기한의 민법 §161 기간계산에서는 만료일이 밀리지 않을 수 있습니다. ` +
            '공정위 고시의 영업일 기준 공시에서만 영업일에서 제외됩니다. 달력일 기한이라면 그 전 영업일까지 공시하는 것이 안전합니다.',
        );
      } else {
        citeLaborDayAmendment = true;
      }
    }
    if (entries.some((h) => h.substitute === true && h.name.includes('노동절'))) {
      citeLaborDayAmendment = true;
    }
  }
  return { notes: [...notes], refs: citeLaborDayAmendment ? [REF_LABOR_DAY_2027] : [] };
}

export function calcBusinessDays(input: CalcBusinessDaysInput): CalcBusinessDaysResult {
  const ops = [input.add_business_days, input.add_calendar_days, input.count_business_days_to].filter(
    (x) => x !== undefined,
  );
  if (ops.length > 1) {
    throw new ToolError(
      'invalid_argument',
      'add_business_days, add_calendar_days, count_business_days_to 는 동시에 지정할 수 없습니다 — 하나만 선택하세요.',
    );
  }

  const base = dayInfo(input.date);
  const notes: string[] = [];
  const legalBasis: LegalRef[] = [REF_BUSINESS_DAY];

  let operation: CalcBusinessDaysResult['operation'];
  let result: Record<string, unknown>;
  let skipped: SkippedDay[] = [];
  let skippedTruncated = false;
  let touchedDates: YMD[] = [input.date];

  if (input.add_business_days !== undefined) {
    operation = 'add_business_days';
    const deadline = addBusinessDays(input.date, input.add_business_days);
    const collected = collectSkipped(input.date, deadline);
    skipped = collected.days;
    skippedTruncated = collected.truncated;
    touchedDates = [input.date, deadline];
    result = {
      deadline,
      deadlineDayOfWeek: DOW_KO[dayOfWeek(deadline)],
      businessDays: input.add_business_days,
      countingRule: `기준일(${input.date}) 다음 날부터 기산하며 기준일 당일은 포함하지 않습니다 ("의결 후 N영업일 이내"의 통상 해석)`,
    };
    legalBasis.push(REF_LAST_DAY);
  } else if (input.add_calendar_days !== undefined) {
    operation = 'add_calendar_days';
    const raw = toYMD(new Date(toDate(input.date).getTime() + input.add_calendar_days * 86_400_000));
    const effective = nextBusinessDay(raw);
    const collected = raw === effective ? { days: [], truncated: false } : collectSkipped(nextDayBack(raw), effective);
    skipped = collected.days.filter((d) => d.date !== effective);
    skippedTruncated = collected.truncated;
    touchedDates = [input.date, raw, effective];
    result = {
      rawDeadline: raw,
      rawDeadlineDayOfWeek: DOW_KO[dayOfWeek(raw)],
      rawDeadlineIsBusinessDay: isBusinessDay(raw),
      effectiveDeadline: effective,
      effectiveDeadlineDayOfWeek: DOW_KO[dayOfWeek(effective)],
      adjustedToNextBusinessDay: raw !== effective,
      calendarDays: input.add_calendar_days,
      countingRule: `기준일(${input.date}) 다음 날부터 ${input.add_calendar_days}일(달력일)`,
    };
    legalBasis.push(REF_LAST_DAY, REF_CIVIL_161);
  } else if (input.count_business_days_to !== undefined) {
    operation = 'count_business_days';
    const target = input.count_business_days_to;
    const span = Math.abs(countCalendarDays(input.date, target));
    if (span > 1100) {
      throw new ToolError(
        'invalid_argument',
        `두 날짜 간격이 ${span}일입니다 — 3년(1,100일) 이내로 지정하세요.`,
        { from: input.date, to: target },
      );
    }
    touchedDates = [input.date, target];
    // 도구 설명이 "건너뛴 비영업일 목록 동봉"을 약속한다 — 이 분기만 빈 배열로 나가면
    // "구간에 공휴일 없음"으로 읽힌다 (P2-마: 실측 20260810~20261015 에서 추석 연휴 누락 재현)
    const [lo, hi] = input.date <= target ? [input.date, target] : [target, input.date];
    const collected = collectSkipped(lo, hi);
    skipped = collected.days;
    skippedTruncated = collected.truncated;
    result = {
      to: target,
      businessDays: countBusinessDays(input.date, target),
      calendarDays: countCalendarDays(input.date, target),
      countingRule: `기준일(${input.date}) 다음 날부터 ${target}까지 (기준일 당일 불포함)`,
    };
  } else {
    operation = 'inspect';
    const effective = nextBusinessDay(input.date);
    if (effective !== input.date) {
      // 기준일 자체가 비영업일이면 그 사유도 근거에 포함한다
      skipped = [{ ...base, reason: nonBusinessReason(input.date) }];
      const collected = collectSkipped(input.date, effective);
      skipped.push(...collected.days.filter((d) => d.date !== effective));
    }
    touchedDates = [input.date, effective];
    result = {
      effectiveDeadline: effective,
      effectiveDeadlineDayOfWeek: DOW_KO[dayOfWeek(effective)],
      adjustedToNextBusinessDay: effective !== input.date,
      rule:
        effective === input.date
          ? `${input.date} 은(는) 영업일입니다 — 기한 말일이라면 이날까지 공시하면 됩니다.`
          : `${input.date} 은(는) 영업일이 아니므로, 기한 말일이라면 다음 최초 영업일인 ${effective} 까지입니다.`,
    };
    legalBasis.push(REF_LAST_DAY, REF_CIVIL_161);
  }

  const labor = laborDayNotes([base, ...skipped, ...touchedDates.map(dayInfo)]);
  notes.push(...labor.notes);
  for (const ref of labor.refs) if (!legalBasis.includes(ref)) legalBasis.push(ref);
  if (skippedTruncated) {
    notes.push('건너뛴 비영업일 목록이 길어 일부만 표시했습니다 (계산 결과는 전체를 반영).');
  }

  return {
    baseDate: base,
    operation,
    result,
    skippedNonBusinessDays: skipped,
    dataStatus: {
      holidayDataYears: holidayDataStatus(),
      source:
        '관공서의 공휴일에 관한 규정 현행 원문 + 공식 월력요항으로 검증된 내장 데이터 (data/holidays.json)',
    },
    warnings: yearWarnings(touchedDates),
    notes,
    legalBasis,
  };
}

/** collectSkipped 는 (from, to] 를 걷는다 — raw 자신부터 포함해 걷도록 하루 앞으로 되돌린다 */
function nextDayBack(ymd: YMD): YMD {
  return toYMD(new Date(toDate(ymd).getTime() - 86_400_000));
}
