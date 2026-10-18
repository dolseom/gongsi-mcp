import { describe, expect, it } from 'vitest';
import { estimatePenalty } from '../src/rules/penalties.js';
import { ratioTableEffectiveFrom } from '../src/rules/penalty-ratios.js';
import { evaluateDelayScenario } from '../src/tools/duty/delay.js';

// 질서위반행위규제법 제3조 ① "질서위반행위의 성립과 과태료 처분은 행위 시의 법률에 따른다."
// (법제처 MST 290635, 2026-10-18 확인) — 현행 기준표로 옛 위반을 조용히 산정하면 확정 금액처럼 읽힌다.

const base = { regime: 'art26_29', boardResolution: true, disclosed: true, onTime: false, delayDays: 5 } as const;
const hasDateCaveat = (cs: string[]) => cs.some((c) => c.includes('질서위반행위규제법 제3조'));

describe('과태료 — 위반 시점이 현행 부과기준 시행일보다 앞서면 caveat', () => {
  it('적용비율표 시행일은 데이터의 effectiveFrom(2024-08-07) 이다', () => {
    expect(ratioTableEffectiveFrom()).toBe('20240807');
  });

  it('공시기한이 시행일 전이면 caveat 를 붙이고 금액은 그대로 둔다', () => {
    const old = estimatePenalty({ ...base, transactionAmount: 30e8, deadline: '20240520' });
    const now = estimatePenalty({ ...base, transactionAmount: 30e8, deadline: '20250520' });
    expect(hasDateCaveat(old.caveats)).toBe(true);
    expect(hasDateCaveat(now.caveats)).toBe(false);
    expect(old.amount).toBe(now.amount);
  });

  it('시행일 당일 기한은 caveat 없음, 기한 미지정이면 대조하지 않는다', () => {
    expect(hasDateCaveat(estimatePenalty({ ...base, deadline: '20240807' }).caveats)).toBe(false);
    expect(hasDateCaveat(estimatePenalty({ ...base }).caveats)).toBe(false);
  });

  it('§27·§28 은 이 표의 적용 대상이 아니므로 대조하지 않는다', () => {
    const r = estimatePenalty({ regime: 'art27_28', disclosed: true, onTime: false, delayDays: 5, deadline: '20200101' });
    expect(hasDateCaveat(r.caveats)).toBe(false);
  });

  it('지연 시나리오 경로도 기한을 넘겨 caveat 가 붙는다', () => {
    const d = evaluateDelayScenario({
      delayDays: 5,
      basis: 'calendar',
      filingState: 'filed',
      regime: 'art26_29',
      boardRequired: true,
      boardResolution: true,
      transactionAmount: 30e8,
      deadline: '20240520',
      dutyUnconfirmed: false,
    });
    expect(d.output.status).toBe('computed');
    expect(hasDateCaveat(d.output.scenarios![0]!.penalty.caveats)).toBe(true);
  });
});
