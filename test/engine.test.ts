import { testDir } from "./helpers/env.js";
import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { cfg, risk } from "../src/config.js";
import { db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import type { PlaceIntent } from "../src/executor/types.js";
import { stopPrice } from "../src/risk.js";
import { useVirtualClock } from "../src/time.js";
import type { OpenPosition } from "../src/types.js";
import { FakeBroker, isOpen, type FakeOrder } from "./helpers/fake-broker.js";
import { holdAnswers, ScriptedModel } from "./helpers/model.js";

/** 10:00 IST on a Tuesday. */
const T0 = Date.parse("2026-09-15T04:30:00Z");
const vclock = useVirtualClock(T0);
let now = T0;
const setNow = (ms: number) => vclock.set((now = ms));

let broker: FakeBroker;
let engine: Engine;
const px = new Map<string, number>();

function quote(symbol: string, ltp: number): void {
  px.set(symbol, ltp);
  broker.setQuote(symbol, ltp, { ts: now });
}

/** Advance the virtual clock and run one fast-loop tick with fresh quotes. */
async function step(ms = 2000): Promise<void> {
  setNow(now + ms);
  for (const [s, p] of px) broker.setQuote(s, p, { ts: now });
  await engine.tick();
}

async function steps(n: number, ms = 2000): Promise<void> {
  for (let i = 0; i < n; i++) await step(ms);
}

function entryIntent(symbol: string, qty: number, price: number, side: "buy" | "sell" = "buy"): PlaceIntent {
  return {
    symbol,
    token: broker.getInstrument(symbol)!.token,
    segment: "nse_cm",
    tradingSymbol: `${symbol}-EQ`,
    side,
    qty,
    price,
    kind: "entry",
    tag: `wde${symbol.toLowerCase()}${now.toString(36)}`,
    decisionId: null,
    leg: "equity",
    tier: "B",
    stopBps: 20,
  };
}

async function openPosition(symbol: string, qty: number, price: number, side: "buy" | "sell" = "buy"): Promise<OpenPosition> {
  quote(symbol, price);
  const o = await engine.exec.place(entryIntent(symbol, qty, price, side));
  broker.fill(o.brokerId!, qty, price);
  await step();
  const pos = engine.positions.get(symbol);
  assert.ok(pos, `${symbol} position opened`);
  return pos;
}

const stopsAt = (symbol: string) => broker.openOrders().filter((o) => o.symbol === symbol && o.orderType === "SL-L");
const exitsAt = (symbol: string) => broker.openOrders().filter((o) => o.symbol === symbol && o.orderType === "L" && o.tag.startsWith("wdx"));
const lastTrade = () => db.prepare("SELECT * FROM trades ORDER BY id DESC LIMIT 1").get() as { symbol: string; exit_reason: string; qty: number; pnl: number } | undefined;

beforeEach(() => {
  setNow(T0);
  db.exec("DELETE FROM trades; DELETE FROM positions; DELETE FROM orders; DELETE FROM fills; DELETE FROM settings;");
  if (existsSync(cfg.killPath)) unlinkSync(cfg.killPath);
  px.clear();
  broker = new FakeBroker([
    { symbol: "INFY", token: "1" },
    { symbol: "TCS", token: "2" },
  ]);
  engine = new Engine(broker, { model: new ScriptedModel(() => holdAnswers()) });
  engine.jevPaused = true;
  // Keep the periodic reconciler out of tests that are not about it.
  engine.lastReconcile = Number.MAX_SAFE_INTEGER;
});

afterEach(() => {
  if (existsSync(cfg.killPath)) unlinkSync(cfg.killPath);
});

describe("entry fills", () => {
  it("opens a position and rests an exchange stop-limit with a real buffer", async () => {
    const pos = await openPosition("INFY", 10, 1500);
    assert.equal(pos.stop, stopPrice("long", 1500, 20, 0.05));
    const [sl] = stopsAt("INFY");
    assert.ok(sl, "stop resting at the broker");
    assert.equal(sl.trigger, pos.stop);
    assert.ok(pos.stop - sl.price >= (pos.stop * risk.stopLimitBufferBps) / 1e4 - 0.05, `limit ${sl.price} is at least the buffer below ${pos.stop}`);
    assert.equal(sl.qty, 10);
  });

  it("applies partial fills in order and keeps the stop quantity equal to the position", async () => {
    quote("INFY", 1500);
    const o = await engine.exec.place(entryIntent("INFY", 10, 1500));
    broker.fill(o.brokerId!, 4, 1500);
    await step();
    broker.fill(o.brokerId!, 6, 1500);
    await step();
    assert.equal(engine.positions.get("INFY")!.qty, 10);
    const sls = stopsAt("INFY");
    assert.equal(sls.length, 1);
    assert.equal(sls[0].qty, 10);
  });
});

describe("stop watchdog", () => {
  it("replaces a triggered-but-unfilled stop with a marketable exit and books a stop trade", async () => {
    const pos = await openPosition("INFY", 10, 1500);
    const [sl] = stopsAt("INFY");
    quote("INFY", pos.stop - 5);
    broker.trigger(sl.orderId);
    await step();
    assert.equal(exitsAt("INFY").length, 0, "not before stopUnfilledMs");
    await steps(2);
    assert.equal(broker.book.find((o) => o.orderId === sl.orderId)!.status, "cancelled");
    const [ex] = exitsAt("INFY");
    assert.ok(ex, "marketable exit placed");
    assert.equal(ex.side, "sell");
    assert.ok(ex.price < pos.stop - 5 - 0.05 * 2, `exit ${ex.price} priced through the bid`);
    broker.fill(ex.orderId);
    await step();
    assert.equal(engine.positions.size, 0);
    assert.equal(lastTrade()!.exit_reason, "stop");
  });

  it("chases a marketable exit down as the market falls", async () => {
    const pos = await openPosition("INFY", 10, 1500);
    quote("INFY", pos.stop - 2);
    await steps(3);
    const [ex] = exitsAt("INFY");
    assert.ok(ex);
    const first = ex.price;
    quote("INFY", pos.stop - 20);
    await step();
    assert.ok(exitsAt("INFY")[0].price < first, "re-priced lower");
  });

  it("exits at once when there is no stop resting and price is through it", async () => {
    const pos = await openPosition("INFY", 10, 1500);
    const [sl] = stopsAt("INFY");
    sl.status = "cancelled";
    quote("INFY", pos.stop - 1);
    await step();
    assert.equal(exitsAt("INFY").length, 1);
  });
});

describe("stop quantity", () => {
  it("replaces the stop when a quantity modify is refused, so it never exceeds the position", async () => {
    const pos = await openPosition("INFY", 10, 1500);
    pos.closedQty = 4;
    pos.exitNotional = 4 * 1500;
    broker.modifyModes.push("throw");
    await step(3000);
    const sls = stopsAt("INFY");
    assert.equal(sls.length, 1);
    assert.equal(sls[0].qty, 6);
  });
});

describe("stop re-arm", () => {
  it("places a new stop when the resting one disappears", async () => {
    await openPosition("INFY", 10, 1500);
    const [sl] = stopsAt("INFY");
    sl.status = "cancelled";
    await step();
    const next = stopsAt("INFY");
    assert.equal(next.length, 1);
    assert.notEqual(next[0].orderId, sl.orderId);
    assert.notEqual(next[0].tag, sl.tag);
  });

  it("backs off after a refused stop and retries", async () => {
    quote("INFY", 1500);
    const o = await engine.exec.place(entryIntent("INFY", 10, 1500));
    broker.fill(o.brokerId!);
    broker.placeModes.push("reject");
    await step();
    assert.equal(stopsAt("INFY").length, 0);
    await steps(5);
    assert.equal(stopsAt("INFY").length, 0, "no retry inside the backoff");
    await step(30_000);
    assert.equal(stopsAt("INFY").length, 1);
  });
});

describe("kill switch and flatten", () => {
  it("keeps driving positions out after the kill until flat, even when the first exit is refused", async () => {
    await openPosition("INFY", 10, 1500);
    await openPosition("TCS", 5, 3500);
    engine.kill();
    broker.placeModes.push("reject");
    await step();
    for (let i = 0; i < 6 && engine.positions.size; i++) {
      for (const o of broker.openOrders()) if (o.tag.startsWith("wdx")) broker.fill(o.orderId);
      await step();
    }
    assert.equal(engine.positions.size, 0);
    assert.equal(broker.net.size, 0);
    assert.equal(broker.openOrders().length, 0, "no stops left behind");
  });

  it("emergencyFlatten trips the kill switch and ticks until flat", async () => {
    await openPosition("INFY", 10, 1500);
    const place = broker.place.bind(broker);
    broker.place = async (args) => {
      const res = await place(args);
      if (res.orderId && args.tag.startsWith("wdx")) broker.fill(res.orderId);
      return res;
    };
    // Real timers drive emergencyFlatten; the virtual clock must move for order polls to run.
    const advance = setInterval(() => {
      setNow(now + 2000);
      for (const [s, p] of px) broker.setQuote(s, p, { ts: now });
    }, 5);
    try {
      assert.equal(await engine.emergencyFlatten(3000, 10), true);
    } finally {
      clearInterval(advance);
    }
    assert.ok(existsSync(cfg.killPath));
    assert.equal(engine.positions.size, 0);
    assert.equal(broker.net.size, 0);
  });

  it("an exit stuck on a slow stop cancel blocks a second exit", async () => {
    const pos = await openPosition("INFY", 10, 1500);
    let release!: () => void;
    broker.cancelGate = new Promise<void>((r) => (release = r));
    const exitPosition = (engine as unknown as { exitPosition: (p: OpenPosition, r: string) => Promise<void> }).exitPosition.bind(engine);
    const jevExit = exitPosition(pos, "exit");
    engine.kill();
    await steps(4);
    assert.equal(exitsAt("INFY").length, 0);
    broker.cancelGate = null;
    release();
    await jevExit;
    await steps(2);
    const exits = exitsAt("INFY");
    assert.equal(exits.length, 1);
    assert.equal(exits[0].qty, 10);
    assert.equal(stopsAt("INFY").length, 0);
  });

  it("an exit stuck on a slow place (stop already cancelled) blocks a stop re-arm and a second exit", async () => {
    const pos = await openPosition("INFY", 10, 1500);
    let release!: () => void;
    broker.placeGate = new Promise<void>((r) => (release = r));
    const exitPosition = (engine as unknown as { exitPosition: (p: OpenPosition, r: string) => Promise<void> }).exitPosition.bind(engine);
    const jevExit = exitPosition(pos, "exit");
    const placesOf = (pred: (a: { orderType?: string; tag: string }) => boolean) =>
      broker.calls.filter((c) => c.method === "place" && pred(c.args as { orderType?: string; tag: string })).length;
    await steps(2);
    assert.equal(placesOf((a) => a.orderType === "SL-L"), 1, "hardExits must not re-arm a stop beside the pending exit");
    engine.kill();
    await steps(3);
    assert.equal(placesOf((a) => a.tag.startsWith("wdx")), 1, "the kill must not send a second exit");
    broker.placeGate = null;
    release();
    await jevExit;
    await steps(2);
    assert.equal(exitsAt("INFY").length, 1);
    assert.equal(exitsAt("INFY")[0].qty, 10);
  });

  it("walks a forced exit through the market when the quote stops refreshing", async () => {
    await openPosition("INFY", 10, 1500);
    engine.kill();
    await step();
    const [first] = exitsAt("INFY");
    assert.ok(first, "kill placed a marketable exit");
    const p0 = first.price;
    px.delete("INFY");
    await steps(10);
    const [ex] = exitsAt("INFY");
    assert.ok(ex.price < p0 - 1, `stale-quote exit walked from ${p0} to ${ex.price}`);
    assert.ok(ex.price >= 1500 * 0.97 - 0.05, `bounded at 3% (${ex.price})`);
  });

  it("cancels working entries and blocks new ones once killed", async () => {
    quote("INFY", 1500);
    await engine.exec.place(entryIntent("INFY", 10, 1500));
    engine.kill();
    await step();
    assert.equal(broker.openOrders().length, 0);
  });

  it("flattens with marketable exits at FLATTEN_AT", async () => {
    await openPosition("INFY", 10, 1500);
    setNow(Date.parse("2026-09-15T09:41:00Z"));
    await step();
    const [ex] = exitsAt("INFY");
    assert.ok(ex, "flatten exit placed");
    assert.ok(ex.price < 1500 - 0.05);
  });

  it("re-checks the kill switch between the margin call and the order", async () => {
    engine.quotes.set("INFY", broker.setQuote("INFY", 1500, { ts: now }));
    broker.onMargin = () => engine.kill();
    const f = { symbol: "INFY", last: 1500, bid: 1499.95, ask: 1500.05, atr1m: 1.5, tickSize: 0.05 };
    const cand = { symbol: "INFY", side: "long", tier: "B", entryScore: 0.8 };
    await (engine as unknown as { enterEquity: (c: unknown, f: unknown) => Promise<void> }).enterEquity(cand, f);
    assert.ok(broker.calls.some((c) => c.method === "margin"), "reached the margin check");
    assert.equal(broker.calls.filter((c) => c.method === "place").length, 0);
    assert.equal(engine.lastSkipReason, "killed");
  });
});

describe("daily loss cap", () => {
  it("halts and flattens on open mark-to-market loss, before anything is realised", async () => {
    await openPosition("INFY", 100, 1500);
    quote("INFY", 1489);
    await step();
    assert.equal(engine.halted, true);
    await step(3000);
    assert.equal(exitsAt("INFY").length, 1);
  });

  it("uses the broker's realised P&L when it is worse than ours", async () => {
    broker.realised = -1200;
    engine.lastReconcile = 0;
    await step();
    assert.equal(engine.brokerRealised, -1200);
    await step();
    assert.equal(engine.halted, true);
  });

  it("counts a partial exit once even though the broker's realised already includes it", async () => {
    const pos = await openPosition("INFY", 100, 1500);
    pos.closedQty = 50;
    pos.exitNotional = 50 * 1490;
    engine.brokerRealised = -500;
    assert.ok(Math.abs(engine.dayPnl() - -500) < 1, `dayPnl ${engine.dayPnl()} should be -500, not -1000`);
  });

  it("ignores delivery (CNC) realised P&L elsewhere in the account", async () => {
    const positions = broker.positions.bind(broker);
    broker.positions = async () => [...(await positions()), { symbol: "HDFC", token: "9", segment: "nse_cm", qty: 0, avgPrice: 0, product: "CNC", realisedPnl: -5000 }];
    engine.lastReconcile = 0;
    await step();
    assert.notEqual(engine.brokerRealised, -5000);
    assert.equal(engine.halted, false);
  });

  it("clears the halt on a new trading day", async () => {
    engine.halted = true;
    setNow(Date.parse("2026-09-16T04:30:00Z"));
    await step();
    assert.equal(engine.halted, false);
  });
});

describe("exposure", () => {
  it("counts working entries and unconfirmed places toward the position cap", async () => {
    quote("INFY", 1500);
    quote("TCS", 3500);
    await engine.exec.place(entryIntent("INFY", 10, 1500));
    broker.placeModes.push("accept-then-throw");
    await engine.exec.place(entryIntent("TCS", 5, 3500));
    assert.equal(engine.exposureCount(), 2);
    assert.equal(engine.tradesToday(), 2);
  });

  it("stops entering once MAX_TRADES_PER_DAY is used", async () => {
    (cfg as { maxTradesPerDay: number }).maxTradesPerDay = 1;
    try {
      await openPosition("TCS", 5, 3500);
      engine.quotes.set("INFY", broker.setQuote("INFY", 1500, { ts: now }));
      const f = { symbol: "INFY", last: 1500, bid: 1499.95, ask: 1500.05, atr1m: 1.5, tickSize: 0.05 };
      await (engine as unknown as { enterEquity: (c: unknown, f: unknown) => Promise<void> }).enterEquity({ symbol: "INFY", side: "long", tier: "B", entryScore: 0.8 }, f);
      assert.match(engine.lastSkipReason, /MAX_TRADES_PER_DAY/);
    } finally {
      (cfg as { maxTradesPerDay: number }).maxTradesPerDay = 0;
    }
  });

  it("does not enter on a quote the feed stopped refreshing", async () => {
    engine.quotes.set("INFY", broker.setQuote("INFY", 1500, { ts: now - 60_000 }));
    const f = { symbol: "INFY", last: 1500, bid: 1499.95, ask: 1500.05, atr1m: 1.5, tickSize: 0.05 };
    await (engine as unknown as { enterEquity: (c: unknown, f: unknown) => Promise<void> }).enterEquity({ symbol: "INFY", side: "long", tier: "B", entryScore: 0.8 }, f);
    assert.match(engine.lastSkipReason, /stale/);
  });
});

describe("periodic reconciliation", () => {
  it("closes a position the broker no longer holds after two consistent sightings", async () => {
    await openPosition("INFY", 10, 1500);
    broker.setPosition("INFY", "1", 0, 0);
    await step(5_000);
    engine.lastReconcile = 0;
    await step();
    assert.equal(engine.positions.size, 1, "one sighting is not enough");
    await step(30_000);
    assert.equal(engine.positions.size, 0);
    assert.equal(lastTrade()!.exit_reason, "reconcile");
    assert.equal(stopsAt("INFY").length, 0, "our stop was cancelled");
  });

  it("adopts a position that exists only at the broker and protects it", async () => {
    quote("TCS", 3500);
    broker.setPosition("TCS", "2", 5, 3500);
    engine.lastReconcile = 0;
    await step();
    await step(30_000);
    const pos = engine.positions.get("TCS");
    assert.ok(pos);
    assert.equal(pos.qty, 5);
    assert.equal(stopsAt("TCS").length, 1);
  });

  it("resizes when the broker holds a different quantity on the same side", async () => {
    await openPosition("INFY", 10, 1500);
    broker.setPosition("INFY", "1", 6, 1500);
    await step(5_000);
    engine.lastReconcile = 0;
    await step();
    await step(30_000);
    assert.equal(engine.positions.get("INFY")!.qty, 6);
    assert.equal(stopsAt("INFY")[0].qty, 6);
  });

  it("flattens a position that flipped at the broker instead of managing it", async () => {
    await openPosition("INFY", 10, 1500);
    broker.setPosition("INFY", "1", -5, 1500);
    await step(5_000);
    engine.lastReconcile = 0;
    await step();
    await step(30_000);
    const ex = exitsAt("INFY");
    assert.equal(ex.length, 1, "one exit for the flipped excess");
    assert.deepEqual([ex[0].side, ex[0].qty], ["buy", 5]);
    assert.equal(stopsAt("INFY").length, 0, "no stop protecting a position we never chose");
  });

  it("cancels an engine-tagged order nothing tracks, but never a manual one", async () => {
    await broker.place({ segment: "nse_cm", tradingSymbol: "INFY-EQ", side: "buy", qty: 1, price: 1400, tag: "wdeorphan1" });
    await broker.place({ segment: "nse_cm", tradingSymbol: "TCS-EQ", side: "buy", qty: 1, price: 3000, tag: "manual" });
    engine.lastReconcile = 0;
    await step();
    await step(30_000);
    await Promise.resolve();
    const open = broker.openOrders().map((o) => o.tag);
    assert.deepEqual(open, ["manual"]);
  });
});

describe("startup reconcile", () => {
  it("adopts broker positions with their resting stops, restores DB stops, and clears stale state", async () => {
    db.prepare(
      "INSERT INTO positions (opened_at, leg, symbol, token, segment, side, qty, entry, stop, target, tier, stop_bps, closed) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)",
    ).run(T0 - 60_000, "equity", "INFY", "1", "nse_cm", "long", 10, 1500, 1497, 1506, "A", 20);
    db.prepare(
      "INSERT INTO positions (opened_at, leg, symbol, token, segment, side, qty, entry, stop, target, tier, stop_bps, closed) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)",
    ).run(T0 - 60_000, "equity", "TCS", "2", "nse_cm", "long", 5, 3500, 3490, 3520, "B", 20);
    quote("INFY", 1501);
    broker.setPosition("INFY", "1", 10, 1500);
    await broker.place({ segment: "nse_cm", tradingSymbol: "INFY-EQ", side: "sell", qty: 10, price: 1494.75, orderType: "SL-L", trigger: 1497, tag: "wdsabc" });
    await broker.place({ segment: "nse_cm", tradingSymbol: "TCS-EQ", side: "buy", qty: 5, price: 3400, tag: "wdestale" });
    await broker.place({ segment: "nse_cm", tradingSymbol: "TCS-EQ", side: "buy", qty: 1, price: 3000, tag: "mine" });

    await engine.reconcile();

    const pos = engine.positions.get("INFY")!;
    assert.deepEqual([pos.qty, pos.stop, pos.tier], [10, 1497, "A"]);
    assert.equal(stopsAt("INFY").length, 1, "the resting stop was adopted, not duplicated");
    assert.equal(engine.positions.has("TCS"), false);
    const stale = db.prepare("SELECT closed FROM positions WHERE symbol='TCS'").get() as { closed: number };
    assert.equal(stale.closed, 1);
    assert.deepEqual(broker.openOrders().map((o) => o.tag).sort(), ["mine", "wdsabc"]);
  });

  it("flattens adopted positions with a marketable exit when ON_RESTART=flatten", async () => {
    (cfg as { onRestart: string }).onRestart = "flatten";
    try {
      quote("INFY", 1501);
      broker.setPosition("INFY", "1", 10, 1500);
      await engine.reconcile();
      const [ex] = exitsAt("INFY") as FakeOrder[];
      assert.ok(ex);
      assert.ok(ex.price < 1501);
    } finally {
      (cfg as { onRestart: string }).onRestart = "adopt";
    }
  });
});

void testDir;
void join;
void isOpen;
