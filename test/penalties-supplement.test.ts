import { describe, expect, it } from 'vitest';
import { estimatePenalty } from '../src/rules/penalties.js';

const 만 = 10_000;

describe('과태료 — 다음 감경 구간 경계 (고시 Ⅵ.3.다(4)(나) "3일 이하 75%, 7일 이하 50%, 15일 이하 30%, 30일 이하 20%")', () => {
  const late = (d: number) =>
    estimatePenalty({ regime: 'art26_29', boardResolution: true, disclosed: true, onTime: false, delayDays: d });

  it.each([
    [1, 4, '50%'],
    [3, 4, '50%'], // 종전 버그: 3일 구간을 건너뛰어 8일로 안내
    [4, 8, '30%'],
    [7, 8, '30%'],
    [15, 16, '20%'],
    [30, 31, '없어집니다'],
  ])('지연 %i일 → 다음 경계 %i일 (%s)', (d, next, word) => {
    const r = late(d);
    expect(r.nextThreshold?.delayDays).toBe(next);
    expect(r.nextThreshold?.note).toContain(word);
    expect(r.nextThreshold!.amountIfDelayed).toBeGreaterThan(r.amount);
  });

  it('지연 31일 이상이면 다음 경계가 없다', () => {
    expect(late(31).nextThreshold).toBeUndefined();
  });

  it('경계 금액이 실제 그 일수의 산정값과 같다 (3일 → 4일)', () => {
    expect(late(3).nextThreshold!.amountIfDelayed).toBe(late(4).amount);
  });
});

describe('과태료 — 별표 9 보완 칸 ("공시기한까지 공시 … 과태료 처분 사전통지서 발송일 전날까지 보완한 경우")', () => {
  it('§27·28: 100만원 + "공시기한을 넘긴 날의 다음 날부터 보완을 마친 날까지 1일마다 5만원" — 10일 = 150만원', () => {
    const r = estimatePenalty({
      regime: 'art27_28',
      disclosed: true,
      onTime: true,
      hasOmissionOrFalse: true,
      supplemented: true,
      supplementationElapsedDays: 10,
    });
    expect(r.basicTotal).toBe(150 * 만);
    expect(r.dayCounts).toEqual({ surchargeDays: 10, filingDelayDays: 0, supplementationCase: true });
    // 원 공시가 기한 내이므로 공시지연 감경은 확정 산정에 넣지 않는다
    expect(r.mitigations).toEqual([]);
    expect(r.amount).toBe(150 * 만);
  });

  it('§27·28: "5백만원을 초과할 수 없다" — 80일이면 보완 전(500만원)과 같아진다', () => {
    const supp = estimatePenalty({
      regime: 'art27_28', disclosed: true, onTime: true, hasOmissionOrFalse: true,
      supplemented: true, supplementationElapsedDays: 80,
    });
    const notSupp = estimatePenalty({ regime: 'art27_28', disclosed: true, onTime: true, hasOmissionOrFalse: true });
    expect(supp.basicTotal).toBe(500 * 만);
    expect(notSupp.basicTotal).toBe(500 * 만);
  });

  it('§26(의결 O): 500만원 + 1일 10만원, "2천만원을 초과할 수 없다" — 150일이면 보완 전(2,000만원)과 같다', () => {
    const at = (n: number) =>
      estimatePenalty({
        regime: 'art26_29', boardResolution: true, disclosed: true, onTime: true,
        hasOmissionOrFalse: true, supplemented: true, supplementationElapsedDays: n, transactionAmount: 100 * 1e8,
      }).basicTotal;
    expect(at(10)).toBe(600 * 만);
    expect(at(150)).toBe(2000 * 만);
    expect(at(400)).toBe(2000 * 만);
  });

  it('종전 delayDays 만 준 보완 사건도 공시지연 감경을 확정 산정에 쓰지 않는다 (원문 미확인 해석)', () => {
    const r = estimatePenalty({
      regime: 'art27_28', disclosed: true, onTime: true, hasOmissionOrFalse: true,
      supplemented: true, delayDays: 3,
    });
    expect(r.basicTotal).toBe(115 * 만);
    expect(r.mitigations).toEqual([]);
    expect(r.nextThreshold).toBeUndefined();
    const sc = r.scenarios?.find((s) => s.id === 'supplementation_counted_as_filing_delay');
    expect(sc?.status).toBe('unconfirmed_interpretation');
    expect(sc?.amount).toBe(28 * 만); // 115만 × (1 − 75%) = 28.75만 → 만원 미만 절사
    expect(sc?.note).toContain('원문 미확인');
  });

  it('감경 일수를 넘어서는 경과(31일↑)면 미확인 시나리오도 만들지 않는다', () => {
    const r = estimatePenalty({
      regime: 'art27_28', disclosed: true, onTime: true, hasOmissionOrFalse: true,
      supplemented: true, supplementationElapsedDays: 40,
    });
    expect(r.scenarios).toBeUndefined();
  });

  it('기한 초과 공시는 filingDelayDays 로 공시지연 감경을 확정 적용한다 (delayDays 와 같은 결과)', () => {
    const a = estimatePenalty({ regime: 'art27_28', disclosed: true, onTime: false, filingDelayDays: 5 });
    const b = estimatePenalty({ regime: 'art27_28', disclosed: true, onTime: false, delayDays: 5 });
    expect(a.amount).toBe(b.amount);
    expect(a.mitigations[0]!.rate).toBe(0.5);
  });
});

describe('과태료 — 이사회 의결 여부 미입력 가정의 노출', () => {
  const base = { regime: 'art26_29' as const, disclosed: true, onTime: false, delayDays: 3, transactionAmount: 30 * 1e8 };

  it('미입력이면 assumptions 필드와 "의결 X" 대안 시나리오를 함께 준다', () => {
    const r = estimatePenalty(base);
    expect(r.assumptions?.[0]).toMatchObject({ field: 'boardResolution', assumedValue: true });
    const alt = r.scenarios?.find((s) => s.id === 'board_resolution_not_obtained');
    expect(alt?.status).toBe('alternative_fact');
    expect(alt!.amount).toBeGreaterThan(r.amount);
    // d09 유형: (500만 + 30만) × 60% = 318만 − 75% → 79만 (본 산정은 그대로)
    expect(r.amount).toBe(79 * 만);
  });

  it('명시하면 가정도 대안 시나리오도 없다', () => {
    const r = estimatePenalty({ ...base, boardResolution: true });
    expect(r.assumptions).toBeUndefined();
    expect(r.scenarios).toBeUndefined();
  });
});
