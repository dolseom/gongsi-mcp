/**
 * 자진시정 골든타임 — 과태료 면제기준 (두 과태료 고시의 Ⅴ)
 *
 * 리서치 결론: 이 도구의 포지셔닝은 "위반 통보"가 아니라 **"면제 골든타임 내 구조"**다.
 * 기한을 놓친 담당자에게 필요한 것은 질책이 아니라 "지금 무엇을 하면 피해가 최소화되는가"다.
 *
 * ⚠️ 원문 확인 결과(2026-08-02, 법제처), 통용되는 "10영업일 내 자진시정하면 면제"는 **과한 요약**이다:
 *  - 10영업일 내 자진시정 재공시는 면제의 **필요조건**이고, 여기에 더해
 *    ①신규 지정·편입 통지일부터 30일 이내 위반 또는 ②단순 계산 실수·오기 등 사소한 부주의
 *    (관련 공시로 사실내용 확인 가능) 중 하나가 성립해야 한다.
 *  - 별도 사유: 단순 누락·명백한 오류로 오인 가능성이 거의 없는 경우(재공시 없이도) /
 *    전산장애·천재지변 등 불가항력.
 *  - 과태료 체납자는 제외, 그리고 "면제할 **수 있다**"(공정위 재량)이다.
 * 다만 골든타임이 무의미해지는 것은 아니다 — 지연일수 감경(3일↓ 75% / 7일↓ 50%)이
 * 달력일 기준으로 굴러가므로, **어느 경우든 지금 즉시 공시가 손실을 최소화한다.**
 */

import { addBusinessDays, toDate, toYMD } from './business-days.js';
import { businessDaysRemaining } from './deadlines.js';
import type { LegalRef, YMD } from './types.js';
import type { PenaltyRegime } from './penalties.js';

export interface SelfCorrectionResult {
  /** 골든타임 시작 = 공시기한 만료일 다음 날 (달력일) */
  windowStart: YMD;
  /** 골든타임 종료 = 공시기한 만료일 다음 날부터 10영업일째 되는 날 */
  windowEnd: YMD;
  /** open = 골든타임 진행 중 / closed = 경과 / before_deadline = 아직 기한 전 */
  status: 'open' | 'closed' | 'before_deadline';
  /** status=open 일 때: 오늘 이후 골든타임 종료까지 남은 영업일 (오늘 미포함 — 0이면 오늘이 마지막 날) */
  businessDaysRemaining?: number;
  /** status=open 이고 오늘이 골든타임 마지막 날이면 true */
  isLastDay?: boolean;
  /** 면제가 성립할 수 있는 사유 — 고시 Ⅴ 원문 기반 */
  exemptionGrounds: string[];
  caution: string;
  legalBasis: LegalRef[];
}

const REGIME_RULE_NAME: Record<PenaltyRegime, string> = {
  art26_29: '대규모내부거래 등에 대한 이사회 의결 및 공시의무 위반사건에 관한 과태료 부과기준',
  art27_28: '공시대상기업집단 소속회사 등의 중요사항 공시의무 위반사건에 관한 과태료 부과기준',
};

function exemptionGrounds(regime: PenaltyRegime): string[] {
  const grounds = [
    '① 공시기한 만료일 다음 날부터 10영업일 이내 자진시정 재공시 + 위반공시일이 공시대상기업집단 신규 지정·계열 편입 통지일부터 30일 이내인 경우 (Ⅴ.1.가)',
    '② 공시기한 만료일 다음 날부터 10영업일 이내 자진시정 재공시 + 단순 계산 실수나 오기 등 사소한 부주의로 인정되고 관련 공시 내용으로 사실이 확인되는 경우 (Ⅴ.1.나)',
    '③ 명칭·성명·날짜·금액 등 단순 누락이거나 명백한 오류로서 오인 가능성이 거의 없다고 인정되는 경우 — 재공시 없이도 면제 가능 (Ⅴ.2)',
    '④ 전산장애·천재지변 등 불가항력으로 기한을 넘긴 것으로 인정되는 경우 (Ⅴ.3)',
  ];
  if (regime === 'art27_28') {
    grounds.splice(2, 0,
      '②-2 특수관계인과의 거래 현황 중 5억원 미만의 상품·용역 제공·거래 현황에 관한 사항 + 10영업일 이내 자진시정 재공시 (Ⅴ.1.나(2))',
    );
  }
  return grounds;
}

/**
 * 공시기한이 지난 시점의 자진시정 골든타임을 계산한다.
 *
 * @param deadline 공시기한 (이미 영업일 보정된 값)
 * @param today 판정 기준일
 */
export function selfCorrectionWindow(
  deadline: YMD,
  regime: PenaltyRegime,
  today: YMD,
): SelfCorrectionResult {
  const windowStart = nextCalendarDay(deadline);
  const windowEnd = addBusinessDays(deadline, 10);

  let status: SelfCorrectionResult['status'];
  if (toDate(today) <= toDate(deadline)) status = 'before_deadline';
  else if (toDate(today) <= toDate(windowEnd)) status = 'open';
  else status = 'closed';

  return {
    windowStart,
    windowEnd,
    status,
    ...(status === 'open'
      ? (() => {
          const remaining = businessDaysRemaining(today, windowEnd);
          return { businessDaysRemaining: remaining, isLastDay: remaining === 0 };
        })()
      : {}),
    exemptionGrounds: exemptionGrounds(regime),
    caution:
      '10영업일 내 자진시정은 면제의 필요조건일 뿐입니다 — 신규 지정·편입 30일 이내 위반이거나 ' +
      '사소한 부주의(계산 실수·오기)로 인정되는 등 고시 Ⅴ의 사유가 함께 성립해야 하며, ' +
      '요건을 갖춰도 면제는 공정위 재량("면제할 수 있다")입니다. 과태료 체납 중이면 면제되지 않습니다. ' +
      '면제가 안 되더라도 지연일수 감경(3일 이하 75% / 7일 이하 50% / 15일 이하 30% / 30일 이하 20%, 달력일 기준)이 ' +
      '있으므로 지금 즉시 공시하는 것이 언제나 손실을 최소화합니다.',
    legalBasis: [
      {
        source: `${REGIME_RULE_NAME[regime]} Ⅴ(과태료 면제기준)`,
        summary:
          '공시기한 만료일의 다음 날부터 10영업일 이내에 스스로 시정하여 다시 공시한 경우로서 ' +
          '신규 지정·편입 30일 이내 위반이거나 사소한 부주의로 인정되는 경우 등에는 과태료를 면제할 수 있다. ' +
          '체납자는 제외한다.',
      },
    ],
  };
}

function nextCalendarDay(ymd: YMD): YMD {
  return toYMD(new Date(toDate(ymd).getTime() + 86_400_000));
}
