import { describe, it, expect } from 'vitest';
import { disclosureCalendar } from '../src/tools/disclosure-calendar.js';
import { buildPeriodicCalendar } from '../src/rules/periodic-calendar.js';
import {
  loadPeriodicDuties,
  periodicDutyFileSchema,
} from '../src/rules/periodic-duties.js';

const call = (input: Parameters<typeof disclosureCalendar>[0]) =>
  disclosureCalendar(input) as Record<string, any>;

describe('정기공시 정의 데이터', () => {
  it('6종 의무가 모두 근거 조문과 항목을 갖는다', () => {
    const duties = loadPeriodicDuties();
    expect(duties.map((d) => d.key).sort()).toEqual([
      'goods_services_reduced',
      'group_status_annual',
      'group_status_quarterly',
      'omnibus_financial',
      'subcontract_payment_terms',
      'unlisted_major_shareholder',
    ]);
    for (const d of duties) {
      expect(d.legalBasis.length).toBeGreaterThan(0);
      expect(d.items.length).toBeGreaterThan(0);
      // 조건부 의무인데 조건이 없으면 "무조건 해야 하는 것"으로 오독된다
      if (d.obligation === 'conditional') expect(d.appliesWhen).toBeTruthy();
    }
  });

  it('스키마가 망가진 법령 데이터를 통과시키지 않는다', () => {
    const good = {
      _meta: {
        title: 't',
        verified: true,
        verifiedAt: '2026-08-27',
        scope: ['s'],
        verification: ['v'],
      },
      duties: [
        {
          key: 'k',
          label: 'l',
          dartType: 'J004',
          frequency: 'annual',
          obligation: 'unconditional',
          items: [{ code: 'c', name: 'n', asOf: 'a' }],
          legalBasis: [{ source: 's', summary: 'm' }],
        },
      ],
    };
    expect(periodicDutyFileSchema.safeParse(good).success).toBe(true);

    // 근거 조문이 비면 "근거 없는 기한"이 된다 — 이 프로젝트에서 성립할 수 없다
    const noBasis = structuredClone(good);
    noBasis.duties[0]!.legalBasis = [];
    expect(periodicDutyFileSchema.safeParse(noBasis).success).toBe(false);

    // 조건부인데 조건이 없으면 "무조건 의무"로 오독된다
    const condNoWhen = structuredClone(good) as any;
    condNoWhen.duties[0].obligation = 'conditional';
    expect(periodicDutyFileSchema.safeParse(condNoWhen).success).toBe(false);

    // 기준일(asOf) 누락 — 담당자가 가장 자주 틀리는 정보가 조용히 사라지면 안 된다
    const noAsOf = structuredClone(good) as any;
    delete noAsOf.duties[0].items[0].asOf;
    expect(periodicDutyFileSchema.safeParse(noAsOf).success).toBe(false);

    // 검증되지 않은 법령 데이터는 실을 수 없다
    const unverified = structuredClone(good) as any;
    unverified._meta.verified = false;
    expect(periodicDutyFileSchema.safeParse(unverified).success).toBe(false);
  });

  it('반환값을 변이해도 다음 호출이 오염되지 않는다', () => {
    const first = loadPeriodicDuties();
    first[0]!.items.length = 0;
    first[0]!.label = '망가뜨림';
    const second = loadPeriodicDuties();
    expect(second[0]!.items.length).toBeGreaterThan(0);
    expect(second[0]!.label).not.toBe('망가뜨림');
  });

  it('분기 공시 항목은 고시 §5①2호대로 4개다 (하목·너목·5호나목·7호)', () => {
    const q = loadPeriodicDuties().find((d) => d.key === 'group_status_quarterly')!;
    expect(q.items).toHaveLength(4);
    expect(q.items.map((i) => i.code)).toEqual([
      '§4①4호 하목',
      '§4①4호 너목',
      '§4①5호 나목',
      '§4①7호',
    ]);
    // 담당자가 가장 자주 틀리는 지점 — 기준일이 "공시기한일의 직전 분기"다
    expect(q.items[0]!.asOf).toContain('직전 분기말');
    expect(q.items[1]!.asOf).toContain('직전 분기 개시일');
  });
});

