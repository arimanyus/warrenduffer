import { db } from "../db.js";
import type { Bar, Bucketed, IndexFeatures, Quote, SymbolFeatures } from "../types.js";
import { clock, istDateStr, istDayIndex, minutesOfDay } from "../time.js";

function bucketReturn(bps: number): Bucketed<"up" | "flat" | "down"> {
  if (bps > 8) return { value: bps, label: "up" };
  if (bps < -8) return { value: bps, label: "down" };
  return { value: bps, label: "flat" };
}

function bucketVwap(distBps: number, atrBps: number): SymbolFeatures["vwapDist"] {
  const u = Math.max(atrBps, 8);
  if (distBps > 2 * u) return { value: distBps, label: "far_above" };
  if (distBps > 0.5 * u) return { value: distBps, label: "above" };
  if (distBps < -2 * u) return { value: distBps, label: "far_below" };
  if (distBps < -0.5 * u) return { value: distBps, label: "below" };
  return { value: distBps, label: "near" };
}

function atr(bars: Bar[]): number {
  if (bars.length < 2) return bars[0] ? bars[0].high - bars[0].low : 0;
  let s = 0;
  const n = Math.min(14, bars.length - 1);
  for (let i = bars.length - n; i < bars.length; i++) {
    const prev = bars[i - 1] ?? bars[i];
    const b = bars[i];
    s += Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close));
  }
  return s / n;
}

/** Bars up to the clock. In replay the DB holds the whole day; this is what stops look-ahead. */
export function loadBars(symbol: string, limit = 400): Bar[] {
  return db
    .prepare("SELECT symbol, ts, open, high, low, close, volume FROM bars_1m WHERE symbol = ? AND ts <= ? ORDER BY ts DESC LIMIT ?")
    .all(symbol, clock.now(), limit)
    .reverse() as Bar[];
}

export function loadRecentSnaps(
  symbol: string,
  ms: number,
): { ts: number; ltp: number; volume: number; bid: number; ask: number; tbq: number; tsq: number }[] {
  return db
    .prepare("SELECT ts, ltp, volume, bid, ask, tbq, tsq FROM snapshots WHERE symbol = ? AND ts >= ? ORDER BY ts")
    .all(symbol, clock.now() - ms) as ReturnType<typeof loadRecentSnaps>;
}

/** Relative volume: today's volume so far vs the average of prior days to the same minute. Cached per symbol per day. */
const rvolProfile = new Map<string, { date: string; byMinute: Map<number, number>; days: number }>();

export function relativeVolume(symbol: string, todayBars: Bar[]): number {
  const date = istDateStr();
  let prof = rvolProfile.get(symbol);
  if (!prof || prof.date !== date) {
    const start = barDayStart();
    const rows = db
      .prepare("SELECT ts, volume FROM bars_1m WHERE symbol = ? AND ts < ? AND ts > ? ORDER BY ts")
      .all(symbol, start, start - 40 * 86400_000) as { ts: number; volume: number }[];
    const perDay = new Map<number, Map<number, number>>();
    for (const r of rows) {
      const d = istDayIndex(r.ts);
      const m = minutesOfDay(r.ts);
      const day = perDay.get(d) ?? new Map<number, number>();
      day.set(m, (day.get(m) ?? 0) + r.volume);
      perDay.set(d, day);
    }
    const byMinute = new Map<number, number>();
    const days = perDay.size;
    for (const day of perDay.values()) {
      let cum = 0;
      for (let m = 555; m <= 930; m++) {
        cum += day.get(m) ?? 0;
        byMinute.set(m, (byMinute.get(m) ?? 0) + cum / Math.max(1, days));
      }
    }
    prof = { date, byMinute, days };
    rvolProfile.set(symbol, prof);
  }
  if (prof.days < 3) return 1;
  const nowMin = minutesOfDay();
  const todayCum = todayBars.reduce((s, b) => s + b.volume, 0);
  const expected = prof.byMinute.get(Math.min(930, Math.max(555, nowMin))) ?? 0;
  if (expected <= 0) return 1;
  return todayCum / expected;
}

