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
 *  - 시행령 별표 9 는 "공시기한까지 공시 + 누락·거짓 사항을 공시기한이 지난 후 과태료 처분
 *    사전통지서 발송일 전날까지 보완한 경우" 칸을 따로 둔다 (2026-09-24 법제처 원문 재확인).
 *    §26 500만원 + 1일 10만원(2천만원 한도) / §27·28 100만원 + 1일 5만원(5백만원 한도).
 *    ⚠️ 경과일이 길면 한도에 닿아 보완 전 칸과 금액이 같아진다 — "정정하면 감액" 은 조건부다.
 *  - 기한 만료 후 10영업일 내 자진시정 재공시는 Ⅴ.1 면제의 필요조건이다 (Ⅴ.2·Ⅴ.3 은 별도 경로).
 *  - 명칭·성명·날짜·금액 등 단순 오기·누락으로 오인 가능성이 거의 없으면 재공시 없이도
 *    면제 사유(Ⅴ.2)라 "정정이 필수는 아닌" 경우도 있다.
 *  - 보완 사건의 경과일을 고시 Ⅵ.3.다(4)(나) "공시지연 일수" 로 보아 감경하는지는 원문이 정하지
 *    않았다 — 확정 숫자로 내보내지 않고 "적용 미확인 시나리오" 로만 준다 (Codex 검토 §2).
 *
 * 이 도구는 확답이 아니라 **근거를 동봉한 판단 재료**를 준다 (제품 철학).
 */

import { z } from 'zod';
import { ymdSchema } from '../lib/schemas.js';
import { countCalendarDays, todayKstYMD } from '../rules/business-days.js';
import { selfCorrectionWindow, type SelfCorrectionResult } from '../rules/self-correction.js';
import { estimatePenalty, type PenaltyRegime } from '../rules/penalties.js';
import type { LegalRef, YMD as YMDType } from '../rules/types.js';

const YMD = ymdSchema;
const 만 = 10_000;
const 만원 = (won: number) => `${(won / 만).toLocaleString('ko-KR')}만원`;

const REGIME_RULE: Record<PenaltyRegime, string> = {
  art26_29: '대규모내부거래 등에 대한 이사회 의결 및 공시의무 위반사건에 관한 과태료 부과기준',
  art27_28: '공시대상기업집단 소속회사 등의 중요사항 공시의무 위반사건에 관한 과태료 부과기준',
};

