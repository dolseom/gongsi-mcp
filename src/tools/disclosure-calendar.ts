/**
 * `disclosure_calendar` — 정기 공시 연간 캘린더
 *
 * "올해 우리가 언제 무엇을 공시해야 하나"에 답한다. 기존 도구는 전부 "이 건" 단위라
 * 이 질문에 답하는 경로가 없었다. 위반의 94~95%가 '기한' 유형이고 공정위가 밝힌 원인이
 * "신규 담당자 업무 미숙"이라는 실측을 정면으로 겨냥한다.
 *
 * 외부 API 를 쓰지 않는다 — 전부 로컬 룰·법령 데이터 계산이라 인증키 없이 동작한다.
 */

import { z } from 'zod';
import { buildPeriodicCalendar, type CalendarEntry } from '../rules/periodic-calendar.js';
import { periodicDutiesMeta, loadPeriodicDuties } from '../rules/periodic-duties.js';
import { businessDaysRemaining } from '../rules/deadlines.js';
import { countCalendarDays, isValidYMD, toYMD } from '../rules/business-days.js';
import { ToolError } from '../lib/errors.js';

const YMD = z
  .string()
  .regex(/^\d{8}$/, 'YYYYMMDD 형식이어야 합니다')
  .refine(isValidYMD, '실존하지 않는 날짜입니다');

export const disclosureCalendarInput = z.object({
  year: z
    .number()
    .int()
    .min(2020)
    .max(2100)
    .optional()
    .describe('대상 연도. 생략하면 오늘이 속한 연도. **그 해에 기한이 도래하는** 공시를 담는다'),
  today: YMD.optional().describe('오늘 날짜 (기본: 시스템 날짜). D-day 계산 기준'),
  duties: z
    .array(z.string())
    .optional()
    .describe(
      '의무 키로 거르기 (group_status_annual, group_status_quarterly, omnibus_financial, ' +
        'goods_services_reduced, unlisted_major_shareholder, subcontract_payment_terms)',
    ),
  from: YMD.optional().describe('기한 범위 시작 — 예: 이번 분기만 보고 싶을 때'),
  to: YMD.optional().describe('기한 범위 끝'),
  include_past: z
    .boolean()
    .optional()
    .describe('이미 기한이 지난 항목도 포함할지 (기본 true). false 면 남은 것만'),
  unconditional_only: z
    .boolean()
    .optional()
    .describe('해당 사유가 있을 때만 하는 조건부 의무를 빼고 무조건 의무만 볼지 (기본 false)'),
});

export type DisclosureCalendarInput = z.infer<typeof disclosureCalendarInput>;

type Status = 'past' | 'due_soon' | 'upcoming';

interface DatedEntry extends CalendarEntry {
  d_day: number;
  business_days_remaining: number;
  calendar_days_remaining: number;
  status: Status;
}

/** 기한이 임박했다고 볼 영업일 수 — 자진시정 골든타임(10영업일)과 같은 감각으로 잡는다 */
const DUE_SOON_BUSINESS_DAYS = 10;

