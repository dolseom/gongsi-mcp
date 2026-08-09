/**
 * `check_disclosure_duty` — 공시의무 진단·기한 계산 (킬러 #1)
 *
 * 룰 엔진을 MCP 도구로 노출한다. **외부 API를 쓰지 않으므로** 키가 없어도 동작하고,
 * 호출 한도와도 무관하다.
 *
 * 설계 원칙:
 *  - 판정 결과에는 **근거 조문·계산식·입력값을 반드시 동봉**한다 (재현 가능성).
 *  - 자본총계·자본금이 없으면 추정하지 않고 `insufficient_data` 로 돌려준다.
 *  - 자동 제출은 하지 않는다. 초안·판정까지만.
 */

import { z } from 'zod';
import {
  calcThreshold,
  isLargeInternalTransaction,
  AMOUNT_BASIS_GUIDE,
  UNLISTED_MATERIAL_THRESHOLDS,
  UNLISTED_MATERIAL_UNCONDITIONAL,
  effectiveEquity,
} from '../rules/thresholds.js';
import {
  litDeadline,
  unlistedMaterialDeadline,
  unlistedMajorShareholderDeadline,
  omnibusQuarterlyDeadline,
  goodsServicesReducedDeadline,
  groupStatusAnnualDeadline,
  groupStatusQuarterlyDeadline,
  evaluateCompliance,
  businessDaysRemaining,
} from '../rules/deadlines.js';
import {
  checkUnlistedSubjectCompany,
  UNLISTED_UNCONDITIONAL_ITEMS,
  DECISION_DATE_NOTE,
  CAPITAL_MARKET_OVERLAP_NOTE,
  type UnconditionalItem,
} from '../rules/unlisted-material.js';
import { estimatePenalty, type PenaltyRegime } from '../rules/penalties.js';
import { selfCorrectionWindow, type SelfCorrectionResult } from '../rules/self-correction.js';
import { toYMD, toDate, isValidYMD } from '../rules/business-days.js';
import type { AmountBasis, DeadlineResult, Verdict } from '../rules/types.js';
import { errorResponse, type ErrorResponse } from '../lib/errors.js';
import { searchQna, type QnaCategory } from '../kb/qna.js';

const YMD = z
  .string()
  .regex(/^\d{8}$/, 'YYYYMMDD 형식이어야 합니다 (예: 20260722)')
  // 20260231 같은 값은 Date 롤오버로 기한이 조용히 틀어진다 — 실존 날짜만 통과
  .refine(isValidYMD, '실존하지 않는 날짜입니다');

