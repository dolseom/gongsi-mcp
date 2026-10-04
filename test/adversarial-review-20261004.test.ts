/**
 * 배포 직전 적대적 검토 (2026-10-04) — a6f9241 · cea6470 반례 테스트
 *
 * ★ 이 파일의 "반례" 테스트는 **현재 소스에서 실패해야** 결함이 재현된 것이다.
 *   (통과하는 테스트는 "확인한 것" 목록용)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useMemoryStore } from './helpers/store.js';
import { DartClient, __resetDartGate } from '../src/clients/dart.js';
import { __resetConfig } from '../src/lib/config.js';
import { auditPeriodicDisclosures, type PeriodicAuditDeps } from '../src/tools/audit-periodic-disclosures.js';
import { suggestDocSplits } from '../src/tools/audit-group-disclosures.js';
import type { DeadlineLike } from '../src/lib/deadline.js';
import type { BatchResult } from '../src/search/batch.js';

const store = useMemoryStore();

beforeEach(() => {
  store().upsertCorps([
    { corpCode: '00000001', corpName: '갑회사', stockCode: null, jurirNo: null, modifyDate: null },
    { corpCode: '00000002', corpName: '을회사', stockCode: null, jurirNo: null, modifyDate: null },
  ]);
  store().set('corps_loaded_at', new Date().toISOString());
  vi.stubEnv('DART_API_KEY', 'test-key');
  __resetConfig();
  __resetDartGate();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  __resetConfig();
  __resetDartGate();
});

const BASE = {
  companies: ['00000001', '00000002'],
  year: 2026,
  duties: ['group_status_annual' as const],
  today: '20261201',
};

const NO_DATA = JSON.stringify({ status: '013', message: '조회된 데이타가 없습니다.' });
const ONE_ROW = JSON.stringify({
  status: '000',
  total_count: 1,
  total_page: 1,
  page_no: 1,
  list: [
    {
      corp_code: '00000001',
      corp_name: '갑회사',
      rcept_no: '20260531000001',
      rcept_dt: '20260531',
      report_nm: '대규모기업집단현황공시[연1회공시및1/4분기용(개별회사)]',
      corp_cls: 'Y',
      flr_nm: '갑회사',
      rm: '공',
    },
  ],
});

function corpOf(url: unknown): string | null {
  return new URL(String(url)).searchParams.get('corp_code');
}

describe('A. audit_periodic_disclosures — 실제 경로(collectAdaptive)에서 목록 조회 실패 회사', () => {
  it('★ 반례: collectAdaptive 는 청크 실패를 던지지 않고 rows=[]·partial 로 돌려준다 → 조회 실패 회사가 not_filed_candidates 에 들어간다', async () => {
    // 을회사(00000002)는 DART 응답이 JSON 이 아니다(DartApiError, 재시도 없음) — 측정·수집 모두 실패
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        if (corpOf(url) === '00000002') return new Response('<html>oops</html>', { status: 200 });
        return new Response(NO_DATA, { status: 200 });
      }),
    );
    const r = (await auditPeriodicDisclosures(BASE)) as Record<string, any>;
    const rep = r.deadlines.find((d: any) => d.duty === 'group_status_annual');
    // 기대: 을회사는 "확인 못 함"(not_checked) — 미제출 후보가 아니다
    expect(rep.not_checked?.map((x: any) => x.corp_code) ?? []).toEqual(['00000002']);
    expect(rep.not_filed_candidates.map((x: any) => x.corp_code)).toEqual(['00000001']);
    expect(r.list_errors ?? []).toHaveLength(1);
  });

  it('★ 반례: 시간 예산이 조회 도중 끊긴 회사(측정 성공 → 수집에서 deadline_exceeded)도 not_filed_candidates 가 된다', async () => {
    // 갑회사는 접수분이 1건 있다. 측정(page_count=1)은 성공하지만 그 직후 예산이 0 이 되어 수집 요청은 시작되지 않는다.
    let fetchCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        fetchCalls++;
        if (corpOf(url) === '00000001') return new Response(ONE_ROW, { status: 200 });
        return new Response(NO_DATA, { status: 200 });
      }),
    );
    // 첫 fetch 가 나가기 전까지는 예산이 넉넉하고, 그 뒤로는 0
    const deadline: DeadlineLike = {
      remainingMs: () => (fetchCalls === 0 ? 50_000 : 0),
      isExpired: () => fetchCalls > 0,
    };
    const r = (await auditPeriodicDisclosures(
      { ...BASE, companies: ['00000001'] },
      undefined,
      { deadline },
    )) as Record<string, any>;
    const rep = r.deadlines.find((d: any) => d.duty === 'group_status_annual');
    // 갑회사는 실제로 제출했다(ONE_ROW). 예산 때문에 수집을 못 했으면 "확인 못 함"이어야 한다
    expect(rep.not_filed_candidates).toEqual([]);
    expect(rep.not_checked?.map((x: any) => x.corp_code) ?? []).toEqual(['00000001']);
    expect(r.summary.not_filed_candidates).toBe(0);
  });
});

describe('B. audit_periodic_disclosures — 전부 미확인인데 likely_out_of_scope', () => {
  const EXPIRED: DeadlineLike = { remainingMs: () => 0, isExpired: () => true };
  it('★ 반례: 시간 예산 소진으로 한 회사도 조회하지 않았는데 "모집단 전부가 한 건도 내지 않은 기한" 🚨 노트가 붙는다', async () => {
    const collectList = vi.fn(async (): Promise<BatchResult> => {
      throw new Error('도달 불가');
    });
    const deps: PeriodicAuditDeps = { collectList };
    const r = (await auditPeriodicDisclosures(BASE, deps, { deadline: EXPIRED })) as Record<string, any>;
    expect(collectList).not.toHaveBeenCalled();
    const rep = r.deadlines.find((d: any) => d.duty === 'group_status_annual');
    expect(rep.not_checked).toHaveLength(2);
    // 아무것도 확인하지 않았으면 "전부 미제출 → 지정 전일 가능성" 추론은 성립하지 않는다
    expect(rep.likely_out_of_scope).toBeUndefined();
    expect(r.notes.some((n: string) => n.includes('전부가 한 건도 내지 않은'))).toBe(false);
  });
});

describe('C. 송신 대기열 — 취소된 요청이 슬롯을 차지하지 않는가 (확인용)', () => {
  it('줄 서 있던 요청이 abort 되면 뒤 요청의 시작 시각이 밀리지 않는다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      vi.stubEnv('GONGSI_DART_MIN_INTERVAL_MS', '200');
      __resetConfig();
      const OK = JSON.stringify({ status: '000', total_count: 0, total_page: 1, list: [] });
      const starts: number[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          starts.push(Date.now());
          return new Response(OK, { status: 200 });
        }),
      );
      const t0 = Date.now();
      const a = new DartClient('test-key').listPage({ corpCode: '00111111' });
      const ac = new AbortController();
      const b = new DartClient('test-key').listPage({ corpCode: '00111112' }, ac.signal).catch((e: unknown) => e);
      const c = new DartClient('test-key').listPage({ corpCode: '00111113' });
      await vi.advanceTimersByTimeAsync(50);
      ac.abort();
      await vi.advanceTimersByTimeAsync(400);
      await a;
      expect(await b).toMatchObject({ code: 'deadline_exceeded', details: { cancelled: true } });
      await c;
      // b 가 슬롯을 쓰지 않았으므로 c 는 200ms 에 나가야 한다 (400 이면 취소된 요청이 간격을 밀었다)
      expect(starts.map((s) => s - t0)).toEqual([0, 200]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('D. suggestDocSplits 제안 구간 사이의 빈 날짜 (사전 존재, remainingRange 와 결합)', () => {
  it('★ 반례: 미캐시 문서 날짜로만 자르면 구간 사이 날짜가 어느 제안에도 들어가지 않는다 — 그 날짜의 캐시된 원문은 재호출에서 판정되지 않는다', () => {
    const splits = suggestDocSplits(['20260101', '20260120'], '20260101', '20260131', 1);
    // 연속이어야 한다: 앞 구간 끝 + 1일 = 뒤 구간 시작
    expect(splits).toEqual([
      { from: '20260101', to: '20260119' },
      { from: '20260120', to: '20260131' },
    ]);
  });
});

describe('E. 부분 수집에서 찾은 접수분이 기한 뒤면 지연으로 단정하지 않는다 (수정 후 추가)', () => {
  const diag = (failed: number, error?: string) => ({
    measure_calls: 1,
    collect_calls: 1,
    measure_budget_exhausted: false,
    date_chunks: error ? [{ from: '20251001', to: '20260131', count: -1, error }] : [],
    chunks_failed: failed,
    partial_results: failed > 0,
    truncated: false,
    dedup_dropped: 0,
    total_count_reported: 1,
  });
  it('더 이른 원본이 실패한 청크에 있었을 수 있으면 late_candidates 가 아니라 not_checked', async () => {
    const collectList = vi.fn(async (corpCode: string): Promise<BatchResult> => {
      if (corpCode === '00000001') {
        return {
          rows: [
            {
              corp_code: '00000001',
              corp_name: '갑회사',
              rcept_no: '20260610000001',
              rcept_dt: '20260610',
              report_nm: '대규모기업집단현황공시[연1회공시및1/4분기용(개별회사)]',
              corp_cls: 'Y',
              flr_nm: '갑회사',
              rm: '공',
            },
          ],
          diagnostics: diag(1, '청크 수집이 50초를 넘겨 중단했습니다.'),
        } as unknown as BatchResult;
      }
      return { rows: [], diagnostics: diag(0) } as unknown as BatchResult;
    });
    const r = (await auditPeriodicDisclosures(BASE, { collectList })) as Record<string, any>;
    const rep = r.deadlines.find((d: any) => d.duty === 'group_status_annual');
    expect(rep.late_candidates).toEqual([]);
    expect(rep.not_checked.map((x: any) => x.corp_code)).toEqual(['00000001']);
    expect(rep.not_checked[0].reason).toContain('50초');
    expect(rep.not_filed_candidates.map((x: any) => x.corp_code)).toEqual(['00000002']);
  });
});
