/**
 * audit_periodic_disclosures 테스트 — PeriodicAuditDeps 주입으로 실제 API 없이 검증
 *
 * 이 도구의 핵심 주장 두 가지를 회귀로 고정한다.
 *   ① 원문을 한 건도 받지 않는다 (deps 에 loadDoc 자체가 없다)
 *   ② 미제출을 볼 수 있다 — 단 "후보"이며, 기한 미도래·조건부 의무에는 쓰지 않는다
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store, __setStore } from '../src/lib/store.js';
import {
  auditPeriodicDisclosures,
  classifyReportName,
  isCorrection,
  assignmentWindow,
  addMonthsToPeriodEnd,
  type PeriodicAuditDeps,
} from '../src/tools/audit-periodic-disclosures.js';
import { buildPeriodicCalendar } from '../src/rules/periodic-calendar.js';
import type { Disclosure } from '../src/clients/dart.js';
import type { BatchResult } from '../src/search/batch.js';

let store: Store;
beforeEach(() => {
  store = new Store(':memory:');
  __setStore(store);
  store.upsertCorps([
    { corpCode: '00000001', corpName: '갑회사', stockCode: null, jurirNo: null, modifyDate: null },
    { corpCode: '00000002', corpName: '을회사', stockCode: null, jurirNo: null, modifyDate: null },
  ]);
  store.set('corps_loaded_at', new Date().toISOString());
});
afterEach(() => {
  store.close();
  __setStore(null);
});

function row(over: Partial<Disclosure>): Disclosure {
  return {
    corp_code: '00000001',
    corp_name: '갑회사',
    corp_cls: 'E',
    report_nm: '대규모기업집단현황공시[연1회공시및1/4분기용(개별회사)]',
    rcept_no: '20260531000001',
    flr_nm: '갑회사',
    rcept_dt: '20260531',
    rm: '공',
    ...over,
  };
}

function batchOf(rows: Disclosure[]): BatchResult {
  return {
    rows,
    diagnostics: {
      measure_calls: 1,
      collect_calls: 1,
      measure_budget_exhausted: false,
      date_chunks: [],
      chunks_failed: 0,
      partial_results: false,
      truncated: false,
      dedup_dropped: 0,
      total_count_reported: rows.length,
    },
  };
}

/** corp_code 별로 다른 접수분을 돌려주는 주입 deps */
function makeDeps(byCorp: Record<string, Disclosure[]>): PeriodicAuditDeps {
  return {
    collectList: async (corpCode) => batchOf(byCorp[corpCode] ?? []),
  };
}

const BASE = {
  companies: ['00000001', '00000002'],
  year: 2026,
  duties: ['group_status_annual' as const],
  today: '20261201',
};

const call = (input: Parameters<typeof auditPeriodicDisclosures>[0], deps: PeriodicAuditDeps) =>
  auditPeriodicDisclosures(input, deps) as Promise<Record<string, any>>;

describe('보고서명 분류 (DART 실측 형태)', () => {
  it('연1회 서식과 분기 서식을 가른다', () => {
    expect(classifyReportName('대규모기업집단현황공시[연1회공시및1/4분기용(개별회사)]')).toEqual({
      kind: 'annual_q1',
      representative: false,
    });
    expect(classifyReportName('대규모기업집단현황공시[분기별공시(개별회사용)]')).toEqual({
      kind: 'quarterly',
      representative: false,
    });
  });

  it('대표회사 접미사가 서식마다 다르다 — 둘 다 잡는다', () => {
    // 연1회는 '(대표회사)', 분기는 '(대표회사용)' 이다 (실측)
    expect(classifyReportName('대규모기업집단현황공시[연1회공시및1/4분기용(대표회사)]').representative).toBe(
      true,
    );
    expect(classifyReportName('대규모기업집단현황공시[분기별공시(대표회사용)]').representative).toBe(true);
  });

  it('정정 접두사가 붙어도 서식 종류는 그대로 읽는다', () => {
    expect(
      classifyReportName('[기재정정]대규모기업집단현황공시[분기별공시(개별회사용)]').kind,
    ).toBe('quarterly');
  });

  it('모르는 서식명은 unknown 으로 두고 억지로 배정하지 않는다', () => {
    expect(classifyReportName('무언가 다른 공시').kind).toBe('unknown');
  });
});

