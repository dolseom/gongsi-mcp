/**
 * 요청 맥락 — 취소 신호와 시간 예산을 **인자로 넘기지 않아도** 상류 클라이언트까지 닿게 한다.
 *
 * ★ 왜 필요한가: 예산과 신호를 인자로만 넘기면 중간 계층 하나가 빠뜨릴 때 조용히 끊긴다.
 *   실제로 감사 도구는 50초 Deadline 을 만들어 두고도 모집단 조회(getGroupStructure →
 *   EgroupClient)에는 넘기지 않아, 포털이 느리면 100초 타임아웃까지 붙잡혀 60초 벽에 걸렸다.
 *   wrap 은 MCP 취소 신호를 detect 에만 넘겨, 사용자가 취소한 감사가 서버에서 계속 돌며
 *   송신 대기열과 일일 한도를 썼다. (korean-law-mcp session-state 대조에서 발견, 2026-10-18)
 *
 * 규칙:
 * - 클라이언트는 **명시 인자가 우선**이고, 없을 때만 맥락을 본다.
 * - 맥락은 **요청 시점**에 읽는다 — 생성 시점에 붙잡으면 재사용 인스턴스가 지난 요청의 예산을 쓴다.
 * - 안쪽 run 은 바깥 맥락을 이어받고, 준 키만 덮어쓴다.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DeadlineLike } from './deadline.js';

export interface RequestContext {
  /** MCP 클라이언트 취소 신호 */
  signal?: AbortSignal;
  /** 도구의 시간 예산 (60초 벽 대비) */
  deadline?: DeadlineLike;
}

const als = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  const parent = als.getStore();
  const merged: RequestContext = { ...parent };
  if (ctx.signal) merged.signal = ctx.signal;
  if (ctx.deadline) merged.deadline = ctx.deadline;
  return als.run(merged, fn);
}

export function currentRequestContext(): RequestContext | undefined {
  return als.getStore();
}

/** 명시 신호와 맥락 신호를 합친다 — 둘 중 하나만 끊겨도 끊긴다 */
export function withContextSignal(explicit?: AbortSignal): AbortSignal | undefined {
  const ctx = als.getStore()?.signal;
  if (!ctx || ctx === explicit) return explicit;
  if (!explicit) return ctx;
  return AbortSignal.any([explicit, ctx]);
}
