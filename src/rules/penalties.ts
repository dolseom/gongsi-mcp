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

/** 기본금액 상한 — 자본 규모가 작은 회사 보호 */
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
  const beforeAdjust = baseAmount + dailySurcharge;

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

  // 가중 ≤ 기본금액의 1/2, 감경 ≤ 기본금액의 3/4
  const aggRate = aggravations.reduce((s, a) => s + a.rate, 0);
  const mitRate = mitigations.reduce((s, m) => s + m.rate, 0);
  const aggAmount = Math.min(beforeAdjust * aggRate, baseAmount * 0.5);
  const mitAmount = Math.min(beforeAdjust * mitRate, baseAmount * 0.75);

  let amount = beforeAdjust + aggAmount - mitAmount;

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

  const formulaParts = [
    `기본금액 ${(baseAmount / 만).toLocaleString('ko-KR')}만원 (${raw.label})`,
  ];
  if (dailySurcharge > 0) {
    formulaParts.push(`+ 일수가산 ${(dailySurcharge / 만).toLocaleString('ko-KR')}만원 (${delayDays}일 × ${raw.daily / 만}만원)`);
  }
  if (aggAmount > 0) formulaParts.push(`+ 가중 ${(aggAmount / 만).toLocaleString('ko-KR')}만원`);
  if (mitAmount > 0) formulaParts.push(`− 감경 ${(mitAmount / 만).toLocaleString('ko-KR')}만원`);
  if (capApplied) formulaParts.push(`→ 상한 적용`);
  formulaParts.push(`= ${(amount / 만).toLocaleString('ko-KR')}만원`);

  return {
    amount,
    baseAmount,
    dailySurcharge,
    aggravations,
    mitigations,
    capApplied,
    formula: formulaParts.join(' '),
    nextThreshold,
    legalBasis: REF[v.regime],
    disclaimer:
      '공정위 고시 기준에 따른 단순 산정값입니다. 실제 부과액은 공정위 재량과 개별 사정에 따라 달라질 수 있으며 확정액이 아닙니다. 기한 만료일 다음 날부터 10영업일 이내에 자진 시정·재공시하면 면제될 수 있습니다.',
  };
}
