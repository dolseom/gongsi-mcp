/**
 * audit_group_disclosures 테스트 — AuditDeps 주입으로 실제 API 없이 판정 로직 검증
 *
 * 기준 사례 (실측 검증된 소노스테이션 변형):
 *   비상장(E) 의결 2026-07-22 → 기한 2026-07-31 / 상장이었다면 3영업일 = 2026-07-27
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store, __setStore } from '../src/lib/store.js';
import {
  auditGroupDisclosures,
  suggestDocSplits,
  type AuditDeps,
} from '../src/tools/audit-group-disclosures.js';
import type { Disclosure } from '../src/clients/dart.js';
import type { DocMeta } from '../src/tools/read-disclosure.js';
import type { BatchResult } from '../src/search/batch.js';

let store: Store;
beforeEach(() => {
  store = new Store(':memory:');
  __setStore(store);
});
afterEach(() => {
  store.close();
  __setStore(null);
});

function row(over: Partial<Disclosure>): Disclosure {
  return {
    corp_code: '00000001',
    corp_name: '테스트회사',
    corp_cls: 'E',
    report_nm: '대규모내부거래관련(자금차입)',
    rcept_no: '20260728000001',
    flr_nm: '테스트회사',
    rcept_dt: '20260728',
    rm: '공',
    ...over,
  };
}

function docMeta(over: Partial<DocMeta>): DocMeta {
  return {
    acode: '80718',
    aregcik: null,
    formulaVersion: '6.0',
    encoding: 'utf-8',
    attachments: [],
    bodyParsable: true,
    boardDate: '20260722',
    pickedEntry: 'doc.xml',
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

function makeDeps(rows: Disclosure[], metas: Record<string, DocMeta>, cachedSet = new Set<string>()): AuditDeps {
  return {
    collectList: async () => batchOf(rows),
    loadDoc: async (rceptNo) => {
      const meta = metas[rceptNo];
      if (!meta) throw new Error(`meta 없음: ${rceptNo}`);
      return { meta };
    },
    isCached: (rceptNo) => cachedSet.has(rceptNo),
  };
}

const BASE_INPUT = {
  companies: ['00000001'],
  from: '20260701',
  to: '20260810',
  today: '20260805',
};

describe('판정 로직', () => {
  it('비상장 7영업일 내 접수 → on_time (소노스테이션 사례)', async () => {
    const deps = makeDeps(
      [row({ rcept_dt: '20260728' })],
      { '20260728000001': docMeta({}) },
    );
    const r = (await auditGroupDisclosures(BASE_INPUT, deps)) as Record<string, any>;
    expect(r.summary.on_time).toBe(1);
    expect(r.summary.late_candidates).toBe(0);
  });

  it('같은 접수일이라도 상장(Y)이면 3영업일 기한이라 지연 후보', async () => {
    const deps = makeDeps(
      [row({ corp_cls: 'Y', rcept_dt: '20260728' })],
      { '20260728000001': docMeta({}) },
    );
    const r = (await auditGroupDisclosures(BASE_INPUT, deps)) as Record<string, any>;
    expect(r.summary.late_candidates).toBe(1);
    const late = r.late_candidates[0];
    expect(late.listing).toBe('listed');
    expect(late.deadline).toBe('20260727');
    expect(late.delay_days).toBe(1);
    expect(late.penalty_estimate.amount).toBeGreaterThan(0);
    expect(late.self_correction.status).toBe('open'); // 기한 7/27 → 골든타임 ~8/10, 오늘 8/5
  });

  it('정정 제출분은 판정에서 제외된다', async () => {
    const deps = makeDeps(
      [
        row({ rcept_dt: '20260728' }),
        row({
          rcept_no: '20260805000009',
          report_nm: '[기재정정]대규모내부거래관련(자금차입)',
          rcept_dt: '20260805',
        }),
      ],
      { '20260728000001': docMeta({}) },
    );
    const r = (await auditGroupDisclosures(BASE_INPUT, deps)) as Record<string, any>;
    expect(r.summary.corrections_excluded).toBe(1);
    expect(r.summary.disclosures_scanned).toBe(1);
    expect(r.summary.on_time).toBe(1);
  });

  it('트랙 B(약관특례 ACODE)는 별도 분류 — 의결일 없어도 정상', async () => {
    const deps = makeDeps(
      [row({})],
      { '20260728000001': docMeta({ acode: '80701', boardDate: null }) },
    );
    const r = (await auditGroupDisclosures(BASE_INPUT, deps)) as Record<string, any>;
    expect(r.summary.omnibus_track_b).toBe(1);
    expect(r.summary.late_candidates).toBe(0);
    expect(r.omnibus_track_b[0].reason).toContain('약관');
  });

  it('의결일 미추출은 board_date_missing 으로 분리 (지연으로 단정하지 않음)', async () => {
    const deps = makeDeps(
      [row({})],
      { '20260728000001': docMeta({ boardDate: null }) },
    );
    const r = (await auditGroupDisclosures(BASE_INPUT, deps)) as Record<string, any>;
    expect(r.summary.board_date_missing).toBe(1);
    expect(r.summary.late_candidates).toBe(0);
  });

  it('파싱 불가 원문은 unparsable 로 집계하고 감사는 계속된다', async () => {
    const deps = makeDeps(
      [row({}), row({ rcept_no: '20260728000002', rcept_dt: '20260728' })],
      {
        '20260728000001': docMeta({ bodyParsable: false, boardDate: null }),
        '20260728000002': docMeta({}),
      },
    );
    const r = (await auditGroupDisclosures(BASE_INPUT, deps)) as Record<string, any>;
    expect(r.summary.unparsable).toBe(1);
    expect(r.summary.on_time).toBe(1);
  });

  it('지연 후보는 "후보" 주의 노트를 반드시 동봉한다', async () => {
    const deps = makeDeps(
      [row({ corp_cls: 'Y' })],
      { '20260728000001': docMeta({}) },
    );
    const r = (await auditGroupDisclosures(BASE_INPUT, deps)) as Record<string, any>;
    expect(r.notes.some((n: string) => n.includes('후보'))).toBe(true);
  });
});

describe('입력 검증', () => {
  it('group 도 companies 도 없으면 invalid_argument', async () => {
    await expect(
      auditGroupDisclosures({ from: '20260701', to: '20260810' } as never),
    ).rejects.toThrow(/필수/);
  });

  it('from > to 면 invalid_argument', async () => {
    await expect(
      auditGroupDisclosures({ ...BASE_INPUT, from: '20260811' }),
    ).rejects.toThrow(/늦습니다/);
  });
});

describe('60초 벽 예측', () => {
  it('미캐시 원문이 많으면 range_too_large + 분할 안내', async () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      row({
        rcept_no: `2026070100${String(i).padStart(4, '0')}`,
        rcept_dt: `202607${String(1 + Math.floor(i / 2)).padStart(2, '0')}`,
      }),
    );
    const deps = makeDeps(rows, {});
    await expect(auditGroupDisclosures(BASE_INPUT, deps)).rejects.toMatchObject({
      code: 'range_too_large',
    });
  });

  it('전부 캐시돼 있으면 대량 건수도 통과한다', async () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      row({ rcept_no: `2026070100${String(i).padStart(4, '0')}`, rcept_dt: '20260728' }),
    );
    const metas: Record<string, DocMeta> = {};
    const cached = new Set<string>();
    for (const r of rows) {
      metas[r.rcept_no] = docMeta({});
      cached.add(r.rcept_no);
    }
    const deps = makeDeps(rows, metas, cached);
    const r = (await auditGroupDisclosures(BASE_INPUT, deps)) as Record<string, any>;
    expect(r.summary.on_time).toBe(60);
    expect(r.diagnostics.doc_cache_hits).toBe(60);
  });
});

describe('suggestDocSplits', () => {
  it('접수일 분포를 따라 청크당 문서 수를 지킨다', () => {
    const dates = [
      ...Array.from({ length: 10 }, () => '20260705'),
      ...Array.from({ length: 10 }, () => '20260715'),
      ...Array.from({ length: 10 }, () => '20260725'),
    ];
    const splits = suggestDocSplits(dates, '20260701', '20260731', 10);
    expect(splits.length).toBeGreaterThanOrEqual(3);
    expect(splits[0]!.from).toBe('20260701');
    expect(splits[splits.length - 1]!.to).toBe('20260731');
    // 구간이 이어져야 한다
    for (let i = 1; i < splits.length; i++) {
      expect(splits[i]!.from >= splits[i - 1]!.to).toBe(true);
    }
  });

  it('단일 날짜 폭주도 최소 1구간으로 감싼다', () => {
    const splits = suggestDocSplits(
      Array.from({ length: 100 }, () => '20260715'),
      '20260701',
      '20260731',
      10,
    );
    expect(splits[splits.length - 1]!.to).toBe('20260731');
  });
});
