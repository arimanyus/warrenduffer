/**
 * Gate 1: does Jev's `setup` probability carry information on the last ~30 days of 1-min bars?
 *
 *   pnpm calibrate                 # every 10th bar, ~1 hour with Jev
 *   pnpm calibrate -- --step 20    # faster, fewer samples
 *   pnpm calibrate -- --days 10
 *   pnpm calibrate -- --nofetch     # DB bars only, no broker calls
 *
 * Runs stage 1 + stage 2 on a virtual clock (no look-ahead), labels each candidate by whether price
 * reached +1R before −1R in the next 30 minutes. Bars are stored in the live DB, which also serves as warm-up.
 * Caveat: candles carry no book or flow, so this catches a model with no signal, not one with weak signal.
 */
import { createBroker } from "../src/broker.js";
import { INDEX_TOKEN, NIFTY50 } from "../src/symbols.js";
import { CandlesFeed } from "../src/data/feed.js";
import { db, setDecisionStagePrefix } from "../src/db.js";
import { buildFeatures, buildIndexFeatures } from "../src/data/features.js";
import { createModel } from "../src/model/index.js";
import { runStage1, runStage2 } from "../src/strategy/continuation.js";
import { addDays, istDateStr, useVirtualClock } from "../src/time.js";
import { stopBps } from "../src/risk.js";
import type { Bar } from "../src/types.js";

const args = parseArgs(process.argv.slice(2));
const STEP = Math.max(1, Number(args.step ?? 10));
const DAYS = Math.min(29, Math.max(3, Number(args.days ?? 29)));

