import { cfg } from "../src/config.js";
import { KotakClient } from "../src/kotak/client.js";
import { INDEX_TOKEN, NIFTY50 } from "../src/kotak/scrip.js";
import { CandlesFeed } from "../src/data/feed.js";
import { seedBars } from "../src/data/bars.js";
import { buildFeatures, buildIndexFeatures } from "../src/data/features.js";
import { createModel } from "../src/model/index.js";
import { runStage1, runStage2 } from "../src/strategy/continuation.js";
import { addDays, istDateStr } from "../src/time.js";
import { stopBps } from "../src/risk.js";
import type { Bar } from "../src/types.js";

async function main(): Promise<void> {
  const client = new KotakClient();
  await client.login();
  await client.loadScrips();
  const to = istDateStr();
  const from = addDays(to, -29);
  const series = new Map<string, Bar[]>();
  const symbols = [...NIFTY50];
  for (const sym of symbols) {
    const inst = client.getInstrument(sym);
    if (!inst) continue;
    try {
      const rows = await client.candles(inst.token, "nse_cm", from, to, "1min");
      series.set(sym, rows.map((r) => ({ symbol: sym, ...r })));
      console.log(sym, rows.length);
    } catch (e) {
      console.error(sym, e);
    }
  }
  try {
    const nifty = await client.candles(INDEX_TOKEN, "nse_cm", from, to, "1min");
    series.set(INDEX_TOKEN, nifty.map((r) => ({ symbol: INDEX_TOKEN, ...r })));
  } catch (e) {
    console.error("nifty", e);
  }

  const feed = new CandlesFeed(series);
  const model = createModel();
  const buckets = new Map<string, { n: number; win: number }>();
  const niftyB: Record<string, { n: number; win: number }> = {};
  const scores: Record<string, { hi: number; lo: number; nHi: number; nLo: number }> = {};
  const n = feed.maxLen();
  console.log("bars", n, "model", model.name);
  for (let i = 80; i < n - 30; i += 5) {
    const quotes = feed.at(i);
    for (const [sym, bars] of series) seedBars(sym, bars.slice(0, i + 1));
    const feats = [];
    for (const [sym, q] of quotes) {
      if (sym === INDEX_TOKEN) continue;
      const f = buildFeatures(sym, q);
      if (f) feats.push(f);
    }
    if (feats.length < 5) continue;
    const above = feats.filter((f) => f.vwapDist.label === "above" || f.vwapDist.label === "far_above").length;
    const index = buildIndexFeatures(quotes.get(INDEX_TOKEN), 0, above / feats.length);
    const s1 = await runStage1(model, feats, index);
    if (!s1) continue;
    bump(niftyB, bucket(s1.niftyLong), continued(series.get(INDEX_TOKEN), i, 1));
    bump(niftyB, "short-" + bucket(s1.niftyShort), continued(series.get(INDEX_TOKEN), i, -1));
    for (const r of [...s1.longs, ...s1.shorts].slice(0, 4)) {
      const f = feats.find((x) => x.symbol === r.symbol);
      if (!f) continue;
      const c = await runStage2(model, f, index, r.side);
      if (!c) continue;
      const win = continued(series.get(c.symbol), i, c.side === "long" ? 1 : -1, f.last, f.atr1m);
      const key = bucket(c.setupProb);
      const b = buckets.get(key) ?? { n: 0, win: 0 };
      b.n++;
      if (win) b.win++;
      buckets.set(key, b);
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
  }

  console.log("\n=== setup probability buckets (continuation next 30m +1R before -1R) ===");
  console.log("CAVEAT: candles only, no book/flow. Catches no-signal models, not weak-signal ones.");
  const keys = [...buckets.keys()].sort();
  for (const k of keys) {
    const b = buckets.get(k)!;
    console.log(k, b.n, ((b.win / b.n) * 100).toFixed(1) + "%");
  }
  if (keys.length >= 2) {
    const top = buckets.get(keys.at(-1)!)!;
    const bot = buckets.get(keys[0]!)!;
    const gap = top.win / top.n - bot.win / bot.n;
    console.log("top-bottom gap", (gap * 100).toFixed(1), "pp", gap >= 0.1 ? "PASS" : "FAIL");
  }
  console.log("\n=== nifty noul buckets ===");
  for (const [k, v] of Object.entries(niftyB)) console.log(k, v.n, v.n ? ((v.win / v.n) * 100).toFixed(1) + "%" : "");
  console.log("\n=== score information ===");
  for (const [k, v] of Object.entries(scores)) {
    const hi = v.nHi ? v.hi / v.nHi : 0;
    const lo = v.nLo ? v.lo / v.nLo : 0;
    console.log(k, "hi", (hi * 100).toFixed(1), "lo", (lo * 100).toFixed(1));
  }
  console.log("suggested: keep thresholds in risk.json if gap >= 10pp, else stop and rethink.");
  void cfg;
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

function continued(bars: Bar[] | undefined, i: number, dir: number, px?: number, atr?: number): boolean {
  if (!bars || !bars[i]) return false;
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

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
