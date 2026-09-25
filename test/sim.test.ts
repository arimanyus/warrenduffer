import "./helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fillAgainstBar } from "../src/replay/sim.js";
import type { Quote, WorkingOrder } from "../src/types.js";

function order(o: Partial<WorkingOrder>): WorkingOrder {
  return {
    id: 1,
    brokerId: "sim-1",
    symbol: "X",
    token: "X",
    segment: "nse_cm",
    side: "buy",
    qty: 1,
    price: 100,
    trigger: null,
    kind: "entry",
    status: "open",
    tag: "t",
    placedAt: 0,
    lastModifyAt: 0,
    filledQty: 0,
    requotes: 0,
    decisionId: null,
    leg: "equity",
    tier: "B",
    stop: null,
    target: null,
    stopBps: null,
    tradingSymbol: "X-EQ",
    orderType: "L",
    marketable: false,
    confirmed: true,
    triggeredAt: null,
    cancelRequested: false,
    reason: null,
    ...o,
  };
}

function bar(open: number, high: number, low: number, close: number): Quote {
  return { symbol: "X", token: "X", segment: "nse_cm", ts: 0, ltp: close, ltq: 0, volume: 0, bid: close, ask: close, tbq: 0, tsq: 0, bids: [], asks: [], open, high, low, close, tickSize: 0.05 };
}

describe("fillAgainstBar", () => {
  it("fills a buy limit at the limit when the bar trades through", () => {
    assert.equal(fillAgainstBar(order({ price: 100 }), bar(101, 102, 99, 100.5)), 100);
  });
  it("fills a buy limit at the open when the bar gaps below it", () => {
    assert.equal(fillAgainstBar(order({ price: 100 }), bar(99, 99.5, 98, 99)), 99);
  });
  it("does not fill a buy limit the bar never reaches", () => {
    assert.equal(fillAgainstBar(order({ price: 100 }), bar(101, 102, 100.5, 101)), null);
  });
  it("fills a marketable sell limit at the open", () => {
    assert.equal(fillAgainstBar(order({ side: "sell", kind: "exit", price: 97.5 }), bar(99, 99.5, 98, 99)), 99);
  });
  it("fills a sell stop at the trigger when the bar crosses it", () => {
    assert.equal(fillAgainstBar(order({ side: "sell", kind: "stop", trigger: 100, price: 99.8, orderType: "SL-L" }), bar(100.5, 101, 99.5, 99.7)), 100);
  });
  it("leaves a sell stop-limit unfilled when the bar gaps below its limit and never recovers", () => {
    assert.equal(fillAgainstBar(order({ side: "sell", kind: "stop", trigger: 100, price: 99.8, orderType: "SL-L" }), bar(99, 99.5, 98, 98.5)), null);
  });
  it("fills a gapped sell stop-limit at its limit if the bar trades back up to it", () => {
    assert.equal(fillAgainstBar(order({ side: "sell", kind: "stop", trigger: 100, price: 99.8, orderType: "SL-L" }), bar(99, 100, 98, 99.5)), 99.8);
  });
  it("treats an already-triggered stop as a plain limit on later bars", () => {
    const o = order({ side: "sell", kind: "stop", trigger: 100, price: 99.8, orderType: "SL-L", triggeredAt: 1 });
    assert.equal(fillAgainstBar(o, bar(99, 99.5, 98, 99)), null);
    assert.equal(fillAgainstBar(o, bar(99.9, 100.2, 99.5, 100)), 99.9);
  });
  it("mirrors the logic for a buy stop (short exit)", () => {
    const o = order({ side: "buy", kind: "stop", trigger: 100, price: 100.2, orderType: "SL-L" });
    assert.equal(fillAgainstBar(o, bar(99.5, 100.5, 99, 100.1)), 100);
    assert.equal(fillAgainstBar(o, bar(101, 102, 100.5, 101.5)), null);
  });
});