describe('기한 판정', () => {
  it('기한 내 접수는 on_time', async () => {
    // 2026-05-31 은 일요일이라 기한은 6/1 로 밀린다
    const deps = makeDeps({
      '00000001': [row({})],
      '00000002': [row({ corp_code: '00000002', corp_name: '을회사', rcept_no: '20260601000002', rcept_dt: '20260601' })],
    });
    const r = await call(BASE, deps);
    const d = r.deadlines[0];
    expect(d.deadline).toBe('20260601');
    expect(d.summary.on_time).toBe(2);
    expect(d.summary.late_candidate).toBe(0);
    expect(d.summary.not_filed_candidate).toBe(0);
  });

  it('기한 다음 날 접수는 지연 후보이고 지연일수를 센다', async () => {
    const deps = makeDeps({
      '00000001': [row({ rcept_no: '20260605000001', rcept_dt: '20260605' })],
      '00000002': [],
    });
    const r = await call(BASE, deps);
    const d = r.deadlines[0];
    expect(d.summary.late_candidate).toBe(1);
    expect(d.late_candidates[0].delay_days).toBe(4); // 6/1 → 6/5
    expect(d.late_candidates[0].viewer_url).toContain('20260605000001');
  });

  it('★ 접수분이 아예 없으면 미제출 후보로 잡는다 (J001 감사가 못 하는 일)', async () => {
    const deps = makeDeps({ '00000001': [row({})], '00000002': [] });
    const r = await call(BASE, deps);
    const d = r.deadlines[0];
    expect(d.non_filing_is_signal).toBe(true);
    expect(d.summary.not_filed_candidate).toBe(1);
    expect(d.not_filed_candidates[0].corp_name).toBe('을회사');
    expect(r.coverage.detects_non_filing).toBe(true);
    // 확정이 아니라는 것과, 이 도구가 판정하지 않는 것들을 반드시 함께 준다
    expect(
      r.notes.some((n: string) => n.includes('미제출 후보') && n.includes('scope_caveats')),
    ).toBe(true);
    expect(r.scope_caveats.some((c: string) => c.includes('§2① 단서'))).toBe(true);
    expect(r.scope_caveats.some((c: string) => c.includes('분기별 소속 상태는 판정하지 않습니다'))).toBe(
      true,
    );
    expect(r.coverage.undetectable.obligation_eligibility).toBe(true);
  });

  it('★ 기한이 아직 오지 않았으면 미제출로 몰지 않는다 (거짓 경보 방지)', async () => {
    const deps = makeDeps({ '00000001': [], '00000002': [] });
    const r = await call({ ...BASE, today: '20260101' }, deps);
    const d = r.deadlines[0];
    expect(d.due).toBe(false);
    expect(d.summary.not_filed_candidate).toBe(0);
    expect(r.summary.deadlines_not_due).toBeGreaterThan(0);
    expect(r.notes.some((n: string) => n.includes('기한이 오지 않은'))).toBe(true);
  });

  it('정정 접수분은 판정에서 빼고 원본으로만 본다', async () => {
    const deps = makeDeps({
      '00000001': [
        row({ report_nm: '[기재정정]대규모기업집단현황공시[연1회공시및1/4분기용(개별회사)]', rcept_no: '20260701000001', rcept_dt: '20260701' }),
        row({}), // 원본 5/31
      ],
      '00000002': [row({ corp_code: '00000002', corp_name: '을회사' })],
    });
    const r = await call(BASE, deps);
    expect(r.summary.corrections_excluded).toBe(1);
    // 원본이 기한 내이므로 적법 — 정정 접수일(7/1)로 지연 판정하면 안 된다
    expect(r.deadlines[0].summary.on_time).toBe(2);
    expect(r.deadlines[0].summary.late_candidate).toBe(0);
  });

  it('대표회사 통합 서식 접수를 표시하되 개별회사 의무 대체 여부는 단정하지 않는다', async () => {
    const deps = makeDeps({
      '00000001': [row({ report_nm: '대규모기업집단현황공시[연1회공시및1/4분기용(대표회사)]' })],
      '00000002': [],
    });
    const r = await call(BASE, deps);
    expect(r.deadlines[0].representative_filings).toHaveLength(1);
    // 고시 §3⑤ 근거로 "대체하지 않는다"를 명시해야 한다 — 모호한 중립 표현은 오히려
    // 법적으로 불확실한 것처럼 읽힌다 (Codex 7차 중간 7)
    expect(
      r.scope_caveats.some(
        (c: string) => c.includes('대표회사') && c.includes('대체하지 않습니다') && c.includes('§3⑤'),
      ),
    ).toBe(true);
  });
});

