import "./helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { equityFillCost, optionsFillCost } from "../src/costs.js";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

describe("equityFillCost (intraday, per ₹1,00,000 turnover)", () => {
  it("charges stamp duty on the buy and no STT", () => {
    // exchange 2.97 + SEBI 0.10 + stamp 3.00 + GST 18% of (2.97 + 0.10)
    close(equityFillCost("buy", 100, 1000), 2.97 + 0.1 + 3 + (2.97 + 0.1) * 0.18);
  });
  it("charges STT on the sell and no stamp duty", () => {
    close(equityFillCost("sell", 100, 1000), 25 + 2.97 + 0.1 + (2.97 + 0.1) * 0.18);
  });
});

describe("optionsFillCost (per ₹1,00,000 premium)", () => {
  it("charges STT only on the sell", () => {
    const buy = optionsFillCost("buy", 1000, 100);
    const sell = optionsFillCost("sell", 1000, 100);
    close(sell - buy, 100 - 3);
  });
});
