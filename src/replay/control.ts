export interface ReplayState {
  date: string;
  speed: number;
  paused: boolean;
  idx: number;
  total: number;
  done: boolean;
  virtualNow: number;
}

/** Shared between the replay loop and the dashboard API. speed 0 = as fast as Jev answers. */
export class ReplayControl {
  speed: number;
  paused = false;
  idx = 0;
  total = 0;
  done = false;
  virtualNow = 0;
  seekTo: number | null = null;

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
      virtualNow: this.virtualNow,
    };
  }

  command(body: { speed?: number; paused?: boolean; seek?: number }): void {
    if (typeof body.speed === "number" && body.speed >= 0) this.speed = body.speed;
    if (typeof body.paused === "boolean") this.paused = body.paused;
    if (typeof body.seek === "number") this.seekTo = Math.max(this.idx, Math.floor(body.seek));
  }

  /** Real milliseconds to wait per virtual minute. */
  delayMs(): number {
    return this.speed > 0 ? 60_000 / this.speed : 0;
  }
}
