/**
 * Deadline — 시간 예산 (60초 벽, 함정 7)
 *
 * 시계를 주입해 **실제 sleep 없이** 검증한다. 시간 의존 테스트를 진짜로 기다리게 만들면
 * CI 가 느려지고 간헐 실패가 난다.
 */

import { describe, it, expect } from 'vitest';
import { Deadline } from '../src/lib/deadline.js';

/** 손으로 굴리는 시계 */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

describe('Deadline — 남은 시간', () => {
  it('경과·잔여·만료를 주입 시계로 계산한다', () => {
    const c = clock();
    const d = new Deadline(50_000, c.now);
    expect(d.elapsedMs()).toBe(0);
    expect(d.remainingMs()).toBe(50_000);
    expect(d.isExpired()).toBe(false);

    c.advance(30_000);
    expect(d.remainingMs()).toBe(20_000);
    expect(d.isExpired()).toBe(false);

    c.advance(25_000);
    // 음수로 내려가지 않는다 — 잔여는 0 이 바닥이다
    expect(d.remainingMs()).toBe(0);
    expect(d.isExpired()).toBe(true);
  });

  it('canAfford 는 "새 상류 호출을 시작해도 되는가" 다 — 경계에서 정확해야 한다', () => {
    const c = clock();
    const d = new Deadline(10_000, c.now);
    c.advance(7_000);
    expect(d.remainingMs()).toBe(3_000);
    expect(d.canAfford(3_000)).toBe(true); // 딱 맞으면 시작한다
    expect(d.canAfford(3_001)).toBe(false);
  });
});

describe('Deadline — 단계 계측', () => {
  it('단계 전환 시 직전 단계가 자동으로 닫히고 소요가 누적된다', () => {
    const c = clock();
    const d = new Deadline(50_000, c.now);
    d.enter('j001_search');
    c.advance(4_000);
    d.enter('judge');
    c.advance(1_000);
    // 열려 있는 단계도 지금까지의 소요로 포함한다
    expect(d.stages()).toEqual({ j001_search: 4_000, judge: 1_000 });

    // 같은 단계로 되돌아오면 누적된다 (검색 ↔ 판정을 오가는 경로가 있다)
    d.enter('j001_search');
    c.advance(2_000);
    d.leave();
    expect(d.stages()).toEqual({ j001_search: 6_000, judge: 1_000 });
  });

  it('during 은 원래 단계로 되돌린다 — 준비 단계를 따로 재기 위한 것이다', async () => {
    const c = clock();
    const d = new Deadline(50_000, c.now);
    d.enter('population');
    c.advance(1_000);
    await d.during('warming', async () => {
      c.advance(3_000);
    });
    c.advance(500);
    expect(d.stages()).toEqual({ population: 1_500, warming: 3_000 });
  });

  it('during 은 예외가 나도 원래 단계로 되돌린다', async () => {
    const c = clock();
    const d = new Deadline(50_000, c.now);
    d.enter('population');
    await expect(
      d.during('corp_index', async () => {
        c.advance(2_000);
        throw new Error('적재 실패');
      }),
    ).rejects.toThrow('적재 실패');
    c.advance(1_000);
    expect(d.stages()).toEqual({ population: 1_000, corp_index: 2_000 });
  });
});

describe('Deadline — 소진 지점', () => {
  it('★ 최초 1회만 기록한다 — 덮어쓰면 어디서 끊겼는지 흐려진다', () => {
    const c = clock();
    const d = new Deadline(1_000, c.now);
    expect(d.stoppedAt).toBeNull();
    d.markStopped('warming');
    d.markStopped('j001_search');
    d.markStopped('judge');
    expect(d.stoppedAt).toBe('warming');
  });

  it('단계 이름을 주지 않으면 열려 있는 단계로 기록한다', () => {
    const c = clock();
    const d = new Deadline(1_000, c.now);
    d.enter('j001_search');
    d.markStopped();
    expect(d.stoppedAt).toBe('j001_search');
  });
});
