/**
 * 1년 recall 기준선 (함정 8번 — "recall 판단은 1년 이상 윈도우로만 확정")
 *
 * 기준선은 scripts/measure-recall-baseline.mjs 실측(2026-08-13)으로 만들었다.
 * 기간이 고정(20250801~20260731)이고 rcept_dt 는 소급 추가되지 않으므로,
 * 재측정하면 같은 수치가 나와야 한다 — 다르면 수집 파이프라인 회귀 신호다.
 *
 * 이 테스트는 오프라인이다: 기준선 픽스처의 **내적 정합성**과 계약(완전 수집,
 * J→"공" 등식)을 고정한다. 실제 재측정은 스크립트로 수동 실행한다
 * (docs/recall-baseline-2026.md 참조).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface BaselineFixture {
  _meta: { period: string };
  j: {
    collected_unique: number;
    reported_total: number;
    per_window: Array<{ window: string; rows: number; reported: number }>;
    issues: string[];
  };
  equivalence: { j_without_gong: number; gong_not_in_J_within_collected: number };
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'recall-baseline-2026.json'), 'utf8'),
) as BaselineFixture;

describe('1년 recall 기준선 (20250801~20260731 실측 고정)', () => {
  it('J 전수: 수집 = DART 신고 = 30,063 (recall 100%)', () => {
    expect(fixture.j.collected_unique).toBe(30_063);
    expect(fixture.j.reported_total).toBe(30_063);
  });

  it('창별 수집이 전부 신고 건수와 일치하고 합이 전체와 같다 (조용한 부분 누락 없음)', () => {
    expect(fixture.j.per_window).toHaveLength(6);
    let sum = 0;
    for (const w of fixture.j.per_window) {
      expect(w.rows, w.window).toBe(w.reported);
      sum += w.rows;
    }
    expect(sum).toBe(fixture.j.collected_unique);
  });

  it('수집 중 partial·truncated·청크 실패가 없었다', () => {
    expect(fixture.j.issues).toEqual([]);
  });

  it('J → rm"공" 등식: J 30,063건 전부 공 마커 보유 (1년 완전 검증)', () => {
    // 종전 근거는 2주×2구간뿐이었다. audit 도구의 rm 교차검증이 이 등식에 기대고 있다.
    expect(fixture.equivalence.j_without_gong).toBe(0);
  });

  it('역방향(공 마커인데 J 아님): 수집된 전체시장 범위 내 0건', () => {
    // ⚠️ 전체시장 수집이 partial(85.3%)이었다 — "완전 검증"이 아니라 "수집 범위 내 0건"이다.
    // 완전 검증은 재측정으로 갱신한다 (_meta 참조). 이 구분을 지우지 말 것 — 거짓 안심 방지.
    expect(fixture.equivalence.gong_not_in_J_within_collected).toBe(0);
  });
});
