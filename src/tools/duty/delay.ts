/**
 * 날짜 없이 "N일 늦었다"만 알 때의 **조건부** 과태료 산정 (B→A 평가 d09 실패 경로, Codex 적대 검토 §4).
 *
 * 설계 (검토문 §4 그대로):
 *  - 일수 단위를 받는다(delayDayBasis: calendar | business | unknown). 과태료의 일수가산·"공시지연 일수" 감경
 *    구간은 이 도구 전체에서 **달력일**로 센다(evaluateCompliance). 영업일 N일은 날짜 없이 달력일로 바꿀 수
 *    없으므로 금액을 만들지 않는다 — 달력일보다 짧게 잡으면 감경이 커져 **과소 산정(거짓 안심)** 이 된다.
 *  - 이미 제출(filed)과 오늘 제출 가정(not_yet_filed)을 구분한다 — 후자는 하루 늦을수록 늘어난다.
 *  - 사전 이사회 의결 상태를 가정하지 않는다: 입력이 없으면 "의결 O / 의결 X" 두 시나리오를 나란히 보인다
 *    (의결 요건이 없는 경로 — 약관특례 제9조제1항·상품용역 감소 — 는 한 시나리오).
 *  - 날짜 입력과 충돌하면 조용히 한쪽을 고르지 않는다 — 불일치를 표시하고 날짜 기반 결과를 그대로 둔다.
 *  - 일수로 공시기한을 **역산하지 않는다** (기한은 미확정인 채 둔다).
 *  - 과태료 계산은 rules/penalties.ts 의 estimatePenalty 를 호출만 한다.
 */

import { estimatePenalty, type PenaltyRegime } from '../../rules/penalties.js';
import type { PenaltyResult } from '../../rules/types.js';

/** 과태료 금액 표기 — penalties.ts 산식과 같은 만원 단위 (1만원 미만은 엔진이 이미 절사) */
export function formatPenaltyWon(won: number): string {
  return `${(won / 10_000).toLocaleString('ko-KR')}만원`;
}

export type DelayDayBasis = 'calendar' | 'business' | 'unknown';
export type DelayFilingState = 'filed' | 'not_yet_filed';

/** 고시 Ⅵ.3.다(4)(나) "공시지연 일수" 감경 구간 — penalties.ts 의 DELAY_TIERS 와 같은 값(안내 문구용) */
const TIERS: Array<{ maxDays: number; pct: number }> = [
  { maxDays: 3, pct: 75 },
  { maxDays: 7, pct: 50 },
  { maxDays: 15, pct: 30 },
  { maxDays: 30, pct: 20 },
];
const TIER_TEXT = '공시지연 3일 이하 75% · 7일 이하 50% · 15일 이하 30% · 30일 이하 20% 감경(달력일, 과태료 고시 Ⅵ.3.다)';

export interface DelayScenarioInput {
  delayDays: number;
  basis: DelayDayBasis | undefined;
  filingState: DelayFilingState | undefined;
  regime: PenaltyRegime;
  /** 이 거래에 사전 의결이 필요한가 — false 면 의결 요건 없음(면제 경로), 'undetermined' 면 경로 미확정 */
  boardRequired: boolean | 'undetermined';
  boardResolution: boolean | undefined;
  transactionAmount?: number | undefined;
  capitalBase?: number | undefined;
  capitalBaseIncomplete?: boolean;
  /** 날짜로 계산된 지연일수가 있으면 (달력일·영업일) — 충돌 검사용 */
  dateBased?: { calendarDays: number; businessDays: number; source: string } | undefined;
  /** 대상 판정이 미확정인지 — 금액을 "대상일 경우"로 한정한다 */
  dutyUnconfirmed: boolean;
}

