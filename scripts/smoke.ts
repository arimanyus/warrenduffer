/** Offline pipeline smoke test on a scratch DB. Never touches the live DB. */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const scratch = join(tmpdir(), `wd-smoke-${process.pid}.db`);
process.env.DB_PATH = scratch;

async function main(): Promise<void> {
  const { upsertBar } = await import("../src/db.js");
  const { buildFeatures, buildIndexFeatures } = await import("../src/data/features.js");
  const { MockModel } = await import("../src/model/mock.js");
  const { pickBest, runStage1, runStage2 } = await import("../src/strategy/continuation.js");
  const { computeGovernor } = await import("../src/strategy/governor.js");
  const { sizeQty, stopBps } = await import("../src/risk.js");
  type Quote = import("../src/types.js").Quote;

  const bar = (symbol: string, i: number, close: number) =>
    upsertBar({ symbol, ts: Date.now() - (80 - i) * 60_000, open: close - 1, high: close + 2, low: close - 2, close, volume: 10000 + i * 50 });
  const quote = (symbol: string, ltp: number): Quote => ({
    symbol,
    token: symbol,
    segment: "nse_cm",
    ts: Date.now(),
    ltp,
    ltq: 10,
    volume: 20000,
    bid: ltp - 0.05,
    ask: ltp + 0.05,
    tbq: 5000,
    tsq: 3000,
    bids: [{ price: ltp - 0.05, qty: 100 }],
    asks: [{ price: ltp + 0.05, qty: 80 }],
    open: ltp - 5,
    high: ltp + 3,
    low: ltp - 6,
    close: ltp,
    tickSize: 0.05,
  });

  for (let i = 0; i < 80; i++) {
    bar("RELIANCE", i, 1400 + i * 0.4);
    bar("TCS", i, 3500 + i * 0.2);
    bar("Nifty 50", i, 24000 + i);
  }
  const fR = buildFeatures("RELIANCE", quote("RELIANCE", 1432))!;
  const fT = buildFeatures("TCS", quote("TCS", 3516))!;
  const index = buildIndexFeatures(quote("Nifty 50", 24080), 0.1, 0.7);
  const model = new MockModel();
  const s1 = await runStage1(model, [fR, fT], index);
  if (!s1) throw new Error("stage1 failed");
  const cands = [];
  for (const r of [...s1.longs, ...s1.shorts]) {
    const c = await runStage2(model, r.symbol === "RELIANCE" ? fR : fT, index, r.side);
    if (c) cands.push(c);
  }
  const best = pickBest(cands);
  const sb = stopBps(fR.atr1m, fR.last);
  const qty = sb ? sizeQty(fR.last, sb, "A", 100000, 100000) : 0;
  const g = computeGovernor();
  console.log({ regime: s1.regime, longs: s1.longs, best: best?.symbol, qty, governor: g.reason });
  console.log("smoke ok");
}

void main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(scratch + suffix, { force: true });
  });