export function disclosureCalendar(input: DisclosureCalendarInput): unknown {
  const today = input.today ?? toYMD(new Date());
  const year = input.year ?? Number(today.slice(0, 4));

  if (input.from && input.to && input.from > input.to) {
    throw new ToolError('invalid_argument', `from(${input.from}) 이 to(${input.to}) 보다 늦습니다.`);
  }
  if (input.duties?.length) {
    const known = new Set(loadPeriodicDuties().map((d) => d.key));
    const unknown = input.duties.filter((d) => !known.has(d));
    if (unknown.length) {
      throw new ToolError(
        'invalid_argument',
        `알 수 없는 의무 키입니다: ${unknown.join(', ')} — 사용 가능: ${[...known].join(', ')}`,
      );
    }
  }

  const all = buildPeriodicCalendar(year);

  const dated: DatedEntry[] = all.map((e) => {
    const calendarDays = countCalendarDays(today, e.deadline);
    const bd = businessDaysRemaining(today, e.deadline);
    const status: Status =
      calendarDays < 0 ? 'past' : bd <= DUE_SOON_BUSINESS_DAYS ? 'due_soon' : 'upcoming';
    return {
      ...e,
      d_day: calendarDays,
      business_days_remaining: bd,
      calendar_days_remaining: calendarDays,
      status,
    };
  });

  const filtered = dated.filter((e) => {
    if (input.duties?.length && !input.duties.includes(e.duty)) return false;
    if (input.from && e.deadline < input.from) return false;
    if (input.to && e.deadline > input.to) return false;
    if (input.include_past === false && e.status === 'past') return false;
    if (input.unconditional_only && e.obligation !== 'unconditional') return false;
    return true;
  });

  // 같은 날에 기한이 겹치는 지점은 업무량이 몰린다 — 미리 알면 준비가 달라진다.
  // (예: 5월 31일은 연1회 공시와 1분기 공시가 같은 날이다)
  const byDate = new Map<string, string[]>();
  for (const e of filtered) {
    const arr = byDate.get(e.deadline) ?? [];
    arr.push(e.label);
    byDate.set(e.deadline, arr);
  }
  const collisions = [...byDate.entries()]
    .filter(([, labels]) => labels.length > 1)
    .map(([date, labels]) => ({ deadline: date, count: labels.length, duties: labels }))
    .sort((a, b) => (a.deadline < b.deadline ? -1 : 1));

  const upcoming = filtered.filter((e) => e.status !== 'past');
  const next = upcoming.length ? upcoming[0] : null;

  const notes: string[] = [
    // ★ 가장 위험한 오독: "캘린더에 없으니 할 게 없다".
    // 이 도구는 날짜가 고정된 정기 공시만 담는다 — 실제 위반의 주력인 대규모내부거래
    // 개별거래는 사유 발생형이라 원리상 캘린더에 올릴 수 없다.
    '⚠️ 이 캘린더에는 **기한이 달력으로 고정된 정기 공시만** 들어 있습니다. ' +
      '대규모내부거래 개별거래(이사회 의결 후 상장 3영업일·비상장 7영업일), ' +
      '비상장회사 중요사항 중 주요주주 지분변동 분기공시를 **제외한** 나머지(사유 발생일부터 7영업일), ' +
      '특수관계인인 공익법인의 이사회 의결·공시(7영업일), ' +
      '고시 §9④ 약관 금융거래(단기금융상품이 아닌 §9② 거래 — 행위 후 3영업일·비상장 7영업일)는 ' +
      '사유가 언제 생길지 알 수 없어 캘린더에 올릴 수 없습니다 — ' +
      '**캘린더가 비어 있다고 해서 공시할 것이 없다는 뜻이 아닙니다.** ' +
      '그 건들은 발생 즉시 check_disclosure_duty 로 판정하세요 (not_in_calendar 참조).',
    'ℹ️ 이 캘린더는 **그 해에 기한이 도래하는** 것을 담습니다. 전년도 4분기분(기한 2월 말 등)이 포함되고, ' +
      '당해 4분기분(기한 익년 2월 말)은 다음 해 캘린더에 들어갑니다. 각 항목의 period 로 대상 기간을 확인하세요.',
    'ℹ️ 대상 회사 판정은 하지 않습니다 — 우리 회사가 공시대상회사인지, 하도급 원사업자인지 등은 ' +
      'applies_to·applies_when 을 읽고 직접 확인해야 합니다. 이 목록은 "해당된다면 이 날짜"입니다.',
  ];

  if (filtered.some((e) => e.obligation === 'conditional')) {
    notes.push(
      'ℹ️ obligation:"conditional" 항목은 해당 사유가 있을 때만 하는 공시입니다 ' +
        '(약관 금융거래가 있었는지, 상품·용역 거래금액이 20% 이상 감소했는지 등). ' +
        '전부 해야 한다는 뜻이 아닙니다 — applies_when 을 확인하세요.',
    );
  }
  if (collisions.length) {
    notes.push(
      `ℹ️ 기한이 같은 날 겹치는 지점이 ${collisions.length}곳 있습니다 (collisions 참조) — 그 주에 업무가 몰립니다.`,
    );
  }
  if (filtered.some((e) => e.filed_together_with)) {
    // 법령상 별개 의무라 캘린더에는 두 줄로 나오지만 DART 제출은 1건이다.
    // "두 번 내야 한다"로 읽으면 실무가 틀어진다 (DART 실측 2026-08-27).
    notes.push(
      'ℹ️ 기업집단현황공시의 **연1회분과 1분기분은 기한이 같은 5월 31일이라 DART 에서 ' +
        "'연1회공시및1/4분기용' 단일 서식으로 함께 제출**합니다 — 캘린더에 두 줄로 보여도 제출은 1건입니다. " +
        "2·3·4분기는 '분기별공시' 서식으로 따로 냅니다 (filed_together_with 참조).",
    );
  }
  const warned = filtered.filter((e) => e.warnings.length > 0);
  if (warned.length) {
    notes.push(
      `⚠️ 공휴일 데이터 경고가 있는 항목이 ${warned.length}건 있습니다 — 영업일 조정이 어긋날 수 있으니 ` +
        '해당 항목의 warnings 를 반드시 읽고, 결과를 단정하지 마세요.',
    );
  }
  if (filtered.length === 0) {
    notes.push(
      'ℹ️ 조건에 맞는 항목이 0건입니다. 필터(duties·from·to·include_past·unconditional_only)를 확인하세요 — ' +
        '"공시할 것이 없다"는 뜻이 아닙니다.',
    );
  }

  const meta = periodicDutiesMeta();

  return {
    scope: {
      year,
      today,
      basis: '기한 도래 기준 (해당 연도에 마감일이 오는 공시)',
      filters: {
        ...(input.duties?.length ? { duties: input.duties } : {}),
        ...(input.from ? { from: input.from } : {}),
        ...(input.to ? { to: input.to } : {}),
        ...(input.include_past === false ? { include_past: false } : {}),
        ...(input.unconditional_only ? { unconditional_only: true } : {}),
      },
    },
    summary: {
      total: filtered.length,
      past: filtered.filter((e) => e.status === 'past').length,
      due_soon: filtered.filter((e) => e.status === 'due_soon').length,
      upcoming: filtered.filter((e) => e.status === 'upcoming').length,
      unconditional: filtered.filter((e) => e.obligation === 'unconditional').length,
      conditional: filtered.filter((e) => e.obligation === 'conditional').length,
      next: next
        ? {
            label: next.label,
            deadline: next.deadline,
            period: next.period,
            business_days_remaining: next.business_days_remaining,
          }
        : null,
    },
    entries: filtered,
    ...(collisions.length ? { collisions } : {}),
    not_in_calendar: [
      {
        duty: 'large_internal_transaction',
        label: '대규모내부거래 개별거래 (J001 트랙 A)',
        reason: '이사회 의결일에 종속 — 상장 3영업일 / 비상장 7영업일',
        use: 'check_disclosure_duty',
      },
      {
        duty: 'unlisted_material',
        label: '비상장회사 중요사항 (J005) — 주요주주 지분변동 분기공시는 제외(그건 캘린더에 있다)',
        reason: '사유 발생일에 종속 — 7영업일. 최대주주 변동도 이쪽이다',
        use: 'check_disclosure_duty',
      },
      {
        duty: 'public_interest_corp',
        label: '특수관계인인 공익법인의 이사회 의결·공시 (J008)',
        reason: '이사회 의결일에 종속 — 7영업일',
        use: 'check_disclosure_duty',
      },
      {
        // Codex 교차검토 치명 1: 약관 금융거래를 뭉뚱그리면 비금융회사에 틀린 기한을 준다.
        // 분기 일괄은 §9③·§9⑤ 뿐이고, 나머지 §9② 거래는 §9④ 사유 발생형이다.
        duty: 'omnibus_financial_event_driven',
        label: '약관에 의한 금융거래 중 §9④ 경로 (계열 금융회사와의 §9② 거래로서 단기금융상품이 아닌 것)',
        reason:
          '행위 후 3영업일(상장) / 7영업일(비상장) — 분기 일괄이 아니다. ' +
          '이사회 의결은 분기별 일괄이 가능하지만(§9②) 공시 기한은 거래 시점에 종속된다',
        use: 'check_disclosure_duty',
      },
    ],
    notes,
    source: {
      verified_at: meta.verifiedAt,
      verification: meta.verification,
    },
  };
}
