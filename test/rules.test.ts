import { describe, expect, it } from 'vitest';
import {
  addBusinessDays,
  countCalendarDays,
  dayOfWeek,
  isBusinessDay,
  nextBusinessDay,
} from '../src/rules/business-days.js';
import { calcThreshold, effectiveEquity, 억 } from '../src/rules/thresholds.js';
import {
  evaluateCompliance,
  groupStatusQuarterlyDeadline,
  litDeadline,
  omnibusQuarterlyDeadline,
  unlistedMaterialDeadline,
} from '../src/rules/deadlines.js';
import { estimatePenalty } from '../src/rules/penalties.js';

describe('영업일 계산', () => {
  it('2026-07-22는 수요일이다', () => {
    expect(dayOfWeek('20260722')).toBe(3);
  });

  it('토요일·일요일은 영업일이 아니다', () => {
    expect(isBusinessDay('20260725')).toBe(false); // 토
    expect(isBusinessDay('20260726')).toBe(false); // 일
    expect(isBusinessDay('20260727')).toBe(true); // 월
  });

  it('근로자의 날(5/1)은 영업일이 아니다 — 고시 §2⑧', () => {
    expect(isBusinessDay('20260501')).toBe(false);
  });

  it('비영업일이면 다음 영업일로 밀린다', () => {
    expect(nextBusinessDay('20260725')).toBe('20260727'); // 토 → 월
  });

  it('n영업일 후는 기준일 다음 날부터 센다', () => {
    // 7/22(수) → 23(목)1 24(금)2 27(월)3
    expect(addBusinessDays('20260722', 3)).toBe('20260727');
    // → 28(화)4 29(수)5 30(목)6 31(금)7
    expect(addBusinessDays('20260722', 7)).toBe('20260731');
  });
});

describe('실제 공시 사례 검증 (소노스테이션 rcept_no=20260728000484)', () => {
  // 원문: 이사회 의결일 2026.07.22 / 공시일자 2026.07.28 / 비상장(corp_cls=E)
  const boardDate = '20260722';
  const disclosedAt = '20260728';

  it('비상장 7영업일 기한은 2026-07-31이다', () => {
    const d = litDeadline(boardDate, 'unlisted');
    expect(d.deadline).toBe('20260731');
    expect(d.businessDays).toBe(7);
  });

  it('실제 공시일 7/28은 기한 내 — 적법 판정', () => {
    const d = litDeadline(boardDate, 'unlisted');
    const r = evaluateCompliance(d.deadline, disclosedAt);
    expect(r.onTime).toBe(true);
    expect(r.delayDays).toBe(0);
  });

  it('같은 건이 상장회사였다면 3영업일 기한(7/27)이라 하루 지연이다', () => {
    const d = litDeadline(boardDate, 'listed');
    expect(d.deadline).toBe('20260727');
    const r = evaluateCompliance(d.deadline, disclosedAt);
    expect(r.onTime).toBe(false);
    expect(r.delayDays).toBe(1);
  });
});

describe('기준금액 — 시행령 §33①', () => {
  it('삼성전자 실데이터: 자본총계 254.3조 → 100억원 상한 적용', () => {
    const r = calcThreshold({
      totalEquity: 254_330_083_000_000,
      paidInCapital: 897_514_000_000,
    });
    expect(r).not.toBeNull();
    expect(r!.threshold).toBe(100 * 억);
  });

  it('자본총계 1,200억 → 5%인 60억이 기준', () => {
    const r = calcThreshold({ totalEquity: 1_200 * 억 });
    expect(r!.threshold).toBe(60 * 억);
  });

  it('자본총계 50억 → 5%가 2.5억이므로 하한 5억 적용', () => {
    const r = calcThreshold({ totalEquity: 50 * 억 });
    expect(r!.threshold).toBe(5 * 억);
  });

  it('자본총계와 자본금 중 큰 금액을 쓴다', () => {
    const r = calcThreshold({ totalEquity: 100 * 억, paidInCapital: 500 * 억 });
    expect(r!.threshold).toBe(25 * 억); // 500억 × 5%
  });

  it('입력이 없으면 추정하지 않고 null을 반환한다', () => {
    expect(calcThreshold({})).toBeNull();
  });

  it('폐지된 50억 기준이 아니라 100억이 상한이다', () => {
    const r = calcThreshold({ totalEquity: 10_000 * 억 });
    expect(r!.threshold).toBe(100 * 억);
    expect(r!.threshold).not.toBe(50 * 억);
  });
});

describe('자기자본 특례 — 중요사항공시 고시 §5의2③', () => {
  it('자기자본이 자본금에 미달하면 자본금을 자기자본으로 본다', () => {
    expect(effectiveEquity(30 * 억, 50 * 억)).toBe(50 * 억);
    expect(effectiveEquity(80 * 억, 50 * 억)).toBe(80 * 억);
  });
});

