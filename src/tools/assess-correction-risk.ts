/**
 * `assess_correction_risk` — 정정공시 리스크 진단
 *
 * 커뮤니티에서 "정정하면 과태료 나온다"는 썰이 유통되지만 (리서치: 정정 질문 비중이 공식 채널의 3배),
 * 과태료 고시 2종 원문(법제처, 2026-08-02 확인)의 위반행위 열거(Ⅱ)에 **정정공시는 없다**.
 *
 * 법적 실체:
 *  - 위반은 미공시·지연·주요내용 누락·거짓 공시(§26 계열은 의결 없음·변경 시 재의결 없음 포함)뿐이다.
 *  - 원 공시에 누락·거짓이 있었다면 **정정 여부와 무관하게 그 시점에 이미 위반이 성립**해 있다.
 *    정정을 미룬다고 위반이 사라지지 않는다.
 *  - 오히려 공시기한 만료 후 10영업일 내 자진시정 재공시가 유일한 면제 경로(Ⅴ.1)이고,
 *    지연일수 감경(Ⅵ.3)은 시간이 갈수록 축소된다(3일 75% → 30일 20% → 소멸).
 *  - 명칭·성명·날짜·금액 등 단순 오기·누락으로 오인 가능성이 거의 없으면 재공시 없이도
 *    면제 사유(Ⅴ.2)라 "정정이 필수는 아닌" 경우도 있다.
 *
 * 이 도구는 확답이 아니라 **근거를 동봉한 판단 재료**를 준다 (제품 철학).
 */

import { z } from 'zod';
import { countCalendarDays, toYMD } from '../rules/business-days.js';
import { selfCorrectionWindow, type SelfCorrectionResult } from '../rules/self-correction.js';
import type { PenaltyRegime } from '../rules/penalties.js';
import type { LegalRef, YMD as YMDType } from '../rules/types.js';

const YMD = z.string().regex(/^\d{8}$/, 'YYYYMMDD 형식이어야 합니다 (예: 20260722)');

const REGIME_RULE: Record<PenaltyRegime, string> = {
  art26_29: '대규모내부거래 등에 대한 이사회 의결 및 공시의무 위반사건에 관한 과태료 부과기준',
  art27_28: '공시대상기업집단 소속회사 등의 중요사항 공시의무 위반사건에 관한 과태료 부과기준',
};

export const assessCorrectionRiskInput = z.object({
  errorType: z
    .enum([
      'trivial_error',
      'minor_miscalculation',
      'content_omission',
      'false_content',
      'transaction_changed',
    ])
    .describe(
      '원 공시 오류의 성격. trivial_error=명칭·성명·날짜·금액 등 단순 오기·누락(오인 가능성 거의 없음), ' +
        'minor_miscalculation=단순 계산 실수·오기(사소한 부주의), content_omission=주요내용 누락, ' +
        'false_content=사실과 다른 기재, transaction_changed=거래의 주요내용 자체가 변경됨(정정이 아니라 새 공시의무)',
    ),
  regime: z
    .enum(['art26_29', 'art27_28'])
    .describe(
      '과태료 체계. art26_29=대규모내부거래·공익법인(약관특례·상품용역 감소 포함), ' +
        'art27_28=비상장사 중요사항·기업집단현황',
    ),
  originalDeadline: YMD.optional().describe(
    '원 공시의 법정 기한 (YYYYMMDD). 주면 자진시정 골든타임과 지연 감경 축소 일정을 계산합니다',
  ),
  crossConfirmable: z
    .boolean()
    .optional()
    .describe(
      '오류의 사실내용이 해당 공시 또는 이전의 다른 공정거래법 공시 내용으로 확인 가능한지 — ' +
        '사소한 부주의 면제(Ⅴ.1.나)의 성립 요건입니다',
    ),
  newlyDesignatedWithin30d: z
    .boolean()
    .optional()
    .describe('위반 공시일이 공시대상기업집단 신규 지정·계열 편입 통지일부터 30일 이내인지 (Ⅴ.1.가)'),
  today: YMD.optional().describe('판정 기준일 (기본: 시스템 날짜)'),
});