export interface DelayScenarioOutput {
  delayDays: number;
  basis: DelayDayBasis;
  filingState: DelayFilingState | 'unspecified';
  status: 'computed' | 'withheld' | 'consistent_with_dates';
  withheldReason?: string;
  scenarios?: Array<{
    label: string;
    boardResolution: 'passed' | 'not_passed' | 'not_required';
    penalty: Omit<PenaltyResult, 'nextThreshold'>;
  }>;
  mitigationTier: string;
  nextBoundary?: { fromDays: number; note: string; amountIfDelayed?: number };
  selfCorrection?: string;
  assumptions: string[];
}

function tierFor(days: number): { maxDays: number; pct: number } | undefined {
  return TIERS.find((t) => days <= t.maxDays);
}

function stripNext(p: PenaltyResult): Omit<PenaltyResult, 'nextThreshold'> {
  // 다음 경계 안내는 이 모듈이 따로 계산한다(nextBoundary) — 두 값이 어긋나 보이지 않게 뺀다.
  const { nextThreshold: _drop, ...rest } = p;
  return rest;
}

export function evaluateDelayScenario(i: DelayScenarioInput): { output: DelayScenarioOutput; notes: string[] } {
  const notes: string[] = [];
  const basis: DelayDayBasis = i.basis ?? 'unknown';
  const filingState = i.filingState ?? 'unspecified';
  const n = i.delayDays;
  const tier = tierFor(n);
  const mitigationTier =
    basis === 'business'
      ? `영업일 ${n}일은 달력일로 ${n}일 이상입니다 — 감경 구간은 달력일로 정해지므로 날짜 없이 확정할 수 없습니다. ${TIER_TEXT}`
      : tier
        ? `달력일 ${n}일 → 공시지연 ${tier.maxDays}일 이하 구간(${tier.pct}% 감경). ${TIER_TEXT}`
        : `달력일 ${n}일 → 공시지연 감경 구간(30일 이하)을 지났습니다. ${TIER_TEXT}`;

  const assumptions: string[] = [
    `신고하신 지연 ${n}일(${basis === 'calendar' ? '달력일' : basis === 'business' ? '영업일' : '단위 미확인 — 달력일로 가정'})을 ` +
      '전제로 한 산정입니다. 공시기한은 날짜가 없어 계산하지 않았습니다(일수로 역산하지 않음).',
    '최초 공시를 기한 뒤에 한 사건(기한 초과 공시)이고, 공시 내용에 주요내용 누락·거짓이 없다는 전제입니다.',
  ];
  if (filingState === 'not_yet_filed') {
    assumptions.push(`아직 공시 전이므로 "오늘 공시하면 ${n}일 지연"이라는 가정입니다 — 하루 늦을수록 일수가 늘어납니다.`);
  } else if (filingState === 'filed') {
    assumptions.push(`이미 ${n}일 늦게 공시를 마친 사건입니다.`);
  }
  if (i.dutyUnconfirmed) {
    assumptions.push('대상 판정이 확정되지 않았습니다 — 아래 금액은 공시 대상으로 확정될 경우의 값입니다.');
  }

  // ── 날짜 입력과의 충돌 ──
  if (i.dateBased) {
    const dateDays = basis === 'business' ? i.dateBased.businessDays : i.dateBased.calendarDays;
    if (dateDays === n) {
      notes.push(
        `신고하신 지연 ${n}일이 날짜로 계산한 지연(${i.dateBased.source})과 일치합니다 — 과태료는 날짜 기반 산정(penalty)을 보세요.`,
      );
      return {
        output: { delayDays: n, basis, filingState, status: 'consistent_with_dates', mitigationTier, assumptions },
        notes,
      };
    }
    notes.push(
      `⚠️ 신고하신 지연 ${n}일${basis === 'business' ? '(영업일)' : ''}이 입력한 날짜로 계산한 지연 ` +
        `${dateDays}일(${i.dateBased.source})과 다릅니다. 어느 쪽도 조용히 고르지 않습니다 — 날짜 기반 결과(compliance·penalty)는 ` +
        '그대로 두었으니 날짜와 일수를 다시 확인하세요.',
    );
    return {
      output: {
        delayDays: n,
        basis,
        filingState,
        status: 'withheld',
        withheldReason: `날짜로 계산한 지연(${dateDays}일)과 불일치`,
        mitigationTier,
        assumptions,
      },
      notes,
    };
  }

  if (basis === 'business') {
    notes.push(
      `지연 ${n}일이 영업일이라 과태료 금액을 만들지 않았습니다 — 일수가산·감경 구간은 달력일 기준이고, 영업일을 달력일로 ` +
        '바꾸려면 날짜가 필요합니다(짧게 잡으면 과소 산정). 기한일·공시일(또는 달력일 지연일수)을 주면 산정합니다.',
    );
    return {
      output: {
        delayDays: n,
        basis,
        filingState,
        status: 'withheld',
        withheldReason: '영업일 → 달력일 환산 불가(날짜 필요)',
        mitigationTier,
        ...selfCorrectionPart(n, basis, filingState),
        assumptions,
      },
      notes,
    };
  }

  // ── 의결 상태별 시나리오 ──
  const base = {
    regime: i.regime,
    disclosed: true,
    onTime: false,
    delayDays: n,
    ...(i.transactionAmount !== undefined ? { transactionAmount: i.transactionAmount } : {}),
    ...(i.capitalBase !== undefined ? { capitalBase: i.capitalBase } : {}),
    ...(i.capitalBaseIncomplete ? { capitalBaseIncomplete: true } : {}),
  };
  const scenarios: NonNullable<DelayScenarioOutput['scenarios']> = [];
  if (i.regime === 'art27_28' || i.boardRequired === false) {
    scenarios.push({
      label: i.regime === 'art27_28' ? '기한 초과 공시 (이사회 의결 요건 없음 — 법 제27조·제28조)' : '기한 초과 공시 (이사회 의결 요건 없는 특례 경로)',
      boardResolution: 'not_required',
      penalty: stripNext(estimatePenalty({ ...base, boardResolution: true })),
    });
  } else if (i.boardResolution === true) {
    scenarios.push({
      label: '사전 이사회 의결 O · 기한 초과 공시',
      boardResolution: 'passed',
      penalty: stripNext(estimatePenalty({ ...base, boardResolution: true })),
    });
  } else if (i.boardResolution === false) {
    scenarios.push({
      label: '사전 이사회 의결 X · 공시 (의결 없이 공시한 것 자체가 별도 위반)',
      boardResolution: 'not_passed',
      penalty: stripNext(estimatePenalty({ ...base, boardResolution: false })),
    });
  } else {
    // 미입력을 "의결 O" 로 가정하지 않는다 — 두 칸의 금액 차이가 커서 한쪽만 보이면 오도한다.
    scenarios.push(
      {
        label:
          i.boardRequired === 'undetermined'
            ? '사전 이사회 의결을 거쳤거나 의결 생략 가능 경로인 경우 · 기한 초과 공시'
            : '사전 이사회 의결 O · 기한 초과 공시',
        boardResolution: 'passed',
        penalty: stripNext(estimatePenalty({ ...base, boardResolution: true })),
      },
      {
        label: '사전 이사회 의결 X · 공시 (의결이 필요했는데 거치지 않은 경우)',
        boardResolution: 'not_passed',
        penalty: stripNext(estimatePenalty({ ...base, boardResolution: false })),
      },
    );
    notes.push(
      '⚠️ 사전 이사회 의결 여부(boardResolution)가 입력되지 않아 의결 O / 의결 X 두 시나리오를 함께 보였습니다 — ' +
        '의결 없이 진행했다면 기한과 무관하게 별표 9의 "의결 X" 칸이 적용됩니다.',
    );
  }

  // ── 다음 감경 경계 (오늘 제출 가정일 때만 의미가 있다) ──
  let nextBoundary: DelayScenarioOutput['nextBoundary'];
  if (tier && filingState !== 'filed') {
    const next = tierFor(tier.maxDays + 1);
    const first = scenarios[0]!;
    const future = estimatePenalty({
      ...base,
      delayDays: tier.maxDays + 1,
      boardResolution: first.boardResolution !== 'not_passed',
    });
    nextBoundary = {
      fromDays: tier.maxDays + 1,
      note:
        `지연 ${tier.maxDays}일까지는 ${tier.pct}% 감경 구간이고, ${tier.maxDays + 1}일째부터 ` +
        (next ? `${next.pct}% 구간으로 떨어집니다` : '공시지연 감경이 없습니다') +
        ` — 감경률은 하루마다가 아니라 이 경계에서 단계적으로 바뀝니다. (${first.label} 기준 ${tier.maxDays + 1}일이면 ` +
        `${formatPenaltyWon(future.amount)})`,
      amountIfDelayed: future.amount,
    };
  }

  const amounts = scenarios.map((s) => `${s.label}: ${formatPenaltyWon(s.penalty.amount)}`).join(' / ');
  notes.push(
    `지연 ${n}일(${basis === 'calendar' ? '달력일' : '단위 미확인 — 달력일 가정'}) 기준 조건부 과태료 산정: ${amounts}. ` +
      '고시 기준 단순 산정값이며 최종 부과액·면제 여부는 공정위 재량입니다 (delayScenario 참조).',
  );
  if (basis === 'unknown') {
    notes.push(
      '⚠️ 지연일수의 단위(delayDayBasis)가 입력되지 않아 달력일로 가정했습니다. 영업일이었다면 달력일은 그보다 길어 일수가산이 ' +
        '늘고 감경 구간이 낮아져 실제 금액이 더 클 수 있습니다.',
    );
  }

  return {
    output: {
      delayDays: n,
      basis,
      filingState,
      status: 'computed',
      scenarios,
      mitigationTier,
      ...(nextBoundary ? { nextBoundary } : {}),
      ...selfCorrectionPart(n, basis, filingState),
      assumptions,
    },
    notes,
  };
}

