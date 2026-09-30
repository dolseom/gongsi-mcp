/**
 * 수집 취소 · 감사 도구 시간 예산 (외부 검토 2026-09-30 §3-1 · Codex astra 교차검토 후속)
 *
 *  ① 청크 제한시간이 지나면 진행 중인 collect 도 취소된다 — 버려질 요청이 송신 대기열을 차지하지 않게
 *  ② 감사 도구는 시간 예산이 모자라면 새 원문·새 회사 조회를 시작하지 않고 "미확인"으로 따로 보고한다
 *  ③ 정기공시 감사: 목록을 조회하지 못한 회사는 미제출 후보가 아니라 not_checked 다
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useMemoryStore } from './helpers/store.js';
import { disclosureBuilder } from './helpers/disclosure.js';
import { collectAdaptive, type SearchClient, type BatchResult } from '../src/search/batch.js';
import { DartClient, type Disclosure } from '../src/clients/dart.js';
import { auditGroupDisclosures, type AuditDeps } from '../src/tools/audit-group-disclosures.js';
import { auditPeriodicDisclosures, type PeriodicAuditDeps } from '../src/tools/audit-periodic-disclosures.js';
import type { DocMeta } from '../src/tools/read-disclosure.js';
import type { DeadlineLike } from '../src/lib/deadline.js';

const store = useMemoryStore();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const EXPIRED: DeadlineLike = { remainingMs: () => 0, isExpired: () => true };

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

describe('① 청크 제한시간 → 진행 중 수집 취소', () => {
  it('제한시간이 지나면 collect 가 받은 신호가 abort 되고 청크는 실패로 보고된다', async () => {
    let seen: AbortSignal | undefined;
    const client: SearchClient = {
      measure: async () => 10,
      collect: (_p, _m, signal) => {
        seen = signal;
        return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      },
    };
    const r = await collectAdaptive(client, { corpCode: '00111111' }, '20260101', '20260131', {
      perChunkTimeoutMs: 30,
    });
    expect(seen?.aborted).toBe(true);
    expect(r.diagnostics.chunks_failed).toBe(1);
    expect(r.diagnostics.partial_results).toBe(true);
  });

  it('DartClient.collect: 취소되면 다음 페이지를 요청하지 않는다', async () => {
    const ac = new AbortController();
    const page = JSON.stringify({ status: '000', total_count: 300, total_page: 3, page_no: 1, list: [{ rcept_no: 'x' }] });
    const f = vi.fn(async () => {
      ac.abort(); // 첫 페이지 응답 직후 호출부가 취소
      return new Response(page, { status: 200 });
    });
    vi.stubGlobal('fetch', f);
    await expect(new DartClient('test-key').collect({ corpCode: '00111111' }, 10, ac.signal)).rejects.toMatchObject({
      code: 'deadline_exceeded',
      details: { cancelled: true },
    });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('② audit_group_disclosures 시간 예산', () => {
  const row = disclosureBuilder({ corp_name: '테스트회사', report_nm: '대규모내부거래관련(자금차입)', rcept_dt: '20260728' });
  const meta: DocMeta = {
    acode: '80718',
    aregcik: null,
    formulaVersion: '6.0',
    encoding: 'utf-8',
    attachments: [],
    bodyParsable: true,
    boardDate: '20260722',
    pickedEntry: 'doc.xml',
  };
  const input = { companies: ['00000001'], from: '20260701', to: '20260810', today: '20260805' };

  it('예산이 없으면 캐시에 없는 원문은 시작하지 않고 not_started_time_budget 으로 — 적법으로 세지 않는다', async () => {
    const loadDoc = vi.fn(async () => ({ meta }));
    const deps: AuditDeps = {
      collectList: async () => batchOf([row({ rcept_no: '20260728000001' }), row({ rcept_no: '20260728000002' })]),
      loadDoc,
      isCached: (no) => no === '20260728000002',
    };
    const r = (await auditGroupDisclosures(input, deps, { deadline: EXPIRED })) as Record<string, any>;
    expect(loadDoc).toHaveBeenCalledTimes(1); // 캐시된 1건만 판정
    expect(r.summary.not_started_time_budget).toBe(1);
    expect(r.summary.on_time).toBe(1);
    expect(r.coverage.not_judged.time_budget).toBe(1);
    expect(r.coverage.not_judged.total).toBe(1);
    expect(r.notes.join('\n')).toContain('시간 예산 소진 1건');
  });

  it('원문 로드가 예산 초과(deadline_exceeded)로 실패하면 파싱 실패가 아니라 시간 예산 미판정이다', async () => {
    const { ToolError } = await import('../src/lib/errors.js');
    const deps: AuditDeps = {
      collectList: async () => batchOf([row({})]),
      loadDoc: async () => {
        throw new ToolError('deadline_exceeded', '예산 초과');
      },
      isCached: () => false,
    };
    const r = (await auditGroupDisclosures(input, deps)) as Record<string, any>;
    expect(r.summary.not_started_time_budget).toBe(1);
    expect(r.summary.unparsable).toBe(0);
  });
});

describe('③ audit_periodic_disclosures — 조회 못 한 회사는 미제출 후보가 아니다', () => {
  beforeEach(() => {
    store().upsertCorps([
      { corpCode: '00000001', corpName: '갑회사', stockCode: null, jurirNo: null, modifyDate: null },
      { corpCode: '00000002', corpName: '을회사', stockCode: null, jurirNo: null, modifyDate: null },
    ]);
    store().set('corps_loaded_at', new Date().toISOString());
  });
  const base = {
    companies: ['00000001', '00000002'],
    year: 2026,
    duties: ['group_status_annual' as const],
    today: '20261201',
  };

  it('★ 목록 조회가 실패한 회사는 not_filed_candidates 가 아니라 not_checked', async () => {
    const deps: PeriodicAuditDeps = {
      collectList: async (corpCode) => {
        if (corpCode === '00000002') throw new Error('네트워크 오류');
        return batchOf([]);
      },
    };
    const r = (await auditPeriodicDisclosures(base, deps)) as Record<string, any>;
    const rep = r.deadlines.find((d: any) => d.duty === 'group_status_annual');
    expect(rep.not_filed_candidates.map((x: any) => x.corp_code)).toEqual(['00000001']);
    expect(rep.not_checked.map((x: any) => x.corp_code)).toEqual(['00000002']);
    expect(rep.not_checked[0].reason).toContain('목록 조회 실패');
  });

  it('시간 예산이 없으면 목록 조회를 시작하지 않고 전부 not_checked — 미제출 0', async () => {
    const collectList = vi.fn(async () => batchOf([]));
    const r = (await auditPeriodicDisclosures(base, { collectList }, { deadline: EXPIRED })) as Record<string, any>;
    expect(collectList).not.toHaveBeenCalled();
    expect(r.summary.not_filed_candidates).toBe(0);
    expect(r.summary.companies_not_started_time_budget).toBe(2);
    const rep = r.deadlines.find((d: any) => d.duty === 'group_status_annual');
    expect(rep.not_checked).toHaveLength(2);
    expect(r.notes.join('\n')).toContain('확인하지 못한 것');
  });
});
