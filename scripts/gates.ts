import { allTrades, db } from "../src/db.js";

function main(): void {
  const trades = allTrades();
  const equity = trades.filter((t) => t.leg === "equity");
  const options = trades.filter((t) => t.leg === "options");
  const days = new Set(equity.map((t) => t.date)).size;
  const exp = equity.length ? equity.reduce((s, t) => s + t.pnl, 0) / equity.length : 0;
  const wins = equity.filter((t) => t.pnl > 0);
  const losses = equity.filter((t) => t.pnl < 0);
  const pf = (sum(wins.map((t) => t.pnl)) || 0) / (Math.abs(sum(losses.map((t) => t.pnl))) || 1);
  const dd = maxDd(equity.map((t) => t.pnl));

  const checks = [
    { id: 2, name: "20 paper days + 40 trades", pass: days >= 20 && equity.length >= 40, detail: `${days} days ${equity.length} trades` },
    { id: 3, name: "expectancy>0 and PF>=1.2", pass: exp > 0 && pf >= 1.2, detail: `E=${exp.toFixed(2)} PF=${pf.toFixed(2)}` },
    { id: 4, name: "max paper DD <= 3000", pass: dd >= -3000, detail: `dd=${dd.toFixed(0)}` },
  ];
  console.log("=== equity gates (run calibrate.ts for gate 1) ===");
  for (const c of checks) console.log(c.pass ? "PASS" : "FAIL", c.name, c.detail);
  console.log("gate 5: live calibration — compare setup buckets on paper decisions vs outcomes");
  console.log("gate 6: 5 days live at 1 share — manual");
  console.log("gate 7: first live month DAILY_LOSS_CAP=1000");
  if (checks[1]?.pass) console.log("unlock: DECISION_INTERVAL_S=30 and SFeed websocket");

  if (options.length) {
    const odays = new Set(options.map((t) => t.date)).size;
    const oexp = options.reduce((s, t) => s + t.pnl, 0) / options.length;
    const opf =
      (sum(options.filter((t) => t.pnl > 0).map((t) => t.pnl)) || 0) /
      (Math.abs(sum(options.filter((t) => t.pnl < 0).map((t) => t.pnl))) || 1);
    const odd = maxDd(options.map((t) => t.pnl));
    console.log("\n=== options paper gates ===");
    console.log(odays >= 20 && options.length >= 40 ? "PASS" : "FAIL", "20d/40t", odays, options.length);
    console.log(oexp > 0 && opf >= 1.3 ? "PASS" : "FAIL", "E/PF", oexp.toFixed(2), opf.toFixed(2));
    console.log(odd >= -4000 ? "PASS" : "FAIL", "dd", odd.toFixed(0));
  }

  const setup = db
    .prepare("SELECT COUNT(*) AS c FROM decisions WHERE stage='stage2' AND question='setup'")
    .get() as { c: number };
  console.log("\nstage2 setup decisions stored:", setup.c);
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
