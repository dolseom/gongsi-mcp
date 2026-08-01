/**
 * 자진시정 골든타임 테스트
 *
 * 기준 사례: 소노스테이션(비상장) 의결 2026-07-22 → 기한 2026-07-31(금)
 * 골든타임 = 8/1(토)부터 10영업일 = 2026-08-14(금)
 *   (8월 첫 2주: 토일 8/1·2, 8/8·9 제외 → 8/3~7 5일 + 8/10~14 5일)
 */

import { describe, it, expect } from 'vitest';
import { selfCorrectionWindow } from '../src/rules/self-correction.js';
import { checkDisclosureDuty } from '../src/tools/check-disclosure-duty.js';

describe('selfCorrectionWindow', () => {
  it('기한 다음 날부터 10영업일 — 20260731 기한이면 20260814까지', () => {
    const w = selfCorrectionWindow('20260731', 'art26_29', '20260805');
    expect(w.windowStart).toBe('20260801');
    expect(w.windowEnd).toBe('20260814');
  });

  it('기한 전이면 before_deadline', () => {
    expect(selfCorrectionWindow('20260731', 'art26_29', '20260730').status).toBe('before_deadline');
    expect(selfCorrectionWindow('20260731', 'art26_29', '20260731').status).toBe('before_deadline');
  });

  it('골든타임 안이면 open + 남은 영업일', () => {
    const w = selfCorrectionWindow('20260731', 'art26_29', '20260805');
    expect(w.status).toBe('open');
    // 8/5(수) → 8/14(금): 8/6, 8/7, 8/10, 8/11, 8/12, 8/13, 8/14 = 7영업일
    expect(w.businessDaysRemaining).toBe(7);
  });

  it('골든타임 마지막 날도 open, 다음 날부터 closed', () => {
    expect(selfCorrectionWindow('20260731', 'art26_29', '20260814').status).toBe('open');
    expect(selfCorrectionWindow('20260731', 'art26_29', '20260815').status).toBe('closed');
  });

  it('면제 사유에 필요조건 경고와 원문 근거가 담긴다', () => {
    const w = selfCorrectionWindow('20260731', 'art26_29', '20260805');
    expect(w.exemptionGrounds.length).toBe(4);
    expect(w.caution).toContain('필요조건');
    expect(w.caution).toContain('재량');
    expect(w.legalBasis[0]!.source).toContain('과태료 부과기준 Ⅴ');
  });

  it('§27·28 은 5억 미만 상품·용역 현황 사유가 추가된다', () => {
    const w = selfCorrectionWindow('20260731', 'art27_28', '20260805');
    expect(w.exemptionGrounds.length).toBe(5);
    expect(w.exemptionGrounds.some((g) => g.includes('5억원 미만'))).toBe(true);
  });
});

