import { cfg, risk } from "../config.js";
import type { OptionContract, Regime } from "../types.js";
import { istParts } from "../time.js";

export type OptionSignal = { right: "CE" | "PE" } | null;

export function optionSignal(args: {
  niftyLong: number;
  niftyShort: number;
  regime: Regime;
  riskOff: number;
}): OptionSignal {
  if (cfg.optionsMode === "off") return null;
  if (args.riskOff >= 0.5) return null;
  if (args.niftyLong >= risk.optionMinNoul && args.regime === "trend_up") return { right: "CE" };
  if (args.niftyShort >= risk.optionMinNoul && args.regime === "trend_down") return { right: "PE" };
  return null;
}

export function pickStrike(
  chain: OptionContract[],
  right: "CE" | "PE",
  spot: number,
  expiry: string,
): OptionContract | null {
  const p = istParts();
  if (expiry === `${p.y}-${pad(p.m)}-${pad(p.d)}` && p.hh * 60 + p.mm >= 13 * 60) return null;
  const side = chain.filter((c) => c.right === right && c.ltp >= 80 && c.ltp <= 250);
  // The chain endpoint has no bid/ask; when absent the spread is checked from the live quote at order time.
  const ok = side.filter((c) => {
    if (!c.bid || !c.ask) return true;
    const mid = (c.bid + c.ask) / 2;
    return (c.ask - c.bid) / mid <= 0.01;
  });
  if (!ok.length) return null;
  ok.sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
  const atm = ok[0];
  const otm = ok.find((c) => (right === "CE" ? c.strike > spot : c.strike < spot) && c !== atm);
  return otm ?? atm ?? null;
}

export function optionStops(entry: number): { stop: number; target: number } {
  return {
    stop: entry * (1 - risk.optionStopPct),
    target: entry * (1 + risk.optionTargetPct),
  };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
