import { upsertBar } from "../src/db.js";
import { buildFeatures, buildIndexFeatures } from "../src/data/features.js";
import { MockModel } from "../src/model/mock.js";
import { pickBest, runStage1, runStage2 } from "../src/strategy/continuation.js";
import { computeGovernor } from "../src/strategy/governor.js";
import { sizeQty, stopBps } from "../src/risk.js";
import type { Quote } from "../src/types.js";

function bar(symbol: string, i: number, close: number): void {
  const ts = Date.now() - (80 - i) * 60_000;
  upsertBar({
    symbol,
    ts,
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    volume: 10000 + i * 50,
  });
}

function quote(symbol: string, ltp: number): Quote {
  return {
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
  };
}

async function main(): Promise<void> {
  for (let i = 0; i < 80; i++) {
    bar("RELIANCE", i, 1400 + i * 0.4);
    bar("TCS", i, 3500 + i * 0.2);
    bar("Nifty 50", i, 24000 + i);
  }
  const qR = quote("RELIANCE", 1432);
  const qT = quote("TCS", 3516);
  const qN = quote("Nifty 50", 24080);
  const fR = buildFeatures("RELIANCE", qR)!;
  const fT = buildFeatures("TCS", qT)!;
  const index = buildIndexFeatures(qN, 0.1, 0.7);
  const model = new MockModel();
  const s1 = await runStage1(model, [fR, fT], index);
  if (!s1) throw new Error("stage1 failed");
  const cands = [];
  for (const r of [...s1.longs, ...s1.shorts]) {
    const f = r.symbol === "RELIANCE" ? fR : fT;
    const c = await runStage2(model, f, index, r.side);
    if (c) cands.push(c);
  }
  const best = pickBest(cands);
  const sb = stopBps(fR.atr1m, fR.last);
  const qty = sb ? sizeQty(fR.last, sb, "A") : 0;
  const g = computeGovernor();
  console.log({ regime: s1.regime, longs: s1.longs, best: best?.symbol, qty, governor: g.reason });
  console.log("smoke ok");
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
