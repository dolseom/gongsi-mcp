import { describe, expect, it } from 'vitest';
import { calcBusinessDays, calcBusinessDaysInput } from '../src/tools/calc-business-days.js';

describe('calc_business_days — 입력 검증', () => {
  it('실존하지 않는 날짜(2월 31일)를 거부한다', () => {
    expect(calcBusinessDaysInput.safeParse({ date: '20270231' }).success).toBe(false);
  });

  it('8자리가 아니면 거부한다', () => {
    expect(calcBusinessDaysInput.safeParse({ date: '2027-05-01' }).success).toBe(false);
  });

  it('옵션을 둘 이상 주면 invalid_argument 에러를 던진다', () => {
    expect(() =>
      calcBusinessDays({ date: '20260722', add_business_days: 3, add_calendar_days: 45 }),
    ).toThrowError(/동시에 지정할 수 없습니다/);
  });
});

describe('calc_business_days — 기한 말일 조정 (실사용 테스트 #52 재현)', () => {
  it('2027-05-01(토·노동절)이 기한이면 5/4(화)까지다 — 5/3은 노동절 대체공휴일', () => {
    const r = calcBusinessDays({ date: '20270501' });
    expect(r.baseDate.isBusinessDay).toBe(false);
    expect(r.baseDate.holidays).toContain('노동절');
    expect(r.result['effectiveDeadline']).toBe('20270504');
    expect(r.result['adjustedToNextBusinessDay']).toBe(true);
    // 근거 동봉: 건너뛴 날짜에 대체공휴일 명칭이 있어야 모델이 "왜 5/4인지" 설명할 수 있다
    const skippedDates = r.skippedNonBusinessDays.map((d) => d.date);
    expect(skippedDates).toEqual(['20270501', '20270502', '20270503']);
    const substitute = r.skippedNonBusinessDays.find((d) => d.date === '20270503');
    expect(substitute?.reason).toContain('노동절 대체공휴일');
    // 노동절 신설 개정 조문이 근거로 동봉된다
    expect(r.legalBasis.some((ref) => ref.source.includes('관공서의 공휴일'))).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('영업일을 주면 조정 없이 그대로 돌려준다', () => {
    const r = calcBusinessDays({ date: '20260722' });
    expect(r.baseDate.isBusinessDay).toBe(true);
    expect(r.result['effectiveDeadline']).toBe('20260722');
    expect(r.result['adjustedToNextBusinessDay']).toBe(false);
    expect(r.skippedNonBusinessDays).toEqual([]);
  });
});

describe('calc_business_days — N영업일 기한', () => {
  it('소노 검증 사례: 의결 2026-07-22 + 비상장 7영업일 = 2026-07-31', () => {
    const r = calcBusinessDays({ date: '20260722', add_business_days: 7 });
    expect(r.result['deadline']).toBe('20260731');
    expect(r.skippedNonBusinessDays.map((d) => d.date)).toEqual(['20260725', '20260726']);
    expect(r.warnings).toEqual([]);
  });

  it('광복절 대체공휴일: 2026-08-14(금) + 1영업일 = 2026-08-18(화)', () => {
    // 8/15 광복절이 토요일이라 8/17(월)이 대체공휴일 — 다음 영업일은 8/18
    const r = calcBusinessDays({ date: '20260814', add_business_days: 1 });
    expect(r.result['deadline']).toBe('20260818');
    const reasons = r.skippedNonBusinessDays.map((d) => d.reason).join(' / ');
    expect(reasons).toContain('광복절');
    expect(reasons).toContain('대체공휴일');
  });
});

describe('calc_business_days — 달력일 기한', () => {
  it('하도급 하반기: 2026-12-31 + 45일 = 2027-02-14(일) → 익영업일 2027-02-15(월)', () => {
    const r = calcBusinessDays({ date: '20261231', add_calendar_days: 45 });
    expect(r.result['rawDeadline']).toBe('20270214');
    expect(r.result['effectiveDeadline']).toBe('20270215');
    expect(r.result['adjustedToNextBusinessDay']).toBe(true);
  });

  it('근로자의 날(2026-05-01) 특칙: 민법 기간계산과 갈린다는 안내를 동봉한다', () => {
    // 4/30 + 1일 = 5/1(금·근로자의 날) → 고시 영업일 기준으론 5/4(월)로 밀리지만
    // 민법 §161 기준으론 밀리지 않을 수 있다 — 이 차이를 notes 로 알린다
    const r = calcBusinessDays({ date: '20260430', add_calendar_days: 1 });
    expect(r.result['rawDeadline']).toBe('20260501');
    expect(r.result['effectiveDeadline']).toBe('20260504');
    expect(r.notes.some((n) => n.includes('민법'))).toBe(true);
  });
});

describe('calc_business_days — 영업일 세기·데이터 경계', () => {
  it('의결일부터 기한까지 영업일 수를 센다 (당일 불포함)', () => {
    const r = calcBusinessDays({ date: '20260722', count_business_days_to: '20260731' });
    expect(r.result['businessDays']).toBe(7);
    expect(r.result['calendarDays']).toBe(9);
  });

  it('영업일 세기도 건너뛴 비영업일 목록을 동봉한다 (P2-마 — 빈 배열이면 "공휴일 없음"으로 읽힌다)', () => {
    // 실측 재현 입력: 이 구간엔 추석 연휴가 있다. 종전엔 skippedNonBusinessDays 가 [] 였다.
    const r = calcBusinessDays({ date: '20260810', count_business_days_to: '20261015' });
    const skipped = r.skippedNonBusinessDays;
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.some((d) => String(d.reason).includes('추석'))).toBe(true);
    // 내적 정합: 달력일 − 영업일 = 건너뛴 날 수
    expect(Number(r.result['calendarDays']) - Number(r.result['businessDays'])).toBe(skipped.length);
  });

  it('간격이 3년을 넘으면 invalid_argument 로 거부한다', () => {
    expect(() =>
      calcBusinessDays({ date: '20260101', count_business_days_to: '20300101' }),
    ).toThrowError(/3년/);
  });

  it('데이터 없는 연도는 경고한다 — 주말만 반영된 결과를 단정하지 않게', () => {
    const r = calcBusinessDays({ date: '20300102' });
    expect(r.warnings.some((w) => w.includes('2030') && w.includes('데이터가 없어'))).toBe(true);
  });

  it('데이터 보유 연도와 검증 상태를 항상 동봉한다', () => {
    const r = calcBusinessDays({ date: '20260722' });
    expect(r.dataStatus.holidayDataYears['2026']).toBe(true);
    expect(r.dataStatus.holidayDataYears['2027']).toBe(true);
  });
});