export function buildFeatures(symbol: string, quote: Quote): SymbolFeatures | null {
  const bars = loadBars(symbol, 120);
  if (!bars.length && !quote.ltp) return null;
  const last = quote.ltp || bars.at(-1)?.close || 0;
  if (!last) return null;
  const a = atr(bars) || last * 0.001;
  const atrBps = (a / last) * 1e4;
  const ret = (mins: number) => {
    const target = clock.now() - mins * 60_000;
    let b: Bar | undefined;
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i].ts <= target) {
        b = bars[i];
        break;
      }
    }
    b ??= bars[0];
    if (!b?.close) return 0;
    return ((last - b.close) / b.close) * 1e4;
  };
  const dayStart = barDayStart();
  const day = bars.filter((b) => b.ts >= dayStart);
  const hi = Math.max(quote.high || 0, ...day.map((b) => b.high), last);
  const lo = Math.min(quote.low || last, ...day.map((b) => b.low).filter((x) => x > 0), last);
  const range = hi - lo || last * 0.01;
  const vwap = sessionVwap(day, last);
  const vwapDistBps = ((last - vwap) / last) * 1e4;
  const vol5 = volSince(bars, 5);
  const vol15 = volSince(bars, 15);
  const prior10 = Math.max(vol15 - vol5, 1);
  const ratio = vol5 / (prior10 / 2);
  const bidQty = quote.bids.reduce((s, l) => s + l.qty, 0);
  const askQty = quote.asks.reduce((s, l) => s + l.qty, 0);
  const imb = bidQty + askQty > 0 ? (bidQty - askQty) / (bidQty + askQty) : 0;
  const tbqTsq = quote.tsq > 0 ? quote.tbq / quote.tsq : quote.tbq > 0 ? 2 : 1;
  const flow = flowShare(symbol);
  const rvol = relativeVolume(symbol, day);
  const last10 = bars.slice(-10).map((b) => `${hhmm(b.ts)} ${n(b.open)} ${n(b.high)} ${n(b.low)} ${n(b.close)} ${Math.round(b.volume)}`);
  return {
    symbol,
    token: quote.token,
    segment: quote.segment,
    ts: quote.ts,
    last,
    bid: quote.bid || last,
    ask: quote.ask || last,
    spreadBps: quote.ask && quote.bid ? ((quote.ask - quote.bid) / last) * 1e4 : 0,
    tickSize: quote.tickSize || 0.05,
    vwapDist: bucketVwap(vwapDistBps, atrBps),
    dayRangePos: {
      value: ((last - lo) / range) * 100,
      label: (last - lo) / range > 0.66 ? "upper" : (last - lo) / range < 0.33 ? "lower" : "middle",
    },
    returnsBps: {
      m1: bucketReturn(ret(1)),
      m5: bucketReturn(ret(5)),
      m15: bucketReturn(ret(15)),
      m60: bucketReturn(ret(60)),
    },
    volume: {
      rvol20d: rvol,
      last5mVsPrior15m: {
        value: ratio,
        label: ratio > 1.4 ? "heavy" : ratio < 0.7 ? "light" : "normal",
      },
    },
    book: {
      imbalance: imb,
      tbqTsqRatio: {
        value: tbqTsq,
        label: tbqTsq > 1.2 ? "buyers" : tbqTsq < 0.8 ? "sellers" : "balanced",
      },
    },
    flow5m: { upShare: flow, approximate: true },
    bars1m: last10,
    atr1m: a,
  };
}

export function buildIndexFeatures(nifty: Quote | undefined, futuresImb: number, breadth: number): IndexFeatures | null {
  if (!nifty && !breadth) return null;
  const last = nifty?.ltp ?? 0;
  const bars = loadBars("Nifty 50", 120);
  const ret = (mins: number) => {
    const target = clock.now() - mins * 60_000;
    let b: Bar | undefined;
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i].ts <= target) {
        b = bars[i];
        break;
      }
    }
    b ??= bars[0];
    if (!b?.close || !last) return 0;
    return ((last - b.close) / b.close) * 1e4;
  };
  const a = atr(bars) || last * 0.001;
  const m15 = ret(15);
  return {
    last,
    returnsBps: {
      m1: bucketReturn(ret(1)),
      m5: bucketReturn(ret(5)),
      m15: bucketReturn(m15),
    },
    extensionAtr: a ? Math.abs(m15) / ((a / last) * 1e4 || 1) : 0,
    breadthAboveVwap: breadth,
    futuresImbalance: futuresImb,
  };
}