async function main(): Promise<void> {
  setDecisionStagePrefix("cal:");
  const client = createBroker();
  await client.login();
  await client.loadScrips();
  const to = istDateStr();
  const from = addDays(to, -DAYS);
  const fromMs = Date.parse(`${from}T00:00:00+05:30`);
  const series = new Map<string, Bar[]>();
  const selectBars = db.prepare("SELECT symbol, ts, open, high, low, close, volume FROM bars_1m WHERE symbol = ? AND ts >= ? ORDER BY ts");
  let fetched = 0;
  for (const sym of [...NIFTY50, INDEX_TOKEN]) {
    const inst = client.getInstrument(sym);
    if (!inst) continue;
    // Reuse what the DB already has (warm-up or a previous run); Kotak throttles repeated 30-day pulls hard.
    const have = selectBars.all(sym, fromMs) as Bar[];
    const lastTs = have.at(-1)?.ts ?? 0;
    const stale = Date.now() - lastTs > 30 * 60_000;
    if (have.length > 300 && !stale) {
      series.set(sym, have);
      process.stdout.write(`${sym} ${have.length}(db)  `);
      continue;
    }
    if (args.nofetch) {
      if (have.length) series.set(sym, have);
      process.stdout.write(`${sym} ${have.length}(db,stale)  `);
      continue;
    }
    try {
      const fetchFrom = have.length > 300 ? istDateStr(lastTs) : from;
      const rows = await client.candles(inst.token, "nse_cm", fetchFrom, to, "1min");
      fetched++;
      const merged = new Map<number, Bar>(have.map((b) => [b.ts, b]));
      for (const r of rows) merged.set(r.ts, { symbol: sym, ...r });
      series.set(sym, [...merged.values()].sort((a, b) => a.ts - b.ts));
      process.stdout.write(`${sym} ${series.get(sym)!.length}(+${rows.length})  `);
    } catch (e) {
      if (have.length) series.set(sym, have);
      console.error(`\n${sym} fetch failed, using ${have.length} db bars: ${String(e).slice(0, 120)}`);
    }
  }
  console.log(`\n${fetched} symbols fetched from broker, rest from DB`);

  // Seeds all bars once (in a transaction). loadBars() filters by the virtual clock, so there is no look-ahead.
  db.transaction(() => new CandlesFeed(series))();
  const timeline = [...new Set([...series.values()].flatMap((b) => b.map((x) => x.ts)))].sort((a, b) => a - b);
  const model = createModel();
  const vclock = useVirtualClock(timeline[0]);
  const buckets = new Map<string, { n: number; win: number }>();
  const niftyB: Record<string, { n: number; win: number }> = {};
  const scores: Record<string, { hi: number; lo: number; nHi: number; nLo: number }> = {};
  const passing = { n: 0, win: 0 };
  let errors = 0;
  let s1Candidates = 0;
  const total = Math.floor((timeline.length - 110) / STEP);
  console.log(`bars ${timeline.length} model ${model.name} step ${STEP} → ~${total} evaluations`);

  let done = 0;
  for (let i = 80; i < timeline.length - 30; i += STEP) {
    const t = timeline[i];
    vclock.set(t + 59_000);
    const quotes = quotesAt(series, t);
    const feats = [];
    for (const [sym, q] of quotes) {
      if (sym === INDEX_TOKEN) continue;
      const f = buildFeatures(sym, q);
      if (f) feats.push(f);
    }
    if (feats.length < 5) continue;
    const above = feats.filter((f) => f.vwapDist.label === "above" || f.vwapDist.label === "far_above").length;
    const index = buildIndexFeatures(quotes.get(INDEX_TOKEN), 0, above / feats.length);
    const s1 = await runStage1(model, feats, index, { candlesOnly: true });
    if (!s1) {
      errors++;
      continue;
    }
    bump(niftyB, "long-" + bucket(s1.niftyLong), continued(series.get(INDEX_TOKEN), t, 1));
    bump(niftyB, "short-" + bucket(s1.niftyShort), continued(series.get(INDEX_TOKEN), t, -1));
    s1Candidates += s1.longs.length + s1.shorts.length;
    for (const r of [...s1.longs, ...s1.shorts].slice(0, 4)) {
      const f = feats.find((x) => x.symbol === r.symbol);
      if (!f) continue;
      const c = await runStage2(model, f, index, r.side, { candlesOnly: true });
      if (!c) {
        errors++;
        continue;
      }
      const win = continued(series.get(c.symbol), t, c.side === "long" ? 1 : -1, f.last, f.atr1m);
      // Bucket by the probability Jev gave the *wanted* side, whether or not it was the chosen class.
      const pWanted = c.setup === (c.side === "long" ? "long_continuation" : "short_continuation") ? c.setupProb : 1 - c.setupProb;
      const b = buckets.get(bucket(pWanted)) ?? { n: 0, win: 0 };
      b.n++;
      if (win) b.win++;
      buckets.set(bucket(pWanted), b);
      if (c.passes) {
        passing.n++;
        if (win) passing.win++;
      }
      for (const [sk, sv] of Object.entries(c.scores)) {
        const rec = scores[sk] ?? { hi: 0, lo: 0, nHi: 0, nLo: 0 };
        if (sv >= 0.66) {
          rec.nHi++;
          if (win) rec.hi++;
        } else {
          rec.nLo++;
          if (win) rec.lo++;
        }
        scores[sk] = rec;
      }
    }
    if (++done % 25 === 0) {
      const n = [...buckets.values()].reduce((s, b) => s + b.n, 0);
      console.log(`${done}/${total} · ${istDateStr(t)} · stage1 picks ${s1Candidates} · labelled ${n} · would-trade ${passing.n} · jev errors ${errors}`);
    }
  }
  console.log(`\njev errors: ${errors} (see decisions table, question='_error', for the messages)`);

  console.log("\n=== setup probability buckets (reached +1R before −1R within 30 min) ===");
  console.log("CAVEAT: candles only, no book/flow. Catches no-signal models, not weak-signal ones.");
  const keys = [...buckets.keys()].sort();
  for (const k of keys) {
    const b = buckets.get(k)!;
    console.log(k.padEnd(10), String(b.n).padStart(5), ((b.win / b.n) * 100).toFixed(1) + "%");
  }
  if (keys.length >= 2) {
    const top = buckets.get(keys.at(-1)!)!;
    const bot = buckets.get(keys[0]!)!;
    const gap = top.win / top.n - bot.win / bot.n;
    console.log("top-bottom gap", (gap * 100).toFixed(1), "pp", gap >= 0.1 ? "PASS" : "FAIL");
  } else {
    console.log("not enough buckets populated to judge");
  }
  console.log(`\n=== candidates that would pass the live gates ===\n${passing.n} trades, ${passing.n ? ((passing.win / passing.n) * 100).toFixed(1) : "–"}% reached +1R first (breakeven ≈ 50% at 2R... but with no target, judge vs the bottom bucket)`);
  console.log("\n=== nifty noul buckets ===");
  for (const [k, v] of Object.entries(niftyB).sort()) console.log(k.padEnd(18), String(v.n).padStart(5), v.n ? ((v.win / v.n) * 100).toFixed(1) + "%" : "");
  console.log("\n=== score information (hit rate when score ≥0.66 vs below) ===");
  for (const [k, v] of Object.entries(scores)) {
    const hi = v.nHi ? v.hi / v.nHi : 0;
    const lo = v.nLo ? v.lo / v.nLo : 0;
    console.log(k.padEnd(16), "hi", (hi * 100).toFixed(1).padStart(5), `(${v.nHi})`, "lo", (lo * 100).toFixed(1).padStart(5), `(${v.nLo})`);
  }
  console.log("\nGate 1 passes if the top setup bucket beats the bottom by ≥10pp. Otherwise stop and rethink.");
}

