/**
 * DART 전자문서 제출 시각 규칙 (18:00) — 기한 당일 공시의 준수 판정.
 *
 * 원문 (공정위 매뉴얼 2026-04):
 *  - 기업집단현황 소속회사용: "전자공시시스템(DART) 상 전자문서 제출 가능 시간은 07:30~19:00이나, 18:00 이후에 제출할
 *    경우 다음 업무 일에 공시한 것으로 처리됨(☞ 공시기한 마지막 날 전자공시시스템에 전자문서를 제출할 때 18:00를
 *    넘기지 않을 것)"
 *  - 기업집단현황 동일인용: "접수시간: 평일 07:30～19:00 - 당일접수: 07:30～18:00 - 익일접수: 18:00이후～19:00
 *    (★공시기한 마지막 날 18시를 넘지 말 것)"
 *  - 비상장사 중요사항: "전자공시시스템 상 전자문서 제출가능 시간은 07:30 ~ 19:00이나, 18:00 이후 제출 시 다음 업무일에
 *    공시처리됨"
 *  - ⚠️ 대규모내부거래 매뉴얼에는 이 규칙이 **없다** (18:00·접수시간 검색 0건). DART 공통 처리로 보이지만 원문 미확인이므로
 *    대규모내부거래 계열(대규모내부거래·공익법인·약관 금융거래·상품용역 감소)은 준수 판정을 바꾸지 않고 조건부로만 알린다.
 *  - 정각 18:00 은 "18:00 이후"(소속회사용·비상장사)와 "당일접수 07:30～18:00"(동일인용) 표현이 겹쳐 원문상 경계가 불분명하다.
 */

import { addBusinessDays, countCalendarDays, toDate } from '../../rules/business-days.js';
import type { YMD } from '../../rules/types.js';

type Duty =
  | 'large_internal_transaction'
  | 'unlisted_material'
  | 'group_status'
  | 'public_interest_corp'
  | 'omnibus_financial'
  | 'goods_services_reduced';

const CUTOFF = '18:00';

/** 매뉴얼에 18:00 규칙이 적혀 있는 의무인가 */
function hasManualRule(duty: Duty): boolean {
  return duty === 'unlisted_material' || duty === 'group_status';
}

const MANUAL_CITE: Record<'unlisted_material' | 'group_status', string> = {
  group_status:
    '공정위 기업집단현황공시 매뉴얼(2026-04) "18:00 이후에 제출할 경우 다음 업무 일에 공시한 것으로 처리됨"',
  unlisted_material: '공정위 비상장사 중요사항 공시 매뉴얼(2026-04) "18:00 이후 제출 시 다음 업무일에 공시처리됨"',
};

export interface FilingTimeResult {
  /** 준수·지연 판정에 쓸 공시일 — 매뉴얼 규칙이 있는 의무에서 18:00 이후 제출이면 다음 업무일 */
  effectiveDate: YMD;
  shifted: boolean;
  notes: string[];
  /** summary 의 "지켰습니다" 뒤에 붙일 조건 문구 (기한 당일 제출인데 시각을 모를 때) */
  summaryCaveat?: string;
}

