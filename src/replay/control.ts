export interface ReplayState {
  date: string;
  speed: number;
  paused: boolean;
  idx: number;
  total: number;
  done: boolean;
  seeking: boolean;
  virtualNow: number;
  lastStepMs: number;
}

/** Shared between the replay loop and the dashboard API. speed 0 = as fast as Jev answers. */
export class ReplayControl {
  speed: number;
  paused = false;
  idx = 0;
  total = 0;
  done = false;
  virtualNow = 0;
  /** Target bar index. Ahead of idx: skip forward without Jev. Behind idx: rebuild the day and skip to it. */
  seekTo: number | null = null;
  lastStepMs = 0;
  private wake: (() => void) | null = null;

  constructor(
    readonly date: string,
    speed: number,
  ) {
    this.speed = speed;
  }

  state(): ReplayState {
    return {
      date: this.date,
      speed: this.speed,
      paused: this.paused,
      idx: this.idx,
      total: this.total,
      done: this.done,
      seeking: this.seekTo !== null,
      virtualNow: this.virtualNow,
      lastStepMs: this.lastStepMs,
    };
  }

  command(body: { speed?: number; paused?: boolean; seek?: number }): void {
    if (typeof body.speed === "number" && body.speed >= 0) this.speed = body.speed;
    if (typeof body.paused === "boolean") this.paused = body.paused;
    if (typeof body.seek === "number") this.seekTo = Math.max(0, Math.min(this.total - 1, Math.floor(body.seek)));
    this.kick();
  }

  /** Real milliseconds budgeted per virtual minute. 0 = MAX. */
  delayMs(): number {
    return this.speed > 0 ? 60_000 / this.speed : 0;
  }

  async waitWhilePaused(): Promise<void> {
    while (this.paused && this.seekTo === null) await this.idle(50);
  }

  /** Block until a seek arrives (used after the day has finished). */
  async waitForSeek(): Promise<void> {
    while (this.seekTo === null) await this.idle(200);
  }

  /**
   * Spend the remaining speed budget after a step. Jev time counts:
   * 60× with a 800ms Jev call only waits 200ms more; MAX and a click off 1× wake immediately.
   */
  async pace(stepStartedAt: number): Promise<void> {
    while (true) {
      if (this.seekTo !== null) return;
      const budget = this.delayMs();
      const elapsed = Date.now() - stepStartedAt;
      if (!this.paused && (budget === 0 || elapsed >= budget)) return;
      await this.idle(50);
    }
  }

  private kick(): void {
    const n = this.wake;
    this.wake = null;
    n?.();
  }

  private idle(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve;
      setTimeout(() => {
        if (this.wake === resolve) this.wake = null;
        resolve();
      }, ms);
    });
  }
}