export type AssessCorrectionRiskInput = z.infer<typeof assessCorrectionRiskInput>;

interface CorrectionRiskResult {
  coreAnswer: string;
  originalViolation: {
    established: boolean | 'depends';
    type: string;
    explanation: string;
  };
  exemptionPath: string[];
  selfCorrection?: SelfCorrectionResult;
  delayMitigation?: {
    delayDaysIfCorrectedToday: number;
    currentReductionPct: number;
    nextDropNote: string;
  };
  recommendation: string;
  notes: string[];
  legalBasis: LegalRef[];
  disclaimer: string;
}

/** 지연일수 → 감경률 (두 고시 공통 Ⅵ.3, 달력일 기준) */
function reductionTier(delayDays: number): { pct: number; nextDropNote: string } {
  if (delayDays <= 3) return { pct: 75, nextDropNote: `지연 4일째부터 감경률이 75% → 50%로 떨어집니다.` };
  if (delayDays <= 7) return { pct: 50, nextDropNote: `지연 8일째부터 감경률이 50% → 30%로 떨어집니다.` };
  if (delayDays <= 15) return { pct: 30, nextDropNote: `지연 16일째부터 감경률이 30% → 20%로 떨어집니다.` };
  if (delayDays <= 30) return { pct: 20, nextDropNote: `지연 31일째부터는 지연일수 감경이 사라집니다.` };
  return { pct: 0, nextDropNote: '지연 30일을 초과하여 지연일수 감경은 적용되지 않습니다.' };
}

