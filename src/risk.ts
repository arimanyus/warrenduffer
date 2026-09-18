import { cfg, risk } from "./config.js";
import { todayEntries, todayFriction, todayPnl } from "./db.js";
import type { OpenPosition, PositionSide, Quote, Tier } from "./types.js";

export function stopBps(atr1m: number, price: number): number | null {
  if (!price) return null;
  const atrBps = (atr1m / price) * 1e4;
  const s = atrBps * risk.stopAtrMult;
  if (s > risk.maxStopBps) return null;
  return clamp(s, risk.minStopBps, risk.maxStopBps);
}

export function sizeQty(price: number, stopBpsV: number, tier: Tier): number {
  if (cfg.mode === "live" && cfg.liveQty > 0) return Math.max(1, Math.floor(cfg.liveQty));
  const riskQty = cfg.riskPerTrade / ((stopBpsV * price) / 1e4);
  const notionalQty = cfg.maxNotional / price;
  const mult = tier === "A" ? 1 : 0.5;
  return Math.max(0, Math.floor(Math.min(riskQty, notionalQty) * mult));
}

export function stopPrice(side: PositionSide, entry: number, stopBpsV: number, tick: number): number {
  const dist = (entry * stopBpsV) / 1e4;
  const raw = side === "long" ? entry - dist : entry + dist;
  return roundTick(raw, tick);
}

export function targetPrice(side: PositionSide, entry: number, stopBpsV: number, tick: number): number {
  return stopPrice(side === "long" ? "short" : "long", entry, stopBpsV * risk.targetMult, tick);
}

export function roundTick(price: number, tick: number): number {
  if (!tick) return price;
  return Math.round(price / tick) * tick;
}

export function canEnterMore(openCount: number, halfSize = false): { ok: boolean; reason: string } {
  if (openCount >= cfg.maxPositions) return { ok: false, reason: "max_positions" };
  if (todayPnl() <= -cfg.dailyLossCap) return { ok: false, reason: "daily_loss_cap" };
  const friction = todayFriction();
  if (friction >= cfg.dailyFrictionBudget) return { ok: false, reason: "friction_budget" };
  if (halfSize && friction >= cfg.dailyFrictionBudget) return { ok: false, reason: "friction_budget" };
  return { ok: true, reason: "" };
}

export function entriesUsed(): number {
  return todayEntries();
}

export function optionLossToday(trades: { leg: string; pnl: number }[]): number {
  return trades.filter((t) => t.leg === "options").reduce((s, t) => s + t.pnl, 0);
}

export function unrealized(pos: OpenPosition, q: Quote): number {
  const px = q.ltp || (pos.side === "long" ? q.bid : q.ask);
  const signed = pos.side === "long" ? 1 : -1;
  return (px - pos.entryPrice) * pos.qty * signed;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
