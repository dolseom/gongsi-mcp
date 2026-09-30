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

  it('주요내용 누락은 원 공시 위반이 이미 성립한 것으로 판단하되, 적발 뒤 여지 소멸이라고 과장하지 않는다', () => {
    // 별표 9: 보완 칸의 기준은 "과태료 처분 사전통지서 발송일 전날" — 누가 먼저 발견했는지가 아니다
    const r = assessCorrectionRisk({ errorType: 'content_omission', regime: 'art26_29' });
    expect(r.originalViolation.established).toBe(true);
    expect(r.recommendation).toContain('미룰 이유가 없습니다');
    const all = JSON.stringify(r);
    expect(all).not.toContain('여지도 없습니다');
    expect(all).not.toContain('모두 사라집니다');
    expect(all).not.toContain('연 1회');
    expect(r.originalViolation.explanation).toContain('사전통지서 발송일 전날');
  });

  it('거래 변경은 "위반 아님" 단정이 아니라 이행 여부에 달린 것으로 안내한다 (P2-다 11)', () => {
    // 변경 재의결·재공시를 이미 놓쳤다면 Ⅱ.라 위반이 성립해 있다 — 이행 여부를 안 물었으므로 depends
    const r = assessCorrectionRisk({ errorType: 'transaction_changed', regime: 'art26_29' });
    expect(r.originalViolation.established).toBe('depends');
    expect(r.originalViolation.explanation).toContain('이미 성립');
    expect(r.recommendation).toContain('이사회 의결');
    expect(r.legalBasis.some((b) => b.source.includes('Ⅱ.라'))).toBe(true);
  });

  it('기한을 주면 골든타임을 계산하고, 보완 경과일 감경은 원문 미확인 시나리오로만 준다', () => {
    // 고시 Ⅵ.3.다(4)(나) "공시지연 일수가 3일 이하인 경우 75% …" — 보완 사건의 경과일을 공시지연 일수로 보는지 원문 미확인
    // 기한 2026-07-24(금), 오늘 2026-07-28(화) → 경과 4일
    const r = assessCorrectionRisk({
      errorType: 'minor_miscalculation',
      regime: 'art26_29',
      originalDeadline: '20260724',
      crossConfirmable: true,
      today: '20260728',
    });
    expect(r.selfCorrection?.status).toBe('open');
    expect(r.selfCorrection?.caution).not.toContain('언제나 손실을 최소화');
    expect(r).not.toHaveProperty('delayMitigation');
    expect(r.delayMitigationScenario?.status).toBe('unconfirmed_interpretation');
    expect(r.delayMitigationScenario?.supplementationElapsedDaysIfCompletedToday).toBe(4);
    expect(r.delayMitigationScenario?.reductionPctIfCounted).toBe(50);
    expect(r.delayMitigationScenario?.note).toContain('원문 미확인');
  });

  it('경과 3일이면 시나리오상 75% 구간이고 다음 하락은 4일째다', () => {
    const r = assessCorrectionRisk({
      errorType: 'minor_miscalculation',
      regime: 'art26_29',
      originalDeadline: '20260724',
      today: '20260727',
    });
    expect(r.delayMitigationScenario?.reductionPctIfCounted).toBe(75);
    expect(r.delayMitigationScenario?.nextDropNoteIfCounted).toContain('4일째');
  });

  it('기한 전이면 지연 감경 블록이 없고 골든타임은 before_deadline', () => {
    const r = assessCorrectionRisk({
      errorType: 'minor_miscalculation',
      regime: 'art26_29',
      originalDeadline: '20260724',
      today: '20260720',
    });
    expect(r.selfCorrection?.status).toBe('before_deadline');
    expect(r.delayMitigationScenario).toBeUndefined();
    expect(r.supplementation?.ifCompletedToday).toBeUndefined();
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

  // ── 별표 9 보완 칸 (시행령 [별표 9] 제2호 가목·나목, 2026-09-24 법제처 원문 재확인) ──
  it('c04 유형: 기업집단현황 누락·거짓 — "100(… 1일마다 5만원씩 가산하되, 5백만원을 초과할 수 없다)" 보완 칸을 조건부로 안내', () => {
    const r = assessCorrectionRisk({ errorType: 'false_content', regime: 'art27_28' });
    const s = r.supplementation!;
    expect(s.applicability).toBe('applies_if_conditions_met');
    expect(s.formula).toContain('500만원');
    expect(s.formula).toContain('100만원 + 5만원 × n');
    expect(s.unsupplementedBasicAmount).toContain('500만원');
    expect(s.daysUntilSameAsUnsupplemented).toBe(80);
    // 원 공시 기한 준수를 모르므로 조건부
    expect(s.conditions.join(' ')).toContain('기한 내에 제출했다면');
    expect(s.caveats.join(' ')).toContain('발송일 전날');
    expect(s.caveats.join(' ')).toContain('받은 날이 아닙니다');
    expect(s.caveats.join(' ')).toContain('기본금액');
    expect(s.caveats.join(' ')).toContain('단정할 수 없습니다');
  });

  it('작년 오류(경과 80일 이상)는 보완해도 기본금액이 보완 전과 같다 — "정정하면 감액" 안심 금지', () => {
    const r = assessCorrectionRisk({
      errorType: 'false_content',
      regime: 'art27_28',
      originalFiledOnTime: true,
      originalDeadline: '20250531',
      today: '20260924',
    });
    const t = r.supplementation!.ifCompletedToday!;
    expect(t.basicAmount).toBe('500만원');
    expect(t.sameAsUnsupplemented).toBe(true);
    expect(r.selfCorrection?.status).toBe('closed');
    expect(r.delayMitigationScenario).toBeUndefined(); // 30일 초과 — 시나리오 자체가 없다
  });

  it('경과 10일이면 §27·28 보완 칸 기본금액 150만원 (보완 전 500만원)', () => {
    const r = assessCorrectionRisk({
      errorType: 'content_omission',
      regime: 'art27_28',
      originalFiledOnTime: true,
      originalDeadline: '20260901',
      today: '20260911',
    });
    expect(r.supplementation!.ifCompletedToday).toMatchObject({ elapsedDays: 10, basicAmount: '150만원', sameAsUnsupplemented: false });
  });

  it('§26 의결 O: "500(… 1일마다 10만원씩 가산하되, 2천만원을 초과할 수 없다)" — 150일에 한도', () => {
    const r = assessCorrectionRisk({ errorType: 'content_omission', regime: 'art26_29', boardResolution: true });
    expect(r.supplementation!.formula).toContain('500만원 + 10만원 × n');
    expect(r.supplementation!.formula).toContain('2,000만원');
    expect(r.supplementation!.daysUntilSameAsUnsupplemented).toBe(150);
  });

  it('§26 의결 X 사건에는 보완 산식을 안내하지 않는다 — 별표 9 가목 "이사회 의결을 거치지 않은 경우" 칸에 보완 칸 없음', () => {
    const r = assessCorrectionRisk({ errorType: 'content_omission', regime: 'art26_29', boardResolution: false });
    expect(r.supplementation!.applicability).toBe('no_supplement_row');
    expect(r.supplementation!.formula).toBeUndefined();
    expect(r.supplementation!.unsupplementedBasicAmount).toContain('7,000만원');
  });

  it('원 공시가 기한을 넘긴 건은 다른 칸("공시기한을 넘긴 경우", §27·28 1천만원 한도)', () => {
    const r = assessCorrectionRisk({ errorType: 'content_omission', regime: 'art27_28', originalFiledOnTime: false });
    expect(r.supplementation!.applicability).toBe('late_original_row');
    expect(r.supplementation!.formula).toContain('1,000만원');
    expect(r.supplementation!.daysUntilSameAsUnsupplemented).toBe(180);
  });

  it('c03 유형(단순 오기)도 Ⅴ.2 면제가 안 될 때를 위해 보완 칸을 함께 준다', () => {
    const r = assessCorrectionRisk({ errorType: 'trivial_error', regime: 'art26_29' });
    expect(r.supplementation).toBeDefined();
    expect(r.recommendation).toContain('재량');
    expect(r.recommendation).not.toContain('정정 여부가 과태료를 좌우하지 않습니다. 기록');
  });

  it('거래 변경은 보완 칸 대상이 아니고, 약관 금융거래 의결 생략은 계열 금융회사 일상거래로 한정해 안내한다 (고시 §9①②)', () => {
    const r = assessCorrectionRisk({ errorType: 'transaction_changed', regime: 'art26_29' });
    expect(r.supplementation).toBeUndefined();
    expect(r.recommendation).not.toContain('통째로');
    expect(r.recommendation).toContain('일상적 거래분야');
    expect(r.recommendation).toContain('할 수 있을 뿐');
  });
});