export const checkDisclosureDutyInput = z.object({
  duty: z
    .enum([
      'large_internal_transaction',
      'unlisted_material',
      'group_status',
      'public_interest_corp',
      'omnibus_financial',
      'goods_services_reduced',
    ])
    .describe(
      '공시의무 유형. large_internal_transaction=대규모내부거래(법§26), unlisted_material=비상장사 중요사항(법§27), ' +
        'group_status=기업집단현황(법§28), public_interest_corp=공익법인(법§29), ' +
        'omnibus_financial=약관에 의한 금융거래 특례(고시§9), goods_services_reduced=상품·용역 20%↑ 감소(고시§9의2)',
    ),

  listing: z
    .enum(['listed', 'unlisted'])
    .optional()
    .describe('상장 여부. 대규모내부거래 기한이 갈린다 (상장 3영업일 / 비상장 7영업일)'),

  boardDate: YMD.optional().describe('이사회 의결일 (대규모내부거래·공익법인)'),
  occurredDate: YMD.optional().describe('사유 발생일 (비상장사 중요사항)'),
  quarterEnd: YMD.optional().describe('분기 종료일 (약관 금융거래·상품용역 감소)'),
  year: z.number().int().optional().describe('연도 (기업집단현황)'),
  quarter: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional()
    .describe('분기. 지정하면 분기공시(종료 후 2개월), 생략하면 연1회(5/31)'),

  amount: z
    .number()
    .nonnegative('거래금액은 0 이상이어야 합니다')
    .optional()
    .describe(
      '거래금액 (원). 기준금액과 비교해 공시 대상 여부를 판정하고, 지연 시 과태료의 ' +
        '거래금액별 적용비율(고시 Ⅵ.2 — 100억원 미만이면 90~50%)에도 쓰인다. ' +
        '약관 금융거래는 분기 일괄 거래금액, 상품·용역 감소 특례는 실제 거래금액을 넣는다',
    ),
  amountBasis: z
    .enum(['actual', 'collateral_limit', 'lease_annualized', 'insurance_premium_total', 'quarterly_sum'])
    .optional()
    .describe(
      '거래금액 산정 방식 (고시§4③). ⚠️ 틀리면 판정이 뒤집힌다. ' +
        'collateral_limit=담보제공은 담보한도액, lease_annualized=부동산임대차는 연간임대료+보증금환산, ' +
        'insurance_premium_total=보험은 보험료총액, quarterly_sum=상품용역은 분기 합계액',
    ),

  totalEquity: z.number().optional().describe('자본총계 (원). 주총 승인된 최근 사업연도말 재무제표 기준'),
  paidInCapital: z.number().optional().describe('자본금 (원). 이사회 의결일 직전일 기준'),
  totalAssets: z.number().optional().describe('자산총액 (원). 비상장사 중요사항 중 고정자산 판정용'),

  materialItem: z
    .enum([
      'fixed_asset',
      'other_corp_stock',
      'gift',
      'guarantee',
      'debt_relief',
      'shareholding_change',
      'capital_change',
      'cb_bw_issue',
      'business_transfer',
      'stock_exchange_transfer',
      'dissolution',
      'rehabilitation',
      'restructuring_procedure',
    ])
    .optional()
    .describe(
      '비상장사 중요사항 세부 항목. 임계 비율형: fixed_asset=고정자산 취득·처분(자산총액 10%), ' +
        'other_corp_stock=타법인 주식(자기자본 5%), gift=증여(1%), guarantee=담보·보증(5%), ' +
        'debt_relief=채무 면제·인수(5%), shareholding_change=최대·주요주주 지분 1%p 변동. ' +
        '금액 무관 결정형: capital_change=증자·감자, cb_bw_issue=CB·BW 발행, business_transfer=영업양수도·합병·분할, ' +
        'stock_exchange_transfer=주식 포괄적 교환·이전, dissolution=해산, rehabilitation=회생절차, ' +
        'restructuring_procedure=기촉법 관리절차',
    ),

  shareholderType: z
    .enum(['largest', 'major'])
    .optional()
    .describe(
      'shareholding_change 전용 — largest=최대주주(7영업일 공시) / major=주요주주(분기별 공시, 고시 §5의2④ 단서). ' +
        '기한이 완전히 달라지므로 반드시 구분하세요',
    ),
  shareChangePct: z
    .number()
    .optional()
    .describe('shareholding_change 전용 — 발행주식총수 대비 지분 변동 크기 (%p). 1 이상이면 공시 대상'),

  isFinancialCompany: z
    .boolean()
    .optional()
    .describe('금융업·보험업 영위 여부 (비상장사 중요사항 대상회사 판정용 — 영위하면 제외)'),
  specialRelated20pct: z
    .boolean()
    .optional()
    .describe(
      '자산총액 100억 미만 회사의 대상 판정용 — 동일인·친족이 합산 20% 이상 소유한 회사(또는 그 회사가 ' +
        '50% 초과 소유한 자회사)인지 (고시 §2②2호)',
    ),
  inLiquidationOrDormant: z
    .boolean()
    .optional()
    .describe('청산 절차 진행 중 또는 1년 이상 휴업 중인지 (고시 §2②2호 단서의 제외 요건)'),

  actualDisclosureDate: YMD.optional()
    .describe('실제 공시일. 주면 기한 준수 여부와 지연일수를 함께 판정한다'),
  today: YMD.optional().describe('오늘 날짜 (기본: 시스템 날짜). D-day 계산 기준'),

  estimatePenaltyIfLate: z
    .boolean()
    .optional()
    .describe('지연이 확인되면 예상 과태료도 함께 산정할지 (기본 true)'),

  disclosureStatus: z
    .enum(['not_disclosed', 'disclosed'])
    .optional()
    .describe(
      '공시 이행 상태. not_disclosed(아직 공시 전)를 명시하면 기한 경과 시 자진시정 골든타임을 계산합니다. ' +
        '생략하면 미공시로 단정하지 않습니다 — 기한만 조회하는 호출과 구분하기 위한 명시적 입력입니다',
    ),

  situation: z
    .string()
    .max(500, '거래 상황 서술은 500자 이내로 요약하세요')
    .optional()
    .describe(
      '거래 상황 서술 (예: "계열사 발행어음이 만기 후 자동연장됨", 500자 이내). 주면 유사한 공정위 공식 Q&A를 ' +
        'relatedOfficialQna 로 함께 돌려줍니다 — 규칙만으로 판정하기 어려운 경계사례(대상 여부·거래 성격)에 유용합니다',
    ),
});

