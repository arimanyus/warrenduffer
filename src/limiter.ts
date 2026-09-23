/** Per-second token bucket plus a sliding per-minute request window. Defaults are Kotak's: 5 order ops/s, 150 requests/min. */
export class RateLimiter {
  private orderTokens: number;
  private lastOrder = Date.now();
  private reqTimes: number[] = [];

  constructor(
    private perSec = 5,
    private perMin = 150,
  ) {
    this.orderTokens = perSec;
  }

  async takeRequest(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.reqTimes = this.reqTimes.filter((t) => now - t < 60_000);
      if (this.reqTimes.length < this.perMin) {
        this.reqTimes.push(now);
        return;
      }
      await sleep(200);
    }
  }

  async takeOrder(): Promise<void> {
    await this.takeRequest();
    for (;;) {
      const now = Date.now();
      const elapsed = (now - this.lastOrder) / 1000;
      this.orderTokens = Math.min(this.perSec, this.orderTokens + elapsed * this.perSec);
      this.lastOrder = now;
      if (this.orderTokens >= 1) {
        this.orderTokens -= 1;
        return;
      }
      await sleep(120);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
