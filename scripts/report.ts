import { allTrades, db } from "../src/db.js";
import { equityRoundTripBps } from "../src/kotak/costs.js";

function main(): void {
  const trades = allTrades();
  if (!trades.length) {
    console.log("no trades yet");
    return;
  }
  const equity = trades.filter((t) => t.leg === "equity");
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const exp = mean(trades.map((t) => t.pnl));
  const hit = wins.length / trades.length;
  const be = 0.5;
  const gp = sum(wins.map((t) => t.pnl));
  const gl = Math.abs(sum(losses.map((t) => t.pnl))) || 1;
  const pf = gp / gl;
  const dd = maxDd(trades.map((t) => t.pnl));
  const days = new Set(trades.map((t) => t.date)).size;
  console.log("=== summary ===");
  console.log("trades", trades.length, "days", days);
  console.log("expectancy", exp.toFixed(2), "hit", (hit * 100).toFixed(1) + "%", "breakeven", (be * 100).toFixed(0) + "%");
  console.log("profit factor", pf.toFixed(2), "max dd", dd.toFixed(0));
  console.log("net", sum(trades.map((t) => t.pnl)).toFixed(0), "friction", sum(trades.map((t) => t.friction)).toFixed(0));
  console.log("equity round-trip bps (model)", equityRoundTripBps().toFixed(2));

  group("leg", trades, (t) => t.leg);
  group("symbol", equity, (t) => t.symbol);
  group("hour", trades, (t) => new Date(t.opened_at).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hourCycle: "h23" }));
  group("tier", trades, (t) => t.tier);
  group("regime", trades, (t) => t.regime || "?");
  group("attribution", trades, (t) => t.attribution || "?");

  console.log("\n=== expectancy vs trades/day ===");
  const byDay = new Map<string, { n: number; pnl: number }>();
  for (const t of trades) {
    const d = byDay.get(t.date) ?? { n: 0, pnl: 0 };
    d.n++;
    d.pnl += t.pnl;
    byDay.set(t.date, d);
  }
  const buckets = [
    { lo: 1, hi: 4 },
    { lo: 5, hi: 8 },
    { lo: 9, hi: 16 },
    { lo: 17, hi: 99 },
  ];
  for (const b of buckets) {
    const daysIn = [...byDay.values()].filter((d) => d.n >= b.lo && d.n <= b.hi);
    if (!daysIn.length) continue;
    const e = mean(daysIn.map((d) => d.pnl / d.n));
    console.log(`${b.lo}-${b.hi} tpd`, daysIn.length, "days", "E/trade", e.toFixed(2));
  }

  console.log("\n=== live calibration (setup answers) ===");
  const decs = db
    .prepare("SELECT probability, answer FROM decisions WHERE stage='stage2' AND question='setup' ORDER BY id")
    .all() as { probability: number; answer: string }[];
  console.log("stage2 setup rows", decs.length, "(join to next-bar outcomes in calibrate.ts for offline study)");
}

function group<T>(title: string, rows: T[], key: (t: T) => string): void {
  const m = new Map<string, { n: number; pnl: number; w: number }>();
  for (const t of rows) {
    const k = key(t);
    const r = m.get(k) ?? { n: 0, pnl: 0, w: 0 };
    r.n++;
    r.pnl += (t as { pnl: number }).pnl;
    if ((t as { pnl: number }).pnl > 0) r.w++;
    m.set(k, r);
  }
  console.log("\n===", title, "===");
  for (const [k, v] of [...m.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(k.padEnd(16), v.n, "E", (v.pnl / v.n).toFixed(2), "hit", ((v.w / v.n) * 100).toFixed(0) + "%", "net", v.pnl.toFixed(0));
  }
}

function mean(xs: number[]): number {
  return xs.length ? sum(xs) / xs.length : 0;
}
function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
function maxDd(xs: number[]): number {
  let eq = 0;
  let peak = 0;
  let dd = 0;
  for (const x of xs) {
    eq += x;
    peak = Math.max(peak, eq);
    dd = Math.min(dd, eq - peak);
  }
  return dd;
}

main();