describe('기한 — 유형별', () => {
  it('비상장사 중요사항은 사유 발생일부터 7영업일', () => {
    const d = unlistedMaterialDeadline('20260722');
    expect(d.deadline).toBe('20260731');
  });

  it('약관 금융거래는 분기 종료 후 익월 10영업일', () => {
    // 2분기 종료 6/30(화) → 7/1부터 10영업일째 = 7/14(화)
    const d = omnibusQuarterlyDeadline('20260630');
    expect(d.deadline).toBe('20260714');
  });

  it('기업집단현황 분기공시는 분기 종료 후 2개월', () => {
    expect(groupStatusQuarterlyDeadline(2026, 1).deadline).toBe('20260601'); // 5/31(일)→6/1
    expect(groupStatusQuarterlyDeadline(2026, 2).deadline).toBe('20260831');
    expect(groupStatusQuarterlyDeadline(2026, 3).deadline).toBe('20261130');
  });

  it('미검증 공휴일 데이터는 경고를 반환한다', () => {
    const d = litDeadline('20260722', 'listed');
    expect(d.warnings.length).toBeGreaterThan(0);
    expect(d.warnings[0]).toContain('미검증');
  });
});

describe('과태료 — 별표9 + 고시', () => {
  it('§26 이사회 의결 없이 미공시 = 7,000만원', () => {
    const r = estimatePenalty({
      regime: 'art26_29',
      boardResolution: false,
      disclosed: false,
    });
    expect(r.amount).toBe(70_000_000);
  });

  it('§26 의결 O + 미공시 = 5,000만원', () => {
    const r = estimatePenalty({ regime: 'art26_29', boardResolution: true, disclosed: false });
    expect(r.amount).toBe(50_000_000);
  });

  it('§26 기한 5일 지연(누락 없음): 기본 500만 + 50만 − 50% 감경', () => {
    const r = estimatePenalty({
      regime: 'art26_29',
      boardResolution: true,
      disclosed: true,
      onTime: false,
      hasOmissionOrFalse: false,
      delayDays: 5,
    });
    expect(r.baseAmount).toBe(5_000_000);
    expect(r.dailySurcharge).toBe(500_000);
    expect(r.mitigations[0]!.rate).toBe(0.5);
    expect(r.amount).toBe(2_750_000);
  });

  it('지연일수가 늘수록 과태료가 계단식으로 오른다', () => {
    const at = (d: number) =>
      estimatePenalty({
        regime: 'art26_29',
        boardResolution: true,
        disclosed: true,
        onTime: false,
        delayDays: d,
      }).amount;
    const d2 = at(2);
    const d5 = at(5);
    const d10 = at(10);
    const d20 = at(20);
    expect(d2).toBeLessThan(d5);
    expect(d5).toBeLessThan(d10);
    expect(d10).toBeLessThan(d20);
  });

  it('다음 감경 구간 경계를 함께 알려준다', () => {
    const r = estimatePenalty({
      regime: 'art26_29',
      boardResolution: true,
      disclosed: true,
      onTime: false,
      delayDays: 2,
    });
    expect(r.nextThreshold).toBeDefined();
    expect(r.nextThreshold!.amountIfDelayed).toBeGreaterThan(r.amount);
  });

  it('§27·§28 기한 초과는 100만원 + 1일 5만원', () => {
    const r = estimatePenalty({
      regime: 'art27_28',
      disclosed: true,
      onTime: false,
      delayDays: 10,
    });
    expect(r.baseAmount).toBe(1_000_000);
    expect(r.dailySurcharge).toBe(500_000);
  });

  it('일수 가산에는 상한이 있다 (§27·§28 = 1,000만원)', () => {
    const r = estimatePenalty({
      regime: 'art27_28',
      disclosed: true,
      onTime: false,
      delayDays: 9999,
    });
    expect(r.baseAmount + r.dailySurcharge).toBeLessThanOrEqual(10_000_000);
  });

  it('고의적 분할거래는 50% 가중된다', () => {
    const base = estimatePenalty({ regime: 'art26_29', boardResolution: true, disclosed: false });
    const split = estimatePenalty({
      regime: 'art26_29',
      boardResolution: true,
      disclosed: false,
      intentionalSplit: true,
    });
    expect(split.amount).toBeGreaterThan(base.amount);
    expect(split.aggravations[0]!.rate).toBe(0.5);
  });

  it('체납 중이면 감경이 배제된다', () => {
    const normal = estimatePenalty({
      regime: 'art26_29',
      boardResolution: true,
      disclosed: true,
      onTime: false,
      delayDays: 2,
    });
    const arrears = estimatePenalty({
      regime: 'art26_29',
      boardResolution: true,
      disclosed: true,
      onTime: false,
      delayDays: 2,
      inArrears: true,
    });
    expect(arrears.amount).toBeGreaterThan(normal.amount);
    expect(arrears.mitigations).toHaveLength(0);
  });

  it('총액은 10억원을 넘지 않는다', () => {
    const r = estimatePenalty({
      regime: 'art26_29',
      boardResolution: false,
      disclosed: false,
      intentionalSplit: true,
      violationsLast5Years: 10,
      capitalBase: 100_000 * 억,
    });
    expect(r.amount).toBeLessThanOrEqual(10 * 억);
  });

  it('모든 결과에 면책 고지가 붙는다', () => {
    const r = estimatePenalty({ regime: 'art26_29', boardResolution: true, disclosed: false });
    expect(r.disclaimer).toContain('확정액이 아닙니다');
    expect(r.legalBasis.length).toBeGreaterThan(0);
  });
});

describe('달력일 계산', () => {
  it('지연일수는 달력일 기준이다', () => {
    expect(countCalendarDays('20260727', '20260728')).toBe(1);
    expect(countCalendarDays('20260731', '20260810')).toBe(10);
  });
});
