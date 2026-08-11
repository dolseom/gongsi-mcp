/**
 * 과태료 산정
 *
 * 근거: 공정거래법 시행령 [별표 9] 과태료의 부과기준(제94조제3호)
 *       + 공정위 과태료 부과기준 고시 2종
 *
 * ⚠️ 공정위 재량과 개별 사정이 반영되지 않은 고시 기준 단순 산정값이다.
 *    실제 부과액과 다를 수 있으며 확정액이 아니다.
 */

import type { LegalRef, PenaltyResult } from './types.js';
import { findRatioTier } from './penalty-ratios.js';

const 만 = 10_000;
const 억 = 100_000_000;

/** 법 §26·§29(대규모내부거래·공익법인) / 법 §27·§28(중요사항·기업집단현황) */
export type PenaltyRegime = 'art26_29' | 'art27_28';

export interface ViolationInput {
  regime: PenaltyRegime;
  /** 이사회 의결을 거쳤는지 (art26_29 전용) */
  boardResolution?: boolean;
  /** 공시를 했는지 */
  disclosed: boolean;
  /** 기한을 지켰는지 (disclosed=true일 때 유효) */
  onTime?: boolean;
  /** 주요내용 누락·거짓 공시가 있었는지 */
  hasOmissionOrFalse?: boolean;
  /** 과태료 처분 사전통지서 발송일 전날까지 보완했는지 */
  supplemented?: boolean;
  /** 지연일수 (달력일). 기한 초과 또는 보완 지연 일수 */
  delayDays?: number;
  /**
   * 위반행위별 거래금액 (원). art26_29 전용 — 100억원 미만이면 고시 Ⅵ.2 적용비율로
   * 기준금액이 낮아진다(최저 50%). 미지정 시 비율을 적용하지 않아 산정값은 상한선이 된다.
   */
  transactionAmount?: number;

  // ── 가중 사유 ──
  /** 공시의무 회피 목적의 고의적 분할거래 */
  intentionalSplit?: boolean;
  /** 최근 5개년(점검연도 포함) 공시의무 위반 건수 */
  violationsLast5Years?: number;

  // ── 감경 사유 ──
  /** 최초 위반 또는 최근 5개년 무위반 (art27_28 전용) */
  firstViolation?: boolean;
  /** 신규 지정·편입일 후 30일 이내 위반 */
  newlyDesignatedWithin30Days?: boolean;
  /** 거래내용 동일성 유지 + 계약기간 자동연장 */
  autoRenewalSameTerms?: boolean;
  /** 공시주체의 적극적 행위 없는 지분율 변동 (art27_28 전용) */
  passiveShareChange?: boolean;
  /** 계열 금융투자회사의 사실상 중개, 매도·매수인 비계열 확인 (art26_29 전용) */
  brokeredNonAffiliate?: boolean;
  /** 민간투자법 §14 민간투자사업자 (art26_29 전용) */
  pppOperator?: boolean;
  /** 과태료 체납 중 — 감경·면제 배제 */
  inArrears?: boolean;

  /** 상한 산정용: max(자본금, 자본총계) */
  capitalBase?: number;
}

const REF: Record<PenaltyRegime, LegalRef[]> = {
  art26_29: [
    {
      source: '독점규제 및 공정거래에 관한 법률 시행령 [별표 9] 제2호 가목',
      summary: '법 제26조·제29조 위반행위에 대한 과태료 기본금액표',
    },
    {
      source: '대규모내부거래 등에 대한 이사회 의결 및 공시의무 위반사건에 관한 과태료 부과기준',
      summary: '기준금액 산정, 임의적 가중·감경, 면제기준 및 상한',
    },
  ],
  art27_28: [
    {
      source: '독점규제 및 공정거래에 관한 법률 시행령 [별표 9] 제2호 나목',
      summary: '법 제27조·제28조 위반행위에 대한 과태료 기본금액표',
    },
    {
      source: '공시대상기업집단 소속회사 등의 중요사항 공시의무 위반사건에 관한 과태료 부과기준',
      summary: '기본금액 산정, 임의적 가중·감경, 면제기준 및 상한',
    },
  ],
};

