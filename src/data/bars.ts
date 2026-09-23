import { upsertBar } from "../db.js";
import type { Bar, Quote } from "../types.js";

const openBars = new Map<string, Bar>();
const cumAtBarStart = new Map<string, number>();

export function barTs(ts: number): number {
  return Math.floor(ts / 60_000) * 60_000;
}

/** Quote.volume is the day's cumulative volume; bars store per-minute volume. */
export function applyQuoteToBar(q: Quote): Bar | null {
  if (!q.ltp) return null;
  const ts = barTs(q.ts);
  const key = q.symbol;
  let b = openBars.get(key);
  if (!b || b.ts !== ts) {
    if (b) upsertBar(b);
    cumAtBarStart.set(key, q.volume);
    b = { symbol: q.symbol, ts, open: q.ltp, high: q.ltp, low: q.ltp, close: q.ltp, volume: 0 };
    openBars.set(key, b);
    upsertBar(b);
    return b;
  }
  b.high = Math.max(b.high, q.ltp);
  b.low = Math.min(b.low, q.ltp);
  b.close = q.ltp;
  b.volume = Math.max(0, q.volume - (cumAtBarStart.get(key) ?? q.volume));
  upsertBar(b);
  return null;
}

export function flushBars(): void {
  for (const b of openBars.values()) upsertBar(b);
}

export function seedBars(symbol: string, bars: Bar[]): void {
  for (const b of bars) upsertBar(b);
}
