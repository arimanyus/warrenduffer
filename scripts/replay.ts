/**
 * Replay a trading session through the real decision loop at any speed.
 *
 *   pnpm replay -- --date 2026-09-15 [--speed 60] [--port 8081] [--source data/harness.db]
 *
 * speed: virtual minutes per real minute. 1 = real time, 60 = one bar per second, 0 = as fast as Jev answers.
 * Bars come from the live DB (warmup history) or, if missing, from broker 1-min candles.
 * Fills are simulated on bars (pessimistic). Writes to data/replay-<date>.db, never the live DB.
 */
import Database from "better-sqlite3";
import { existsSync, unlinkSync } from "node:fs";

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
// Replay must not see the live engine's kill switch (or write to it).
process.env.KILL_PATH = `data/replay-${date}.kill`;
process.env.TELEGRAM_BOT_TOKEN = "";
process.env.OPTIONS_MODE = "off";
process.env.WILD = process.env.REPLAY_WILD ?? process.env.WILD ?? "0";
if (existsSync(process.env.KILL_PATH)) unlinkSync(process.env.KILL_PATH);

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
  const { INDEX_TOKEN, NIFTY50 } = await import("../src/symbols.js");
  const { addDays } = await import("../src/time.js");
  const { barTs } = await import("../src/data/bars.js");
  type Bar = import("../src/types.js").Bar;

  db.exec("DELETE FROM snapshots; DELETE FROM decisions; DELETE FROM rankings; DELETE FROM orders; DELETE FROM fills; DELETE FROM trades; DELETE FROM positions; DELETE FROM governor_log; DELETE FROM events;");
  db.pragma("wal_checkpoint(TRUNCATE)");

  // 1. Bars: always refresh from the live DB (today's replay must see the latest bars), else fetch from Kotak.
  let dayCount = 0;
  if (existsSync(source) && source !== process.env.DB_PATH) {
    const src = new Database(source, { readonly: true });
    const rows = src.prepare("SELECT symbol, ts, open, high, low, close, volume FROM bars_1m WHERE ts >= ? AND ts < ?").all(historyFrom, dayEnd) as Bar[];
    src.close();
    const ins = db.prepare(
      "INSERT INTO bars_1m (symbol, ts, open, high, low, close, volume) VALUES (@symbol, @ts, @open, @high, @low, @close, @volume) ON CONFLICT(symbol, ts) DO UPDATE SET open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume",
    );
    db.transaction((rs: Bar[]) => rs.forEach((r) => ins.run(r)))(rows);
    console.log(`copied ${rows.length} bars from ${source}`);
  }
  dayCount = (db.prepare("SELECT COUNT(*) AS c FROM bars_1m WHERE ts >= ? AND ts < ?").get(dayStart, dayEnd) as { c: number }).c;
  if (dayCount < 100) {
    const { brokerConfigured, cfg } = await import("../src/config.js");
    if (!brokerConfigured()) {
      console.error(`no bars for ${date} in ${source} and no ${cfg.broker} credentials to fetch them. Run the live engine (warmup) first or set the broker vars in .env.`);
      process.exit(1);
    }
    const { createBroker } = await import("../src/broker.js");
    const { seedBars } = await import("../src/data/bars.js");
    const client = createBroker();
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

  // 2. Day bars per symbol, one row per minute. Mixed live/candle timestamps get folded together.
  const rows = db.prepare("SELECT symbol, ts, open, high, low, close, volume FROM bars_1m WHERE ts >= ? AND ts < ? ORDER BY symbol, ts").all(dayStart, dayEnd) as Bar[];
  const bySym = new Map<string, Bar[]>();
  for (const r of rows) {
    const ts = barTs(r.ts);
    const arr = bySym.get(r.symbol) ?? [];
    const last = arr.at(-1);
    if (last && last.ts === ts) {
      last.high = Math.max(last.high, r.high);
      last.low = Math.min(last.low, r.low);
      last.close = r.close;
      last.volume += r.volume;
    } else {
      arr.push({ ...r, ts });
      bySym.set(r.symbol, arr);
    }
  }
  if (!bySym.size) {
    console.error(`still no bars for ${date}`);
    process.exit(1);
  }
  const minutes = [...new Set([...bySym.values()].flatMap((a) => a.map((b) => b.ts)))].sort((a, b) => a - b);
  console.log(`${bySym.size} symbols, ${minutes.length} minutes on ${date}`);

  // 3. Virtual clock, sim broker/executor, real engine. A backward seek rebuilds all of this from 09:15.
  const vclock = useVirtualClock(minutes[0]);
  const ctl = new ReplayControl(date, speed);
  ctl.total = minutes.length;
  const CLEAR = "DELETE FROM snapshots; DELETE FROM decisions; DELETE FROM rankings; DELETE FROM orders; DELETE FROM fills; DELETE FROM trades; DELETE FROM positions; DELETE FROM governor_log; DELETE FROM events;";
  let engine!: InstanceType<typeof Engine>;
  const boot = async () => {
    db.exec(CLEAR);
    vclock.set(minutes[0]);
    const e = new Engine(new SimBroker(bySym), { exec: new SimExecutor(), replay: true });
    await e.start();
    engine = e;
  };
  startServer(() => engine, ctl, port);
  await boot();

  // Each step: clock -> bar close, fast loop (fills, stops), then Jev. Seeking runs fills/stops only.
  const step = async (i: number, seeking: boolean) => {
    const stepAt = Date.now();
    const t = minutes[i] + 59_000;
    vclock.set(t);
    ctl.idx = i;
    ctl.virtualNow = t;
    engine.seeking = seeking;
    await engine.tick(!seeking);
    engine.seeking = false;
    if (seeking) return;
    ctl.lastStepMs = Date.now() - stepAt;
    await ctl.pace(stepAt);
  };

  // 4. Play the day. Seek ahead skips; seek behind (or after the end) rebuilds and skips.
  let i = 0;
  for (;;) {
    await ctl.waitWhilePaused();
    const target = ctl.seekTo;
    if (target !== null && (target < i || ctl.done)) {
      ctl.done = false;
      i = 0;
      await boot();
      continue;
    }
    if (target !== null && i < target) {
      await step(i++, true);
      continue;
    }
    ctl.seekTo = null;
    if (ctl.done) {
      await ctl.waitForSeek();
      continue;
    }
    await step(i++, false);
    if (i >= minutes.length) {
      vclock.set(minutes[minutes.length - 1] + 60_000 * 5);
      await engine.tick(false);
      ctl.done = true;
      console.log("replay done; seek the bar to run it again. Ctrl+C to exit.");
    }
  }
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

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
