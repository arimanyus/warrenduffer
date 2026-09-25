/** Offline pipeline smoke test on a scratch DB. Never touches the live DB, broker or Telegram. */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const scratch = join(tmpdir(), `wd-smoke-${process.pid}.db`);
// dotenv never overrides variables that are already set, so these win over a local .env.
Object.assign(process.env, {
  DB_PATH: scratch,
  MODEL: "mock",
  LIVE_QTY: "0",
  KILL_PATH: join(tmpdir(), `wd-smoke-${process.pid}.kill`),
  TELEGRAM_BOT_TOKEN: "",
  TELEGRAM_CHAT_ID: "",
});

async function main(): Promise<void> {
  const { upsertBar } = await import("../src/db.js");
  const { buildFeatures, buildIndexFeatures } = await import("../src/data/features.js");
  const { MockModel } = await import("../src/model/mock.js");
  const { pickBest, runStage1, runStage2 } = await import("../src/strategy/continuation.js");
  const { computeGovernor } = await import("../src/strategy/governor.js");
  const { sizeQty, stopBps } = await import("../src/risk.js");
  const { risk } = await import("../src/config.js");
  type Quote = import("../src/types.js").Quote;

  const bar = (symbol: string, i: number, close: number) =>
    upsertBar({ symbol, ts: Date.now() - (80 - i) * 60_000, open: close - 0.3, high: close + 0.5, low: close - 0.5, close, volume: 10000 + i * 50 });
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
  const fR = buildFeatures("RELIANCE", quote("RELIANCE", 1432));
  const fT = buildFeatures("TCS", quote("TCS", 3516));
  assert.ok(fR && fT, "features built from 80 bars");
  const index = buildIndexFeatures(quote("Nifty 50", 24080), 0.1, 0.7);
  const model = new MockModel();

  const s1 = await runStage1(model, [fR, fT], index);
  assert.ok(s1, "stage 1 answered");
  assert.ok(s1.longs.length + s1.shorts.length > 0, "stage 1 ranked at least one name");

  const cands = [];
  for (const r of [...s1.longs, ...s1.shorts]) {
    const c = await runStage2(model, r.symbol === "RELIANCE" ? fR : fT, index, r.side);
    if (c) cands.push(c);
  }
  const best = pickBest(cands);
  assert.ok(best, "stage 2 produced a candidate");

  const sb = stopBps(fR.atr1m, fR.last);
  assert.ok(sb !== null && sb >= risk.minStopBps && sb <= risk.maxStopBps, `stop ${sb} bps within risk.json bounds`);
  const qty = sizeQty(fR.last, sb, "A", 100000, 100000);
  assert.ok(qty > 0, "sizing produced a tradable quantity");
  assert.ok(qty * fR.last <= 100000, "sized notional fits the capital box");

  const g = computeGovernor();
  assert.equal(typeof g.reason, "string");
  console.log({ regime: s1.regime, longs: s1.longs.map((l) => l.symbol), best: best.symbol, stopBps: Number(sb.toFixed(1)), qty, governor: g.reason });
  console.log("smoke ok");
}

void main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    (await import("../src/db.js")).db.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(scratch + suffix, { force: true });
  });