describe('★ 통합 서식은 두 의무를 동시에 이행한다 (Codex 7차 치명 1)', () => {
  // '연1회공시및1/4분기용' 서식 1건이 연1회 의무와 1분기 의무를 모두 이행한다.
  // 한쪽에만 배정하면 나머지 한쪽이 통째로 미제출 후보가 된다 — 기본 duties 에서 터진다.
  const BOTH = { companies: ['00000001'], year: 2026, today: '20261201' };

  it('한 접수분이 연1회와 1분기 양쪽에 이행으로 잡힌다', async () => {
    const deps = makeDeps({ '00000001': [row({})] }); // 2026-05-31 접수
    const r = await call(BOTH, deps);
    const annual = r.deadlines.find((d: any) => d.duty === 'group_status_annual');
    const q1 = r.deadlines.find(
      (d: any) => d.duty === 'group_status_quarterly' && d.period === '2026년 1분기',
    );
    expect(annual.summary.on_time).toBe(1);
    expect(annual.summary.not_filed_candidate).toBe(0);
    expect(q1.summary.on_time).toBe(1);
    expect(q1.summary.not_filed_candidate).toBe(0);
    expect(r.notes.some((n: string) => n.includes('동시에 이행'))).toBe(true);
  });

  it('2·3분기는 분기별공시 서식이라 통합 서식으로 이행되지 않는다', async () => {
    const deps = makeDeps({ '00000001': [row({})] });
    const r = await call(BOTH, deps);
    const q2 = r.deadlines.find(
      (d: any) => d.duty === 'group_status_quarterly' && d.period === '2026년 2분기',
    );
    expect(q2.summary.on_time).toBe(0);
    expect(q2.summary.not_filed_candidate).toBe(1);
  });
});

describe('★ 해를 넘긴 늦은 제출 (Codex 7차 치명 3)', () => {
  it('연말 이후 접수도 수집 구간에 들어가 그 해 연1회분으로 잡힌다', async () => {
    // 2025년 연1회분(기한 2025-06-02)을 2026-01-10 에 제출 → 지연 후보여야 한다.
    // 수집 종료일을 연말로 자르면 이 건이 아예 안 보여 "미제출"로 뒤집힌다.
    const deps = makeDeps({
      '00000001': [row({ rcept_no: '20260110000001', rcept_dt: '20260110' })],
    });
    const r = await call(
      { companies: ['00000001'], year: 2025, duties: ['group_status_annual'], today: '20260827' },
      deps,
    );
    expect(r.scope.collection_period.to).toBe('20260827');
    const annual = r.deadlines[0];
    expect(annual.summary.not_filed_candidate).toBe(0);
    expect(annual.summary.late_candidate).toBe(1);
    expect(annual.late_candidates[0].rcept_dt).toBe('20260110');
  });
});