interface BaseAmount {
  base: number;
  daily: number;
  dailyCap: number;
  label: string;
}

/** 별표9 제2호 가목 — 법 §26·§29 */
function baseArt26(v: ViolationInput): BaseAmount {
  const board = v.boardResolution ?? true;
  if (board) {
    if (!v.disclosed) return { base: 5000 * 만, daily: 0, dailyCap: 0, label: '이사회 의결 O / 미공시' };
    if (v.onTime) {
      if (!v.hasOmissionOrFalse) return { base: 0, daily: 0, dailyCap: 0, label: '위반 없음' };
      return v.supplemented
        ? { base: 500 * 만, daily: 10 * 만, dailyCap: 2000 * 만, label: '기한 내 공시 / 누락·거짓 후 보완' }
        : { base: 2000 * 만, daily: 0, dailyCap: 0, label: '기한 내 공시 / 누락·거짓' };
    }
    return v.hasOmissionOrFalse && !v.supplemented
      ? { base: 5000 * 만, daily: 0, dailyCap: 0, label: '기한 초과 / 누락·거짓' }
      : { base: 500 * 만, daily: 10 * 만, dailyCap: 5000 * 만, label: '기한 초과 / 누락·거짓 없음' };
  }
  if (!v.disclosed) return { base: 7000 * 만, daily: 0, dailyCap: 0, label: '이사회 의결 X / 미공시' };
  return v.hasOmissionOrFalse
    ? { base: 7000 * 만, daily: 0, dailyCap: 0, label: '이사회 의결 X / 공시 / 누락·거짓' }
    : { base: 5000 * 만, daily: 0, dailyCap: 0, label: '이사회 의결 X / 공시 / 누락·거짓 없음' };
}

/** 별표9 제2호 나목 — 법 §27·§28 */
function baseArt27(v: ViolationInput): BaseAmount {
  if (!v.disclosed) return { base: 1000 * 만, daily: 0, dailyCap: 0, label: '미공시' };
  if (v.onTime) {
    if (!v.hasOmissionOrFalse) return { base: 0, daily: 0, dailyCap: 0, label: '위반 없음' };
    return v.supplemented
      ? { base: 100 * 만, daily: 5 * 만, dailyCap: 500 * 만, label: '기한 내 공시 / 누락·거짓 후 보완' }
      : { base: 500 * 만, daily: 0, dailyCap: 0, label: '기한 내 공시 / 누락·거짓' };
  }
  return v.hasOmissionOrFalse && !v.supplemented
    ? { base: 1000 * 만, daily: 0, dailyCap: 0, label: '기한 초과 / 누락·거짓' }
    : { base: 100 * 만, daily: 5 * 만, dailyCap: 1000 * 만, label: '기한 초과 / 누락·거짓 없음' };
}

/** 지연일수 감경 구간 — 고시 Ⅵ.3.다.(4) */
const DELAY_TIERS: Array<{ maxDays: number; rate: number }> = [
  { maxDays: 3, rate: 0.75 },
  { maxDays: 7, rate: 0.5 },
  { maxDays: 15, rate: 0.3 },
  { maxDays: 30, rate: 0.2 },
];

function delayMitigationRate(delayDays: number): number {
  for (const t of DELAY_TIERS) {
    if (delayDays <= t.maxDays) return t.rate;
  }
  return 0;
}

/**
 * 기본금액 상한 — 자본 규모가 작은 회사 보호 (고시 Ⅵ.1 단서)
 * "위반 기본금액은 자본금 또는 자본총계 중 큰 금액의 100분의 1을 초과할 수 없으며,
 *  이를 초과하는 경우 그 100분의 1을 기본금액으로 한다"
 *
 * ⚠️ 기본금액에는 일수가산이 포함되므로(별표 9 한 칸에 함께 규정) 이 상한도 가산을 포함한
 *    총액에 걸어야 한다. 가산 전 금액에만 걸면 상한을 넘은 기본금액이 만들어진다.
 */
function applySmallCapCap(base: number, regime: PenaltyRegime, capitalBase?: number): number {
  if (capitalBase === undefined) return base;
  const limit = regime === 'art26_29' ? 50 * 억 : 10 * 억;
  if (capitalBase > limit) return base;
  return Math.min(base, capitalBase * 0.01);
}