export function stage1SymbolState(f: SymbolFeatures): Record<string, unknown> {
  return {
    sym: f.symbol,
    last: round(f.last, 2),
    spreadBps: round(f.spreadBps, 2),
    vwapDist: f.vwapDist.label,
    vwapBps: round(f.vwapDist.value, 0),
    dayRange: f.dayRangePos.label,
    m1: f.returnsBps.m1.label,
    m5: f.returnsBps.m5.label,
    m15: f.returnsBps.m15.label,
    m60: f.returnsBps.m60.label,
    m15Bps: round(f.returnsBps.m15.value, 0),
    volume: f.volume.last5mVsPrior15m.label,
    rvol: round(f.volume.rvol20d, 2),
    book: f.book.tbqTsqRatio.label,
    flow5m: f.flow5m.upShare > 0.55 ? "buyers" : f.flow5m.upShare < 0.45 ? "sellers" : "mixed",
  };
}

export function stage2State(f: SymbolFeatures, index: IndexFeatures | null, position: unknown, candlesOnly = false): Record<string, unknown> {
  const state: Record<string, unknown> = {
    symbol: f.symbol,
    time: hhmm(f.ts),
    dataset: candlesOnly ? "1-minute candles only; no order book, no trade flow" : "live quote with L5 book",
    last: f.last,
    bid: candlesOnly ? undefined : f.bid,
    ask: candlesOnly ? undefined : f.ask,
    spreadBps: candlesOnly ? undefined : round(f.spreadBps, 2),
    tickSize: f.tickSize,
    atrBps: round((f.atr1m / f.last) * 1e4, 1),
    vwapDist: f.vwapDist,
    dayRangePos: f.dayRangePos,
    returnsBps: {
      m1: round(f.returnsBps.m1.value, 0),
      m5: round(f.returnsBps.m5.value, 0),
      m15: round(f.returnsBps.m15.value, 0),
      m60: round(f.returnsBps.m60.value, 0),
      labels: {
        m1: f.returnsBps.m1.label,
        m5: f.returnsBps.m5.label,
        m15: f.returnsBps.m15.label,
        m60: f.returnsBps.m60.label,
      },
    },
    volume: {
      rvol: round(f.volume.rvol20d, 2),
      last5mVsPrior10m: f.volume.last5mVsPrior15m,
    },
    book: candlesOnly ? undefined : { imbalance: round(f.book.imbalance, 2), tbqTsq: f.book.tbqTsqRatio },
    flow5m: candlesOnly ? undefined : { upShare: round(f.flow5m.upShare, 2), approximate: true },
    bars1m: f.bars1m,
    barsFormat: "hh:mm open high low close volume",
    index: index && candlesOnly ? { ...index, futuresImbalance: undefined } : index,
    position,
  };
  for (const k of Object.keys(state)) if (state[k] === undefined) delete state[k];
  return state;
}

function sessionVwap(dayBars: Bar[], fallback: number): number {
  let pv = 0;
  let v = 0;
  for (const b of dayBars) {
    const tp = (b.high + b.low + b.close) / 3;
    pv += tp * (b.volume || 0);
    v += b.volume || 0;
  }
  if (v > 0) return pv / v;
  if (dayBars.length) return dayBars.reduce((s, b) => s + b.close, 0) / dayBars.length;
  return fallback;
}

function volSince(bars: Bar[], mins: number): number {
  const cut = clock.now() - mins * 60_000;
  let s = 0;
  for (const b of bars) if (b.ts >= cut) s += b.volume;
  return s;
}

function flowShare(symbol: string): number {
  const snaps = loadRecentSnaps(symbol, 5 * 60_000);
  let up = 0;
  let down = 0;
  for (let i = 1; i < snaps.length; i++) {
    const dvol = Math.max(0, snaps[i].volume - snaps[i - 1].volume);
    const dp = snaps[i].ltp - snaps[i - 1].ltp;
    if (dp > 0) up += dvol;
    else if (dp < 0) down += dvol;
  }
  const t = up + down;
  return t ? up / t : 0.5;
}

/** 09:15 IST of the IST calendar day containing `ms`. */
export function barDayStart(ms = clock.now()): number {
  return istDayIndex(ms) * 86400_000 - 5.5 * 3600_000 + (9 * 60 + 15) * 60_000;
}

function hhmm(ms: number): string {
  const m = minutesOfDay(ms);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function n(x: number): string {
  return x.toFixed(2);
}

function round(x: number, d: number): number {
  const p = 10 ** d;
  return Math.round(x * p) / p;
}