export type CheckDisclosureDutyInput = z.infer<typeof checkDisclosureDutyInput>;

interface DutyResult {
  duty: string;
  verdict: Verdict;
  summary: string;
  threshold?: {
    amount: number;
    formula: string;
    inputs: Record<string, number | undefined>;
    amountBasisNote?: string;
  };
  deadline?: DeadlineResult & { dDay?: number };
  compliance?: { onTime: boolean; delayDays: number; actualDisclosureDate: string };
  penalty?: unknown;
  selfCorrection?: SelfCorrectionResult;
  relatedOfficialQna?: Array<{
    question: string;
    answer: string | null;
    source: { doc: string; docYear: number | null; url: string };
    caveats: string[];
  }>;
  notes: string[];
  disclaimer: string;
}

/** duty → Q&A 지식베이스 카테고리. 약관특례·상품용역감소·공익법인은 전부 대규모내부거래 문서권이다 */
const DUTY_TO_QNA_CATEGORY: Record<CheckDisclosureDutyInput['duty'], QnaCategory> = {
  large_internal_transaction: 'internal_transaction',
  public_interest_corp: 'internal_transaction',
  omnibus_financial: 'internal_transaction',
  goods_services_reduced: 'internal_transaction',
  unlisted_material: 'unlisted_material',
  group_status: 'group_status',
};

function isUnconditionalItem(x: string): x is UnconditionalItem {
  return x in UNLISTED_UNCONDITIONAL_ITEMS;
}

const DISCLAIMER =
  '본 판정은 공개된 법령·고시에 기반한 참고 정보이며 공정거래위원회의 공식 유권해석이 아닙니다. ' +
  '실제 신고 전 소관 부서 확인을 권장합니다.';

