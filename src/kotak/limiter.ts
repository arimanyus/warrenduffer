/** Token bucket: 5 order ops/s and 150 requests/min. */
export class RateLimiter {
  private orderTokens = 5;
  private lastOrder = Date.now();
  private reqTimes: number[] = [];

  async takeRequest(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.reqTimes = this.reqTimes.filter((t) => now - t < 60_000);
      if (this.reqTimes.length < 150) {
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
      this.orderTokens = Math.min(5, this.orderTokens + elapsed * 5);
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
