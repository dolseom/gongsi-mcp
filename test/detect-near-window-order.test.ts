/**
 * 근접 창(거래일 −90 ~ +30일)이 비대칭인데 공시를 |거리|순으로 열던 문제 (2026-09-24 점검 지적).
 *
 * 창 **밖** +35일 공시가 창 **안** −60일 공시보다 가까워 먼저 열리고, 상대방이 맞아 "확인"되는 즉시
 * 멈추면 근접 판정이 그 한 건으로만 이뤄져 filing_far_from_date 과잉 경보가 났다.
 * 여는 순서를 "창 안 우선 → 거리순 → 최신순 → 접수번호순" 으로 바꿨다.
 */

import { describe, it, expect } from 'vitest';
import { detectUndisclosedTransactions } from '../src/tools/detect-undisclosed-transactions.js';
import { compareNewestFirst } from '../src/tools/detect/dates.js';
import { disc, makeDeps, doc80718, useMemoryStore } from './helpers/detect-deps.js';

useMemoryStore();

const MD = [
  '| 기업집단명 : | 테스트집단 |',
  '| --- | --- |',
  '## (2) 회사 재무현황',
  '| (단위 : 백만원, %) |',
  '| --- |',
  '| 계열회사명 |  | 자본금 | 자본총계 |',
  '| --- | --- | --- | --- |',
  '| 비금융회사 | 에이사(주) | 1,000 | 20,000 |',
  '| 비금융회사 | 씨사(주) | 1,000 | 20,000 |',
  '## (1) 계열회사간 자금거래 현황',
  '가. 일반 차입',
  '| (단위 : 백만원) |',
  '| --- |',
  '| 차입회사 (소속회사) |  | 거래상대방 | 차입금액 | 차입일 |',
  '| --- | --- | --- | --- | --- |',
  '| 비금융회사 | 에이사(주) | 씨사(주) | 16,000 | 2025-06-30 |',
].join('\n');

const CORPS = {
  에이사: [{ corpCode: '00111111', corpName: '에이사' }],
  씨사: [{ corpCode: '00333333', corpName: '씨사' }],
};

/** 차입일 2025-06-30 기준: +35일(창 밖, 더 가까움) · −60일(창 안) — 둘 다 상대방 씨사(주) */
const OUTSIDE_PLUS_35 = '20250804000111';
const INSIDE_MINUS_60 = '20250501000222';

describe('근접 창 비대칭 — 창 안 공시를 먼저 연다', () => {
  it('창 밖 +35일 공시보다 창 안 −60일 공시를 먼저 열어 근접으로 확인한다 (과잉 경보 없음)', async () => {
    const docCalls: string[] = [];
    const deps = makeDeps({
      markdown: MD,
      corps: CORPS,
      j001: (corpCode) =>
        corpCode === '00111111'
          ? [
              disc({
                corp_code: '00111111',
                report_nm: '대규모내부거래관련이사회의결및공시(자금차입)',
                rcept_no: OUTSIDE_PLUS_35,
                rcept_dt: '20250804',
              }),
              disc({
                corp_code: '00111111',
                report_nm: '대규모내부거래관련이사회의결및공시(자금차입)',
                rcept_no: INSIDE_MINUS_60,
                rcept_dt: '20250501',
              }),
            ]
          : [],
      docs: { [OUTSIDE_PLUS_35]: doc80718('씨사(주)'), [INSIDE_MINUS_60]: doc80718('씨사(주)') },
      docCalls,
    });

    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      deps,
    )) as Record<string, any>;

    const opened = docCalls.filter((x) => x === OUTSIDE_PLUS_35 || x === INSIDE_MINUS_60);
    expect(opened[0]).toBe(INSIDE_MINUS_60);
    expect(r['summary'].j001_filing_near_date).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(r)).not.toContain('filing_far_from_date');
  });
});

describe('compareNewestFirst — 동률에도 결정적 순서', () => {
  it('같은 날 접수분은 접수번호 역순, 완전히 같으면 0', () => {
    const a = { rcept_dt: '20250501', rcept_no: '20250501000001' };
    const b = { rcept_dt: '20250501', rcept_no: '20250501000009' };
    expect(compareNewestFirst(a, b)).toBeGreaterThan(0);
    expect(compareNewestFirst(b, a)).toBeLessThan(0);
    expect(compareNewestFirst(a, { ...a })).toBe(0);
    // 입력 순서와 무관하게 같은 결과
    expect([a, b].sort(compareNewestFirst)).toEqual([b, a].sort(compareNewestFirst));
  });

  it('날짜가 다르면 최신이 앞', () => {
    const older = { rcept_dt: '20250101', rcept_no: '20250101000999' };
    const newer = { rcept_dt: '20250601', rcept_no: '20250601000001' };
    expect([older, newer].sort(compareNewestFirst)[0]).toBe(newer);
  });
});