describe('★ 기간 배정 모호성을 단정하지 않는다 (Codex 7차 치명 2)', () => {
  const QUARTERLY = {
    companies: ['00000001'],
    year: 2026,
    duties: ['group_status_quarterly' as const],
    today: '20261201',
  };

  it('직전 기간이 미제출인데 다음 기간에 이른 접수가 있으면 양쪽에 모호 표시', async () => {
    // 2026년 2분기분(기한 8/31)은 없고, 3분기 창((20260930, 20261231]) 앞쪽인
    // 2026-10-05 에 분기별공시가 하나 있다. 이건 3분기분의 이른 제출일 수도,
    // 2분기분의 늦은 제출일 수도 있다 — 접수일만으로는 가릴 수 없다.
    const deps = makeDeps({
      '00000001': [
        row({
          report_nm: '대규모기업집단현황공시[분기별공시(개별회사용)]',
          rcept_no: '20261005000001',
          rcept_dt: '20261005',
        }),
      ],
    });
    const r = await call(QUARTERLY, deps);
    const q2 = r.deadlines.find((d: any) => d.period === '2026년 2분기');
    const q3 = r.deadlines.find((d: any) => d.period === '2026년 3분기');
    expect(q3.summary.on_time).toBe(1);
    expect(q3.on_time[0].ambiguous_assignment).toBe(true);
    expect(q2.summary.not_filed_candidate).toBe(1);
    expect(q2.not_filed_candidates[0].possibly_filed_late.rcept_no).toBe('20261005000001');
    expect(r.summary.ambiguous_assignments).toBe(2);
    expect(r.notes.some((n: string) => n.includes('기간 배정이 모호한'))).toBe(true);
  });

  it('서식 종류가 다르면 모호 표시를 붙이지 않는다 (실측 오탐 재발 방지)', async () => {
    // 웅진씽크빅 실측: 2026-05-29 '연1회공시및1/4분기용' 1건.
    // 2025년 4분기는 '분기별공시' 서식을 기대하므로, 통합 서식 접수를
    // "4분기분을 늦게 낸 것"으로 볼 수 없다 — 모호 표시가 붙으면 오탐이다.
    const deps = makeDeps({ '00000001': [row({ rcept_dt: '20260529', rcept_no: '20260529000001' })] });
    const r = await call({ companies: ['00000001'], year: 2026, today: '20260827' }, deps);
    const q4 = r.deadlines.find((d: any) => d.period === '2025년 4분기');
    const q1 = r.deadlines.find((d: any) => d.period === '2026년 1분기');
    expect(q4.summary.not_filed_candidate).toBe(1);
    expect(q4.not_filed_candidates[0].possibly_filed_late).toBeUndefined();
    expect(q1.summary.on_time).toBe(1);
    expect(q1.on_time[0].ambiguous_assignment).toBeUndefined();
    expect(r.summary.ambiguous_assignments).toBe(0);
  });

  it('창을 크게 벗어난 접수는 억지로 배정하지 않고 unmatched 로 돌려준다', async () => {
    // 2026-04-01 에 접수된 '분기별공시' — 2025년 4분기 창은 3/31 에 닫혔고
    // 2026년 1분기는 통합 서식(annual_q1)이 이행한다. 어느 쪽도 아니다.
    // 억지로 다음 분기에 밀어넣어 "정상 제출"로 만드는 것보다 모른다고 하는 편이 옳다.
    const deps = makeDeps({
      '00000001': [
        row({
          report_nm: '대규모기업집단현황공시[분기별공시(개별회사용)]',
          rcept_no: '20260401000001',
          rcept_dt: '20260401',
        }),
      ],
    });
    const r = await call(QUARTERLY, deps);
    expect(r.unmatched_filings).toHaveLength(1);
    expect(r.unmatched_filings[0].rcept_no).toBe('20260401000001');
    expect(r.notes.some((n: string) => n.includes('배정하지 못한'))).toBe(true);
  });
});

