/**
 * 요청 맥락으로 취소 신호·시간 예산 전달 (2026-10-18)
 *
 * 종전: 감사 도구는 50초 Deadline 을 만들어 두고도 모집단 조회(getGroupStructure → EgroupClient)에
 * 넘기지 않아, 포털이 느리면 100초 타임아웃까지 붙잡혀 60초 벽에 걸렸다. wrap 은 MCP 취소 신호를
 * detect 에만 넘겨, 취소된 감사가 계속 돌며 송신 대기열·일일 한도를 썼다.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { DartClient, __resetDartGate } from '../src/clients/dart.js';
import { EgroupClient } from '../src/clients/egroup.js';
import { __resetConfig } from '../src/lib/config.js';
import { Deadline } from '../src/lib/deadline.js';
import { currentRequestContext, runWithRequestContext, withContextSignal } from '../src/lib/request-context.js';
import { auditGroupDisclosures } from '../src/tools/audit-group-disclosures.js';
import { useMemoryStore } from './helpers/store.js';

useMemoryStore();
beforeEach(() => {
  vi.stubEnv('DART_API_KEY', 'test-key');
  vi.stubEnv('EGROUP_API_KEY', 'test-egroup-key');
  __resetConfig();
  __resetDartGate();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  __resetConfig();
});

/** 손으로 굴리는 시계 — 남은 예산을 정확히 만든다 */
const deadlineWithRemaining = (ms: number) => {
  let t = 1_700_000_000_000;
  const d = new Deadline(10_000, () => t);
  t += 10_000 - ms;
  return d;
};

describe('runWithRequestContext', () => {
  it('안쪽 run 은 바깥 맥락을 이어받고 준 키만 덮어쓴다', async () => {
    const ac = new AbortController();
    const d = deadlineWithRemaining(5_000);
    await runWithRequestContext({ signal: ac.signal }, async () => {
      await runWithRequestContext({ deadline: d }, async () => {
        await Promise.resolve();
        expect(currentRequestContext()).toEqual({ signal: ac.signal, deadline: d });
      });
      expect(currentRequestContext()?.deadline).toBeUndefined();
    });
    expect(currentRequestContext()).toBeUndefined();
  });

  it('withContextSignal: 명시·맥락 신호 중 하나만 끊겨도 끊긴다', () => {
    const explicit = new AbortController();
    const ctx = new AbortController();
    runWithRequestContext({ signal: ctx.signal }, () => {
      const s = withContextSignal(explicit.signal)!;
      expect(s.aborted).toBe(false);
      ctx.abort();
      expect(s.aborted).toBe(true);
      expect(withContextSignal(ctx.signal)).toBe(ctx.signal); // 같은 신호는 감싸지 않는다
    });
    expect(withContextSignal(undefined)).toBeUndefined();
  });
});

describe('DartClient — 명시 예산이 없으면 맥락 예산·신호를 따른다', () => {
  it('맥락 예산이 1초 미만이면 호출을 시작하지 않는다', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', f);
    const client = new DartClient(); // 맥락 밖에서 만든 인스턴스도 요청 시점에 맥락을 읽는다
    await expect(
      runWithRequestContext({ deadline: deadlineWithRemaining(500) }, () => client.listPage({ corpCode: '00111111' })),
    ).rejects.toMatchObject({ code: 'deadline_exceeded' });
    expect(f).not.toHaveBeenCalled();
  });

  it('맥락 신호가 끊겨 있으면 시작하지 않는다', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', f);
    const ac = new AbortController();
    ac.abort();
    await expect(
      runWithRequestContext({ signal: ac.signal }, () => new DartClient().listPage({ corpCode: '00111111' })),
    ).rejects.toMatchObject({ code: 'deadline_exceeded', details: { cancelled: true } });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('EgroupClient — 맥락 예산·신호', () => {
  it('예산이 1초 미만이면 포털 요청을 시작하지 않는다', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await expect(
      runWithRequestContext({ deadline: deadlineWithRemaining(400) }, () => new EgroupClient().groups('202605')),
    ).rejects.toMatchObject({ code: 'deadline_exceeded' });
    expect(f).not.toHaveBeenCalled();
  });

  it('타임아웃을 남은 예산으로 좁히고, 그 만료를 "네트워크 오류"가 아니라 deadline_exceeded 로 적는다', async () => {
    const timeouts: number[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      timeouts.push(ms);
      const ac = new AbortController();
      ac.abort(new DOMException('signal timed out', 'TimeoutError'));
      return ac.signal;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('signal timed out', 'TimeoutError');
      }),
    );
    const err = (await runWithRequestContext({ deadline: deadlineWithRemaining(3_000) }, () =>
      new EgroupClient().groups('202605'),
    ).catch((e) => e)) as { code: string; message: string };
    expect(timeouts[0]).toBe(3_000); // 설정값 100초가 아니라 남은 예산
    expect(err.code).toBe('deadline_exceeded');
    expect(err.message).toContain('키 문제가 아닙니다');
  });

  it('취소되면 request_cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    vi.stubGlobal('fetch', vi.fn());
    await expect(
      runWithRequestContext({ signal: ac.signal }, () => new EgroupClient().groups('202605')),
    ).rejects.toMatchObject({ code: 'request_cancelled' });
  });

  it('맥락이 없으면 종전대로 설정 타임아웃(100초)', async () => {
    const timeouts: number[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      timeouts.push(ms);
      return new AbortController().signal;
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    await expect(new EgroupClient().groups('202605')).rejects.toMatchObject({ code: 'egroup_api_error' });
    expect(timeouts[0]).toBe(100_000);
  });
});

describe('audit_group_disclosures — 모집단 조회도 감사 예산 안에서', () => {
  it('예산이 거의 없으면 포털을 부르지 않고 deadline_exceeded (종전: 100초 타임아웃까지 붙잡힘)', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await expect(
      auditGroupDisclosures({ group: '삼성' } as never, undefined, { deadline: deadlineWithRemaining(500) }),
    ).rejects.toMatchObject({ code: 'deadline_exceeded' });
    expect(f).not.toHaveBeenCalled();
  });
});
