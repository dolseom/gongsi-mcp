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
  type PeriodicAuditDeps,
} from '../src/tools/audit-periodic-disclosures.js';
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
    // 확정이 아니라는 것과 확인할 두 가지를 반드시 함께 준다
    expect(
      r.notes.some((n: string) => n.includes('미제출 후보') && n.includes('§2① 단서')),
    ).toBe(true);
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
    expect(
      r.notes.some((n: string) => n.includes('대표회사') && n.includes('판단하지 않습니다')),
    ).toBe(true);
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