describe('check_disclosure_duty 골든타임 연동', () => {
  const base = {
    duty: 'large_internal_transaction' as const,
    listing: 'unlisted' as const,
    boardDate: '20260722',
    totalEquity: 120_000_000_000,
    paidInCapital: 50_000_000_000,
    amount: 7_000_000_000,
  };

  it('기한 경과 + not_disclosed 명시 → selfCorrection open + 골든타임 노트', () => {
    const r = checkDisclosureDuty({ ...base, disclosureStatus: 'not_disclosed', today: '20260805' });
    if ('error' in r) throw new Error(r.message);
    expect(r.selfCorrection?.status).toBe('open');
    expect(r.selfCorrection?.windowEnd).toBe('20260814');
    expect(r.notes.some((n) => n.includes('골든타임'))).toBe(true);
  });

  it('disclosureStatus 생략 시 미공시로 단정하지 않는다 — 중립 안내만 (Codex 치명 2)', () => {
    const r = checkDisclosureDuty({ ...base, today: '20260805' });
    if ('error' in r) throw new Error(r.message);
    expect(r.selfCorrection).toBeUndefined();
    expect(r.notes.some((n) => n.includes('not_disclosed'))).toBe(true);
    expect(r.notes.some((n) => n.includes('아직 공시 전입니다'))).toBe(false);
  });

  it('verdict 가 insufficient_data 면 기한이 지나도 골든타임을 단정하지 않는다 (Codex 치명 2)', () => {
    const r = checkDisclosureDuty({
      duty: 'large_internal_transaction',
      listing: 'unlisted',
      boardDate: '20260722',
      disclosureStatus: 'not_disclosed',
      today: '20260805',
      // 자본·금액 없음 → insufficient_data
    });
    if ('error' in r) throw new Error(r.message);
    expect(r.verdict).toBe('insufficient_data');
    expect(r.selfCorrection).toBeUndefined();
  });

  it('골든타임도 경과(지연 30일 이내) → closed + 감경 잔여 안내', () => {
    const r = checkDisclosureDuty({ ...base, disclosureStatus: 'not_disclosed', today: '20260825' });
    if ('error' in r) throw new Error(r.message);
    expect(r.selfCorrection?.status).toBe('closed');
    expect(r.notes.some((n) => n.includes('감경 구간') && n.includes('남아 있으므로'))).toBe(true);
  });

  it('지연 30일 초과면 감경이 남았다고 하지 않는다 (Codex 중간 9)', () => {
    // 기한 7/31 → 1년 뒤
    const r = checkDisclosureDuty({ ...base, disclosureStatus: 'not_disclosed', today: '20270801' });
    if ('error' in r) throw new Error(r.message);
    expect(r.selfCorrection?.status).toBe('closed');
    expect(r.notes.some((n) => n.includes('감경 구간(30일 이하)도 지났습니다'))).toBe(true);
    expect(r.notes.some((n) => n.includes('남아 있으므로'))).toBe(false);
  });

  it('기한 전이면 selfCorrection 없음', () => {
    const r = checkDisclosureDuty({ ...base, disclosureStatus: 'not_disclosed', today: '20260728' });
    if ('error' in r) throw new Error(r.message);
    expect(r.selfCorrection).toBeUndefined();
  });

  it('지연 공시 사후 판정에는 골든타임을 붙이지 않는다 — 최초 지연 공시는 "자진시정 재공시"가 아니다 (Codex 치명 1)', () => {
    const r = checkDisclosureDuty({ ...base, actualDisclosureDate: '20260810', today: '20260901' });
    if ('error' in r) throw new Error(r.message);
    expect(r.compliance?.onTime).toBe(false);
    expect(r.selfCorrection).toBeUndefined();
    // 면제 안내는 penalty disclaimer 가 요건과 함께 담당한다
    expect(JSON.stringify(r.penalty)).toContain('면제');
  });

  it('적법 공시(기한 내)면 selfCorrection 없음', () => {
    const r = checkDisclosureDuty({ ...base, actualDisclosureDate: '20260728', today: '20260901' });
    if ('error' in r) throw new Error(r.message);
    expect(r.compliance?.onTime).toBe(true);
    expect(r.selfCorrection).toBeUndefined();
  });

  it('공시 대상이 아니면(not_required) 기한이 지나도 selfCorrection 없음', () => {
    const r = checkDisclosureDuty({
      ...base,
      amount: 1_000_000_000, // 기준금액 미달
      disclosureStatus: 'not_disclosed',
      today: '20260805',
    });
    if ('error' in r) throw new Error(r.message);
    expect(r.verdict).toBe('not_required');
    expect(r.selfCorrection).toBeUndefined();
  });

  it('골든타임 마지막 날은 isLastDay=true + "마지막 날" 노트', () => {
    const r = checkDisclosureDuty({ ...base, disclosureStatus: 'not_disclosed', today: '20260814' });
    if ('error' in r) throw new Error(r.message);
    expect(r.selfCorrection?.status).toBe('open');
    expect(r.selfCorrection?.isLastDay).toBe(true);
    expect(r.notes.some((n) => n.includes('마지막 날'))).toBe(true);
  });
});

describe('과태료 체계 매핑 (Codex 치명 3)', () => {
  it('약관특례(§9)·상품용역 감소(§9의2)는 §26 체계의 면제기준을 쓴다', () => {
    for (const duty of ['omnibus_financial', 'goods_services_reduced'] as const) {
      const r = checkDisclosureDuty({
        duty,
        quarterEnd: '20260630',
        disclosureStatus: 'not_disclosed',
        today: '20260901',
      });
      if ('error' in r) throw new Error(r.message);
      expect(r.selfCorrection).toBeDefined();
      expect(r.selfCorrection!.legalBasis[0]!.source).toContain('대규모내부거래');
      // §27·28 전용 사유(5억 미만 상품·용역 현황)가 §26 유형에 나오면 안 된다
      expect(r.selfCorrection!.exemptionGrounds.some((g) => g.includes('5억원 미만'))).toBe(false);
    }
  });
});

describe('2026-06-03 지방선거일 반영 (Codex 치명 4)', () => {
  it('선거일이 영업일 계산에서 제외된다 — 5/29 의결 상장 3영업일 = 6/4', () => {
    const r = checkDisclosureDuty({
      duty: 'large_internal_transaction',
      listing: 'listed',
      boardDate: '20260529',
      totalEquity: 120_000_000_000,
      paidInCapital: 50_000_000_000,
      amount: 7_000_000_000,
      today: '20260601',
    });
    if ('error' in r) throw new Error(r.message);
    // 6/1(월)·6/2(화)·6/3(수=선거일 제외)→6/4(목)
    expect(r.deadline?.deadline).toBe('20260604');
  });
});
