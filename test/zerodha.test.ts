import "./helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { engineTag, kiteTag, marginCheck, orderForm, parseCandles, parseOrders, parsePositions } from "../src/zerodha/client.js";

describe("kite tags", () => {
  it("round-trips the stop prefix through the 20-char alphanumeric limit", () => {
    assert.equal(kiteTag("sl-12"), "SL12");
    assert.equal(engineTag("SL12"), "sl-12");
    assert.equal(kiteTag("exit-1234-jev_take_profit").length <= 20, true);
  });
});

describe("orderForm", () => {
  it("maps SL-L to SL with a trigger", () => {
    const f = orderForm({ segment: "nse_cm", tradingSymbol: "RELIANCE", side: "sell", qty: 5, price: 99.9, orderType: "SL-L", trigger: 100, tag: "sl-3" });
    assert.equal(f.order_type, "SL");
    assert.equal(f.trigger_price, "100.00");
    assert.equal(f.tag, "SL3");
    assert.equal(f.transaction_type, "SELL");
  });
  it("maps a limit with no trigger", () => {
    const f = orderForm({ segment: "nse_cm", tradingSymbol: "RELIANCE", side: "buy", qty: 1, price: 1234.5, tag: "x" });
    assert.equal(f.order_type, "LIMIT");
    assert.equal(f.trigger_price, undefined);
  });
});

describe("parsers", () => {
  it("prefers average_price for fills", () => {
    const [o] = parseOrders([{ order_id: "1", tradingsymbol: "INFY", status: "COMPLETE", quantity: 2, filled_quantity: 2, average_price: 1500.5, price: 1500, transaction_type: "BUY", tag: "SL9" }]);
    assert.equal(o.price, 1500.5);
    assert.equal(o.tag, "sl-9");
  });
  it("keeps flat positions so realised P&L is visible, and reads realised", () => {
    const ps = parsePositions({ net: [
      { tradingsymbol: "INFY", instrument_token: 1, exchange: "NSE", quantity: 0, average_price: 0, product: "MIS", realised: -120.5 },
      { tradingsymbol: "TCS", instrument_token: 2, exchange: "NSE", quantity: 3, average_price: 3500, product: "MIS", realised: 10 },
    ] });
    assert.equal(ps.length, 2);
    assert.equal(ps[0].realisedPnl, -120.5);
  });
  it("parses +0530 candle timestamps as IST", () => {
    const [c] = parseCandles({ candles: [["2026-09-15T09:15:00+0530", 1, 2, 0.5, 1.5, 100]] });
    assert.equal(new Date(c.ts).toISOString(), "2026-09-15T03:45:00.000Z");
  });
  it("marginCheck fails closed on unparseable numbers", () => {
    assert.equal(marginCheck([{}], { net: 100 }).ok, false);
  });
});
