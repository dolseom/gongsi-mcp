import { describe, expect, it } from 'vitest';
import {
  __resetHolidayData,
  __setHolidayData,
  addBusinessDays,
  countCalendarDays,
  dayOfWeek,
  isBusinessDay,
  isValidYMD,
  nextBusinessDay,
} from '../src/rules/business-days.js';
import { calcThreshold, effectiveEquity, 억 } from '../src/rules/thresholds.js';
import {
  businessDaysRemaining,
  evaluateCompliance,
  goodsServicesReducedDeadline,
  groupStatusQuarterlyDeadline,
  litDeadline,
  omnibusQuarterlyDeadline,
  subcontractPaymentDeadline,
  unlistedMaterialDeadline,
} from '../src/rules/deadlines.js';
import { estimatePenalty } from '../src/rules/penalties.js';
import { findRatioTier } from '../src/rules/penalty-ratios.js';

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

describe('날짜 round-trip 검증 (Codex 3차 백로그)', () => {
  it('실존하는 날짜만 통과한다', () => {
    expect(isValidYMD('20260722')).toBe(true);
    expect(isValidYMD('20261231')).toBe(true);
    expect(isValidYMD('20240229')).toBe(true); // 윤년
  });

  it('Date 롤오버로 넘어가던 가짜 날짜를 거부한다', () => {
    expect(isValidYMD('20260231')).toBe(false); // 2월 31일 → 3월 롤오버
    expect(isValidYMD('20260431')).toBe(false); // 4월 31일
    expect(isValidYMD('20260229')).toBe(false); // 2026은 평년
    expect(isValidYMD('20261301')).toBe(false); // 13월
    expect(isValidYMD('20260100')).toBe(false); // 0일
  });

  it('형식이 아니면 거부한다', () => {
    expect(isValidYMD('2026-07-22')).toBe(false);
    expect(isValidYMD('202607')).toBe(false);
    expect(isValidYMD('')).toBe(false);
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

  it('분기 종료일이 아니면 던진다 — "2분기 = 7월 말" 착각이 30일 지연을 적법으로 뒤집는다 (P0-1)', () => {
    // 실측 재현: quarterEnd 20260731 을 받으면 기한이 20260814 가 되어
    // 실제 기한(20260714) 대비 30일 지연 공시가 "적법"으로 나왔다
    expect(() => omnibusQuarterlyDeadline('20260731')).toThrow('분기 종료일');
    expect(() => goodsServicesReducedDeadline('20260731')).toThrow('분기 종료일');
    expect(() => omnibusQuarterlyDeadline('20260601')).toThrow('분기 종료일');
    // 정상 분기말 4종은 전부 통과한다
    for (const q of ['20260331', '20260630', '20260930', '20261231']) {
      expect(() => omnibusQuarterlyDeadline(q)).not.toThrow();
      expect(() => goodsServicesReducedDeadline(q)).not.toThrow();
    }
  });

  it('상품·용역 감소 특례는 분기 종료 후 45일 (달력일)', () => {
    expect(goodsServicesReducedDeadline('20260630').deadline).toBe('20260814');
  });

  it('하도급 결제조건은 반기 종료일 다음 날부터 45일 (가이드라인 명시 8/14와 일치)', () => {
    const d = subcontractPaymentDeadline('20260630');
    expect(d.deadline).toBe('20260814'); // 금요일, 조정 없음
    expect(d.adjustedToNextBusinessDay).toBe(false);
  });

  it('하도급 하반기분 기한 익년 2/14가 일요일이면 다음 영업일로 민다', () => {
    const d = subcontractPaymentDeadline('20261231');
    expect(d.deadline).toBe('20270215'); // 2027-02-14(일) → 2/15(월)
    expect(d.adjustedToNextBusinessDay).toBe(true);
  });

  it('하도급 반기 종료일이 6/30·12/31이 아니면 던진다', () => {
    expect(() => subcontractPaymentDeadline('20260331')).toThrow('반기 종료일');
  });

  it('기업집단현황 분기공시는 분기 종료 후 2개월', () => {
    expect(groupStatusQuarterlyDeadline(2026, 1).deadline).toBe('20260601'); // 5/31(일)→6/1
    expect(groupStatusQuarterlyDeadline(2026, 2).deadline).toBe('20260831');
    expect(groupStatusQuarterlyDeadline(2026, 3).deadline).toBe('20261130');
  });

  it('미검증 공휴일 데이터는 경고를 반환한다', () => {
    // 2026년은 공식 발표 대조로 verified: true가 됐으므로, 미검증 연도를 주입해 경고 경로를 검증한다
    __setHolidayData({ '2026': { verified: false, holidays: [] } });
    try {
      const d = litDeadline('20260722', 'listed');
      expect(d.warnings.length).toBeGreaterThan(0);
      expect(d.warnings[0]).toContain('미검증');
    } finally {
      __resetHolidayData();
    }
  });

  it('검증된 공휴일 데이터(2026 실데이터)는 경고가 없다', () => {
    const d = litDeadline('20260722', 'listed');
    expect(d.warnings).toEqual([]);
  });

  // 2026 공휴일 데이터 회귀 고정 — 월력요항(우주항공청 2025-06-30 발표) 대조 검증분 (2026-08-02)
  it('2026 공휴일 데이터 고정: 선거일·대체공휴일·근로자의날', () => {
    // 6/3 지방선거일 — Codex 교차검토가 잡았던 누락. 적색표기일 70일 집계가 포함을 증명
    expect(isBusinessDay('20260603')).toBe(false);
    // 대체공휴일 4건 (관공서의 공휴일에 관한 규정 §3)
    expect(isBusinessDay('20260302')).toBe(false); // 삼일절(일) 대체
    expect(isBusinessDay('20260525')).toBe(false); // 부처님오신날(일) 대체
    expect(isBusinessDay('20260817')).toBe(false); // 광복절(토) 대체 — 8/16(일) 건너뜀
    expect(isBusinessDay('20261005')).toBe(false); // 개천절(토) 대체
    // 대체공휴일이 생기지 않아야 하는 날 — 잘못 추가되면 기한이 하루 늦어져 지연을 적법 오판한다
    expect(isBusinessDay('20260608')).toBe(true); // 현충일(토)은 대체 대상 아님
    expect(isBusinessDay('20260928')).toBe(true); // 추석연휴 토요일 겹침은 대체 없음(§3①2는 일요일만)
    // 근로자의 날 — 고시상 영업일 제외 대상
    expect(isBusinessDay('20260501')).toBe(false);
  });

  // 2027 공휴일 데이터 회귀 고정 — 규정 현행 원문(2026-04-30 개정) + 월력요항(2026-06-29) 검증분 (2026-08-05)
  it('2027 공휴일 데이터 고정: 노동절·제헌절 신설 + 대체공휴일 7건', () => {
    // 2026-04-30 개정으로 신설·복귀된 공휴일 2건
    expect(isBusinessDay('20270501')).toBe(false); // 노동절(토) — §2 6호 신설
    expect(isBusinessDay('20270717')).toBe(false); // 제헌절(토) — §2 2호 국경일 전면 편입으로 복귀
    // 대체공휴일 7건 (§3)
    expect(isBusinessDay('20270209')).toBe(false); // 설날(일) 대체 — 연휴 다음 첫 비공휴일 화요일
    expect(isBusinessDay('20270503')).toBe(false); // 노동절(토) 대체 — 5/2(일) 건너뜀. 실사용 테스트 #52가 잡은 갭
    expect(isBusinessDay('20270719')).toBe(false); // 제헌절(토) 대체
    expect(isBusinessDay('20270816')).toBe(false); // 광복절(일) 대체
    expect(isBusinessDay('20271004')).toBe(false); // 개천절(일) 대체
    expect(isBusinessDay('20271011')).toBe(false); // 한글날(토) 대체
    expect(isBusinessDay('20271227')).toBe(false); // 성탄절(토) 대체
    // 대체공휴일이 생기지 않아야 하는 날 — 현충일(일)은 §3 대상이 아니다 (언론 헤드라인 오보 주의)
    expect(isBusinessDay('20270607')).toBe(true);
    // 추석연휴(9/14 화~16 목)는 주말 겹침 없음 — 9/17(금) 정상 영업일
    expect(isBusinessDay('20270917')).toBe(true);
  });

  it('2027-05-01 전후 기한 계산 — 실사용 테스트 #52 오답(5/3) 교정: 정답은 5/4(화)', () => {
    // 역일 기한이 5/1(토)에 떨어지면: 5/2(일)·5/3(대체공휴일) 건너 5/4(화)
    expect(nextBusinessDay('20270501')).toBe('20270504');
    // 비상장 7영업일: 의결 4/22(목) → 4/23·26·27·28·29·30 = 6영업일, 5/3 대체공휴일 제외 → 5/4(화)
    const d = litDeadline('20270422', 'unlisted');
    expect(d.deadline).toBe('20270504');
    expect(d.warnings).toEqual([]); // 2027 verified — 미검증 경고가 있으면 안 된다
  });
});

describe('과태료 0원 경로 차단 — 감경 상한 해석 (Opus 검토 C-1, 고시 원문 재확인 2026-08-11)', () => {
  // Ⅵ.3.가 산식 이미지: 감경금액 = 기준금액 × 감경비율 합계. 단서의 상한만 "기본금액의 3/4".
  // Ⅵ.2 비율(2024-08-07 신설)로 기준금액 < 기본금액이면 문언 그대로는 감경금액이 기준금액을
  // 초과해 0원이 된다 → "감경 후 기준금액의 1/4 잔존" 취지 해석을 채택 (비율 미적용이면 동일).
  const zeroCase = {
    regime: 'art26_29' as const,
    disclosed: true,
    onTime: false,
    delayDays: 3,
    autoRenewalSameTerms: true, // 감경 합계 75% + 30% = 105%
  };

  it('지연 3일 + 자동연장 + 거래 10억: 0원이 아니라 기준금액의 25%가 남는다', () => {
    const r = estimatePenalty({ ...zeroCase, transactionAmount: 10 * 억 });
    // 기본총액 530만 × 50% = 기준 265만, 감경 상한 265×0.75 = 198.75만 → 66.25만 → 66만
    expect(r.amount).toBe(660_000);
    expect(r.caveats.join(' ')).toContain('감경비율 합계');
    expect(r.formula).toContain('감경 상한');
  });

  it('거래금액을 정확히 줄수록 과태료가 사라지는 역전이 없다 — 금액에 대해 단조', () => {
    const none = estimatePenalty(zeroCase).amount; // 비율 미적용 상한선 132만
    const a10 = estimatePenalty({ ...zeroCase, transactionAmount: 10 * 억 }).amount; // 66만
    const a60 = estimatePenalty({ ...zeroCase, transactionAmount: 60 * 억 }).amount;
    const a80 = estimatePenalty({ ...zeroCase, transactionAmount: 80 * 억 }).amount;
    const a100 = estimatePenalty({ ...zeroCase, transactionAmount: 100 * 억 }).amount;
    expect(a10).toBeGreaterThan(0);
    expect(a10).toBeLessThanOrEqual(a60);
    expect(a60).toBeLessThanOrEqual(a80);
    expect(a80).toBeLessThanOrEqual(a100);
    expect(a100).toBe(none); // 100억↑ = 비율 1.0 = 미지정 상한선과 동일
  });

  it('비율 미적용이면 종전 동작과 완전히 같다 — Codex 5차 회귀값 132만 유지', () => {
    const r = estimatePenalty({ ...zeroCase, pppOperator: true }); // 감경 합계 155%
    expect(r.amount).toBe(1_320_000); // 530만 − min(·, 530×0.75=397.5만) = 132.5만 → 132만
    // 기준금액 = 기본금액이라 해석 분기 caveat 는 붙지 않는다
    expect(r.caveats.join(' ')).not.toContain('감경비율 합계');
  });

  it('감경 합계가 75% 이하면 상한이 물리지 않는다', () => {
    const r = estimatePenalty({
      regime: 'art26_29', disclosed: true, onTime: false, delayDays: 5, // 50%만
      transactionAmount: 10 * 억,
    });
    // 기준 275만 − 137.5만 = 137.5만 → 137만 (battery4 실측과 일치)
    expect(r.amount).toBe(1_370_000);
    expect(r.formula).not.toContain('감경 상한');
  });
});

describe('businessDaysRemaining — 방향과 무관하게 영업일 기준 (검토 백로그)', () => {
  it('미래 기한은 영업일 카운트', () => {
    // 8/12(수) → 8/14(금): 13(목)·14(금) = 2영업일
    expect(businessDaysRemaining('20260812', '20260814')).toBe(2);
  });

  it('경과 기한도 영업일 카운트 — 달력일 음수가 아니다', () => {
    // 기한 8/7(금), 오늘 8/10(월): 8(토)·9(일) 건너뛰고 10(월)만 = -1 (달력일이면 -3)
    // ※ 8/14~17 을 쓰면 안 된다 — 8/15(토) 광복절의 대체공휴일이 8/17(월)이다
    expect(businessDaysRemaining('20260810', '20260807')).toBe(-1);
  });

  it('당일이면 0', () => {
    expect(businessDaysRemaining('20260814', '20260814')).toBe(0);
  });
});

describe('낙관 기본값의 가정 고지 (P2-다 10·12)', () => {
  const lateCase = {
    regime: 'art26_29' as const,
    disclosed: true,
    onTime: false,
    delayDays: 5,
  };

  it('boardResolution 미입력이면 금액은 종전과 같되 "의결 가정" caveat 가 붙는다', () => {
    const r = estimatePenalty(lateCase);
    expect(r.amount).toBe(2_750_000); // 의결 O 가정 — 종전 동작 유지
    expect(r.caveats.join(' ')).toContain('의결을 거친 것으로 가정');
  });

  it('boardResolution 을 명시하면 가정 caveat 가 붙지 않는다', () => {
    const withTrue = estimatePenalty({ ...lateCase, boardResolution: true });
    expect(withTrue.caveats.join(' ')).not.toContain('의결을 거친 것으로 가정');
    const withFalse = estimatePenalty({ ...lateCase, boardResolution: false });
    expect(withFalse.caveats.join(' ')).not.toContain('의결을 거친 것으로 가정');
    expect(withFalse.amount).toBeGreaterThan(withTrue.amount); // 의결 X 칸이 실제로 적용된다
  });

  it('자본 한쪽만 입력 + 소기업 상한 구간이면 과소평가 가능성 caveat 가 붙는다', () => {
    const r = estimatePenalty({ ...lateCase, capitalBase: 30 * 억, capitalBaseIncomplete: true });
    expect(r.caveats.join(' ')).toContain('한쪽만 입력');
  });

  it('자본을 둘 다 입력했으면(incomplete 아님) caveat 가 없다', () => {
    const r = estimatePenalty({ ...lateCase, capitalBase: 30 * 억 });
    expect(r.caveats.join(' ')).not.toContain('한쪽만 입력');
  });

  it('상한 구간 밖(자본 > 50억)이면 한쪽만 입력해도 caveat 불요 — 상한이 어차피 안 걸린다', () => {
    const r = estimatePenalty({ ...lateCase, capitalBase: 100 * 억, capitalBaseIncomplete: true });
    expect(r.caveats.join(' ')).not.toContain('한쪽만 입력');
  });

  it('위반 없음(0원)에는 가정 caveat 를 붙이지 않는다 — 소음 방지', () => {
    const r = estimatePenalty({ regime: 'art26_29', disclosed: true, onTime: true });
    expect(r.amount).toBe(0);
    expect(r.caveats.join(' ')).not.toContain('가정');
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

describe('거래금액별 적용비율 — 고시 Ⅵ.2 (기준금액)', () => {
  it('표 6구간이 20억원 단위로 50%→100% 등차다', () => {
    // 표 판독의 회귀 고정. 구간 경계나 비율 어느 쪽이 틀어지면 이 등차가 깨진다.
    const probes: Array<[number, number, string]> = [
      [200 * 억, 1.0, '100억원 이상'],
      [100 * 억, 1.0, '100억원 이상'],
      [99 * 억, 0.9, '80억원 이상 ~ 100억원 미만'],
      [80 * 억, 0.9, '80억원 이상 ~ 100억원 미만'],
      [79 * 억, 0.8, '60억원 이상 ~ 80억원 미만'],
      [60 * 억, 0.8, '60억원 이상 ~ 80억원 미만'],
      [59 * 억, 0.7, '40억원 이상 ~ 60억원 미만'],
      [40 * 억, 0.7, '40억원 이상 ~ 60억원 미만'],
      [39 * 억, 0.6, '20억원 이상 ~ 40억원 미만'],
      [20 * 억, 0.6, '20억원 이상 ~ 40억원 미만'],
      [19 * 억, 0.5, '20억원 미만'],
      [0, 0.5, '20억원 미만'],
    ];
    for (const [amount, rate, label] of probes) {
      const tier = findRatioTier(amount);
      expect(tier.rate, `${amount / 억}억원`).toBe(rate);
      expect(tier.label, `${amount / 억}억원`).toBe(label);
    }
  });

  it('음수·NaN 거래금액은 최저 구간으로 둔갑시키지 않고 거부한다', () => {
    // 0원으로 보정하면 잘못된 입력이 "20억원 미만 50%" 라는 정상 산정값이 돼 버린다.
    expect(() => findRatioTier(-1)).toThrow('0 이상의 유한한 금액');
    expect(() => findRatioTier(Number.NaN)).toThrow('0 이상의 유한한 금액');
    expect(findRatioTier(0).rate).toBe(0.5);
  });

  it('잘못된 거래금액이 들어오면 비율을 적용하지 않고 입력 오류를 알린다', () => {
    const r = estimatePenalty({
      regime: 'art26_29',
      boardResolution: true,
      disclosed: true,
      onTime: false,
      delayDays: 5,
      transactionAmount: -1,
    });
    expect(r.transactionRatio).toBeUndefined();
    expect(r.isUpperBound).toBe(true);
    expect(r.caveats.join(' ')).toContain('올바르지 않아');
    expect(r.amount).toBe(2_750_000); // 비율 미적용 상한선
  });

  const late5 = {
    regime: 'art26_29' as const,
    boardResolution: true,
    disclosed: true,
    onTime: false,
    hasOmissionOrFalse: false,
    delayDays: 5,
  };

  it('거래금액 30억(60%)이면 기준금액이 낮아져 275만 → 165만이 된다', () => {
    const r = estimatePenalty({ ...late5, transactionAmount: 30 * 억 });
    // 기본금액 500만 + 일수가산 50만 = 550만 → × 60% = 기준금액 330만
    // 감경 50%(지연 7일 이하) = 165만 → 330만 − 165만
    expect(r.standardAmount).toBe(3_300_000);
    expect(r.amount).toBe(1_650_000);
    expect(r.transactionRatio).toEqual({ rate: 0.6, label: '20억원 이상 ~ 40억원 미만', transactionAmount: 30 * 억 });
    expect(r.formula).toContain('적용비율 60%');
  });

  it('20억원 미만(50%)이 최대 축소폭 — 미적용 대비 약 절반', () => {
    const withRatio = estimatePenalty({ ...late5, transactionAmount: 10 * 억 });
    const without = estimatePenalty(late5);
    expect(withRatio.amount).toBe(1_370_000);
    expect(without.amount).toBe(2_750_000);
    expect(without.amount / withRatio.amount).toBeGreaterThan(1.9);
  });

  it('100억원 이상은 비율 적용 없이 기본금액이 기준금액이다', () => {
    const r = estimatePenalty({ ...late5, transactionAmount: 100 * 억 });
    expect(r.transactionRatio?.rate).toBe(1.0);
    expect(r.standardAmount).toBe(5_500_000);
    expect(r.amount).toBe(2_750_000);
    expect(r.caveats).toEqual([]);
  });

  it('거래금액 미지정이면 값은 종전과 같고, 상한선임을 캐비앳과 구조화 필드로 알린다', () => {
    const r = estimatePenalty(late5);
    expect(r.amount).toBe(2_750_000); // 회귀 고정 — 알려진 값을 바꾸지 않는다
    expect(r.standardAmount).toBe(5_500_000);
    expect(r.transactionRatio).toBeUndefined();
    expect(r.isUpperBound).toBe(true); // 중첩 caveat 을 놓쳐도 알 수 있어야 한다
    expect(r.caveats.join(' ')).toContain('상한선');
    expect(r.caveats.join(' ')).toContain('절반');
  });

  it('비율이 확정된 건과 위반 없는 건은 상한선이 아니다', () => {
    expect(estimatePenalty({ ...late5, transactionAmount: 30 * 억 }).isUpperBound).toBe(false);
    expect(estimatePenalty({ regime: 'art27_28', disclosed: false }).isUpperBound).toBe(false);
    expect(
      estimatePenalty({ regime: 'art26_29', boardResolution: true, disclosed: true, onTime: true }).isUpperBound,
    ).toBe(false);
  });

  it('★ 소기업 1% 상한은 일수가산을 포함한 총액에 걸린다 (Codex 지적 반영)', () => {
    // 자본기준 1억원 → 상한 100만원. 종전엔 가산 전 금액에만 걸어 100만+50만=150만원을
    // 기본금액으로 써서 상한을 넘겼다. 비율·조정액이 모두 과대해지는 경로였다.
    const r = estimatePenalty({ ...late5, capitalBase: 1 * 억 });
    expect(r.baseAmount).toBe(1_000_000);
    expect(r.dailySurcharge).toBe(500_000);
    expect(r.standardAmount).toBe(1_000_000); // 150만원이 아니라 상한 100만원
    expect(r.amount).toBe(500_000); // 100만 − 감경 50만
    expect(r.formula).toContain('자본 1% 상한');
  });

  it('★ 조정 상한 기준이 기본금액 총액이라 상한 적중 시 금액이 낮아진다 (§26, 의도된 변경)', () => {
    // Codex 가 잡은 실제 변화 지점: 종전 155만원 → 132만원.
    // 감경비율 합계 1.55(지연 3일 75% + 자동연장 30% + 민간투자 50%)로 상한이 물린다.
    const r = estimatePenalty({
      regime: 'art26_29',
      boardResolution: true,
      disclosed: true,
      onTime: false,
      delayDays: 3,
      autoRenewalSameTerms: true,
      pppOperator: true,
    });
    // 기본금액총액 530만 → 감경 min(530×1.55, 530×0.75=397.5) = 397.5만 → 132.5만 → 1만원 절사
    expect(r.standardAmount).toBe(5_300_000);
    expect(r.amount).toBe(1_320_000);
  });

  it('★ 같은 변경이 §27·§28 에도 적용된다 (종전 40만원 → 28만원)', () => {
    const r = estimatePenalty({
      regime: 'art27_28',
      disclosed: true,
      onTime: false,
      delayDays: 3,
      autoRenewalSameTerms: true,
      firstViolation: true,
    });
    // 기본금액총액 115만 → 감경 min(115×1.25, 115×0.75=86.25) = 86.25만 → 28.75만 → 절사
    expect(r.standardAmount).toBe(1_150_000);
    expect(r.amount).toBe(280_000);
  });

  it('§27·§28은 비율표 대상이 아니다 — 거래금액을 줘도 무시하고 캐비앳도 없다', () => {
    // 해당 고시는 Ⅲ.2 기준금액 정의와 Ⅵ.2 를 모두 "삭제"로 두었다.
    const withAmount = estimatePenalty({
      regime: 'art27_28',
      disclosed: true,
      onTime: false,
      delayDays: 5,
      transactionAmount: 10 * 억,
    });
    const without = estimatePenalty({ regime: 'art27_28', disclosed: true, onTime: false, delayDays: 5 });
    expect(withAmount.amount).toBe(without.amount);
    expect(withAmount.transactionRatio).toBeUndefined();
    expect(withAmount.caveats).toEqual([]);
  });

  it('위반이 없으면 비율·캐비앳 모두 붙지 않는다', () => {
    const r = estimatePenalty({
      regime: 'art26_29',
      boardResolution: true,
      disclosed: true,
      onTime: true,
      hasOmissionOrFalse: false,
    });
    expect(r.amount).toBe(0);
    expect(r.transactionRatio).toBeUndefined();
    expect(r.caveats).toEqual([]);
  });

  it('감경이 아무리 커도 기준금액의 25%는 남는다 — 문언(기본금액 3/4 상한)의 0원 결과를 뒤집은 해석', () => {
    // ⚠️ 이 테스트는 종전에 amount 0 을 "의도된 동작"으로 고정하고 있었다 (Codex 5차 당시 문언 그대로 구현).
    //    Opus 검토(C-1)가 "거래금액을 정확히 줄수록 0원이 되는 역전 = 최악의 거짓 안심"임을 지적,
    //    원문 재확인(2026-08-11) 후 감경 상한을 기준금액의 3/4에도 함께 거는 해석으로 교체했다.
    const v = {
      regime: 'art26_29' as const,
      boardResolution: true,
      disclosed: true,
      onTime: false,
      delayDays: 3,
      autoRenewalSameTerms: true,
      pppOperator: true, // 감경비율 합계 1.55
    };
    const r = estimatePenalty({ ...v, transactionAmount: 10 * 억 });
    // 기본금액총액 = 500만 + 30만 = 530만, 기준금액 = 265만
    // 감경 = min(265만 × 1.55, 530만 × 0.75, 265만 × 0.75 = 198.75만) → 198.75만
    expect(r.standardAmount).toBe(2_650_000);
    expect(r.amount).toBe(660_000); // 265만 − 198.75만 = 66.25만 → 66만 (0원이 아니다)
    expect(r.caveats.join(' ')).toContain('감경비율 합계'); // 해석 채택을 밝힌다
  });
});

describe('달력일 계산', () => {
  it('지연일수는 달력일 기준이다', () => {
    expect(countCalendarDays('20260727', '20260728')).toBe(1);
    expect(countCalendarDays('20260731', '20260810')).toBe(10);
  });
});
