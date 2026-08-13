import { describe, expect, it } from 'vitest';
import { assessCorrectionRisk } from '../src/tools/assess-correction-risk.js';

describe('assess_correction_risk — 정정 리스크 진단', () => {
  it('핵심 답변: 정정 자체는 위반행위가 아니다 (근거 조문 동봉)', () => {
    const r = assessCorrectionRisk({
      errorType: 'content_omission',
      regime: 'art26_29',
    });
    expect(r.coreAnswer).toContain('정정공시 자체는 과태료 부과 대상 행위가 아닙니다');
    expect(r.legalBasis.some((b) => b.source.includes('Ⅱ'))).toBe(true);
  });

  it('단순 오기는 재공시 없이도 면제 사유(Ⅴ.2)를 안내한다', () => {
    const r = assessCorrectionRisk({ errorType: 'trivial_error', regime: 'art27_28' });
    expect(r.originalViolation.established).toBe('depends');
    expect(r.exemptionPath.some((e) => e.includes('Ⅴ.2'))).toBe(true);
    expect(r.legalBasis.some((b) => b.source.includes('Ⅴ.2'))).toBe(true);
  });

  it('주요내용 누락은 원 공시 위반이 이미 성립한 것으로 판단한다', () => {
    const r = assessCorrectionRisk({ errorType: 'content_omission', regime: 'art26_29' });
    expect(r.originalViolation.established).toBe(true);
    expect(r.recommendation).toContain('즉시 정정');
  });

  it('거래 변경은 "위반 아님" 단정이 아니라 이행 여부에 달린 것으로 안내한다 (P2-다 11)', () => {
    // 변경 재의결·재공시를 이미 놓쳤다면 Ⅱ.라 위반이 성립해 있다 — 이행 여부를 안 물었으므로 depends
    const r = assessCorrectionRisk({ errorType: 'transaction_changed', regime: 'art26_29' });
    expect(r.originalViolation.established).toBe('depends');
    expect(r.originalViolation.explanation).toContain('이미 성립');
    expect(r.recommendation).toContain('이사회 의결');
    expect(r.legalBasis.some((b) => b.source.includes('Ⅱ.라'))).toBe(true);
  });

  it('기한을 주면 골든타임과 지연 감경 축소 일정을 계산한다', () => {
    // 기한 2026-07-24(금), 오늘 2026-07-28(화) → 지연 4일 → 감경 50% 구간
    const r = assessCorrectionRisk({
      errorType: 'minor_miscalculation',
      regime: 'art26_29',
      originalDeadline: '20260724',
      crossConfirmable: true,
      today: '20260728',
    });
    expect(r.selfCorrection?.status).toBe('open');
    expect(r.delayMitigation?.delayDaysIfCorrectedToday).toBe(4);
    expect(r.delayMitigation?.currentReductionPct).toBe(50);
    expect(r.delayMitigation?.nextDropNote).toContain('30%');
  });

  it('지연 3일 이내면 75% 구간이다', () => {
    const r = assessCorrectionRisk({
      errorType: 'minor_miscalculation',
      regime: 'art26_29',
      originalDeadline: '20260724',
      today: '20260727',
    });
    expect(r.delayMitigation?.currentReductionPct).toBe(75);
  });

  it('기한 전이면 지연 감경 블록이 없고 골든타임은 before_deadline', () => {
    const r = assessCorrectionRisk({
      errorType: 'minor_miscalculation',
      regime: 'art26_29',
      originalDeadline: '20260724',
      today: '20260720',
    });
    expect(r.selfCorrection?.status).toBe('before_deadline');
    expect(r.delayMitigation).toBeUndefined();
  });

  it('교차확인 불가 시 경고 노트를 단다', () => {
    const r = assessCorrectionRisk({
      errorType: 'minor_miscalculation',
      regime: 'art26_29',
      crossConfirmable: false,
    });
    expect(r.notes.some((n) => n.includes('확인할 수 없다면'))).toBe(true);
  });

  it('art27_28은 5억 미만 상품·용역 면제 사유가 추가된다', () => {
    const r = assessCorrectionRisk({ errorType: 'minor_miscalculation', regime: 'art27_28' });
    expect(r.exemptionPath.some((e) => e.includes('5억원 미만'))).toBe(true);
  });

  it('신규 지정 30일 내면 Ⅴ.1.가 경로가 추가된다', () => {
    const r = assessCorrectionRisk({
      errorType: 'content_omission',
      regime: 'art26_29',
      newlyDesignatedWithin30d: true,
    });
    expect(r.exemptionPath.some((e) => e.includes('Ⅴ.1.가'))).toBe(true);
  });
});
