/**
 * 시간 예산 — MCP 클라이언트의 60초 벽(함정 7) 안에서 **반드시 무언가를 돌려주기** 위한 장치
 *
 * MCP 클라이언트는 약 60초에 호출을 끊는다. 서버 내부 타임아웃을 늘려도 소용없고, 끊기면
 * 사용자는 결과를 **하나도** 받지 못한다. 그래서 도구가 스스로 남은 시간을 보며 멈추고,
 * 그때까지 만든 판정을 부분 결과로 돌려준다.
 *
 * ★ **진행 중인 것을 죽이지 않는다 — 다음 것을 시작하지 않을 뿐이다.** 이미 받은 응답을
 *   버리면 예산만 쓰고 결과가 없다. 유일한 예외는 HTTP 요청 자체의 타임아웃이다
 *   (`DartClient.request` 가 남은 예산으로 `AbortSignal.timeout` 을 좁힌다): 예산이 끝난 뒤
 *   돌아오는 응답은 어차피 이 실행의 결과에 실리지 못하므로 abort 하는 편이 낫다.
 *
 * ★ 건수 예산(`MAX_*`)과는 **독립**이다. 건수 예산은 "몇 건까지 볼 것인가", 이것은 "언제까지
 *   볼 것인가"라서 서로를 대체하지 못한다 — 한 번의 상류 지연은 건수를 늘리지 않고도 벽을 넘는다.
 */

/** 상류 호출부(DartClient)가 보는 최소 인터페이스 — 클래스 전체를 알 필요가 없다 */
export interface DeadlineLike {
  /** 남은 시간 (ms). 이미 지났으면 0 */
  remainingMs(): number;
  isExpired(): boolean;
}

/**
 * 시간 예산 + 단계별 계측.
 *
 * `now` 를 주입받는 이유는 **테스트를 실제 sleep 없이** 돌리기 위해서다 — 시간에 의존하는
 * 테스트를 진짜로 기다리게 만들면 CI 가 느려지고 간헐 실패가 생긴다.
 */
export class Deadline implements DeadlineLike {
  readonly budgetMs: number;
  private readonly now: () => number;
  private readonly startedAt: number;
  /** 단계 이름 → 누적 소요 (ms) */
  private readonly stageMs = new Map<string, number>();
  private open: { name: string; at: number } | null = null;
  private stopped: string | null = null;

  constructor(budgetMs: number, now: () => number = Date.now) {
    this.budgetMs = budgetMs;
    this.now = now;
    this.startedAt = now();
  }

  elapsedMs(): number {
    return Math.max(0, this.now() - this.startedAt);
  }

  remainingMs(): number {
    return Math.max(0, this.budgetMs - this.elapsedMs());
  }

  isExpired(): boolean {
    return this.remainingMs() <= 0;
  }

  /**
   * 이만큼의 시간이 남아 있는가 — **새 상류 호출을 시작해도 되는지**의 판단이다.
   * 임계값은 호출 종류별 실측 단가에서 온다 (호출부 상수 주석 참조).
   */
  canAfford(ms: number): boolean {
    return this.remainingMs() >= ms;
  }

  /** 단계 전환 — 직전 단계는 자동으로 닫힌다 (판정 경로가 순차라 구간이 겹치지 않는다) */
  enter(stage: string): void {
    this.close();
    this.open = { name: stage, at: this.now() };
  }

  /** 열린 단계를 닫는다 (더 잴 구간이 없을 때) */
  leave(): void {
    this.close();
  }

  /**
   * 단계를 잠시 바꿨다가 **원래 단계로 되돌린다** — 준비 단계(인덱스 적재·워밍)처럼
   * 다른 단계 안에서 도는 구간을 따로 재기 위한 것이다.
   */
  async during<T>(stage: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.open?.name ?? null;
    this.enter(stage);
    try {
      return await fn();
    } finally {
      if (prev) this.enter(prev);
      else this.leave();
    }
  }

  /**
   * 예산 때문에 일을 건너뛴 지점을 기록한다.
   *
   * ★ **최초 1회만** 남긴다 — 뒤에서 덮어쓰면 "어디서 끊겼는지"가 마지막 단계로 흐려진다.
   *   사용자가 알아야 하는 것은 예산이 처음 모자라기 시작한 지점이다.
   */
  markStopped(stage?: string): void {
    if (this.stopped !== null) return;
    this.stopped = stage ?? this.open?.name ?? 'unknown';
  }

  /** 예산이 처음 모자랐던 단계 (없으면 null) */
  get stoppedAt(): string | null {
    return this.stopped;
  }

  /** 단계별 누적 소요 (ms) — 열려 있는 단계도 지금까지의 소요로 포함한다 */
  stages(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.stageMs) out[k] = v;
    if (this.open) {
      out[this.open.name] = (out[this.open.name] ?? 0) + Math.max(0, this.now() - this.open.at);
    }
    return out;
  }

  private close(): void {
    if (!this.open) return;
    const spent = Math.max(0, this.now() - this.open.at);
    this.stageMs.set(this.open.name, (this.stageMs.get(this.open.name) ?? 0) + spent);
    this.open = null;
  }
}
