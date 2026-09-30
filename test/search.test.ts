/**
 * 적응형 분할 전수 수집 테스트
 *
 * docs/absorbed-from-dart-mcp.md §7 회귀 체크리스트를 고정한다:
 * - 적응형 분할이 구간 누락·중복 없이 전 범위를 덮는다
 * - per-task 실패 시 나머지 결과 보존 + partial_results=true
 * - dedup 키는 rcept_no 단일 — 정당한 다중 제출이 잘리지 않는다
 * - 측정 예산 소진 시 균등 fallback
 * - 60초 벽 사전 예측 → range_too_large + suggested_splits
 */

import { describe, expect, it } from 'vitest';
import {
  collectAdaptive,
  estimateSeconds,
  suggestSplits,
  type SearchClient,
} from '../src/search/batch.js';
import { PRESETS } from '../src/search/presets.js';
import { ToolError } from '../src/lib/errors.js';
import type { CollectResult, Disclosure, ListParams } from '../src/clients/dart.js';

// ── 가짜 데이터셋: 날짜별 건수를 지정해 밀도 편중을 재현한다 ──────

function ymdToMs(ymd: string): number {
  return Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
}

function* eachDay(from: string, to: string): Generator<string> {
  for (let ms = ymdToMs(from); ms <= ymdToMs(to); ms += 86_400_000) {
    yield new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
  }
}

function makeRows(from: string, to: string, perDay: (ymd: string) => number): Disclosure[] {
  const rows: Disclosure[] = [];
  for (const day of eachDay(from, to)) {
    const n = perDay(day);
    for (let i = 0; i < n; i++) {
      rows.push({
        corp_code: '00000001',
        corp_name: '테스트',
        corp_cls: 'E',
        report_nm: '대규모내부거래(자금차입)',
        rcept_no: `${day}${String(i).padStart(6, '0')}`,
        flr_nm: '테스트',
        rcept_dt: day,
        rm: '공',
      });
    }
  }
  return rows;
}

class FakeClient implements SearchClient {
  measureCalls = 0;
  collectCalls: Array<{ from: string; to: string }> = [];
  failCollectFor: Set<string> = new Set();
  failMeasureFor: Set<string> = new Set();

  constructor(readonly rows: Disclosure[]) {}

  private inRange(from: string, to: string): Disclosure[] {
    return this.rows.filter((r) => r.rcept_dt >= from && r.rcept_dt <= to);
  }

  async measure(p: ListParams): Promise<number> {
    this.measureCalls++;
    const key = `${p.bgnDe}-${p.endDe}`;
    if (this.failMeasureFor.has(key)) throw new Error('네트워크 오류');
    return this.inRange(p.bgnDe!, p.endDe!).length;
  }

  async collect(p: ListParams): Promise<CollectResult> {
    const key = `${p.bgnDe}-${p.endDe}`;
    this.collectCalls.push({ from: p.bgnDe!, to: p.endDe! });
    if (this.failCollectFor.has(key)) throw new Error('청크 실패');
    const rows = this.inRange(p.bgnDe!, p.endDe!);
    return {
      rows,
      truncated: false,
      totalPage: Math.max(1, Math.ceil(rows.length / 100)),
      totalCount: rows.length,
      calls: Math.max(1, Math.ceil(rows.length / 100)),
    };
  }
}

const OPTS = { threshold: 100, minDays: 3, fallbackDays: 30, concurrency: 4, measureBudget: 200 };
const BASE: ListParams = { corpCode: '00000001' };

