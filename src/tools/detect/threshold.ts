/**
 * 회사별 기준금액(J004 재무현황 근사치)과 기준 초과 판정 (순수 함수)
 */

import type { extractCapitals } from '../../parsers/j004-transactions.js';
import { normalizeCompanyName } from '../../parsers/md-table.js';
import { calcThreshold, CAP_100 } from '../../rules/thresholds.js';
import type { GoodsSignal } from './types.js';

/** 회사별 기준금액 (J004 재무현황 기반 근사치) */
export interface ApproxThreshold {
  value: number;
  formula: string;
  /** 재무현황 표에서 매칭된 원문 회사명 */
  source_row: string;
}

/**
 * 재무현황 자본으로 회사별 기준금액을 계산한다.
 * 자본총계·자본금이 둘 다 없는 회사는 넣지 않는다 (추정 금지).
 * 정규화 동명이 **서로 다른 기준금액**으로 두 번 나오면 어느 쪽이 맞는지 알 수 없다 —
 * 둘 다 버리고 conflicts 로 보고한다 (첫 행 유지는 다른 회사의 자본을 쓰는 사고가 된다.
 * 교차검토 S-3).
 */
export function buildThresholdMap(capitals: ReturnType<typeof extractCapitals>): {
  map: Map<string, ApproxThreshold>;
  conflicts: string[];
} {
  const map = new Map<string, ApproxThreshold>();
  const conflicted = new Set<string>();
  for (const c of capitals) {
    if (c.totalEquity === null && c.paidInCapital === null) continue;
    const r = calcThreshold({
      ...(c.totalEquity !== null ? { totalEquity: c.totalEquity } : {}),
      ...(c.paidInCapital !== null ? { paidInCapital: c.paidInCapital } : {}),
    });
    if (!r) continue;
    const key = normalizeCompanyName(c.company);
    if (conflicted.has(key)) continue;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { value: r.threshold, formula: r.formula, source_row: c.company });
      continue;
    }
    // 같은 이름·같은 값이면 중복 행일 뿐이다 (표가 금융/비금융으로 갈릴 때) — 유지
    if (prev.value !== r.threshold) {
      map.delete(key);
      conflicted.add(key);
    }
  }
  return { map, conflicts: [...conflicted] };
}

export type Certainty = 'certain_by_cap' | 'approx_from_j004';

/** 거래 1건의 기준금액 판정 */
export function judgeOverThreshold(
  amount: number,
  threshold: ApproxThreshold | undefined,
): { over: boolean | null; certainty?: Certainty } {
  // 령 §33①1호 상한: 기준금액은 어떤 자본에서도 100억을 넘지 못한다 —
  // 거래금액이 100억 이상이면 자본을 몰라도 기준 이상이 확실하다
  if (amount >= CAP_100) return { over: true, certainty: 'certain_by_cap' };
  if (!threshold) return { over: null };
  return amount >= threshold.value
    ? { over: true, certainty: 'approx_from_j004' }
    : { over: false };
}

/**
 * 상품·용역 연간 총액 → 분기 판정 강도. (6) 합산과 (5) 총괄 두 금액을 **같은 규칙**으로
 * 재기 위해 함수로 뺐다 — 승격 여부를 "판정이 실제로 달라지는가"로 정하려면 둘을
 * 같은 자로 재야 한다.
 *
 * 비둘기집: 연간 합산 ≥ 4×기준금액이면 네 분기 전부가 기준금액 미만일 수 없다.
 * 그 미만이면 분기 집중 여부를 알 수 없어 **원리상 판정 불가**다.
 */
export function goodsQuarterlyLogic(
  amount: number,
  th: ApproxThreshold | undefined,
): GoodsSignal['quarterly_logic'] {
  if (amount >= 4 * CAP_100) return 'annual_geq_4x_threshold';
  if (!th) return 'threshold_unknown';
  return amount >= 4 * th.value ? 'annual_geq_4x_threshold' : 'annual_below_4x_threshold';
}
