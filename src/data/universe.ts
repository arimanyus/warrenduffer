import { db } from "../db.js";
import { contextFor } from "../db.js";
import type { Instrument, Quote } from "../types.js";
import { NIFTY50 } from "../symbols.js";
import { clock, istDateStr } from "../time.js";

export interface UniverseMember {
  symbol: string;
  token: string;
  segment: string;
  tickSize: number;
  tradingSymbol: string;
}

export function buildUniverse(args: {
  cash: Instrument[];
  quotes: Map<string, Quote>;
  openSymbols: Set<string>;
  cooldownMs: number;
}): UniverseMember[] {
  const ctx = contextFor(istDateStr());
  const out: UniverseMember[] = [];
  const wanted = new Set(NIFTY50);
  for (const i of args.cash) {
    if (!wanted.has(i.symbol as (typeof NIFTY50)[number]) && !wanted.has(i.symbol.replace(/&/g, "") as never)) {
      if (!NIFTY50.includes(i.symbol as (typeof NIFTY50)[number])) continue;
    }
    if (i.symbol === "Nifty 50") continue;
    const q = args.quotes.get(i.symbol);
    const px = q?.ltp ?? lastClose(i.symbol);
    if (px && px < 400) continue;
    const spread = medianSpread(i.symbol);
    if (spread !== null && spread > 3) continue;
    const adr = avgDailyRange(i.symbol);
    if (adr !== null && adr < 0.8) continue;
    const c = ctx.get(i.symbol);
    if (c?.exclude) continue;
    if (args.openSymbols.has(i.symbol)) continue;
    if (inCooldown(i.symbol, args.cooldownMs)) continue;
    out.push({
      symbol: i.symbol,
      token: i.token,
      segment: i.segment,
      tickSize: i.tickSize,
      tradingSymbol: i.tradingSymbol,
    });
  }
  return out;
}

function lastClose(symbol: string): number {
  const row = db.prepare("SELECT close FROM bars_1m WHERE symbol = ? AND ts <= ? ORDER BY ts DESC LIMIT 1").get(symbol, clock.now()) as
    | { close: number }
    | undefined;
  return row?.close ?? 0;
}

function medianSpread(symbol: string): number | null {
  const rows = db
    .prepare("SELECT bid, ask, ltp FROM snapshots WHERE symbol = ? AND ts <= ? ORDER BY ts DESC LIMIT 400")
    .all(symbol, clock.now()) as { bid: number; ask: number; ltp: number }[];
  const bps = rows
    .map((r) => (r.bid && r.ask && r.ltp ? ((r.ask - r.bid) / r.ltp) * 1e4 : 0))
    .filter((x) => x > 0)
    .sort((a, b) => a - b);
  if (bps.length < 20) return null;
  return bps[Math.floor(bps.length / 2)] ?? null;
}

function avgDailyRange(symbol: string): number | null {
  const rows = db
    .prepare("SELECT ts, high, low, close FROM bars_1m WHERE symbol = ? AND ts <= ? ORDER BY ts DESC LIMIT 8000")
    .all(symbol, clock.now()) as { ts: number; high: number; low: number; close: number }[];
  if (!rows.length) return null;
  const byDay = new Map<string, { h: number; l: number; c: number }>();
  for (const r of rows) {
    const day = new Date(r.ts).toISOString().slice(0, 10);
    const cur = byDay.get(day) ?? { h: r.high, l: r.low, c: r.close };
    cur.h = Math.max(cur.h, r.high);
    cur.l = Math.min(cur.l, r.low);
    cur.c = r.close;
    byDay.set(day, cur);
  }
  const days = [...byDay.values()].slice(0, 20);
  if (days.length < 5) return null;
  const avg = days.reduce((s, d) => s + ((d.h - d.l) / d.c) * 100, 0) / days.length;
  return avg;
}

function inCooldown(symbol: string, ms: number): boolean {
  const row = db.prepare("SELECT MAX(closed_at) AS t FROM trades WHERE symbol = ?").get(symbol) as { t: number | null };
  return !!row.t && clock.now() - row.t < ms;
}
