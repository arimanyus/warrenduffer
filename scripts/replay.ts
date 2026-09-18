/**
 * Replay a trading session through the real decision loop at any speed.
 *
 *   pnpm replay -- --date 2026-09-15 [--speed 60] [--port 8081] [--source data/harness.db]
 *
 * speed: virtual minutes per real minute. 1 = real time, 60 = one bar per second, 0 = as fast as Jev answers.
 * Bars come from the live DB (warmup history) or, if missing, from Kotak 1-min candles.
 * Fills are simulated on bars (pessimistic). Writes to data/replay-<date>.db, never the live DB.
 */
import Database from "better-sqlite3";
import { existsSync } from "node:fs";

const args = parseArgs(process.argv.slice(2));
const date = args.date;
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error("usage: pnpm replay -- --date YYYY-MM-DD [--speed N] [--port 8081]");
  process.exit(1);
}
const speed = Number(args.speed ?? 60);
const port = Number(args.port ?? 8081);
const source = args.source ?? process.env.DB_PATH ?? "data/harness.db";

process.env.DB_PATH = `data/replay-${date}.db`;
process.env.TELEGRAM_BOT_TOKEN = "";
process.env.OPTIONS_MODE = "off";

const dayStart = Date.parse(`${date}T03:45:00Z`);
const dayEnd = Date.parse(`${date}T10:00:00Z`);
const historyFrom = dayStart - 40 * 86400_000;

async function main(): Promise<void> {
  const { db } = await import("../src/db.js");
  const { useVirtualClock } = await import("../src/time.js");
  const { Engine } = await import("../src/engine.js");
  const { SimBroker, SimExecutor } = await import("../src/replay/sim.js");
  const { ReplayControl } = await import("../src/replay/control.js");
  const { startServer } = await import("../src/server.js");
  const { INDEX_TOKEN, NIFTY50 } = await import("../src/kotak/scrip.js");
  const { addDays } = await import("../src/time.js");
  type Bar = import("../src/types.js").Bar;

  db.exec("DELETE FROM snapshots; DELETE FROM decisions; DELETE FROM rankings; DELETE FROM orders; DELETE FROM fills; DELETE FROM trades; DELETE FROM positions; DELETE FROM governor_log; DELETE FROM events;");

  // 1. Bars: copy from the live DB if it has them, else fetch from Kotak.
  let dayCount = (db.prepare("SELECT COUNT(*) AS c FROM bars_1m WHERE ts >= ? AND ts < ?").get(dayStart, dayEnd) as { c: number }).c;
  if (dayCount < 100 && existsSync(source) && source !== process.env.DB_PATH) {
    const src = new Database(source, { readonly: true });
    const rows = src.prepare("SELECT symbol, ts, open, high, low, close, volume FROM bars_1m WHERE ts >= ? AND ts < ?").all(historyFrom, dayEnd) as Bar[];
    src.close();
    const ins = db.prepare(
      "INSERT INTO bars_1m (symbol, ts, open, high, low, close, volume) VALUES (@symbol, @ts, @open, @high, @low, @close, @volume) ON CONFLICT(symbol, ts) DO UPDATE SET open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume",
    );
    db.transaction((rs: Bar[]) => rs.forEach((r) => ins.run(r)))(rows);
    console.log(`copied ${rows.length} bars from ${source}`);
    dayCount = (db.prepare("SELECT COUNT(*) AS c FROM bars_1m WHERE ts >= ? AND ts < ?").get(dayStart, dayEnd) as { c: number }).c;
  }
  if (dayCount < 100) {
    const { cfg } = await import("../src/config.js");
    if (!cfg.kotakAccessToken) {
      console.error(`no bars for ${date} in ${source} and no KOTAK_* creds to fetch them. Run the live engine (warmup) first or set KOTAK_*.`);
      process.exit(1);
    }
    const { KotakClient } = await import("../src/kotak/client.js");
    const { seedBars } = await import("../src/data/bars.js");
    const client = new KotakClient();
    await client.login();
    await client.loadScrips();
    const from = addDays(date, -cfg.warmupDays);
    for (const sym of [...NIFTY50, INDEX_TOKEN]) {
      const inst = client.getInstrument(sym);
      if (!inst) continue;
      try {
        const rows = await client.candles(inst.token, "nse_cm", from, date, "1min");
        seedBars(sym, rows.map((r) => ({ symbol: sym, ...r })));
        console.log(sym, rows.length);
      } catch (e) {
        console.error(sym, String(e));
      }
    }
  }

  // 2. Day bars per symbol, in order.
  const rows = db.prepare("SELECT symbol, ts, open, high, low, close, volume FROM bars_1m WHERE ts >= ? AND ts < ? ORDER BY symbol, ts").all(dayStart, dayEnd) as Bar[];
  const bySym = new Map<string, Bar[]>();
  for (const r of rows) {
    const arr = bySym.get(r.symbol) ?? [];
    arr.push(r);
    bySym.set(r.symbol, arr);
  }
  if (!bySym.size) {
    console.error(`still no bars for ${date}`);
    process.exit(1);
  }
  const minutes = [...new Set(rows.map((r) => r.ts))].sort((a, b) => a - b);
  console.log(`${bySym.size} symbols, ${minutes.length} minutes on ${date}`);

  // 3. Virtual clock, sim broker/executor, real engine.
  const vclock = useVirtualClock(minutes[0]);
  const broker = new SimBroker(bySym);
  const exec = new SimExecutor();
  const engine = new Engine(broker, { exec, replay: true });
  const ctl = new ReplayControl(date, speed);
  ctl.total = minutes.length;
  startServer(engine, ctl, port);
  await engine.start();

  // 4. Step one bar at a time. Each step: clock -> bar close, fast loop (fills, stops), then Jev decision.
  for (let i = 0; i < minutes.length; i++) {
    while (ctl.paused && ctl.seekTo === null) await sleep(100);
    if (ctl.seekTo !== null && i < ctl.seekTo) {
      vclock.set(minutes[i] + 59_000);
      ctl.idx = i;
      ctl.virtualNow = minutes[i] + 59_000;
      await engine.tick(false);
      continue;
    }
    ctl.seekTo = null;
    const t = minutes[i] + 59_000;
    vclock.set(t);
    ctl.idx = i;
    ctl.virtualNow = t;
    await engine.tick(true);
    const d = ctl.delayMs();
    if (d > 0) await sleep(d);
  }
  vclock.set(minutes[minutes.length - 1] + 60_000 * 5);
  await engine.tick(false);
  ctl.done = true;
  console.log("replay done; dashboard stays up for review. Ctrl+C to exit.");
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "1";
      out[k] = v;
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