describe('캘린더 날짜 산술', () => {
  // 2027년: 5/31(월)은 영업일이라 조정 없음. 노동절 공휴일 신설(2027-05-01 토)로
  // 5/3(월)이 대체공휴일이 되는 해라 영업일 계산이 실제로 달라진다.
  it('2027년 기업집단현황 연1회 기한은 5월 31일이다', () => {
    const cal = buildPeriodicCalendar(2027);
    const annual = cal.find((e) => e.duty === 'group_status_annual')!;
    expect(annual.statutory_date).toBe('20270531');
    expect(annual.deadline).toBe('20270531');
    expect(annual.adjusted_to_next_business_day).toBe(false);
  });

  it('기한 도래 기준이라 전년도 4분기분이 들어오고 당해 4분기분은 빠진다', () => {
    const cal = buildPeriodicCalendar(2027);
    const gsq = cal.filter((e) => e.duty === 'group_status_quarterly');
    // 2026년 4분기(기한 2027-02-28) ~ 2027년 3분기(기한 2027-11-30) = 4건
    expect(gsq).toHaveLength(4);
    expect(gsq[0]!.period).toBe('2026년 4분기');
    expect(gsq[0]!.period_end).toBe('20261231');
    expect(gsq.at(-1)!.period).toBe('2027년 3분기');
    // 2027년 4분기는 기한이 2028-02-28 이라 이 해에 없다
    expect(gsq.some((e) => e.period === '2027년 4분기')).toBe(false);
  });

  it('법정 마지막 날이 비영업일이면 다음 최초 영업일로 조정하고 그 사실을 표시한다', () => {
    // 고시 §5② 단서. 이 케이스가 도구의 존재 이유를 그대로 보여준다 —
    // 2026-02-28(토) → 3/1(일, 삼일절) → 3/2(삼일절 대체공휴일) → **3/3(화)**.
    // 사람이 달력만 보고 "3월 2일"이라 답하기 딱 좋은 자리다.
    const cal = buildPeriodicCalendar(2026);
    const q4 = cal.find((e) => e.duty === 'group_status_quarterly' && e.period === '2025년 4분기')!;
    expect(q4.statutory_date).toBe('20260228');
    expect(q4.deadline).toBe('20260303');
    expect(q4.adjusted_to_next_business_day).toBe(true);
  });

  it('하도급 45일 기한이 설 연휴를 건너뛴다 (2025 하반기 → 2026-02-19)', () => {
    // 20251231 + 45일 = 2026-02-14(토). 2/15(일) + 설 연휴 2/16~2/18 → 2/19(목).
    const cal = buildPeriodicCalendar(2026);
    const h2 = cal.find(
      (e) => e.duty === 'subcontract_payment_terms' && e.period === '2025년 하반기',
    )!;
    expect(h2.statutory_date).toBe('20260214');
    expect(h2.deadline).toBe('20260219');
  });

  it('2027 상반기 하도급 기한이 광복절 대체공휴일을 건너뛴다 (→ 2027-08-17)', () => {
    // 20270630 + 45일 = 2027-08-14(토) → 8/15 광복절(일) → 8/16 대체공휴일(월) → 8/17(화)
    const cal = buildPeriodicCalendar(2027);
    const h1 = cal.find(
      (e) => e.duty === 'subcontract_payment_terms' && e.period === '2027년 상반기',
    )!;
    expect(h1.statutory_date).toBe('20270814');
    expect(h1.deadline).toBe('20270817');
    expect(h1.adjusted_to_next_business_day).toBe(true);
  });

  it('하도급대금 결제조건은 반기말 + 45일 (상반기 8/14)', () => {
    const cal = buildPeriodicCalendar(2026);
    const h1 = cal.find(
      (e) => e.duty === 'subcontract_payment_terms' && e.period === '2026년 상반기',
    )!;
    expect(h1.statutory_date).toBe('20260814');
    expect(h1.period_end).toBe('20260630');
  });

  it('모든 항목의 기한이 요청 연도 안에 있고 시간순으로 정렬된다', () => {
    const cal = buildPeriodicCalendar(2026);
    expect(cal.length).toBeGreaterThan(10);
    for (const e of cal) expect(e.deadline.slice(0, 4)).toBe('2026');
    const dates = cal.map((e) => e.deadline);
    expect([...dates].sort()).toEqual(dates);
  });
});

describe('약관 금융거래 적용범위 (Codex 교차검토 치명 1)', () => {
  it('분기 일괄공시는 §9③·§9⑤ 두 경로뿐이고 §9④ 대비를 근거에 함께 싣는다', () => {
    const omni = loadPeriodicDuties().find((d) => d.key === 'omnibus_financial')!;
    // 계열 금융회사(§9③)와 단기금융상품(§9⑤) 두 항목
    expect(omni.items.map((i) => i.code)).toEqual(['고시 §9③', '고시 §9⑤']);
    // 비금융회사의 그 밖의 §9② 거래는 3/7영업일이라는 것을 조건에 명시
    expect(omni.appliesWhen).toContain('3영업일');
    expect(omni.appliesWhen).toContain('단기금융상품');
    expect(omni.legalBasis.some((r) => r.source.includes('제9조제4항'))).toBe(true);
  });
});