function quotesAt(series: Map<string, Bar[]>, t: number) {
  const out = new Map<string, import("../src/types.js").Quote>();
  for (const [symbol, bars] of series) {
    let b: Bar | undefined;
    for (let k = bars.length - 1; k >= 0; k--) {
      if (bars[k].ts <= t) {
        b = bars[k];
        break;
      }
    }
    if (!b) continue;
    out.set(symbol, {
      symbol,
      token: symbol,
      segment: "nse_cm",
      ts: t,
      ltp: b.close,
      ltq: 0,
      volume: b.volume,
      bid: b.close,
      ask: b.close,
      tbq: 0,
      tsq: 0,
      bids: [],
      asks: [],
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      tickSize: 0.05,
    });
  }
  return out;
}

function bucket(p: number): string {
  if (p >= 0.8) return "0.80+";
  if (p >= 0.7) return "0.70-0.80";
  if (p >= 0.6) return "0.60-0.70";
  if (p >= 0.5) return "0.50-0.60";
  return "<0.50";
}

function bump(m: Record<string, { n: number; win: number }>, k: string, win: boolean): void {
  const b = m[k] ?? { n: 0, win: 0 };
  b.n++;
  if (win) b.win++;
  m[k] = b;
}

/** +1R before −1R over the next 30 bars after time t. */
function continued(bars: Bar[] | undefined, t: number, dir: number, px?: number, atr?: number): boolean {
  if (!bars) return false;
  const i = bars.findIndex((b) => b.ts === t);
  if (i < 0) return false;
  const entry = px ?? bars[i].close;
  const sb = stopBps(atr ?? entry * 0.001, entry) ?? 12;
  const dist = (entry * sb) / 1e4;
  const tgt = entry + dir * dist;
  const stp = entry - dir * dist;
  for (let k = i + 1; k < Math.min(bars.length, i + 31); k++) {
    const b = bars[k];
    if (dir > 0) {
      if (b.low <= stp) return false;
      if (b.high >= tgt) return true;
    } else {
      if (b.high >= stp) return false;
      if (b.low <= tgt) return true;
    }
  }
  return false;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "1";
  }
  return out;
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