const ANNEX9_ROW: Record<PenaltyRegime, string> = {
  art26_29: '독점규제 및 공정거래에 관한 법률 시행령 [별표 9] 제2호 가목',
  art27_28: '독점규제 및 공정거래에 관한 법률 시행령 [별표 9] 제2호 나목',
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
    '원 공시의 법정 기한 (YYYYMMDD). 주면 자진시정 골든타임과 보완 칸 가산일수(오늘 보완을 마친다고 가정)를 계산합니다',
  ),
  originalFiledOnTime: z
    .boolean()
    .optional()
    .describe(
      '원 공시를 법정 기한 내에 제출했는지. 별표 9 보완 칸("공시기한까지 공시한 경우")의 전제입니다 — ' +
        '기한을 넘겨 최초 공시한 건은 다른 칸이 적용됩니다. 모르면 비워 두세요(조건부로 안내합니다)',
    ),
  boardResolution: z
    .boolean()
    .optional()
    .describe(
      'art26_29 전용: 원 거래에 사전 이사회 의결을 거쳤는지. 별표 9 가목의 보완 칸은 "이사회 의결을 거친 경우" 에만 있습니다',
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

/** 별표 9 보완 칸 안내 — 원 공시에 누락·거짓이 있는 경우 */
interface SupplementationGuide {
  /**
   * applies_if_conditions_met = 보완 칸 적용 가능(아래 conditions 전제)
   * late_original_row = 원 공시가 기한을 넘겨 다른 칸("공시기한을 넘긴 경우")
   * no_supplement_row = §26 의결을 거치지 않은 사건 — 별표 9 에 보완 칸이 없음
   */
  applicability: 'applies_if_conditions_met' | 'late_original_row' | 'no_supplement_row';
  row: string;
  formula?: string;
  /** 보완하지 않았을 때(또는 사전통지서 발송일 이후 보완) 칸의 기본금액 */
  unsupplementedBasicAmount?: string;
  /** 가산이 한도에 닿아 보완 전 칸과 기본금액이 같아지는 경과일 */
  daysUntilSameAsUnsupplemented?: number;
  conditions: string[];
  /** originalDeadline 이 지났을 때: 오늘 보완을 마친다고 가정한 기본금액 */
  ifCompletedToday?: {
    elapsedDays: number;
    basicAmount: string;
    sameAsUnsupplemented: boolean;
    note: string;
  };
  caveats: string[];
}

interface CorrectionRiskResult {
  coreAnswer: string;
  originalViolation: {
    established: boolean | 'depends';
    type: string;
    explanation: string;
  };
  exemptionPath: string[];
  supplementation?: SupplementationGuide;
  selfCorrection?: SelfCorrectionResult;
  /**
   * 보완 경과일을 "공시지연 일수"(고시 Ⅵ.3.다(4)(나))로 보아 감경한다면 — **원문 미확인 해석**.
   * 확정 감경률이 아니다.
   */
  delayMitigationScenario?: {
    status: 'unconfirmed_interpretation';
    supplementationElapsedDaysIfCompletedToday: number;
    /** 원 공시 자체의 공시지연 일수 — 기한 내 제출이면 0, 모르면 null */
    filingDelayDays: number | null;
    reductionPctIfCounted: number;
    nextDropNoteIfCounted: string;
    note: string;
  };
  recommendation: string;
  notes: string[];
  legalBasis: LegalRef[];
  disclaimer: string;
}

/** 지연일수 → 감경률 (두 고시 공통 Ⅵ.3.다(4)(나), 달력일 기준) — "N일 이하" 구간 */
function reductionTier(delayDays: number): { pct: number; nextDropNote: string } {
  if (delayDays <= 3) return { pct: 75, nextDropNote: `4일째부터 75% → 50%로 떨어집니다.` };
  if (delayDays <= 7) return { pct: 50, nextDropNote: `8일째부터 50% → 30%로 떨어집니다.` };
  if (delayDays <= 15) return { pct: 30, nextDropNote: `16일째부터 30% → 20%로 떨어집니다.` };
  if (delayDays <= 30) return { pct: 20, nextDropNote: `31일째부터는 이 감경이 없습니다.` };
  return { pct: 0, nextDropNote: '30일을 초과하여 이 감경 구간에 해당하지 않습니다.' };
}

/**
 * 별표 9 보완 칸 안내. 원문(2026-09-24 법제처 별표 9 재확인):
 *  가목(§26·29) 이사회 의결을 거친 경우 / 공시기한까지 공시한 경우 /
 *   "주요내용을 누락하거나 거짓 공시한 사항을 공시기한이 지난 후 과태료 처분 사전통지서 발송일 전날까지 보완한 경우"
 *   500 (공시기한을 넘긴 날의 다음 날부터 보완을 마친 날까지 1일마다 10만원씩 가산하되, 2천만원을 초과할 수 없다)
 *   / 보완하지 않은 누락·거짓 2,000
 *  나목(§27·28) 같은 구조: 100 (1일마다 5만원, 5백만원 한도) / 500
 *  기한을 넘긴 경우: "누락·거짓 공시하지 않은 경우(… 사전통지서 발송일 전날까지 보완한 경우를 포함한다)"
 *   가목 500 + 10만원/일 (5천만원 한도) vs 5,000 / 나목 100 + 5만원/일 (1천만원 한도) vs 1,000
 *  가목 이사회 의결을 거치지 않은 경우: 공시 O 누락·거짓 7,000 / 누락·거짓 없음 5,000 — 보완 칸 없음
 */
function supplementationGuide(input: AssessCorrectionRiskInput, today: YMDType): SupplementationGuide {
  const art26 = input.regime === 'art26_29';
  const commonCaveats = [
    '기준은 과태료 처분 사전통지서 **발송일 전날**입니다(받은 날이 아닙니다). 발송일 이후에 보완하면 이 칸이 아니라 ' +
      '보완하지 않은 칸이 적용됩니다.',
    '이 금액은 별표 9 **기본금액**입니다 — 최종 부과액이 아닙니다. ' +
      (art26 ? '거래금액별 적용비율(고시 Ⅵ.2)·' : '') +
      '가중·감경(고시 Ⅵ.3)·소기업 상한(Ⅵ.1 단서)·면제(Ⅴ)는 별도로 판단합니다.',
    '가산일수는 원문상 "공시기한을 넘긴 날의 다음 날부터 **보완을 마친 날까지**" 셉니다 — 오류를 발견한 날부터가 아닙니다.',
  ];

  if (art26 && input.boardResolution === false) {
    return {
      applicability: 'no_supplement_row',
      row: `${ANNEX9_ROW.art26_29} "이사회 의결을 거치지 않은 경우"`,
      unsupplementedBasicAmount: '공시 O + 누락·거짓 7,000만원 / 공시 O + 누락·거짓 없음 5,000만원',
      conditions: [],
      caveats: [
        '이사회 의결을 거치지 않은 사건에는 별표 9 가목에 보완 칸이 없습니다 — 보완 산식(500만원 + 1일 10만원)을 ' +
          '이 사건에 적용하지 마세요. 의결 없는 거래 자체가 별도 위반(고시 Ⅱ.가)입니다.',
      ],
    };
  }

  const lateOriginal = input.originalFiledOnTime === false;
  const base = art26 ? 500 * 만 : 100 * 만;
  const daily = art26 ? 10 * 만 : 5 * 만;
  const cap = lateOriginal ? (art26 ? 5000 * 만 : 1000 * 만) : art26 ? 2000 * 만 : 500 * 만;
  const unsupplemented = cap; // 두 체계·두 칸 모두 한도 = 보완하지 않은 칸의 금액
  const daysToCap = Math.ceil((cap - base) / daily);
  const formula = `min(${만원(cap)}, ${만원(base)} + ${만원(daily)} × n)  (n = 가산일수)`;

  const conditions: string[] = [];
  if (art26) {
    conditions.push(
      input.boardResolution === true
        ? '원 거래에 사전 이사회 의결을 거쳤다고 하셨습니다 (가목 "이사회 의결을 거친 경우" 칸).'
        : '원 거래에 사전 이사회 의결을 거쳤다면 — 의결 없는 사건은 보완 칸이 없고 7,000만원/5,000만원 칸입니다(boardResolution:false 로 확인).',
    );
  }
  if (!lateOriginal) {
    conditions.push(
      input.originalFiledOnTime === true
        ? '원 공시를 기한 내에 제출했다고 하셨습니다 ("공시기한까지 공시한 경우" 칸).'
        : '원 공시를 **기한 내에 제출했다면** — 기한을 넘겨 최초 공시한 건은 "공시기한을 넘긴 경우" 칸(' +
            (art26 ? '500만원 + 1일 10만원, 5천만원 한도' : '100만원 + 1일 5만원, 1천만원 한도') +
            ')입니다. 제출 기한 준수 여부를 originalFiledOnTime 으로 알려 주세요.',
    );
  }
  conditions.push('주요내용 누락·거짓을 공시기한이 지난 후 과태료 처분 사전통지서 발송일 전날까지 보완을 마쳐야 합니다.');

  const guide: SupplementationGuide = lateOriginal
    ? {
        applicability: 'late_original_row',
        row:
          `${ANNEX9_ROW[input.regime]} "공시기한을 넘긴 경우 — 주요내용을 누락하거나 거짓 공시하지 않은 경우` +
          '(과태료 처분 사전통지서 발송일 전날까지 보완한 경우를 포함한다)"',
        formula,
        unsupplementedBasicAmount: `${만원(unsupplemented)} (공시기한을 넘긴 경우 — 누락·거짓 공시, 보완 안 함)`,
        daysUntilSameAsUnsupplemented: daysToCap,
        conditions,
        caveats: [
          ...commonCaveats,
          '원 공시가 기한을 넘긴 건이므로 원 공시의 공시지연 일수에 따른 감경(고시 Ⅵ.3.다(4)(나))은 원 공시 접수일 기준으로 ' +
            '따로 봅니다 — 이 도구는 원 공시 접수일을 받지 않아 산정하지 않았습니다.',
        ],
      }
    : {
        applicability: 'applies_if_conditions_met',
        row:
          `${ANNEX9_ROW[input.regime]} "공시기한까지 공시한 경우 — 주요내용을 누락하거나 거짓 공시한 사항을 ` +
          '공시기한이 지난 후 과태료 처분 사전통지서 발송일 전날까지 보완한 경우"',
        formula,
        unsupplementedBasicAmount: `${만원(unsupplemented)} (공시기한까지 공시한 경우 — 누락·거짓 공시, 보완 안 함)`,
        daysUntilSameAsUnsupplemented: daysToCap,
        conditions,
        caveats: [...commonCaveats],
      };

  guide.caveats.push(
    `가산일수가 ${daysToCap}일 이상이면 한도(${만원(cap)})에 닿아 보완하지 않은 칸과 기본금액이 같습니다 — ` +
      '"정정하면 과태료가 줄어든다"고 단정할 수 없습니다. 오래된 오류일수록 차이가 없을 수 있습니다.',
  );

  if (input.originalDeadline && countCalendarDays(input.originalDeadline, today) > 0) {
    const n = countCalendarDays(input.originalDeadline, today);
    const est = estimatePenalty({
      regime: input.regime,
      boardResolution: true,
      disclosed: true,
      onTime: !lateOriginal,
      hasOmissionOrFalse: true,
      supplemented: true,
      supplementationElapsedDays: n,
    });
    const same = est.basicTotal >= unsupplemented;
    guide.ifCompletedToday = {
      elapsedDays: n,
      basicAmount: 만원(est.basicTotal),
      sameAsUnsupplemented: same,
      note:
        `오늘(${today}) 보완을 마친다고 가정하면 가산일수 약 ${n}일 → 기본금액 ${만원(est.basicTotal)}` +
        (same ? ` — 이미 한도에 닿아 보완하지 않은 칸(${만원(unsupplemented)})과 같습니다.` : ` (보완하지 않은 칸 ${만원(unsupplemented)}).`) +
        ' 일수는 기한 다음 날부터 오늘까지 달력일로 셌습니다 — 원문 "공시기한을 넘긴 날의 다음 날부터" 를 하루 늦게 ' +
        '읽는 해석이면 하루 적습니다(원문 미확인, 큰 쪽으로 계산).',
    };
  }
  return guide;
}

export function assessCorrectionRisk(input: AssessCorrectionRiskInput): CorrectionRiskResult {
  const today = input.today ?? todayKstYMD();
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

  const hasContentError = input.errorType !== 'transaction_changed';
  const coreAnswer =
    '정정공시 자체는 과태료 부과 대상 행위가 아닙니다. 과태료 고시의 위반행위 열거(Ⅱ)에 정정은 없으며, ' +
    '문제가 되는 것은 정정이 아니라 **원 공시의 상태**(누락·거짓·지연)입니다. 원 공시에 위반이 있었다면 ' +
    '정정 여부와 무관하게 이미 성립해 있고, 정정을 미룬다고 사라지지 않습니다.' +
    (hasContentError
      ? ' 별표 9는 기한까지 공시한 뒤 누락·거짓 사항을 과태료 처분 사전통지서 발송일 전날까지 보완한 경우를 ' +
        '"공시기한까지 공시한 경우"의 별도 칸으로 둡니다 — 원 공시를 기한 내에 냈다면 정정 때문에 ' +
        '"공시기한을 넘긴 경우" 칸으로 옮겨 가지 않습니다(아래 supplementation, 조건 확인).'
      : '');

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
        'Ⅴ.2 면제가 인정되면 정정 여부가 과태료를 좌우하지 않습니다. 다만 면제는 공정위 재량이라, 인정되지 않으면 ' +
        '주요내용 누락·거짓으로 보아 사전통지서 발송일 전날까지 보완했는지가 별표 9 칸을 가릅니다(supplementation). ' +
        '정정으로 불이익을 받을 근거는 고시에 없으므로 기록의 정확성을 위해 정정하는 것이 무난합니다. ' +
        '"오인 가능성이 거의 없는지"가 애매하면 (예: 금액 자릿수 오기) minor_miscalculation 시나리오로도 함께 검토하세요.';
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
            '면제가 안 되더라도 사전통지서 발송일 전날까지 보완하면 별표 9 보완 칸이 적용될 수 있습니다(supplementation — 조건 확인).',
        );
      }
      recommendation =
        '골든타임(공시기한 만료 다음 날부터 10영업일) 내라면 즉시 자진시정 재공시하세요 — Ⅴ.1.나 면제의 필요조건입니다. ' +
        '골든타임이 지났어도 사전통지서 발송일 전날까지 보완을 마치면 별표 9 보완 칸이 적용될 수 있고 가산은 보완을 ' +
        '마친 날까지 쌓이므로 미룰 이유는 없습니다. 다만 경과일이 길어 가산 한도에 닿았다면 보완 전 칸과 금액이 같을 수 있습니다.';
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
          `원 공시가 ${label}에 해당하면 위반은 이미 성립해 있고, 정정하지 않으면 그 상태가 그대로 남습니다. ` +
          '공정위가 먼저 문제를 발견한 경우라도 과태료 처분 사전통지서 발송일 전날까지 보완을 마치면 별표 9 보완 칸이 ' +
          '적용될 수 있습니다(supplementation — 조건 확인). 발송일 이후 보완은 보완하지 않은 칸입니다. ' +
          '고시 Ⅵ.3 의 감경 사유' +
          (input.regime === 'art27_28' ? '(예: 최초 위반 또는 최근 5개년 무위반 20%)' : '') +
          '는 위반을 누가 먼저 발견했는지를 요건으로 두지 않습니다.',
      };
      exemptionPath.push(
        'Ⅴ.1 — 공시기한 만료 다음 날부터 10영업일 내 자진시정 재공시가 면제의 필요조건. 여기에 신규 지정·편입 30일 내 ' +
          '위반이거나 사소한 부주의로 인정되는 경우여야 하므로, 고의성 있는 누락·거짓은 면제가 어렵습니다.',
      );
      recommendation =
        '정정할 계획이면 미룰 이유가 없습니다 — 보완 칸은 과태료 처분 사전통지서 발송일 전날까지 보완을 마쳐야 ' +
        '적용되고, 가산은 보완을 마친 날까지 쌓입니다. 다만 경과일이 길어 가산 한도에 닿았다면 보완해도 기본금액은 ' +
        '보완하지 않은 칸과 같습니다(supplementation.ifCompletedToday). 이 경우 정정은 과태료를 줄이는 수단이라기보다 ' +
        '공시 내용을 바로잡는 일입니다 — 공정위는 공시내용의 정정을 시정조치로 명할 수 있습니다(법 제37조제1항, 공정위 공시 매뉴얼 "위반 시 제재").';
      break;
    }
    case 'transaction_changed': {
      // 'depends' 인 이유 (P2-다 11): "위반 아님" 단정은 변경 재의결·재공시를 **이미 이행했을 때만** 참이다.
      // 이 도구는 이행 여부를 입력받지 않으므로, 이미 놓친 상태라면 Ⅱ.라 위반이 성립해 있는데
      // "위반 아님"이 최악의 거짓 안심이 된다.
      originalViolation = {
        established: 'depends',
        type: '원 공시의 오류 아님 — 변경 건의 새 공시의무 이행 여부에 달림',
        explanation:
          input.regime === 'art26_29'
            ? '거래의 주요내용이 변경된 경우는 원 공시의 오류가 아니라 **다시 이사회 의결을 거쳐 공시할 의무**가 ' +
              '새로 발생한 것입니다. 이 의무를 기한 내 이행했다면 위반이 아니지만, 변경 후 재의결·재공시 없이 ' +
              '이미 기한을 넘겼다면 그 자체가 별도의 위반으로 **이미 성립해 있습니다** (과태료 고시 Ⅱ.라). ' +
              '이행 여부와 기한을 먼저 확인하세요 (변경 의결일 기준 — check_disclosure_duty).'
            : '공시한 내용에 변동이 생긴 경우는 원 공시의 오류가 아니라 변동사항에 대한 공시의무가 새로 ' +
              '발생했는지의 문제입니다. 새 의무가 성립하는데 기한을 이미 넘겼다면 지연 위반이 성립해 있습니다. ' +
              '해당 항목의 공시 요건과 기한을 check_disclosure_duty 로 판정하세요.',
      };
      recommendation =
        input.regime === 'art26_29'
          ? '정정이 아니라 변경 건의 이사회 의결 + 공시 절차를 밟으세요. 기한은 변경 의결일 기준으로 다시 ' +
            '계산됩니다 (check_disclosure_duty 사용). 변경 재의결 없이 방치하면 그 자체가 위반행위입니다. ' +
            '예외는 조건부입니다: 약관에 의한 금융거래 중 이사회 의결을 거치지 않을 수 있는 것은 **금융·보험업을 ' +
            '영위하는 계열 금융회사가 자기 일상적 거래분야에서 약관에 따라 하는 거래**(고시 §9①, 공정위 매뉴얼)이고, ' +
            '그 밖의 회사(비금융사 등)가 계열 금융회사와 약관 금융거래를 하는 경우는 이사회 의결을 분기별로 ' +
            '일괄하여 **할 수 있을 뿐**(수익증권은 1년 이내 기간, 고시 §9②) 의결 자체가 면제되지 않습니다. ' +
            '상품·용역거래가 의결금액보다 20% 이상 감소한 경우는 의결 없이 분기 종료 후 45일 이내 실제 거래금액을 ' +
            '공시합니다(§9의2②). 해당 여부를 먼저 확인하세요.'
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

  // ── 별표 9 보완 칸 ──
  let supplementation: SupplementationGuide | undefined;
  if (hasContentError) {
    supplementation = supplementationGuide(input, today);
    legalBasis.push({
      source: ANNEX9_ROW[input.regime],
      summary:
        input.regime === 'art26_29'
          ? '이사회 의결을 거친 경우 / 공시기한까지 공시 / 누락·거짓 사항을 공시기한이 지난 후 과태료 처분 사전통지서 ' +
            '발송일 전날까지 보완: 500만원(공시기한을 넘긴 날의 다음 날부터 보완을 마친 날까지 1일마다 10만원 가산, ' +
            '2천만원 한도) / 보완하지 않은 누락·거짓: 2,000만원'
          : '공시기한까지 공시 / 누락·거짓 사항을 공시기한이 지난 후 과태료 처분 사전통지서 발송일 전날까지 보완: ' +
            '100만원(공시기한을 넘긴 날의 다음 날부터 보완을 마친 날까지 1일마다 5만원 가산, 5백만원 한도) / ' +
            '보완하지 않은 누락·거짓: 500만원',
    });
  }

  // ── 골든타임 · 보완 사건 감경 시나리오 ──
  let selfCorrection: SelfCorrectionResult | undefined;
  let delayMitigationScenario: CorrectionRiskResult['delayMitigationScenario'];
  if (input.originalDeadline && hasContentError) {
    const w = selfCorrectionWindow(input.originalDeadline, input.regime, today);
    // selfCorrectionWindow 의 caution 은 "지연 공시" 건의 지연일수 감경을 전제로 쓰였다 — 보완 사건에는
    // 그 감경 적용이 원문 미확인이므로 caution 을 이 맥락에 맞게 바꿔 준다.
    selfCorrection = {
      ...w,
      caution:
        '10영업일 내 자진시정은 면제의 필요조건일 뿐입니다 — 신규 지정·편입 30일 이내 위반이거나 ' +
        '사소한 부주의(계산 실수·오기)로 인정되는 등 고시 Ⅴ의 사유가 함께 성립해야 하며, ' +
        '요건을 갖춰도 면제는 공정위 재량("면제할 수 있다")입니다. 과태료 체납 중이면 면제되지 않습니다.',
    };
    const n = countCalendarDays(input.originalDeadline, today);
    if (n > 0) {
      const tier = reductionTier(n);
      if (tier.pct > 0) {
        delayMitigationScenario = {
          status: 'unconfirmed_interpretation',
          supplementationElapsedDaysIfCompletedToday: n,
          filingDelayDays: input.originalFiledOnTime === true ? 0 : null,
          reductionPctIfCounted: tier.pct,
          nextDropNoteIfCounted: tier.nextDropNote,
          note:
            '고시 Ⅵ.3.다(4)(나)는 "공시지연 일수가 3일 이하인 경우 75%, 7일 이하 50%, 15일 이하 30%, 30일 이하 20%" ' +
            '라고만 정합니다. 기한 내 공시한 뒤 누락·거짓을 보완한 사건의 보완 경과일을 "공시지연 일수"로 보는지는 ' +
            '원문이 정하지 않았습니다(원문 미확인) — 이 감경률을 확정값으로 전달하지 마세요.' +
            (input.originalFiledOnTime === false
              ? ' 원 공시가 기한을 넘긴 건이면 원 공시의 지연일수(원 공시 접수일 기준)가 공시지연 일수입니다.'
              : ''),
        };
      }
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
    ...(supplementation ? { supplementation } : {}),
    ...(selfCorrection ? { selfCorrection } : {}),
    ...(delayMitigationScenario ? { delayMitigationScenario } : {}),
    recommendation,
    notes,
    legalBasis,
    disclaimer:
      '본 진단은 공개된 과태료 고시·시행령 별표 9 원문에 기반한 참고 정보이며 공정거래위원회의 공식 유권해석이 아닙니다. ' +
      '면제·감경은 모두 공정위 재량("면제할 수 있다")이고, 제시한 금액은 기본금액이지 최종 부과액이 아닙니다.',
  };
}