describe('배정 창 산술', () => {
  it('분기 창은 대상기간 종료 다음 날부터 다음 분기말까지로 닫힌다', () => {
    const cal = buildPeriodicCalendar(2026).filter((e) => e.duty === 'group_status_quarterly');
    const q1 = cal.find((e) => e.period === '2026년 1분기')!;
    expect(assignmentWindow(q1)).toEqual({ start: '20260331', end: '20260630' });
    const q4prev = cal.find((e) => e.period === '2025년 4분기')!;
    expect(assignmentWindow(q4prev)).toEqual({ start: '20251231', end: '20260331' });
  });

  it('연1회 창은 4/1 부터 이듬해 3/31 까지 — 연말을 넘겨 낸 것도 잡는다', () => {
    const annual = buildPeriodicCalendar(2026).find((e) => e.duty === 'group_status_annual')!;
    expect(assignmentWindow(annual)).toEqual({ start: '20260331', end: '20270331' });
  });

  it('반기 창은 6개월이다', () => {
    const h1 = buildPeriodicCalendar(2026).find(
      (e) => e.duty === 'subcontract_payment_terms' && e.period === '2026년 상반기',
    )!;
    expect(assignmentWindow(h1)).toEqual({ start: '20260630', end: '20261231' });
  });

  it('월말 산술이 연도 경계를 넘어도 정확하다', () => {
    expect(addMonthsToPeriodEnd('20261231', 3)).toBe('20270331');
    expect(addMonthsToPeriodEnd('20260930', 3)).toBe('20261231');
    expect(addMonthsToPeriodEnd('20271231', 3)).toBe('20280331');
    // 윤년 2월
    expect(addMonthsToPeriodEnd('20271231', 2)).toBe('20280229');
  });
});

describe('정정 판정', () => {
  it('대괄호 접두사 변형을 잡는다', () => {
    expect(isCorrection('[기재정정]대규모기업집단현황공시[분기별공시(개별회사용)]')).toBe(true);
    expect(isCorrection('[첨부정정]대규모기업집단현황공시[분기별공시(개별회사용)]')).toBe(true);
    expect(isCorrection('[자진정정]대규모기업집단현황공시[분기별공시(개별회사용)]')).toBe(true);
    expect(isCorrection('[기재추가]대규모기업집단현황공시[분기별공시(개별회사용)]')).toBe(true);
    expect(isCorrection('대규모기업집단현황공시[분기별공시(개별회사용)]')).toBe(false);
  });
});

describe('신규 편입·신규 지정 오탐 차단 (실측 기반)', () => {
  // 실측: 웅진씽크빅은 2024-01-01~2026-08-27 사이 J004 가 단 1건(2026-05-29)이다.
  // 웅진이 2026년 5월 신규 지정 집단이기 때문이다. 편입 전 기한을 미제출로 몰면
  // 신규 지정 집단은 통째로 "집단 전체 위반"이 된다 — 이 도구를 못 쓰게 만드는 오탐이다.
  it('companies 경로에서는 편입일을 모른다는 사실을 밝힌다', async () => {
    // group 경로만 포털에서 계열편입일(grinil)을 받아온다. companies 로 직접 지정하면
    // 편입 전 기간을 걸러낼 근거가 없으므로, 그 사실 자체를 응답에 밝혀야 한다.
    const deps = makeDeps({ '00000001': [], '00000002': [] });
    const r = await call(BASE, deps);
    expect(
      r.notes.some((n: string) => n.includes('계열편입일을 알 수 없어')),
    ).toBe(true);
  });

  it('★ 모집단 전체가 0건이면 "집단 전체 위반"이 아니라 범위 오류 신호로 알린다', async () => {
    const deps = makeDeps({ '00000001': [], '00000002': [] });
    const r = await call(BASE, deps);
    const d = r.deadlines[0];
    expect(d.due).toBe(true);
    expect(d.likely_out_of_scope).toBe(true);
    expect(
      r.notes.some(
        (n: string) => n.includes('전부가 한 건도 내지 않은') && n.includes('지정되지 않았거나'),
      ),
    ).toBe(true);
  });

  it('일부만 미제출이면 범위 오류 신호를 붙이지 않는다', async () => {
    const deps = makeDeps({ '00000001': [row({})], '00000002': [] });
    const r = await call(BASE, deps);
    expect(r.deadlines[0].likely_out_of_scope).toBeUndefined();
    expect(r.deadlines[0].summary.not_filed_candidate).toBe(1);
  });
});