/**
 * 자진시정 면제 요건 중 **기간** 요건만 일수로 판단한다 (과태료 고시 Ⅴ: 기한 만료 다음 날부터 10영업일 이내 재공시).
 * 영업일 수 ≤ 달력일 수이므로 N ≤ 10 이면 단위와 무관하게 기간 안이다. 그 밖은 날짜가 있어야 안다.
 * ⚠️ 최초 공시를 늦게 낸 사건에는 붙이지 않는다 — 기존 설계(자진시정 = 미공시 상태의 재공시)와 같다.
 */
function selfCorrectionPart(
  n: number,
  basis: DelayDayBasis,
  filingState: DelayFilingState | 'unspecified',
): { selfCorrection?: string } {
  if (filingState !== 'not_yet_filed') return {};
  const exemptionReq =
    '면제는 기간 요건만으로 되지 않습니다 — 신규 지정·편입일 후 30일 이내 위반이거나 사소한 부주의 등 고시 Ⅴ의 사유가 함께 ' +
    '있어야 하고, "면제할 수 있다"(공정위 재량)이며 과태료 체납자는 제외됩니다.';
  if (n <= 10) {
    return {
      selfCorrection:
        `오늘 공시하면 기한 만료 다음 날부터 ${basis === 'business' ? n : `최대 ${n}`}영업일째로, 자진시정 면제의 기간 요건` +
        `(기한 만료 다음 날부터 10영업일 이내 재공시)은 충족합니다. ${exemptionReq}`,
    };
  }
  if (basis === 'business') {
    return {
      selfCorrection: `영업일 ${n}일이 지나 자진시정 면제 기간(기한 만료 다음 날부터 10영업일)은 지났습니다. 즉시 공시가 손실을 줄입니다.`,
    };
  }
  return {
    selfCorrection:
      `달력일 ${n}일은 영업일로는 더 적을 수 있어 자진시정 면제 기간(10영업일) 안인지 날짜 없이 확정할 수 없습니다 — ` +
      `기한일을 주면 계산합니다. ${exemptionReq}`,
  };
}
