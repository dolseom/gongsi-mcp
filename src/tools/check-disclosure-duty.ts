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
  omnibusQuarterlyDeadline,
  goodsServicesReducedDeadline,
  groupStatusAnnualDeadline,
  groupStatusQuarterlyDeadline,
  evaluateCompliance,
  businessDaysRemaining,
} from '../rules/deadlines.js';
import { estimatePenalty } from '../rules/penalties.js';
import { toYMD } from '../rules/business-days.js';
import type { AmountBasis, DeadlineResult, Verdict } from '../rules/types.js';
import { errorResponse, type ErrorResponse } from '../lib/errors.js';

const YMD = z
  .string()
  .regex(/^\d{8}$/, 'YYYYMMDD 형식이어야 합니다 (예: 20260722)');

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

  amount: z.number().optional().describe('거래금액 (원). 기준금액과 비교해 공시 대상 여부를 판정한다'),
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
    ])
    .optional()
    .describe('비상장사 중요사항 세부 항목. 항목별로 임계 비율과 기준 수치가 다르다'),

  actualDisclosureDate: YMD.optional()
    .describe('실제 공시일. 주면 기한 준수 여부와 지연일수를 함께 판정한다'),
  today: YMD.optional().describe('오늘 날짜 (기본: 시스템 날짜). D-day 계산 기준'),

  estimatePenaltyIfLate: z
    .boolean()
    .optional()
    .describe('지연이 확인되면 예상 과태료도 함께 산정할지 (기본 true)'),
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
  notes: string[];
  disclaimer: string;
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
      deadline = unlistedMaterialDeadline(input.occurredDate);
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
    if (!input.materialItem) {
      verdict = 'insufficient_data';
      summary =
        'materialItem(세부 항목)이 필요합니다. 금액 무관 공시 대상도 있습니다: ' +
        UNLISTED_MATERIAL_UNCONDITIONAL.join(' / ');
    } else {
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
      }
      if (input.totalEquity !== undefined && input.paidInCapital !== undefined && input.totalEquity < input.paidInCapital) {
        notes.push(
          '자기자본이 자본금에 미달하여 고시 §5의2③에 따라 **자본금을 자기자본으로 보아** 계산했습니다.',
        );
      }
    }
  } else {
    // 기한만 계산하는 유형
    verdict = 'required';
    summary = '해당 의무의 공시기한을 계산했습니다.';
  }

  // ── 기한 준수·과태료 ──
  let compliance: DutyResult['compliance'];
  let penalty: unknown;

  if (deadline && input.actualDisclosureDate) {
    const c = evaluateCompliance(deadline.deadline, input.actualDisclosureDate);
    compliance = { ...c, actualDisclosureDate: input.actualDisclosureDate };
    summary +=
      ' ' +
      (c.onTime
        ? `실제 공시 ${input.actualDisclosureDate} — 기한(${deadline.deadline}) 내이므로 **적법**합니다.`
        : `실제 공시 ${input.actualDisclosureDate} — 기한(${deadline.deadline}) 대비 **${c.delayDays}일 지연**입니다.`);

    if (!c.onTime && (input.estimatePenaltyIfLate ?? true)) {
      const regime =
        input.duty === 'large_internal_transaction' || input.duty === 'public_interest_corp'
          ? 'art26_29'
          : 'art27_28';
      penalty = estimatePenalty({
        regime,
        boardResolution: true,
        disclosed: true,
        onTime: false,
        delayDays: c.delayDays,
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

  return {
    duty: input.duty,
    verdict,
    summary,
    ...(threshold ? { threshold } : {}),
    ...(deadlineOut ? { deadline: deadlineOut } : {}),
    ...(compliance ? { compliance } : {}),
    ...(penalty ? { penalty } : {}),
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
