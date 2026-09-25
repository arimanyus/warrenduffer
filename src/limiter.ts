/**
 * Per-second token bucket plus a sliding per-minute request window. Defaults are Kotak's: 5 order ops/s, 150 requests/min.
 * Low-priority requests (quotes, candles, chains) may only use the window up to `perMin - reserve`, so market-data
 * polling can never starve order placement, cancels or the order-book poll.
 */
export class RateLimiter {
  private orderTokens: number;
  private lastOrder = Date.now();
  private reqTimes: number[] = [];
  private readonly reserve: number;

  constructor(
    private perSec = 5,
    private perMin = 150,
    reserveFraction = 0.2,
  ) {
    this.orderTokens = perSec;
    this.reserve = Math.floor(perMin * reserveFraction);
  }

  async takeRequest(lowPriority = false): Promise<void> {
    const limit = lowPriority ? this.perMin - this.reserve : this.perMin;
    for (;;) {
      const now = Date.now();
      this.reqTimes = this.reqTimes.filter((t) => now - t < 60_000);
      if (this.reqTimes.length < limit) {
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

  /** Requests in the current window; exposed for tests and diagnostics. */
  used(): number {
    const now = Date.now();
    return this.reqTimes.filter((t) => now - t < 60_000).length;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