export function estimatePenalty(v: ViolationInput): PenaltyResult {
  const delayDays = v.delayDays ?? 0;
  const raw = v.regime === 'art26_29' ? baseArt26(v) : baseArt27(v);

  const baseAmount = applySmallCapCap(raw.base, v.regime, v.capitalBase);
  const surchargeRaw = raw.daily * delayDays;
  const dailySurcharge = raw.dailyCap > 0 ? Math.min(surchargeRaw, Math.max(0, raw.dailyCap - baseAmount)) : 0;
  /**
   * 기본금액 = 별표 9 해당 칸의 금액. 일수가산("1일마다 10만원씩 가산하되 …")은
   * 그 칸에 함께 규정된 금액이므로 기본금액에 포함해 비율의 피승수·조정 상한의 기준으로 쓴다.
   * 소기업 1% 상한(Ⅵ.1 단서)도 같은 이유로 가산 포함 총액에 다시 건다.
   */
  const basicTotal = applySmallCapCap(baseAmount + dailySurcharge, v.regime, v.capitalBase);

  // ── 기준금액 = 기본금액 × 거래금액별 적용비율 (고시 Ⅵ.2) ──
  // §27·§28 고시는 Ⅲ.2·Ⅵ.2 가 모두 "삭제"이므로 비율 적용 대상이 아니다.
  const caveats: string[] = [];
  let transactionRatio: PenaltyResult['transactionRatio'];
  let standardAmount = basicTotal;
  if (v.regime === 'art26_29' && basicTotal > 0) {
    const validAmount =
      v.transactionAmount !== undefined && Number.isFinite(v.transactionAmount) && v.transactionAmount >= 0;
    if (v.transactionAmount !== undefined && !validAmount) {
      // 음수·NaN 을 조용히 최저구간(50%)으로 처리하면 입력 오류가 정상 산정값으로 둔갑한다.
      caveats.push(
        `⚠️ 거래금액 입력값(${v.transactionAmount})이 올바르지 않아 거래금액별 적용비율(고시 Ⅵ.2)을 ` +
          '적용하지 않았습니다. 0 이상의 금액(원)을 주십시오. 아래 금액은 비율 미적용 상한선입니다.',
      );
    }
    if (validAmount) {
      const tier = findRatioTier(v.transactionAmount!);
      transactionRatio = { rate: tier.rate, label: tier.label, transactionAmount: v.transactionAmount! };
      standardAmount = basicTotal * tier.rate;
    } else if (v.transactionAmount === undefined) {
      caveats.push(
        '⚠️ 거래금액(transactionAmount)을 주지 않아 거래금액별 적용비율(고시 Ⅵ.2)을 적용하지 못했습니다. ' +
          '이 산정값은 거래금액 100억원 이상 기준이며 사실상 상한선입니다. 거래금액이 100억원 미만이면 ' +
          '기준금액이 80억원 이상 90%, 60억원 이상 80%, 40억원 이상 70%, 20억원 이상 60%, 20억원 미만 50% 로 ' +
          '낮아지므로 실제 과태료는 이 값의 최저 절반까지 내려갑니다.',
      );
    }
  }

  // ── 가중 ──
  const aggravations: Array<{ reason: string; rate: number }> = [];
  if (v.intentionalSplit) aggravations.push({ reason: '공시의무 회피 목적 고의적 분할거래', rate: 0.5 });
  const n = v.violationsLast5Years ?? 0;
  if (n >= 7) aggravations.push({ reason: '최근 5개년 공시의무 위반 7회 이상', rate: 0.2 });
  else if (n >= 4) aggravations.push({ reason: '최근 5개년 공시의무 위반 4~6회', rate: 0.1 });

  // ── 감경 (체납자는 배제) ──
  const mitigations: Array<{ reason: string; rate: number }> = [];
  if (!v.inArrears) {
    // 위반 정도가 경미한 사유는 "해당 비율 중 큰 하나"만 적용
    const minorCandidates: Array<{ reason: string; rate: number }> = [];
    if (v.newlyDesignatedWithin30Days) {
      minorCandidates.push({ reason: '신규 지정·편입일 후 30일 이내 위반', rate: 0.5 });
    }
    if (delayDays > 0) {
      const r = delayMitigationRate(delayDays);
      if (r > 0) minorCandidates.push({ reason: `공시지연 ${delayDays}일`, rate: r });
    }
    if (minorCandidates.length > 0) {
      minorCandidates.sort((a, b) => b.rate - a.rate);
      mitigations.push(minorCandidates[0]!);
    }

    if (v.autoRenewalSameTerms) {
      mitigations.push({ reason: '거래내용 동일성 유지 + 계약기간 자동연장', rate: 0.3 });
    }
    if (v.regime === 'art27_28') {
      if (v.firstViolation) mitigations.push({ reason: '최초 위반 또는 최근 5개년 무위반', rate: 0.2 });
      if (v.passiveShareChange) {
        mitigations.push({ reason: '공시주체의 적극적 행위 없는 지분율 변동', rate: 0.2 });
      }
    } else {
      if (v.brokeredNonAffiliate) {
        mitigations.push({ reason: '계열 금융투자회사의 사실상 중개, 매도·매수인 비계열', rate: 0.4 });
      }
      if (v.pppOperator) mitigations.push({ reason: '민간투자법 제14조 민간투자사업자', rate: 0.5 });
    }
  }

  // 고시 Ⅵ.3.가 — 가중·감경액은 기준금액에 비율을 곱하되, 문언상 상한은 기본금액 기준(1/2, 3/4)이다.
  //
  // ★ 문언 그대로면 0원이 나온다 (2026-08-11 원문 재확인, Opus 교차검토가 발견):
  //   Ⅵ.2 비율(2024-08-07 신설)로 기준금액 < 기본금액이 된 상태에서 감경비율 합이 100%를 넘으면
  //   (예: 지연 3일 75% + 자동연장 30% = 105%) 감경금액이 기준금액 자체를 초과해 부과 과태료가
  //   0원·음수가 된다. 거래금액을 정확히 줄수록 0원이 나오는 역전이라 최악의 거짓 안심이다.
  //   면제(Ⅴ)가 아닌 감경(Ⅵ.3)만으로 0원이 되는 해석은 체계상 무리로 보아, 감경 상한을
  //   "감경 후에도 기준금액의 4분의 1이 남는다"는 취지로 기준금액의 4분의 3에도 함께 건다
  //   (비율 미적용이면 기준금액 = 기본금액이라 종전 동작과 완전히 같다).
  //   가중 쪽은 문언대로 둔다 — 과대 방향이라 거짓 안심이 아니고, 낮추면 과소 산정 위험이 있다.
  const aggRate = aggravations.reduce((s, a) => s + a.rate, 0);
  const mitRate = mitigations.reduce((s, m) => s + m.rate, 0);
  const aggAmount = Math.min(standardAmount * aggRate, basicTotal * 0.5);
  const mitAmount = Math.min(standardAmount * mitRate, basicTotal * 0.75, standardAmount * 0.75);
  const mitCapBound = mitRate > 0.75; // 감경 상한(3/4)이 실제로 물렸는가
  if (mitCapBound && standardAmount < basicTotal) {
    caveats.push(
      `⚠️ 감경비율 합계가 ${Math.round(mitRate * 100)}%로 75%를 초과합니다. 고시 Ⅵ.3.가 단서의 감경 상한` +
        '(기본금액의 4분의 3)을 문언 그대로 적용하면 거래금액 적용비율(Ⅵ.2)과 결합해 감경금액이 기준금액을 ' +
        '초과, 부과 과태료가 0원이 됩니다. 이 산정은 "감경 후에도 기준금액의 4분의 1이 남는다"는 취지 해석을 ' +
        '채택해 감경을 기준금액의 4분의 3으로 상한했습니다. 실제 부과액은 공정위 재량이며, 0원(사실상 면제)이 ' +
        '되려면 고시 Ⅴ의 면제 요건 충족 여부를 별도로 확인해야 합니다.',
    );
  }

  let amount = standardAmount + aggAmount - mitAmount;

  // 총액 상한: min(자본 × 10%, 10억원)
  let capApplied = false;
  const hardCap = v.capitalBase !== undefined ? Math.min(v.capitalBase * 0.1, 10 * 억) : 10 * 억;
  if (amount > hardCap) {
    amount = hardCap;
    capApplied = true;
  }

  // 1만원 단위 미만 절사
  amount = Math.max(0, Math.floor(amount / 만) * 만);

  // 다음 감경 구간 경계
  let nextThreshold: PenaltyResult['nextThreshold'];
  if (delayDays > 0 && raw.base > 0) {
    const nextTier = DELAY_TIERS.find((t) => t.maxDays > delayDays);
    if (nextTier) {
      const futureDelay = nextTier.maxDays + 1;
      const future = estimatePenalty({ ...v, delayDays: futureDelay });
      nextThreshold = {
        delayDays: futureDelay,
        amountIfDelayed: future.amount,
        note: `지연 ${nextTier.maxDays}일까지는 ${Math.round(delayMitigationRate(nextTier.maxDays) * 100)}% 감경이지만, ${futureDelay}일이 되면 감경률이 떨어집니다.`,
      };
    }
  }

  const 만원 = (won: number) => `${(won / 만).toLocaleString('ko-KR')}만원`;
  const applyingRatio = transactionRatio !== undefined && transactionRatio.rate < 1;

  // 비율을 곱할 때는 (기본금액 + 일수가산) 전체가 피승수임을 괄호로 드러낸다.
  let basicExpr = `기본금액 ${만원(baseAmount)} (${raw.label})`;
  if (dailySurcharge > 0) {
    basicExpr += ` + 일수가산 ${만원(dailySurcharge)} (${delayDays}일 × ${raw.daily / 만}만원)`;
  }
  if (basicTotal < baseAmount + dailySurcharge) {
    // 소기업 1% 상한(Ⅵ.1 단서)이 물렸다 — 안 밝히면 뒤 숫자와 어긋나 보인다
    basicExpr += ` → 자본 1% 상한으로 기본금액 ${만원(basicTotal)}`;
  }
  if (applyingRatio && (dailySurcharge > 0 || basicTotal < baseAmount + dailySurcharge)) {
    basicExpr = `(${basicExpr})`;
  }

  const formulaParts = [basicExpr];
  if (applyingRatio) {
    formulaParts.push(
      `× 거래금액 적용비율 ${Math.round(transactionRatio!.rate * 100)}% (${transactionRatio!.label})` +
        ` = 기준금액 ${만원(standardAmount)}`,
    );
  }
  if (aggAmount > 0) formulaParts.push(`+ 가중 ${(aggAmount / 만).toLocaleString('ko-KR')}만원`);
  if (mitAmount > 0) {
    formulaParts.push(
      `− 감경 ${(mitAmount / 만).toLocaleString('ko-KR')}만원` +
        (mitCapBound ? ' (감경 상한: 기준금액의 4분의 3)' : ''),
    );
  }
  if (capApplied) formulaParts.push(`→ 상한 적용`);
  formulaParts.push(`= ${(amount / 만).toLocaleString('ko-KR')}만원`);

  return {
    amount,
    baseAmount,
    dailySurcharge,
    basicTotal,
    standardAmount,
    // 비율을 적용하지 못한 §26·§29 건은 확정 추정치가 아니라 상한선이다.
    isUpperBound: v.regime === 'art26_29' && amount > 0 && transactionRatio === undefined,
    transactionRatio,
    aggravations,
    mitigations,
    capApplied,
    formula: formulaParts.join(' '),
    nextThreshold,
    legalBasis: REF[v.regime],
    caveats,
    disclaimer:
      '공정위 고시 기준에 따른 단순 산정값입니다. 실제 부과액은 공정위 재량과 개별 사정에 따라 달라질 수 있으며 확정액이 아닙니다. ' +
      '기한 만료일 다음 날부터 10영업일 이내에 자진 시정·재공시하고 고시 Ⅴ의 사유(신규 지정·편입 30일 이내 위반, ' +
      '사소한 부주의 등)에 해당하면 면제될 수 있습니다(공정위 재량, 체납자 제외).',
  };
}
