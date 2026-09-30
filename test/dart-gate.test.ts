/**
 * OpenDART 송신 제어 — 전역 송신 간격 · 연속 접속 실패 차단기 · 429 Retry-After (외부 검토 2026-09-30 §3-1)
 *
 * 종전에는 요청 사이 간격이 없고 기본 동시성 10 × 3회 시도였다. OpenDART 과호출 차단은 IP 단위라
 * 같은 공인 IP 의 다른 사용자까지 막는다 — 차단 중에는 모든 호출이 연결 리셋이라 재시도가 곧 차단 연장이다.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { DartClient, __resetDartGate } from '../src/clients/dart.js';
import { __resetConfig } from '../src/lib/config.js';
import { useMemoryStore } from './helpers/store.js';

useMemoryStore();

const OK_BODY = JSON.stringify({ status: '000', total_count: 0, total_page: 1, list: [] });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  __resetConfig();
  __resetDartGate();
});

function useEnv(env: Record<string, string>): void {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  __resetConfig();
}

describe('전역 송신 간격', () => {
  it('동시에 걸린 요청도 시작 시각이 간격만큼 벌어진다 — 클라이언트 인스턴스가 달라도', async () => {
    useEnv({ GONGSI_DART_MIN_INTERVAL_MS: '200' });
    const starts: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        starts.push(Date.now());
        return new Response(OK_BODY, { status: 200 });
      }),
    );
    const t0 = Date.now();
    const jobs = [0, 1, 2].map(() => new DartClient('test-key').listPage({ corpCode: '00111111' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(199);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all(jobs);
    expect(starts.map((s) => s - t0)).toEqual([0, 200, 400]);
  });
});

describe('연속 접속 실패 차단기', () => {
  it('★ 접속 실패 4회째에 차단기가 열리고, 쿨다운 동안은 fetch 를 부르지 않는다', async () => {
    useEnv({ GONGSI_DART_MIN_INTERVAL_MS: '0' });
    const f = vi.fn(async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', f);
    const client = new DartClient('test-key');

    // 첫 요청: 3회 시도 모두 실패 (백오프 1초·2초)
    const first = client.listPage({ corpCode: '00111111' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await first).toMatchObject({ code: 'dart_api_error' });
    expect(f).toHaveBeenCalledTimes(3);

    // 둘째 요청: 첫 시도 실패가 연속 4회째 → 재시도 없이 upstream_unavailable
    const second = client.listPage({ corpCode: '00111111' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(await second).toMatchObject({ code: 'upstream_unavailable' });
    expect(f).toHaveBeenCalledTimes(4);

    // 쿨다운 중: 호출을 시작하지 않는다
    await expect(client.listPage({ corpCode: '00111111' })).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(f).toHaveBeenCalledTimes(4);

    // 60초 뒤: 다시 시도한다
    await vi.advanceTimersByTimeAsync(60_000);
    f.mockImplementation(async () => new Response(OK_BODY, { status: 200 }));
    await expect(client.listPage({ corpCode: '00111111' })).resolves.toBeDefined();
    expect(f).toHaveBeenCalledTimes(5);
  });

  it('응답을 받으면(상태코드 무관) 연속 실패 카운트가 초기화된다', async () => {
    useEnv({ GONGSI_DART_MIN_INTERVAL_MS: '0' });
    let n = 0;
    const f = vi.fn(async () => {
      n++;
      // 실패 2 → 성공 1 → 실패 2 : 연속 4회가 되지 않는다
      if (n === 3) return new Response(OK_BODY, { status: 200 });
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', f);
    const client = new DartClient('test-key');
    const a = client.listPage({ corpCode: '00111111' });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(a).resolves.toBeDefined();
    const b = client.listPage({ corpCode: '00111111' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(3_000);
    // 3회 시도 중 2회 실패 후 3회째도 실패 → dart_api_error (차단기가 아니라)
    expect(await b).toMatchObject({ code: 'dart_api_error' });
  });
});

describe('429 Retry-After', () => {
  it('Retry-After 가 백오프보다 길면 그만큼 기다린 뒤 재시도한다', async () => {
    useEnv({ GONGSI_DART_MIN_INTERVAL_MS: '0' });
    let n = 0;
    const f = vi.fn(async () => {
      n++;
      if (n === 1) return new Response('', { status: 429, headers: { 'Retry-After': '3' } });
      return new Response(OK_BODY, { status: 200 });
    });
    vi.stubGlobal('fetch', f);
    const p = new DartClient('test-key').listPage({ corpCode: '00111111' });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(f).toHaveBeenCalledTimes(1); // 백오프 1초가 아니라 Retry-After 3초
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBeDefined();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('Retry-After 가 상한(10초)을 넘으면 기다리지 않고 실패로 알린다', async () => {
    useEnv({ GONGSI_DART_MIN_INTERVAL_MS: '0' });
    const f = vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } }));
    vi.stubGlobal('fetch', f);
    await expect(new DartClient('test-key').listPage({ corpCode: '00111111' })).rejects.toMatchObject({
      code: 'dart_api_error',
      details: { retry_after_ms: 120_000 },
    });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

// ── Codex astra 교차검토(2026-09-30)가 첫 구현에서 재현한 반례 ──
describe('교차검토 반례 — 송신 간격과 차단기를 함께 켠 동시 실행', () => {
  it('★ 슬롯을 기다리던 요청은 차단기가 열린 뒤 fetch 를 시작하지 않는다 (8건 동시 · 간격 50ms · 임계 4)', async () => {
    useEnv({ GONGSI_DART_MIN_INTERVAL_MS: '50' });
    const f = vi.fn(async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', f);
    const jobs = Array.from({ length: 8 }, () =>
      new DartClient('test-key').listPage({ corpCode: '00111111' }).catch((e: unknown) => e),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const results = await Promise.all(jobs);
    expect(f).toHaveBeenCalledTimes(4); // 4번째 실패에서 열린 뒤로는 송신 0
    expect(results.filter((r) => (r as { code?: string }).code === 'upstream_unavailable').length).toBeGreaterThanOrEqual(4);
  });

  it('★ 시간초과(예산 만료·느린 망)는 차단기에 세지 않는다 — 정상 예산 만료가 프로세스 전체를 막지 않는다', async () => {
    useEnv({ GONGSI_DART_MIN_INTERVAL_MS: '0' });
    let n = 0;
    const f = vi.fn(async (): Promise<Response> => {
      n++;
      if (n <= 6) throw new DOMException('signal timed out', 'TimeoutError');
      return new Response(OK_BODY, { status: 200 });
    });
    vi.stubGlobal('fetch', f);
    for (let i = 0; i < 2; i++) {
      const p = new DartClient('test-key').listPage({ corpCode: '00111111' }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await p).toMatchObject({ code: 'dart_api_error' });
    }
    await expect(new DartClient('test-key').listPage({ corpCode: '00111111' })).resolves.toBeDefined();
    expect(f).toHaveBeenCalledTimes(7);
  });

  it('★ 429 Retry-After 는 다른 요청에도 적용된다 — 긴 대기면 다른 요청도 송신하지 않고 실패', async () => {
    useEnv({ GONGSI_DART_MIN_INTERVAL_MS: '0' });
    const f = vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } }));
    vi.stubGlobal('fetch', f);
    await expect(new DartClient('test-key').listPage({ corpCode: '00111111' })).rejects.toMatchObject({
      code: 'dart_api_error',
    });
    await expect(new DartClient('test-key').listPage({ corpCode: '00222222' })).rejects.toMatchObject({
      code: 'dart_api_error',
      details: { status: 429 },
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('429 Retry-After 3초 동안 다른 요청도 기다린다', async () => {
    useEnv({ GONGSI_DART_MIN_INTERVAL_MS: '0' });
    let n = 0;
    const starts: number[] = [];
    const f = vi.fn(async () => {
      n++;
      starts.push(Date.now());
      if (n === 1) return new Response('', { status: 429, headers: { 'Retry-After': '3' } });
      return new Response(OK_BODY, { status: 200 });
    });
    vi.stubGlobal('fetch', f);
    const t0 = Date.now();
    const a = new DartClient('test-key').listPage({ corpCode: '00111111' });
    await vi.advanceTimersByTimeAsync(0);
    const b = new DartClient('test-key').listPage({ corpCode: '00222222' });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([a, b]);
    expect(starts.slice(1).every((s) => s - t0 >= 3_000)).toBe(true);
  });
});

describe('교차검토 반례 — 이벤트 루프가 밀려도 몰려 나가지 않는다 (실제 타이머)', () => {
  it('★ 5건 예약 후 300ms 동안 루프를 막아도 실제 시작 간격이 간격값을 지킨다', async () => {
    vi.useRealTimers();
    useEnv({ GONGSI_DART_MIN_INTERVAL_MS: '50' });
    const starts: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        starts.push(performance.now());
        return new Response(OK_BODY, { status: 200 });
      }),
    );
    const jobs = Array.from({ length: 5 }, () => new DartClient('test-key').listPage({ corpCode: '00111111' }));
    const until = performance.now() + 300;
    while (performance.now() < until) {
      // 이벤트 루프 정체 재현 (동기 바쁜 대기)
    }
    await Promise.all(jobs);
    const gaps = starts.slice(1).map((s, i) => s - starts[i]!);
    // 타이머 해상도 여유 5ms
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(45);
  });
});

describe('기본값', () => {
  it('기본 동시성 4 · 송신 간격 200ms · 차단 임계 4회 · 쿨다운 60초', async () => {
    vi.stubEnv('GONGSI_CONCURRENCY', '');
    vi.stubEnv('GONGSI_DART_MIN_INTERVAL_MS', '');
    __resetConfig();
    const { getConfig } = await import('../src/lib/config.js');
    const cfg = getConfig();
    expect(cfg.concurrency).toBe(4);
    expect(cfg.dartMinIntervalMs).toBe(200);
    expect(cfg.dartBreakerThreshold).toBe(4);
    expect(cfg.dartBreakerCooldownMs).toBe(60_000);
  });
});