export function applyFilingTimeRule(duty: Duty, deadline: YMD, actualDate: YMD, time?: string): FilingTimeResult {
  const notes: string[] = [];
  const onDeadlineDay = actualDate === deadline;
  const next = addBusinessDays(actualDate, 1);
  const manual = hasManualRule(duty);

  if (time === undefined) {
    if (!onDeadlineDay) return { effectiveDate: actualDate, shifted: false, notes };
    if (manual) {
      return {
        effectiveDate: actualDate,
        shifted: false,
        notes: [
          `⚠️ 기한 당일(${deadline}) 공시입니다. 제출 시각이 18:00 이후였다면 다음 업무일(${next})에 공시한 것으로 처리되어 ` +
            `기한을 넘깁니다 (${MANUAL_CITE[duty as 'unlisted_material' | 'group_status']}). 접수증의 제출 시각을 ` +
            'actualDisclosureTime 으로 주면 확정합니다.',
        ],
        summaryCaveat: `단, 기한 당일 제출이라 제출 시각이 18:00 이전이었다는 전제입니다 — 18:00 이후면 다음 업무일(${next}) 공시로 처리되어 지연입니다.`,
      };
    }
    return {
      effectiveDate: actualDate,
      shifted: false,
      notes: [
        `⚠️ 기한 당일(${deadline}) 공시입니다. 기업집단현황·비상장사 매뉴얼은 DART 에 18:00 이후 제출하면 다음 업무일 공시로 ` +
          '처리된다고 적고 있고 DART 공통 처리로 보이나, 대규모내부거래 매뉴얼에는 이 규칙이 기재되어 있지 않습니다(원문 미확인). ' +
          `18:00 이후 제출이었고 같은 처리가 적용된다면 ${next} 공시로 보아 기한을 넘깁니다 — 접수 시각을 확인하세요.`,
      ],
      summaryCaveat: '단, 기한 당일 제출이라 제출 시각(18:00 전후)에 따라 달라질 수 있습니다(대규모내부거래 매뉴얼에는 기재 없음 — 원문 미확인).',
    };
  }

  if (time < CUTOFF) return { effectiveDate: actualDate, shifted: false, notes };

  if (time === CUTOFF) {
    if (onDeadlineDay) {
      notes.push(
        '⚠️ 기한 당일 정각 18:00 제출입니다. 매뉴얼 표현이 "18:00 이후 제출 시 다음 업무일"(기업집단현황 소속회사용·비상장사)과 ' +
          '"당일접수 07:30～18:00"(기업집단현황 동일인용)으로 겹쳐 정각 제출의 처리는 원문상 불분명합니다(원문 미확인) — ' +
          '입력한 날짜 기준으로 판정했습니다. DART 접수증의 접수일자를 확인하세요.',
      );
    }
    return { effectiveDate: actualDate, shifted: false, notes };
  }

  // time > 18:00
  if (manual) {
    notes.push(
      `제출 시각 ${time}은 18:00 이후라 다음 업무일(${next})에 공시한 것으로 처리됩니다 ` +
        `(${MANUAL_CITE[duty as 'unlisted_material' | 'group_status']}) — ${next}를 공시일로 보아 준수·지연을 판정했습니다.`,
    );
    return { effectiveDate: next, shifted: true, notes };
  }
  if (toDate(actualDate) <= toDate(deadline) && toDate(next) > toDate(deadline)) {
    const delay = countCalendarDays(deadline, next);
    notes.push(
      `⚠️ 기한 당일 ${time} 제출입니다. 기업집단현황·비상장사 매뉴얼은 18:00 이후 제출을 다음 업무일 공시로 처리한다고 적고 있고 ` +
        'DART 공통 처리로 보이나, 대규모내부거래 매뉴얼에는 이 규칙이 기재되어 있지 않습니다(원문 미확인). 입력한 날짜 기준으로는 ' +
        `기한 내이지만, 같은 처리가 적용된다면 ${next} 공시로 보아 ${delay}일 지연입니다 — DART 접수증의 접수일자를 확인하세요.`,
    );
  }
  return { effectiveDate: actualDate, shifted: false, notes };
}

/** 기한이 아직 안 지났을 때의 D-day 안내 — 마지막 날은 18:00 전 제출 (매뉴얼에 규칙이 있는 의무만) */
export function lastDayFilingTimeNote(duty: Duty, deadline: YMD): string | null {
  if (!hasManualRule(duty)) return null;
  return (
    `공시기한 마지막 날(${deadline})에 제출한다면 18:00 전에 제출하세요 — 18:00 이후 제출은 다음 업무일에 공시한 것으로 ` +
    `처리됩니다 (${MANUAL_CITE[duty as 'unlisted_material' | 'group_status']}).`
  );
}