describe('적응형 분할 수집', () => {
  it('시즌 편중이 있어도 전 범위를 누락·중복 없이 덮는다', async () => {
    // 2월에 하루 40건(시즌), 평시 2건
    const rows = makeRows('20260101', '20260331', (d) => (d.startsWith('202602') ? 40 : 2));
    const client = new FakeClient(rows);
    const r = await collectAdaptive(client, BASE, '20260101', '20260331', OPTS);

    expect(r.rows.length).toBe(rows.length); // 전량 회수
    expect(r.diagnostics.partial_results).toBe(false);
    expect(r.diagnostics.dedup_dropped).toBe(0);

    // 청크가 경계 틈·겹침 없이 이어진다
    const chunks = r.diagnostics.date_chunks;
    expect(chunks[0]!.from).toBe('20260101');
    expect(chunks[chunks.length - 1]!.to).toBe('20260331');
    for (let i = 1; i < chunks.length; i++) {
      const prevEnd = ymdToMs(chunks[i - 1]!.to);
      expect(ymdToMs(chunks[i]!.from)).toBe(prevEnd + 86_400_000);
    }

    // 시즌 구간(2월)은 평시보다 잘게 쪼개진다
    const febChunks = chunks.filter((c) => c.from.startsWith('202602'));
    expect(febChunks.length).toBeGreaterThan(1);
  });

  it('청크 하나가 실패해도 나머지 결과는 보존되고 partial_results=true', async () => {
    const rows = makeRows('20260101', '20260228', (d) => (d.startsWith('202602') ? 40 : 2));
    const client = new FakeClient(rows);

    // 계획을 한 번 돌려 실제 청크 경계를 얻은 뒤, 그중 하나를 실패시킨다
    const dry = await collectAdaptive(client, BASE, '20260101', '20260228', OPTS);
    const target = dry.diagnostics.date_chunks.find((c) => (c.count ?? 0) > 0)!;
    client.failCollectFor.add(`${target.from}-${target.to}`);

    const r = await collectAdaptive(client, BASE, '20260101', '20260228', OPTS);
    expect(r.diagnostics.partial_results).toBe(true);
    expect(r.diagnostics.chunks_failed).toBe(1);
    const failedChunk = r.diagnostics.date_chunks.find((c) => c.error);
    expect(failedChunk).toBeDefined();
    // 실패 청크 밖의 행은 전부 살아 있다
    const expected = rows.filter(
      (row) => row.rcept_dt < target.from || row.rcept_dt > target.to,
    ).length;
    expect(r.rows.length).toBe(expected);
  });

  it('산술 파생 0 청크도 수집한다 — 측정 불일치가 조용한 미수집이 되지 않는다 (P2-가 2)', async () => {
    // 왼쪽 측정이 부풀려지면(측정 시점 차이 재현) 오른쪽 파생 건수가 0 이 된다.
    // 종전에는 그 구간을 collect 없이 건너뛰어 실제 180건이 partial_results:false 로 사라졌다.
    const rows = makeRows('20260101', '20260112', () => 30); // 360건
    class LyingClient extends FakeClient {
      override async measure(p: ListParams): Promise<number> {
        if (`${p.bgnDe}-${p.endDe}` === '20260101-20260106') {
          this.measureCalls++;
          return 360; // 실제 180 — 과대 신고로 오른쪽 파생 건수를 0 으로 만든다
        }
        return super.measure(p);
      }
    }
    const client = new LyingClient(rows);
    const r = await collectAdaptive(client, BASE, '20260101', '20260112', OPTS);
    expect(r.rows.length).toBe(360); // 오른쪽 절반(20260107~)의 180건이 살아 있어야 한다
    expect(r.diagnostics.partial_results).toBe(false);
  });

  it('부모가 양수인데 왼쪽 실측이 0 이면 그 실측도 신뢰하지 않고 수집한다 (Codex 7차 치명 2)', async () => {
    // 반대 방향 측정 불일치: 왼쪽 측정이 과소(0)로 오면 오른쪽 파생값이 부모 전체가 되고,
    // 왼쪽은 "실측 0"이라는 이유로 건너뛰어 실제 180건이 조용히 사라지던 경로
    const rows = makeRows('20260101', '20260112', () => 30); // 360건
    class UnderClient extends FakeClient {
      override async measure(p: ListParams): Promise<number> {
        if (`${p.bgnDe}-${p.endDe}` === '20260101-20260106') {
          this.measureCalls++;
          return 0; // 실제 180 — 과소 신고. 부모(360)와 모순되는 실측 0 은 신뢰하면 안 된다
        }
        return super.measure(p);
      }
    }
    const client = new UnderClient(rows);
    const r = await collectAdaptive(client, BASE, '20260101', '20260112', OPTS);
    expect(r.rows.length).toBe(360);
    expect(r.diagnostics.partial_results).toBe(false);
  });

  it('모순 신호 없는 독립 실측 0 창은 여전히 수집을 생략한다 (호출 절약 유지)', async () => {
    // ⚠️ 이 생략은 "종료된 과거 구간" 전제에서만 안전하다 (Opus 7차 미확인 의심 1) —
    // 오늘을 포함한 구간은 측정~수집 사이에 새 접수가 들어올 수 있는 미세한 창이 남는다.
    // rcept_dt 소급 불변(과거 날짜에 새 건이 생기지 않음)이 이 전제의 근거다.
    // corp_code 없는 전체시장 검색은 90일 창으로 나뉜다 — 데이터가 없는 창은 창 단위 실측 0
    const rows = makeRows('20260110', '20260220', () => 3); // 첫 창(1~3월)에만 데이터
    const client = new FakeClient(rows);
    const r = await collectAdaptive(client, {}, '20260101', '20260731', OPTS);
    expect(r.rows.length).toBe(rows.length);
    expect(r.diagnostics.partial_results).toBe(false);
    // 실측 0 창(4월 이후)에는 collect 가 한 번도 가지 않아야 한다
    const zeroSkipped = r.diagnostics.date_chunks.filter((c) => c.count === 0 && c.pages === 0 && !c.derived);
    expect(zeroSkipped.length).toBeGreaterThan(0); // 스킵된 청크가 실제로 존재해야 이 테스트가 의미 있다
    for (const c of zeroSkipped) {
      expect(client.collectCalls.some((cc) => cc.from === c.from && cc.to === c.to)).toBe(false);
    }
  });

  it('창 측정 실패를 diagnostics 로 표면화한다 — total 은 하한임을 알린다 (P2-가 3)', async () => {
    const rows = makeRows('20260101', '20260112', () => 5);
    const client = new FakeClient(rows);
    client.failMeasureFor.add('20260101-20260112'); // 창 측정만 실패, 분할 측정은 성공
    const r = await collectAdaptive(client, BASE, '20260101', '20260112', OPTS);
    expect(r.rows.length).toBe(60); // 수집 자체는 전량 성공
    expect(r.diagnostics.measure_failures).toBeGreaterThanOrEqual(1);
    expect(r.diagnostics.total_count_incomplete).toBe(true);
    // 과소 신고된 total 을 진짜 전체 건수로 읽으면 안 된다는 것이 이 필드의 존재 이유
    expect(r.diagnostics.total_count_reported).toBeLessThan(60);
  });

  it('dedup 은 rcept_no 단일 키 — 같은 회사·같은 날 다중 제출이 잘리지 않는다', async () => {
    // 같은 날 같은 보고서명 5건 (rcept_no 만 다름) — 행복나래 실증 사례의 재현
    const rows = makeRows('20260701', '20260701', () => 5);
    const client = new FakeClient(rows);
    const r = await collectAdaptive(client, BASE, '20260701', '20260703', OPTS);
    expect(r.rows.length).toBe(5);
    expect(r.diagnostics.dedup_dropped).toBe(0);
  });

  it('측정 예산 소진 시 남은 구간은 균등 fallback 으로 쪼갠다 (원청크 유지 금지)', async () => {
    const rows = makeRows('20260101', '20260630', () => 10); // 181일 × 10건 = 1,810건
    const client = new FakeClient(rows);
    const r = await collectAdaptive(client, BASE, '20260101', '20260630', {
      ...OPTS,
      threshold: 200,
      measureBudget: 2, // 전체 측정 1회 + 분할 측정 1회면 소진
      fallbackDays: 30,
    });
    expect(r.diagnostics.measure_budget_exhausted).toBe(true);
    // fallback 청크는 30일을 넘지 않는다
    for (const c of r.diagnostics.date_chunks) {
      const days = (ymdToMs(c.to) - ymdToMs(c.from)) / 86_400_000 + 1;
      expect(days).toBeLessThanOrEqual(31);
    }
    expect(r.rows.length).toBe(rows.length); // fallback 이어도 전량 회수
  });

  it('측정 실패한 구간은 더 쪼개지 않고 원청크로 수집한다', async () => {
    const rows = makeRows('20260101', '20260228', () => 10);
    const client = new FakeClient(rows);
    // 첫 분할 측정(전반부)을 실패시킨다
    client.failMeasureFor.add('20260101-20260129');
    const r = await collectAdaptive(client, BASE, '20260101', '20260228', {
      ...OPTS,
      threshold: 200,
    });
    expect(r.rows.length).toBe(rows.length);
    // 실패한 왼쪽 절반이 원청크 그대로 수집됐다
    expect(r.diagnostics.date_chunks.some((c) => c.from === '20260101' && c.to === '20260228')).toBe(
      true,
    );
  });

  it('건수 0 청크는 collect 를 호출하지 않는다', async () => {
    const client = new FakeClient([]);
    const r = await collectAdaptive(client, BASE, '20260101', '20260131', OPTS);
    expect(r.rows).toEqual([]);
    expect(client.collectCalls.length).toBe(0);
    expect(r.diagnostics.total_count_reported).toBe(0);
  });

  it('60초 초과 예상이면 range_too_large 와 전 범위를 덮는 suggested_splits 를 던진다', async () => {
    const rows = makeRows('20260101', '20261231', () => 100); // 1년 × 100건 = 36,500건
    const client = new FakeClient(rows);
    let caught: ToolError | undefined;
    try {
      await collectAdaptive(client, BASE, '20260101', '20261231', {
        ...OPTS,
        threshold: 1000,
        concurrency: 10,
      });
    } catch (err) {
      caught = err as ToolError;
    }
    expect(caught).toBeInstanceOf(ToolError);
    expect(caught!.code).toBe('range_too_large');
    expect(client.collectCalls.length).toBe(0); // 수집 없이 즉시 반환

    const splits = caught!.details!['suggestedSplits'] as Array<{ from: string; to: string }>;
    expect(splits.length).toBeGreaterThan(1);
    expect(splits[0]!.from).toBe('20260101');
    expect(splits[splits.length - 1]!.to).toBe('20261231');
    for (let i = 1; i < splits.length; i++) {
      expect(ymdToMs(splits[i]!.from)).toBe(ymdToMs(splits[i - 1]!.to) + 86_400_000);
    }
    // 제안된 각 구간은 예상 시간 안에 들어온다 (균등 밀도 가정 하에서)
    for (const s of splits) {
      const days = (ymdToMs(s.to) - ymdToMs(s.from)) / 86_400_000 + 1;
      expect(estimateSeconds(days * 100, 10, 1000)).toBeLessThanOrEqual(45 + 20); // 마지막 잔여 구간 여유
    }
  });

  it('corp_code 없는 전체시장 검색은 건수가 적어도 청크를 90일 이하로 쪼갠다', async () => {
    const rows = makeRows('20250101', '20261231', (d) => (d.endsWith('15') ? 1 : 0)); // 월 1건
    const client = new FakeClient(rows);
    const r = await collectAdaptive(client, {}, '20250101', '20261231', OPTS);
    expect(r.rows.length).toBe(rows.length);
    for (const c of r.diagnostics.date_chunks) {
      const days = (ymdToMs(c.to) - ymdToMs(c.from)) / 86_400_000 + 1;
      expect(days).toBeLessThanOrEqual(90);
    }
  });
});

