/**
 * 1년 recall 기준선 (함정 8번 — "recall 판단은 1년 이상 윈도우로만 확정")
 *
 * 기준선은 scripts/measure-recall-baseline.mjs 실측(2026-08-13)으로 만들었다.
 * 기간이 고정(20250801~20260731)이고 rcept_dt 는 소급 추가되지 않으므로,
 * 재측정하면 같은 수치가 나와야 한다 — 다르면 수집 파이프라인 회귀 신호다.
 *
 * 이 테스트는 오프라인이다: 기준선 픽스처의 **내적 정합성**과 계약(완전 수집,
 * J↔"공" 등식 양방향)을 고정한다. 실제 재측정은 스크립트로 수동 실행한다
 * (docs/recall-baseline-2026.md 참조).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface SetBaseline {
  collected_unique: number;
  reported_total: number;
  per_window: Array<{ window: string; rows: number; reported: number }>;
  issues: string[];
}

interface BaselineFixture {
  _meta: { period: string };
  j: SetBaseline;
  all_market: SetBaseline;
  equivalence: {
    j_without_gong: number;
    gong_not_in_J: number;
    j_not_in_all: number;
    all_market_coverage: string;
  };
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'recall-baseline-2026.json'), 'utf8'),
) as BaselineFixture;

function assertCompleteSet(s: SetBaseline, total: number): void {
  expect(s.collected_unique).toBe(total);
  expect(s.reported_total).toBe(total);
  expect(s.per_window).toHaveLength(6);
  let sum = 0;
  for (const w of s.per_window) {
    expect(w.rows, w.window).toBe(w.reported);
    sum += w.rows;
  }
  expect(sum).toBe(s.collected_unique);
  expect(s.issues).toEqual([]);
}

describe('1년 recall 기준선 (20250801~20260731 실측 고정)', () => {
  it('J 전수: 수집 = DART 신고 = 30,063 (recall 100%, 창별 일치, issues 0)', () => {
    assertCompleteSet(fixture.j, 30_063);
  });

  it('전체시장 전수: 수집 = DART 신고 = 269,692 (창별 일치, issues 0)', () => {
    // 1차 측정은 85.3% 부분 수집이었다 — 완전 수집에는 GONGSI_MAX_PAGES=150 이 필요했다
    // (결산시즌 단일 일자 136페이지, _meta.all_market_note). coverage 문구가 'complete' 가 아니면
    // 아래 역방향 검증 주장도 함께 무너진다.
    assertCompleteSet(fixture.all_market, 269_692);
    expect(fixture.equivalence.all_market_coverage).toContain('complete');
  });

  it('J → rm"공" 등식: J 30,063건 전부 공 마커 보유 (1년 완전 검증)', () => {
    // 종전 근거는 2주×2구간뿐이었다. audit 도구의 rm 교차검증이 이 등식에 기대고 있다.
    expect(fixture.equivalence.j_without_gong).toBe(0);
  });

  it('역방향(공 마커인데 J 아님): 1년 전체시장 전수 기준 0건 — 완전 검증', () => {
    // 1차 측정에서는 "수집 범위(85.3%) 내 0건"까지만 말할 수 있었다.
    // 전체시장이 전수(위 테스트)이므로 이제 완전 검증이다.
    expect(fixture.equivalence.gong_not_in_J).toBe(0);
    expect(fixture.equivalence.j_not_in_all).toBe(0);
  });
});
