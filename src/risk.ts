import { cfg, risk } from "./config.js";
import type { OpenPosition, PositionSide, Quote, Side, Tier } from "./types.js";

export function stopBps(atr1m: number, price: number): number | null {
  if (!price) return null;
  const atrBps = (atr1m / price) * 1e4;
  const s = atrBps * risk.stopAtrMult;
  if (s > risk.maxStopBps) return null;
  return clamp(s, risk.minStopBps, risk.maxStopBps);
}

/** Rupee risk per trade scales with the capital box; RISK_PER_TRADE is the floor. */
export function riskPerTrade(capital: number): number {
  return Math.max(cfg.riskPerTrade, capital * cfg.riskPct);
}

export function sizeQty(price: number, stopBpsV: number, tier: Tier, remainingCapital: number, capital: number): number {
  if (remainingCapital < price) return 0;
  if (cfg.liveQty > 0) return Math.max(0, Math.min(Math.floor(cfg.liveQty), Math.floor(remainingCapital / price)));
  const riskQty = riskPerTrade(capital) / ((stopBpsV * price) / 1e4);
  const notionalQty = Math.min(cfg.maxNotional, remainingCapital) / price;
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

/** Snap to tick and strip float residue (715.9000000000001 would be rejected by Kotak). */
export function roundTick(price: number, tick: number): number {
  if (!tick) return Math.round(price * 100) / 100;
  return Math.round(Math.round(price / tick) * tick * 100) / 100;
}

/** Snap to tick, never rounding toward the given direction's opposite (a marketable sell must not round up). */
export function roundTickDir(price: number, tick: number, dir: "up" | "down"): number {
  const t = tick || 0.01;
  const steps = price / t;
  // 1e-9 absorbs float residue so an exact multiple stays put.
  const n = dir === "up" ? Math.ceil(steps - 1e-9) : Math.floor(steps + 1e-9);
  return Math.round(n * t * 100) / 100;
}

/** Stop-limit price: at least 3 ticks, or stopLimitBufferBps, beyond the trigger. */
export function stopLimitPrice(side: PositionSide, trigger: number, tick: number): number {
  const t = tick || 0.05;
  const buffer = Math.max(3 * t, (trigger * risk.stopLimitBufferBps) / 1e4);
  return side === "long" ? roundTickDir(trigger - buffer, t, "down") : roundTickDir(trigger + buffer, t, "up");
}

/** A limit priced marketableBps through the touch (and at least one tick), so it fills like a market order with a cap. */
export function marketablePrice(side: Side, q: Pick<Quote, "bid" | "ask" | "ltp" | "tickSize">): number {
  const tick = q.tickSize || 0.05;
  const bps = risk.marketableBps / 1e4;
  if (side === "sell") {
    const base = q.bid || q.ltp;
    return Math.max(tick, roundTickDir(Math.min(base * (1 - bps), base - tick), tick, "down"));
  }
  const base = q.ask || q.ltp;
  return roundTickDir(Math.max(base * (1 + bps), base + tick), tick, "up");
}

export function canEnterMore(openCount: number, dayPnl: number): { ok: boolean; reason: string } {
  if (openCount >= cfg.maxPositions) return { ok: false, reason: "max_positions" };
  if (dayPnl <= -cfg.dailyLossCap) return { ok: false, reason: "daily_loss_cap" };
  return { ok: true, reason: "" };
}

export function positionNotional(pos: OpenPosition): number {
  return pos.qty * pos.entryPrice;
}

/** Gross P&L already booked by partial exits of a still-open position. */
export function partialRealised(pos: OpenPosition): number {
  const signed = pos.side === "long" ? 1 : -1;
  return (pos.exitNotional - pos.closedQty * pos.entryPrice) * signed;
}

/** Mark-to-market of the still-open quantity only, at LTP (before charges). */
export function openMtm(pos: OpenPosition, q: Quote): number {
  const px = q.ltp || (pos.side === "long" ? q.bid : q.ask);
  const signed = pos.side === "long" ? 1 : -1;
  return (px - pos.entryPrice) * (pos.qty - pos.closedQty) * signed;
}

/** Whole-position P&L: booked partials plus the open remainder. Not for the loss cap, whose realised side already counts partials. */
export function unrealized(pos: OpenPosition, q: Quote): number {
  return partialRealised(pos) + openMtm(pos, q);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