export function assessCorrectionRisk(input: AssessCorrectionRiskInput): CorrectionRiskResult {
  const today = input.today ?? toYMD(new Date());
  const ruleName = REGIME_RULE[input.regime];
  const notes: string[] = [];
  const legalBasis: LegalRef[] = [
    {
      source: `${ruleName} Ⅱ(적용범위)`,
      summary:
        '과태료 부과 대상 위반행위는 공시하지 아니한 자, 지연하여 공시한 자, 주요내용을 누락하여 공시한 자, ' +
        '거짓으로 공시한 자' +
        (input.regime === 'art26_29'
          ? ', 이사회 의결을 거치지 아니한 자, 주요내용 변경 시 재의결·재공시하지 아니한 자'
          : '') +
        '로 열거되어 있다. 정정(재공시) 행위 자체는 위반행위가 아니다.',
    },
  ];

  const coreAnswer =
    '정정공시 자체는 과태료 부과 대상 행위가 아닙니다. 과태료 고시의 위반행위 열거(Ⅱ)에 정정은 없으며, ' +
    '문제가 되는 것은 정정이 아니라 **원 공시의 상태**(누락·거짓·지연)입니다. 원 공시에 위반이 있었다면 ' +
    '정정 여부와 무관하게 이미 성립해 있고, 정정을 미룬다고 사라지지 않습니다.';

  // ── 오류 유형별 원 공시 위반 성립 판단 ──
  let originalViolation: CorrectionRiskResult['originalViolation'];
  let recommendation: string;
  const exemptionPath: string[] = [];

  switch (input.errorType) {
    case 'trivial_error': {
      originalViolation = {
        established: 'depends',
        type: '단순 누락·명백한 오류',
        explanation:
          '명칭·성명·날짜·금액 등 단순한 사항의 누락이거나 명백한 오류로서 오인 가능성이 거의 없다고 ' +
          '인정되면, 스스로 시정하여 다시 공시하지 않더라도 과태료 면제 사유입니다 (Ⅴ.2). ' +
          '오인 가능성 판단은 공정위 재량이므로 "위반 불성립 확정"은 아닙니다.',
      };
      exemptionPath.push(
        'Ⅴ.2 — 단순 누락·명백한 오류 + 오인 가능성 거의 없음 → 재공시 없이도 면제 가능. ' +
          '정정하더라도 불이익 근거는 없습니다.',
      );
      recommendation =
        '이 유형은 정정 여부가 과태료를 좌우하지 않습니다. 기록의 정확성을 위해 정정하는 것이 무난하며, ' +
        '정정으로 불이익을 받을 근거는 고시에 없습니다. 다만 "오인 가능성이 거의 없는지"가 애매하면 ' +
        '(예: 금액 자릿수 오기) minor_miscalculation 시나리오로도 함께 검토하세요.';
      legalBasis.push({
        source: `${ruleName} Ⅴ.2`,
        summary:
          '명칭·성명·날짜·금액 등 단순한 사항의 누락이거나 명백한 오류인 경우로서 다시 공시하지 않더라도 ' +
          '오인 가능성이 거의 없다고 인정되는 경우 과태료를 면제할 수 있다.',
      });
      break;
    }
    case 'minor_miscalculation': {
      originalViolation = {
        established: 'depends',
        type: '주요내용 누락·거짓 공시 (사소한 부주의)',
        explanation:
          '계산 실수·오기로 주요내용이 사실과 다르게 공시됐다면 형식적으로는 누락·거짓 공시에 해당할 수 있습니다. ' +
          '다만 단순 계산 실수나 오기 등 사소한 부주의로 인정되고 그 사실내용이 해당 공시 또는 이전의 다른 ' +
          '공정거래법 공시로 확인되는 경우, 공시기한 만료 후 10영업일 내 자진시정 재공시 시 면제 사유입니다 (Ⅴ.1.나).',
      };
      exemptionPath.push(
        'Ⅴ.1.나 — 10영업일 내 자진시정 재공시 + 사소한 부주의 + 관련 공시로 사실 확인 → 면제 가능.',
      );
      if (input.crossConfirmable === true) {
        notes.push('다른 공시로 사실내용 확인이 가능하다고 하셨으므로 Ⅴ.1.나 요건에 부합할 여지가 큽니다.');
      } else if (input.crossConfirmable === false) {
        notes.push(
          '⚠️ 다른 공시로 사실내용을 확인할 수 없다면 Ⅴ.1.나의 면제 요건이 성립하지 않을 수 있습니다. ' +
            '그래도 자진시정이 늦어질수록 지연 감경까지 축소되므로 즉시 정정이 유리합니다.',
        );
      }
      recommendation =
        '골든타임(공시기한 만료 후 10영업일) 내라면 즉시 자진시정 재공시하세요 — 이 경로가 유일한 면제 통로입니다. ' +
        '골든타임이 지났어도 지연일수 감경은 계속 축소되므로 미룰 이유가 없습니다.';
      legalBasis.push({
        source: `${ruleName} Ⅴ.1.나`,
        summary:
          '공시기한 만료일 다음 날부터 10영업일 이내에 스스로 시정하여 다시 공시하고, 단순 계산 실수나 오기 등 ' +
          '사소한 부주의로 인정되며 관련 공시 내용으로 사실이 확인되는 경우 면제할 수 있다.',
      });
      if (input.regime === 'art27_28') {
        exemptionPath.push(
          'Ⅴ.1.나(2) — 특수관계인과의 거래 현황 중 5억원 미만 상품·용역 거래 사항이면 별도 면제 사유.',
        );
      }
      break;
    }
    case 'content_omission':
    case 'false_content': {
      const label = input.errorType === 'content_omission' ? '주요내용 누락 공시' : '거짓 공시';
      originalViolation = {
        established: true,
        type: label,
        explanation:
          `원 공시가 ${label}에 해당하면 위반은 공시 시점에 이미 성립해 있습니다. ` +
          '정정하지 않으면 위반 상태가 계속되고 공정위 점검(연 1회 이상)에서 적발될 수 있으며, ' +
          '이때는 자진시정 면제·감경 여지도 없습니다.',
      };
      exemptionPath.push(
        'Ⅴ.1 — 공시기한 만료 후 10영업일 내 자진시정 재공시가 면제의 필요조건. 다만 신규 지정·편입 30일 내 ' +
          '위반이거나 사소한 부주의로 인정되는 경우여야 하므로, 고의성 있는 누락·거짓은 면제가 어렵습니다.',
      );
      recommendation =
        '즉시 정정(자진시정 재공시)이 유일하게 손실을 줄이는 선택입니다. 정정으로 위반이 "드러나는" 것을 ' +
        '걱정할 수 있으나, 공정위 정기 점검 체계에서 미정정 상태로 적발되면 면제·자진시정 정상참작 여지가 모두 ' +
        '사라집니다. 지연일수 감경도 달력일 기준으로 매일 축소됩니다.';
      break;
    }
    case 'transaction_changed': {
      originalViolation = {
        established: false,
        type: '위반 아님 — 새로운 공시의무 발생',
        explanation:
          input.regime === 'art26_29'
            ? '거래의 주요내용이 변경된 경우는 원 공시의 오류가 아니라 **다시 이사회 의결을 거쳐 공시할 의무**가 ' +
              '새로 발생한 것입니다. 이를 이행하지 않으면 그것이 별도의 위반입니다 (과태료 고시 Ⅱ.라).'
            : '공시한 내용에 변동이 생긴 경우는 원 공시의 오류가 아니라 변동사항에 대한 공시의무가 새로 ' +
              '발생했는지의 문제입니다. 해당 항목의 공시 요건을 check_disclosure_duty 로 판정하세요.',
      };
      recommendation =
        input.regime === 'art26_29'
          ? '정정이 아니라 변경 건의 이사회 의결 + 공시 절차를 밟으세요. 기한은 변경 의결일 기준으로 다시 ' +
            '계산됩니다 (check_disclosure_duty 사용). 변경 재의결 없이 방치하면 그 자체가 위반행위입니다. ' +
            '단, 약관에 의한 금융업 일상거래(고시 §9 특례)와 상품·용역 20% 이상 감소(§9의2)는 ' +
            '이사회 의결 없이 분기별 공시로 처리하는 예외이므로 해당 여부를 먼저 확인하세요.'
          : '변동사항이 독립적인 공시 대상인지 check_disclosure_duty 로 판정한 뒤, 대상이면 사유 발생일 기준 ' +
            '기한 내에 공시하세요.';
      if (input.regime === 'art26_29') {
        legalBasis.push({
          source: `${ruleName} Ⅱ.라`,
          summary: '주요내용이 변경되었음에도 다시 이사회 의결을 거치지 아니하거나 공시하지 아니한 자는 과태료 부과 대상이다.',
        });
      }
      break;
    }
  }

  if (input.newlyDesignatedWithin30d) {
    exemptionPath.push(
      'Ⅴ.1.가 — 신규 지정·편입 통지일부터 30일 이내의 위반 + 10영업일 내 자진시정 재공시 → 면제 가능. ' +
        '(감경 단계에서도 신규 지정·편입 30일 내 위반은 50% 감경 사유)',
    );
  }

  // ── 골든타임·감경 축소 타임라인 ──
  let selfCorrection: SelfCorrectionResult | undefined;
  let delayMitigation: CorrectionRiskResult['delayMitigation'];
  if (input.originalDeadline && input.errorType !== 'transaction_changed') {
    selfCorrection = selfCorrectionWindow(input.originalDeadline, input.regime, today);
    const delayDays = countCalendarDays(input.originalDeadline, today);
    if (delayDays > 0) {
      const tier = reductionTier(delayDays);
      delayMitigation = {
        delayDaysIfCorrectedToday: delayDays,
        currentReductionPct: tier.pct,
        nextDropNote: tier.nextDropNote,
      };
    }
  }

  notes.push(
    '공정위의 공식 위반 원인 1위는 "신규 담당자의 업무 미숙"이며, 위반의 94~95%가 기한 유형입니다 — ' +
      '정정 자체를 두려워해 공시를 미루는 것이 통계적으로 가장 흔한 실수 경로입니다.',
  );

  return {
    coreAnswer,
    originalViolation,
    exemptionPath,
    ...(selfCorrection ? { selfCorrection } : {}),
    ...(delayMitigation ? { delayMitigation } : {}),
    recommendation,
    notes,
    legalBasis,
    disclaimer:
      '본 진단은 공개된 과태료 고시 원문에 기반한 참고 정보이며 공정거래위원회의 공식 유권해석이 아닙니다. ' +
      '면제·감경은 모두 공정위 재량("면제할 수 있다")임에 유의하세요.',
  };
}