describe('분할 제안', () => {
  it('suggestSplits 는 항상 전 범위를 연속으로 덮는다', () => {
    const splits = suggestSplits('20260101', '20261231', 36_500, 10, 1000, 45);
    expect(splits[0]!.from).toBe('20260101');
    expect(splits[splits.length - 1]!.to).toBe('20261231');
    for (let i = 1; i < splits.length; i++) {
      expect(ymdToMs(splits[i]!.from)).toBe(ymdToMs(splits[i - 1]!.to) + 86_400_000);
    }
  });

  it('estimateSeconds 는 건수에 단조 증가한다', () => {
    let prev = 0;
    for (const rows of [100, 1000, 5000, 20000, 50000]) {
      const est = estimateSeconds(rows, 10, 1000);
      expect(est).toBeGreaterThanOrEqual(prev);
      prev = est;
    }
  });
});

describe('프리셋', () => {
  it('공정위 프리셋 코드 매핑이 실측 J코드와 일치한다', () => {
    expect(PRESETS.ftc_all.pblntfTy).toBe('J');
    expect(PRESETS.internal_transaction.pblntfDetailTy).toBe('J001');
    expect(PRESETS.group_status.pblntfDetailTy).toBe('J004');
    expect(PRESETS.unlisted_material.pblntfDetailTy).toBe('J005');
    expect(PRESETS.public_interest_corp.pblntfDetailTy).toBe('J008');
    expect(PRESETS.subcontract.pblntfDetailTy).toBe('J009');
  });
});