export function checkDisclosureDuty(
  input: CheckDisclosureDutyInput,
): DutyResult | ErrorResponse {
  const today = input.today ?? toYMD(new Date());
  const notes: string[] = [];

  // ── 기한 계산 ──
  let deadline: DeadlineResult | undefined;
  switch (input.duty) {
    case 'large_internal_transaction':
    case 'public_interest_corp': {
      if (!input.boardDate) {
        return errorResponse('invalid_argument', 'boardDate(이사회 의결일)가 필요합니다.');
      }
      if (!input.listing) {
        return errorResponse(
          'invalid_argument',
          'listing(상장 여부)이 필요합니다. 상장 3영업일 / 비상장·공익법인 7영업일로 기한이 갈립니다.',
        );
      }
      deadline = litDeadline(input.boardDate, input.listing);
      break;
    }
    case 'unlisted_material': {
      if (!input.occurredDate) {
        return errorResponse('invalid_argument', 'occurredDate(사유 발생일)가 필요합니다.');
      }
      // 주요주주 지분변동만 분기별 공시 — 최대주주 변동·그 외 사유는 전부 7영업일 (§5의2④)
      // 유형에 따라 기한이 완전히 달라지므로 미지정 추정은 위험하다 (Codex 3차: 지연·과태료가 뒤집힌다)
      if (input.materialItem === 'shareholding_change') {
        if (!input.shareholderType) {
          return errorResponse(
            'invalid_argument',
            'shareholding_change 는 shareholderType(largest=최대주주/major=주요주주)이 필수입니다. ' +
              '최대주주 변동은 7영업일, 주요주주 변동은 분기 종료 후 2개월로 기한이 완전히 다릅니다 (고시 §5의2④ 단서).',
          );
        }
        deadline =
          input.shareholderType === 'major'
            ? unlistedMajorShareholderDeadline(input.occurredDate)
            : unlistedMaterialDeadline(input.occurredDate);
      } else {
        deadline = unlistedMaterialDeadline(input.occurredDate);
      }
      break;
    }
    case 'omnibus_financial': {
      if (!input.quarterEnd) {
        return errorResponse('invalid_argument', 'quarterEnd(분기 종료일)가 필요합니다.');
      }
      deadline = omnibusQuarterlyDeadline(input.quarterEnd);
      notes.push(
        '약관에 의한 금융업 일상거래는 고시 §9 특례로 **이사회 의결이 필요 없습니다**. 분기별로 모아 공시합니다.',
      );
      break;
    }
    case 'goods_services_reduced': {
      if (!input.quarterEnd) {
        return errorResponse('invalid_argument', 'quarterEnd(분기 종료일)가 필요합니다.');
      }
      deadline = goodsServicesReducedDeadline(input.quarterEnd);
      break;
    }
    case 'group_status': {
      const year = input.year ?? Number(today.slice(0, 4));
      deadline = input.quarter
        ? groupStatusQuarterlyDeadline(year, input.quarter)
        : groupStatusAnnualDeadline(year);
      break;
    }
  }

  // ── 기준금액·대상 판정 ──
  let verdict: Verdict = 'insufficient_data';
  let summary = '';
  let threshold: DutyResult['threshold'];

  if (input.duty === 'large_internal_transaction' || input.duty === 'public_interest_corp') {
    const t = calcThreshold(
      { totalEquity: input.totalEquity, paidInCapital: input.paidInCapital },
      { entity: input.duty === 'public_interest_corp' ? 'public_interest_corp' : 'company' },
    );
    if (!t) {
      verdict = 'insufficient_data';
      summary =
        '자본총계 또는 자본금이 없어 기준금액을 계산할 수 없습니다. ' +
        'get_financials 로 해당 회사의 자본총계·자본금을 먼저 조회하세요.';
      notes.push('※ 통용되는 "50억원 기준"은 폐지된 옛 기준입니다. 현행은 min(100억, max(5억, 자본×5%))입니다.');
    } else {
      threshold = {
        amount: t.threshold,
        formula: t.formula,
        inputs: t.inputs as Record<string, number | undefined>,
      };
      if (input.amountBasis) {
        threshold.amountBasisNote = `거래금액 산정: ${AMOUNT_BASIS_GUIDE[input.amountBasis as AmountBasis]}`;
      } else {
        notes.push(
          '⚠️ amountBasis 를 지정하지 않았습니다. 담보제공(담보한도액)·부동산임대차(연간임대료+보증금환산)·' +
            '보험(보험료총액)·상품용역(분기 합계액)은 산정 방식이 달라 판정이 뒤집힐 수 있습니다.',
        );
      }
      if (input.amount === undefined) {
        verdict = 'insufficient_data';
        summary = `기준금액은 ${fmtWon(t.threshold)}입니다. amount(거래금액)를 주면 대상 여부를 판정합니다.`;
      } else {
        const required = isLargeInternalTransaction(input.amount, t.threshold);
        verdict = required ? 'required' : 'not_required';
        summary = required
          ? `공시 대상입니다. 거래금액 ${fmtWon(input.amount)} ≥ 기준금액 ${fmtWon(t.threshold)}. 이사회 사전 의결이 필요합니다.`
          : `공시 대상이 아닙니다. 거래금액 ${fmtWon(input.amount)} < 기준금액 ${fmtWon(t.threshold)}.`;
        if (!required && input.amount >= t.threshold * 0.9) {
          notes.push(
            '기준금액의 90% 이상입니다. 분기 합산이나 관련 거래 합산 시 대상이 될 수 있으니 확인하세요.',
          );
        }
      }
    }
  } else if (input.duty === 'unlisted_material') {
    // ── 0단계: 대상회사 판정 (§2②) — 사유를 보기 전에 회사 자체가 대상인지부터 ──
    const subjectCheck = checkUnlistedSubjectCompany({
      isListed: input.listing === undefined ? undefined : input.listing === 'listed',
      isFinancialOrInsurance: input.isFinancialCompany,
      totalAssets: input.totalAssets,
      specialRelated20pct: input.specialRelated20pct,
      inLiquidationOrDormant: input.inLiquidationOrDormant,
    });
    if (subjectCheck.subject === false) {
      verdict = 'not_required';
      summary = `공시대상비상장회사가 아닙니다. ${subjectCheck.reasons.join(' ')}`;
      notes.push(
        '※ 대상회사 판정은 공시대상기업집단 소속을 전제로 합니다 — 소속 여부는 resolve_entity(includeGroup=true)로 확인하세요.',
      );
    } else {
      if (subjectCheck.subject === 'insufficient_data') {
        notes.push(
          `대상회사 여부 미확정: ${subjectCheck.reasons.join(' ')} 아래 사유 판정은 대상회사임을 전제한 참고값입니다.`,
        );
      } else {
        notes.push(`대상회사 확인: ${subjectCheck.reasons.join(' ')}`);
      }
      notes.push(
        '※ 법 §26(대규모내부거래)에 따라 공시되는 사항은 비상장사 중요사항 공시에서 제외됩니다 (고시 §5의2① 단서).',
      );

      if (!input.materialItem) {
        verdict = 'insufficient_data';
        summary =
          'materialItem(세부 항목)이 필요합니다. 금액 무관 공시 대상도 있습니다: ' +
          UNLISTED_MATERIAL_UNCONDITIONAL.join(' / ');
      } else if (isUnconditionalItem(input.materialItem)) {
        // ── 금액 무관 결정형 사유 — 결정이 있으면 그 자체로 공시 대상 ──
        const spec = UNLISTED_UNCONDITIONAL_ITEMS[input.materialItem];
        verdict = 'required';
        summary = `${spec.label}은(는) 금액과 무관하게 결정(사유 발생) 자체로 공시 대상입니다 (고시 ${spec.clause}).`;
        if (spec.occurrenceNote) notes.push(spec.occurrenceNote);
        notes.push(DECISION_DATE_NOTE);
        notes.push(CAPITAL_MARKET_OVERLAP_NOTE);
      } else if (input.materialItem === 'shareholding_change') {
        // ── 지분 변동 — 금액이 아니라 발행주식총수 대비 변동폭(%p)으로 판정 ──
        if (input.shareChangePct === undefined) {
          verdict = 'insufficient_data';
          summary =
            '최대주주·주요주주 지분변동은 발행주식총수 대비 1%p 이상 변동 시 공시 대상입니다. ' +
            'shareChangePct(변동폭 %p)를 주면 판정합니다.';
        } else {
          // 감소(-)도 변동이다 — 절댓값으로 판정한다 (Codex 3차: 음수 입력 미탐)
          const changeMagnitude = Math.abs(input.shareChangePct);
          const required = changeMagnitude >= 1;
          verdict = required ? 'required' : 'not_required';
          summary = required
            ? `공시 대상입니다. 지분 변동 ${changeMagnitude}%p ≥ 1%p (고시 §5의2①1호가목).`
            : `공시 대상이 아닙니다. 지분 변동 ${changeMagnitude}%p < 1%p.`;
          threshold = {
            amount: 1,
            formula: `발행주식총수 대비 변동폭 |${input.shareChangePct}|%p vs 임계 1%p`,
            inputs: { shareChangePct: input.shareChangePct },
          };
        }
        notes.push(
          '변동 기준일은 시행령 §17제1호에서 규정한 날입니다. 주요주주 변동은 분기별 공시입니다 (§5의2④ 단서).',
        );
      } else {
        // ── 임계 비율형 사유 ──
        const spec = UNLISTED_MATERIAL_THRESHOLDS[input.materialItem];
        const base =
          spec.base === 'totalAssets'
            ? input.totalAssets
            : spec.base === 'equity'
              ? input.totalEquity !== undefined && input.paidInCapital !== undefined
                ? effectiveEquity(input.totalEquity, input.paidInCapital)
                : input.totalEquity
              : undefined;

        if (base === undefined) {
          verdict = 'insufficient_data';
          summary = `${spec.label} 판정에는 ${spec.base === 'totalAssets' ? '자산총액' : '자기자본'}이 필요합니다.`;
          notes.push(
            '신설 회사로 최근 사업연도 대차대조표가 없으면 설립 당시 납입자본금을 기준으로 합니다 (고시 §5의2②).',
          );
        } else if (input.amount === undefined) {
          verdict = 'insufficient_data';
          summary = `${spec.label}: 임계값은 ${fmtWon(base * spec.rate)} (${spec.base === 'totalAssets' ? '자산총액' : '자기자본'}의 ${spec.rate * 100}%)입니다. amount 를 주면 판정합니다.`;
        } else {
          const limit = base * spec.rate;
          const required = input.amount >= limit;
          verdict = required ? 'required' : 'not_required';
          summary = required
            ? `공시 대상입니다. ${spec.label} ${fmtWon(input.amount)} ≥ 임계 ${fmtWon(limit)}.`
            : `공시 대상이 아닙니다. ${spec.label} ${fmtWon(input.amount)} < 임계 ${fmtWon(limit)}.`;
          threshold = {
            amount: limit,
            formula: `${spec.base === 'totalAssets' ? '자산총액' : '자기자본'} ${fmtWon(base)} × ${spec.rate * 100}% = ${fmtWon(limit)}`,
            inputs: { base },
          };
          if (input.materialItem === 'guarantee') {
            notes.push('계약 등의 이행보증·납세보증을 위한 채무보증은 제외됩니다 (고시 §5의2①2호라목).');
          }
        }
        if (
          input.totalEquity !== undefined &&
          input.paidInCapital !== undefined &&
          input.totalEquity < input.paidInCapital
        ) {
          notes.push(
            '자기자본이 자본금에 미달하여 고시 §5의2③에 따라 **자본금을 자기자본으로 보아** 계산했습니다.',
          );
        }
        notes.push(DECISION_DATE_NOTE);
        notes.push(CAPITAL_MARKET_OVERLAP_NOTE);
      }
    }
  } else {
    // 기한만 계산하는 유형
    verdict = 'required';
    summary = '해당 의무의 공시기한을 계산했습니다.';
  }

  // ── 기한 준수·과태료 ──
  // 약관특례(§9)·상품용역 감소(§9의2)는 대규모내부거래 고시의 특례이므로 위반 시 법 §26 체계다.
  // §27·§28 은 비상장사 중요사항·기업집단현황뿐이다. (Codex 교차검토가 잡은 오분류 수정)
  const regime: PenaltyRegime =
    input.duty === 'unlisted_material' || input.duty === 'group_status' ? 'art27_28' : 'art26_29';

  let compliance: DutyResult['compliance'];
  let penalty: unknown;

  // 대상이 아니라고 판정했으면 지연·과태료를 붙이지 않는다 — "대상 아님 + 20일 지연"은 모순이다
  // (Codex 3차 지적: 상장회사 not_required 응답에 지연·과태료가 동봉되던 실버그)
  if (deadline && input.actualDisclosureDate && verdict !== 'not_required') {
    const c = evaluateCompliance(deadline.deadline, input.actualDisclosureDate);
    compliance = { ...c, actualDisclosureDate: input.actualDisclosureDate };
    summary +=
      ' ' +
      (c.onTime
        ? `실제 공시 ${input.actualDisclosureDate} — 기한(${deadline.deadline}) 내이므로 **적법**합니다.`
        : `실제 공시 ${input.actualDisclosureDate} — 기한(${deadline.deadline}) 대비 **${c.delayDays}일 지연**입니다.`);

    if (!c.onTime && (input.estimatePenaltyIfLate ?? true)) {
      penalty = estimatePenalty({
        regime,
        boardResolution: true,
        disclosed: true,
        onTime: false,
        delayDays: c.delayDays,
        // 거래금액별 적용비율(고시 Ⅵ.2)은 §26·§29 전용이다. 그 게이트는 estimatePenalty 안에 있으므로
        // 여기서는 그대로 넘긴다 — §27·§28(비상장사 중요사항·기업집단현황)에서는 무시된다.
        ...(input.amount !== undefined ? { transactionAmount: input.amount } : {}),
        capitalBase:
          input.totalEquity !== undefined || input.paidInCapital !== undefined
            ? Math.max(input.totalEquity ?? 0, input.paidInCapital ?? 0)
            : undefined,
      });
    }
  }

  const deadlineOut = deadline
    ? { ...deadline, dDay: businessDaysRemaining(today, deadline.deadline) }
    : undefined;

  if (deadline?.warnings.length) notes.push(...deadline.warnings);

  // ── 자진시정 골든타임 ──
  // 리서치 결론의 포지셔닝: "위반 통보"가 아니라 "면제 골든타임 내 구조".
  //
  // Codex 교차검토 반영 2건:
  //  - actualDisclosureDate 생략은 "아직 미공시"가 아니다 (기한만 조회하는 호출이 흔하다)
  //    → disclosureStatus:'not_disclosed' 명시 + verdict가 required 로 확정된 경우에만 부착한다.
  //  - 최초 공시를 늦게 낸 것은 고시 Ⅴ의 "스스로 시정하여 다시 공시"가 아니다
  //    → 지연 공시 사후 판정에는 골든타임을 부착하지 않는다 (면제 요건은 penalty disclaimer가 안내).
  let selfCorrection: DutyResult['selfCorrection'];
  const deadlinePassed = deadline && toDate(today) > toDate(deadline.deadline);
  if (deadline && deadlinePassed && !input.actualDisclosureDate && verdict === 'required') {
    if (input.disclosureStatus === 'not_disclosed') {
      selfCorrection = selfCorrectionWindow(deadline.deadline, regime, today);
      if (selfCorrection.status === 'open') {
        notes.push(
          `⚠️ 공시기한(${deadline.deadline})이 지났고 아직 공시 전입니다. ` +
            `자진시정 골든타임이 ${selfCorrection.windowEnd}까지 열려 있습니다` +
            (selfCorrection.isLastDay
              ? ' — **오늘이 마지막 날입니다**. '
              : ` (남은 영업일 ${selfCorrection.businessDaysRemaining}일). `) +
            `selfCorrection 의 면제 사유와 주의사항을 확인하고 즉시 공시하세요.`,
        );
      } else {
        // 감경 구간(지연 30일 이하)이 실제로 남아 있을 때만 감경을 언급한다
        const delaySoFar = evaluateCompliance(deadline.deadline, today).delayDays;
        notes.push(
          `공시기한(${deadline.deadline})과 자진시정 10영업일(${selfCorrection.windowEnd})이 모두 지났습니다. ` +
            (delaySoFar <= 30
              ? `현재 지연 ${delaySoFar}일 — 지연일수 감경 구간(30일 이하, 달력일 기준)이 아직 남아 있으므로 즉시 공시가 손실을 최소화합니다.`
              : `현재 지연 ${delaySoFar}일로 지연일수 감경 구간(30일 이하)도 지났습니다. ` +
                `그래도 기한초과 과태료는 일수 가산에 상한이 있어 미공시 상태보다 불리하지 않습니다 — 즉시 공시해 위반 상태를 해소하세요.`),
        );
      }
    } else {
      notes.push(
        `공시기한(${deadline.deadline})이 이미 지났습니다. 아직 공시 전이라면 disclosureStatus:"not_disclosed" 로 ` +
          `다시 호출하세요 — 자진시정 골든타임(기한 만료 익일부터 10영업일)과 면제 사유를 계산해 드립니다.`,
      );
    }
  }

  // ── 유사 공정위 공식 Q&A 동봉 ──
  // 규칙 엔진은 금액·기한만 판정한다. "이 거래가 애초에 대상인가"(특수관계인 여부·거래 성격)는
  // 규칙으로 환원되지 않는 경계사례가 많아, 상황 서술이 오면 공정위 공식 답변을 근거로 붙인다.
  let relatedOfficialQna: DutyResult['relatedOfficialQna'];
  if (input.situation) {
    // 지식베이스 문제(파일 손상 등)가 본 판정을 죽이면 안 된다 — Q&A 첨부는 부가 기능이다
    let matches: ReturnType<typeof searchQna> = [];
    try {
      matches = searchQna(input.situation, {
        category: DUTY_TO_QNA_CATEGORY[input.duty],
        limit: 3,
      });
    } catch (err) {
      notes.push(
        `공정위 Q&A 지식베이스 검색에 실패해 relatedOfficialQna 를 첨부하지 못했습니다 ` +
          `(${err instanceof Error ? err.name : 'unknown'}). 판정 결과 자체는 유효합니다.`,
      );
    }
    if (matches.length) {
      relatedOfficialQna = matches.map((m) => ({
        question: m.entry.question,
        answer: m.entry.answer,
        source: { doc: m.entry.doc, docYear: m.entry.docYear, url: m.entry.url },
        caveats: m.entry.caveats,
      }));
      notes.push(
        '상황 서술과 유사한 공정위 공식 Q&A를 relatedOfficialQna 로 첨부했습니다. ' +
          '옛 문서의 답변은 caveats(폐지된 기준금액·기한)를 함께 읽어야 하며, 현행 수치는 본 판정 결과가 우선합니다. ' +
          '더 찾으려면 search_ftc_qna 를 사용하세요.',
      );
    }
  }

  return {
    duty: input.duty,
    verdict,
    summary,
    ...(threshold ? { threshold } : {}),
    ...(deadlineOut ? { deadline: deadlineOut } : {}),
    ...(compliance ? { compliance } : {}),
    ...(penalty ? { penalty } : {}),
    ...(selfCorrection ? { selfCorrection } : {}),
    ...(relatedOfficialQna ? { relatedOfficialQna } : {}),
    notes,
    disclaimer: DISCLAIMER,
  };
}

function fmtWon(n: number): string {
  const 억 = 100_000_000;
  if (n >= 억) {
    const v = n / 억;
    return `${Number.isInteger(v) ? v : v.toFixed(2)}억원`;
  }
  return `${n.toLocaleString('ko-KR')}원`;
}
