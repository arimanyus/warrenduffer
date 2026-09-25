import "./helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canEnterMore, marketablePrice, riskPerTrade, roundTick, roundTickDir, sizeQty, stopBps, stopLimitPrice, stopPrice, targetPrice, unrealized } from "../src/risk.js";
import { optionStops } from "../src/strategy/options.js";
import type { OpenPosition, Quote } from "../src/types.js";

describe("stopBps", () => {
  it("scales 1-min ATR by stopAtrMult and clamps to the floor", () => {
    assert.equal(stopBps(0.5, 1000), 10);
  });
  it("returns the ATR-based distance inside the band", () => {
    assert.equal(stopBps(1.5, 1000), 18);
  });
  it("refuses a stop wider than maxStopBps", () => {
    assert.equal(stopBps(3, 1000), null);
  });
  it("refuses a zero price", () => {
    assert.equal(stopBps(1, 0), null);
  });
});

describe("sizeQty", () => {
  it("sizes tier A by rupee risk over stop distance, capped by capital", () => {
    // risk 300 over 20bps of 1000 = 2/share -> 150 shares; capital 100k / 1000 = 100 shares
    assert.equal(sizeQty(1000, 20, "A", 100_000, 100_000), 100);
  });
  it("halves tier B", () => {
    assert.equal(sizeQty(1000, 20, "B", 100_000, 100_000), 50);
  });
  it("returns 0 when remaining capital cannot buy one share", () => {
    assert.equal(sizeQty(1000, 20, "A", 999, 100_000), 0);
  });
  it("uses the risk floor when capital is small", () => {
    assert.equal(riskPerTrade(10_000), 300);
    assert.equal(riskPerTrade(1_000_000), 3000);
  });
});

describe("roundTick", () => {
  it("snaps to tick and strips float residue", () => {
    assert.equal(roundTick(715.9000000000001, 0.05), 715.9);
    assert.equal(roundTick(100.03, 0.05), 100.05);
    assert.equal(roundTick(100.02, 0.05), 100);
  });
  it("supports a 0.10 tick", () => {
    assert.equal(roundTick(1234.56, 0.1), 1234.6);
  });
});

describe("stop and target prices", () => {
  it("places a long stop below and target above entry", () => {
    assert.equal(stopPrice("long", 1000, 20, 0.05), 998);
    assert.equal(targetPrice("long", 1000, 20, 0.05), 1004);
  });
  it("places a short stop above and target below entry", () => {
    assert.equal(stopPrice("short", 1000, 20, 0.05), 1002);
    assert.equal(targetPrice("short", 1000, 20, 0.05), 996);
  });
});

describe("directional tick rounding", () => {
  it("never rounds a marketable sell up or a buy down", () => {
    assert.equal(roundTickDir(100.03, 0.05, "down"), 100);
    assert.equal(roundTickDir(100.01, 0.05, "up"), 100.05);
    assert.equal(roundTickDir(100.05, 0.05, "up"), 100.05);
    assert.equal(roundTickDir(715.9000000000001, 0.05, "down"), 715.9);
  });
});

describe("stopLimitPrice", () => {
  it("uses the bps buffer when it exceeds three ticks", () => {
    // 15 bps of 1000 = 1.50 > 3 ticks
    assert.equal(stopLimitPrice("long", 1000, 0.05), 998.5);
    assert.equal(stopLimitPrice("short", 1000, 0.05), 1001.5);
  });
  it("falls back to three ticks on low-priced names", () => {
    assert.equal(stopLimitPrice("long", 50, 0.05), 49.85);
  });
});

describe("marketablePrice", () => {
  const q = { bid: 1000, ask: 1000.5, ltp: 1000.2, tickSize: 0.05 } as Quote;
  it("prices a sell 25 bps under the bid and a buy 25 bps over the ask", () => {
    assert.equal(marketablePrice("sell", q), 997.5);
    assert.equal(marketablePrice("buy", q), 1003.05);
  });
  it("is at least one tick through on a cheap instrument", () => {
    assert.equal(marketablePrice("sell", { bid: 1, ask: 1.05, ltp: 1, tickSize: 0.05 } as Quote), 0.95);
  });
  it("falls back to LTP with an empty book", () => {
    assert.equal(marketablePrice("sell", { bid: 0, ask: 0, ltp: 200, tickSize: 0.05 } as Quote), 199.5);
  });
});

describe("unrealized", () => {
  it("includes the realised part of a partial exit", () => {
    const pos = { side: "long", qty: 10, entryPrice: 100, closedQty: 4, exitNotional: 4 * 98 } as OpenPosition;
    // -8 realised on 4, -12 open on 6 at 98
    assert.equal(unrealized(pos, { ltp: 98 } as Quote), -20);
  });
});

describe("optionStops", () => {
  it("returns tick-valid prices", () => {
    const { stop, target } = optionStops(123.45, 0.05);
    assert.equal(stop, 113.55);
    assert.equal(target, 142);
  });
});

describe("canEnterMore", () => {
  it("blocks at the position cap", () => {
    assert.equal(canEnterMore(3, 0).ok, false);
    assert.equal(canEnterMore(2, 0).ok, true);
  });
  it("blocks once the day is at the loss cap", () => {
    assert.deepEqual(canEnterMore(0, -1000), { ok: false, reason: "daily_loss_cap" });
  });
});
