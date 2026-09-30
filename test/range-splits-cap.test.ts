/**
 * range_too_large 제안 구간 상한 (외부 검토 2026-09-30 §3-1 "제안 구간 수에 상한")
 * 자르되 조용히 자르지 않는다 — 총 구간 수와 남은 범위를 함께 준다.
 */
import { describe, it, expect } from 'vitest';
import { RangeTooLargeError, MAX_SUGGESTED_SPLITS } from '../src/lib/errors.js';

function splits(n: number): Array<{ from: string; to: string }> {
  return Array.from({ length: n }, (_, i) => {
    const d = String(i + 1).padStart(2, '0');
    return { from: `202601${d}`, to: `202601${d}` };
  });
}

describe('RangeTooLargeError 제안 구간 상한', () => {
  it(`${MAX_SUGGESTED_SPLITS}개를 넘으면 처음 ${MAX_SUGGESTED_SPLITS}개 + totalSplits + 남은 범위`, () => {
    const e = new RangeTooLargeError('검색', 120, splits(10));
    const d = e.details as Record<string, any>;
    expect(d.suggestedSplits).toHaveLength(MAX_SUGGESTED_SPLITS);
    expect(d.totalSplits).toBe(10);
    // 남은 범위는 보여준 마지막 구간 바로 다음부터 전체 끝까지 — 빈틈이 없다
    expect(d.remainingRange).toEqual({ from: '20260107', to: '20260110' });
    expect(e.message).toContain('전체 10개 구간 중 처음 6개');
    expect(e.message).toContain('조회되지 않은 것');
  });

  it('상한 이하면 전부 주고 remainingRange 는 없다', () => {
    const e = new RangeTooLargeError('검색', 70, splits(MAX_SUGGESTED_SPLITS));
    const d = e.details as Record<string, any>;
    expect(d.suggestedSplits).toHaveLength(MAX_SUGGESTED_SPLITS);
    expect(d.totalSplits).toBe(MAX_SUGGESTED_SPLITS);
    expect(d.remainingRange).toBeUndefined();
  });
});