describe('도구 응답', () => {
  it('D-day 와 상태를 계산하고 다음 마감을 뽑는다', () => {
    const r = call({ year: 2026, today: '20260101' });
    expect(r.summary.total).toBeGreaterThan(10);
    expect(r.summary.past).toBe(0);
    expect(r.summary.next).not.toBeNull();
    const first = r.entries[0];
    expect(first.deadline).toBe(r.summary.next.deadline);
    expect(first.business_days_remaining).toBeGreaterThan(0);
  });

  it('지난 기한은 past 로 분류하고 include_past:false 로 걸러진다', () => {
    const all = call({ year: 2026, today: '20261201' });
    expect(all.summary.past).toBeGreaterThan(0);
    const remaining = call({ year: 2026, today: '20261201', include_past: false });
    expect(remaining.entries.every((e: any) => e.status !== 'past')).toBe(true);
    expect(remaining.summary.total).toBeLessThan(all.summary.total);
  });

  it('★ 캘린더에 없는 사유 발생형 공시를 항상 함께 고지한다 (가장 위험한 오독)', () => {
    const r = call({ year: 2026, today: '20260101' });
    expect(r.notes[0]).toContain('캘린더가 비어 있다고 해서 공시할 것이 없다는 뜻이 아닙니다');
    expect(r.not_in_calendar.map((n: any) => n.duty)).toEqual([
      'large_internal_transaction',
      'unlisted_material',
      'public_interest_corp',
      // Codex 교차검토 치명 1: §9④ 경로(단기금융상품이 아닌 §9② 약관 금융거래)는
      // 분기 일괄이 아니라 행위 후 3/7영업일이다 — 캘린더에 없다는 것을 명시해야 한다
      'omnibus_financial_event_driven',
    ]);
    // 주요주주 지분변동 분기공시는 캘린더에 **있으므로** 제외 문구가 그것까지 덮으면 안 된다
    expect(r.notes[0]).toContain('주요주주 지분변동 분기공시를 **제외한**');
    expect(r.notes[0]).toContain('공익법인');
    // 필터로 0건이 나와도 같은 고지가 유지돼야 한다
    const empty = call({ year: 2026, today: '20260101', from: '20260101', to: '20260102' });
    expect(empty.summary.total).toBe(0);
    expect(empty.notes[0]).toContain('공시할 것이 없다는 뜻이 아닙니다');
    expect(empty.notes.some((n: string) => n.includes('0건입니다'))).toBe(true);
  });

  it('연1회와 1분기가 같은 날 겹치는 것을 collisions 로 알린다', () => {
    // 연1회(5/31)와 1분기(3/31+2개월=5/31)는 원래 같은 날이다.
    // 2026 년은 5/31 이 일요일이라 둘 다 6/1(월)로 밀리며, 주요주주 분기공시까지 3건이 겹친다.
    const r = call({ year: 2026, today: '20260101' });
    const hit = r.collisions.find((c: any) => c.deadline === '20260601');
    expect(hit).toBeTruthy();
    expect(hit.count).toBe(3);
    expect(hit.duties.some((d: string) => d.includes('연1회'))).toBe(true);
    expect(r.notes.some((n: string) => n.includes('겹치는 지점'))).toBe(true);
  });

  it('연1회·1분기 통합 제출 사실을 알린다 (두 번 내는 것이 아니다)', () => {
    const r = call({ year: 2026, today: '20260101' });
    const annual = r.entries.find((e: any) => e.duty === 'group_status_annual');
    expect(annual.filed_together_with.duty).toBe('group_status_quarterly');
    const q1 = r.entries.find(
      (e: any) => e.duty === 'group_status_quarterly' && e.period === '2026년 1분기',
    );
    expect(q1.filed_together_with).toBeTruthy();
    // 2·3분기는 별도 서식이므로 표시가 붙으면 안 된다
    const q2 = r.entries.find(
      (e: any) => e.duty === 'group_status_quarterly' && e.period === '2026년 2분기',
    );
    expect(q2.filed_together_with).toBeUndefined();
    expect(r.notes.some((n: string) => n.includes('단일 서식으로 함께 제출'))).toBe(true);
  });

  it('조건부 의무는 별도로 세고 unconditional_only 로 뺄 수 있다', () => {
    const all = call({ year: 2026, today: '20260101' });
    expect(all.summary.conditional).toBeGreaterThan(0);
    expect(all.notes.some((n: string) => n.includes('conditional'))).toBe(true);
    const only = call({ year: 2026, today: '20260101', unconditional_only: true });
    expect(only.entries.every((e: any) => e.obligation === 'unconditional')).toBe(true);
  });

  it('공휴일 데이터가 없는 연도는 항목 warnings 와 상위 note 로 알린다', () => {
    const r = call({ year: 2029, today: '20290101' });
    expect(r.entries.every((e: any) => e.warnings.length > 0)).toBe(true);
    expect(r.notes.some((n: string) => n.includes('공휴일 데이터 경고'))).toBe(true);
  });

  it('알 수 없는 의무 키는 조용히 무시하지 않고 거부한다', () => {
    expect(() => call({ year: 2026, duties: ['없는키'] })).toThrowError(/알 수 없는 의무 키/);
  });

  it('from 이 to 보다 늦으면 거부한다', () => {
    expect(() => call({ year: 2026, from: '20260601', to: '20260101' })).toThrowError(/보다 늦습니다/);
  });
});
