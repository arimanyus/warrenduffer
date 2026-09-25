import "./helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { kotakRefusal, parseKotakCandles, parseKotakOrders, parseKotakPositions } from "../src/kotak/parse.js";

describe("parseKotakOrders", () => {
  it("reads the average price once filled and the limit before", () => {
    const [filled, working] = parseKotakOrders({
      data: [
        { nOrdNo: "1", trdSym: "INFY-EQ", ordSt: "complete", qty: 10, fldQty: 10, prc: "1500.00", avgPrc: "1499.35", trnsTp: "B", prod: "MIS", ig: "wdeabc", usrId: "AB1234" },
        { nOrdNo: "2", trdSym: "INFY-EQ", ordSt: "open", qty: 10, fldQty: 0, prc: "1490.00", avgPrc: "0", trnsTp: "S", prod: "MIS", ig: "wdsdef", usrId: "AB1234" },
      ],
    });
    assert.equal(filled.price, 1499.35);
    assert.equal(working.price, 1490);
    assert.equal(filled.symbol, "INFY");
    assert.equal(working.side, "sell");
  });

  it("reads the tag we sent, never the user id", () => {
    const [o] = parseKotakOrders({ data: [{ nOrdNo: "1", ig: "wdeabc", usrId: "AB1234", ordSt: "open" }] });
    assert.equal(o.tag, "wdeabc");
    const [noTag] = parseKotakOrders({ data: [{ nOrdNo: "2", usrId: "AB1234", ordSt: "open" }] });
    assert.equal(noTag.tag, "");
  });
});

describe("parseKotakPositions", () => {
  it("keeps flat rows and computes realised P&L from the day's amounts", () => {
    const [flat, open] = parseKotakPositions({
      data: [
        { trdSym: "INFY-EQ", tok: "1", exSeg: "nse_cm", prod: "MIS", flBuyQty: "10", flSellQty: "10", buyAmt: "15000", sellAmt: "14880" },
        { trdSym: "TCS-EQ", tok: "2", exSeg: "nse_cm", prod: "MIS", flBuyQty: "10", flSellQty: "4", buyAmt: "35000", sellAmt: "14040" },
      ],
    });
    assert.equal(flat.qty, 0);
    assert.equal(flat.realisedPnl, -120);
    assert.equal(open.qty, 6);
    // matched 4 × (3510 − 3500)
    assert.equal(open.realisedPnl, 40);
    assert.equal(open.avgPrice, 3500);
  });

  it("leaves realised undefined when the row has no amounts", () => {
    const [p] = parseKotakPositions({ data: [{ trdSym: "INFY-EQ", flBuyQty: 5, flSellQty: 0, avgPrc: 1500 }] });
    assert.equal(p.realisedPnl, undefined);
    assert.equal(p.avgPrice, 1500);
  });
});

describe("kotakRefusal", () => {
  it("treats HTTP-200 Not_Ok bodies as refusals", () => {
    assert.equal(kotakRefusal({ stat: "Ok", stCode: 200, nOrdNo: "1" }), null);
    assert.equal(kotakRefusal({ result: "ok" }), null);
    assert.match(kotakRefusal({ stat: "Not_Ok", stCode: 1020, emsg: "Order not found" }) ?? "", /Order not found/);
    assert.ok(kotakRefusal({ stCode: 5203 }));
  });
});

describe("parseKotakCandles", () => {
  it("reads offset-less timestamps as IST regardless of the host timezone", () => {
    const [c] = parseKotakCandles({ data: [["2026-09-15 09:15:00", 1, 2, 0.5, 1.5, 100]] });
    assert.equal(new Date(c.ts).toISOString(), "2026-09-15T03:45:00.000Z");
  });
});