describe('배정 규칙과 정직성', () => {
  it('분기 서식은 접수일 창으로 각 분기에 갈린다', async () => {
    const deps = makeDeps({
      '00000001': [
        // 2025년 4분기분 (기한 2026-03-03) — 기간 종료 20251231 이후 접수
        row({ report_nm: '대규모기업집단현황공시[분기별공시(개별회사용)]', rcept_no: '20260302000001', rcept_dt: '20260302' }),
        // 2026년 2분기분 (기한 2026-08-31)
        row({ report_nm: '대규모기업집단현황공시[분기별공시(개별회사용)]', rcept_no: '20260831000001', rcept_dt: '20260831' }),
      ],
      '00000002': [],
    });
    const r = await call({ ...BASE, duties: ['group_status_quarterly'] as any }, deps);
    const q4 = r.deadlines.find((d: any) => d.period === '2025년 4분기');
    const q2 = r.deadlines.find((d: any) => d.period === '2026년 2분기');
    expect(q4.summary.on_time).toBe(1);
    expect(q2.summary.on_time).toBe(1);
  });

  it('어느 창에도 못 넣은 접수분은 버리지 않고 전부 돌려준다', async () => {
    const deps = makeDeps({
      '00000001': [row({ report_nm: '알 수 없는 공시 서식', rcept_no: '20260401000001', rcept_dt: '20260401' })],
      '00000002': [],
    });
    const r = await call(BASE, deps);
    expect(r.unmatched_filings).toHaveLength(1);
    expect(r.notes.some((n: string) => n.includes('배정하지 못한'))).toBe(true);
  });

  it('목록 조회 실패는 "미제출"이 아니라 "확인 못 함"으로 보고한다', async () => {
    const deps: PeriodicAuditDeps = {
      collectList: async (corpCode) => {
        if (corpCode === '00000002') throw new Error('네트워크 실패');
        return batchOf([row({})]);
      },
    };
    const r = await call(BASE, deps);
    expect(r.list_errors).toHaveLength(1);
    expect(
      r.notes.some((n: string) => n.includes('목록 조회가 실패') && n.includes('확인하지 못한 것')),
    ).toBe(true);
  });

  it('내용의 정확성은 보지 않는다는 것을 구조화 필드로 밝힌다', async () => {
    const deps = makeDeps({ '00000001': [row({})], '00000002': [row({ corp_code: '00000002' })] });
    const r = await call(BASE, deps);
    expect(r.coverage.undetectable.content_accuracy).toBe(true);
    expect(r.coverage.undetectable.other_duty_types).toEqual(['J001', 'J005', 'J008']);
  });
});

describe('입력 검증', () => {
  it('group 도 companies 도 없으면 거부', async () => {
    await expect(
      auditPeriodicDisclosures({ year: 2026 } as any, makeDeps({})),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  it('group 과 companies 동시 지정은 거부', async () => {
    await expect(
      auditPeriodicDisclosures({ year: 2026, group: '삼성', companies: ['00000001'] } as any, makeDeps({})),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });
});
