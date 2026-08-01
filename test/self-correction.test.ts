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

  it('기한 경과 + 미공시 → selfCorrection open + 골든타임 노트', () => {
    const r = checkDisclosureDuty({ ...base, today: '20260805' });
    if ('error' in r) throw new Error(r.message);
    expect(r.selfCorrection?.status).toBe('open');
    expect(r.selfCorrection?.windowEnd).toBe('20260814');
    expect(r.notes.some((n) => n.includes('골든타임'))).toBe(true);
  });

  it('골든타임도 경과 → closed + 즉시 공시 안내', () => {
    const r = checkDisclosureDuty({ ...base, today: '20260901' });
    if ('error' in r) throw new Error(r.message);
    expect(r.selfCorrection?.status).toBe('closed');
    expect(r.notes.some((n) => n.includes('즉시 공시'))).toBe(true);
  });

  it('기한 전이면 selfCorrection 없음', () => {
    const r = checkDisclosureDuty({ ...base, today: '20260728' });
    if ('error' in r) throw new Error(r.message);
    expect(r.selfCorrection).toBeUndefined();
  });

  it('지연 공시가 골든타임 내였으면 면제 검토 노트', () => {
    // 기한 7/31, 실제 공시 8/10 (지연이지만 골든타임 내)
    const r = checkDisclosureDuty({ ...base, actualDisclosureDate: '20260810', today: '20260901' });
    if ('error' in r) throw new Error(r.message);
    expect(r.compliance?.onTime).toBe(false);
    expect(r.selfCorrection?.status).toBe('open');
    expect(r.notes.some((n) => n.includes('면제를 검토'))).toBe(true);
  });

  it('지연 공시가 골든타임 밖이면 면제 노트 없음', () => {
    const r = checkDisclosureDuty({ ...base, actualDisclosureDate: '20260901', today: '20260910' });
    if ('error' in r) throw new Error(r.message);
    expect(r.selfCorrection).toBeUndefined();
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
      today: '20260805',
    });
    if ('error' in r) throw new Error(r.message);
    expect(r.verdict).toBe('not_required');
    expect(r.selfCorrection).toBeUndefined();
  });
});
