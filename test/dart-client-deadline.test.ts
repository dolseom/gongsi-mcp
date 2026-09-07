/**
 * DartClient — 시간 예산이 붙은 요청 (작업 4 요구사항 B)
 *
 * 종전에는 단일 요청이 타임아웃 100초 × 재시도 3회 + 백오프 7초 = 최악 307초라, 한 번의 상류
 * 지연만으로 MCP 60초 벽을 그대로 넘겼다(Codex ③). 예산을 준 호출만 좁힌다 —
 * **예산을 주지 않는 도구(audit·search 등)의 동작은 그대로여야 한다.**
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DartClient } from '../src/clients/dart.js';
import { Deadline } from '../src/lib/deadline.js';
import { Store, __setStore } from '../src/lib/store.js';

let store: Store;
beforeEach(() => {
  store = new Store(':memory:');
  __setStore(store);
});
afterEach(() => {
  store.close();
  __setStore(null);
  vi.unstubAllGlobals();
});

/** 손으로 굴리는 시계 */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_700_000_000_000;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

describe('시간 예산이 붙은 DART 요청', () => {
  it('★ 남은 예산이 한 번의 요청도 감당하지 못하면 **호출을 시작하지 않는다**', async () => {
    const c = clock();
    const d = new Deadline(5_000, c.now);
    const f = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', f);

    const client = new DartClient('test-key', { deadline: d });
    c.advance(4_500); // 남은 500ms < 최소 시도 시간 1초

    await expect(client.listPage({ corpCode: '00111111' })).rejects.toMatchObject({
      code: 'deadline_exceeded',
    });
    expect(f).not.toHaveBeenCalled(); // 실패가 확정된 호출에 예산을 쓰지 않는다
  });

  it('요청 타임아웃이 **남은 예산**으로 좁혀진다 — 100초 설정값을 그대로 쓰지 않는다', async () => {
    const c = clock();
    // 남은 1.2초. 좁히지 않으면 이 테스트는 설정값 100초를 기다린다.
    const d = new Deadline(1_200, c.now);
    // 신호가 끊길 때까지 응답하지 않는 상류 (연결은 됐는데 본문이 안 오는 상황)
    const f = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('TimeoutError')));
        }),
    );
    vi.stubGlobal('fetch', f);

    const client = new DartClient('test-key', { deadline: d });
    const started = Date.now();
    await expect(client.listPage({ corpCode: '00111111' })).rejects.toMatchObject({
      code: 'deadline_exceeded',
    });
    // 100초가 아니라 남은 예산 안에서 끊겼다 (여유 있게 10초로 확인)
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(f).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('백오프 + 다음 시도 시간이 남지 않으면 재시도하지 않는다 (sleep 으로 예산을 태우지 않는다)', async () => {
    const c = clock();
    const d = new Deadline(1_500, c.now); // 백오프 1초 + 최소 시도 1초 = 2초를 감당 못 한다
    const f = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    vi.stubGlobal('fetch', f);

    const client = new DartClient('test-key', { deadline: d });
    const started = Date.now();
    await expect(client.listPage({ corpCode: '00111111' })).rejects.toMatchObject({
      code: 'deadline_exceeded',
    });
    expect(f).toHaveBeenCalledTimes(1); // 3회가 아니라 1회에서 멈춘다
    expect(Date.now() - started).toBeLessThan(1_000); // 백오프를 기다리지 않았다
  });

  it('예산을 주지 않으면 종전 동작 그대로다 — 다른 도구의 타임아웃·재시도를 바꾸지 않는다', async () => {
    const f = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: '000', total_count: 0, total_page: 1, list: [] }), {
          status: 200,
        }),
    );
    vi.stubGlobal('fetch', f);

    const client = new DartClient('test-key'); // deadline 없음
    const page = await client.listPage({ corpCode: '00111111' });
    expect(page.status).toBe('000');
    expect(f).toHaveBeenCalledTimes(1);
  });
});
