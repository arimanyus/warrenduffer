import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { cfg } from "../config.js";
import { db, getCapital } from "../db.js";

export interface SessionRow {
  date: string;
  bars: number;
  symbols: number;
  trades: number;
  pnl: number;
}

export interface RunningReplay {
  date: string;
  port: number;
  speed: number;
  wild: boolean;
  startedAt: number;
  ready: boolean;
  exited: boolean;
  exitCode: number | null;
  lastLog: string;
}

const BASE_PORT = 8081;

/** Lists replayable days and spawns/stops `scripts/replay.ts` children from the live dashboard. */
export class ReplayManager {
  private running = new Map<string, { proc: ChildProcess; info: RunningReplay }>();

  sessions(): SessionRow[] {
    const rows = db
      .prepare(
        `SELECT date(ts/1000 + 19800, 'unixepoch') AS d, COUNT(*) AS bars, COUNT(DISTINCT symbol) AS symbols
         FROM bars_1m GROUP BY d HAVING bars >= 100 ORDER BY d DESC LIMIT 60`,
      )
      .all() as { d: string; bars: number; symbols: number }[];
    const tr = db.prepare("SELECT date, COUNT(*) AS n, COALESCE(SUM(pnl),0) AS p FROM trades GROUP BY date").all() as {
      date: string;
      n: number;
      p: number;
    }[];
    const byDate = new Map(tr.map((t) => [t.date, t]));
    return rows.map((r) => ({
      date: r.d,
      bars: r.bars,
      symbols: r.symbols,
      trades: byDate.get(r.d)?.n ?? 0,
      pnl: byDate.get(r.d)?.p ?? 0,
    }));
  }

  list(): RunningReplay[] {
    return [...this.running.values()].map((r) => r.info);
  }

  start(date: string, speed: number, wild = false): RunningReplay {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("bad date");
    const existing = this.running.get(date);
    if (existing && !existing.info.exited) return existing.info;
    const port = this.freePort();
    const tsx = resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
    if (!existsSync(tsx)) throw new Error("tsx not found");
    const proc = spawn(
      process.execPath,
      [tsx, "scripts/replay.ts", "--date", date, "--speed", String(speed), "--port", String(port), "--source", cfg.dbPath],
      {
        cwd: process.cwd(),
        env: { ...process.env, REPLAY_WILD: wild ? "1" : "0", CAPITAL: String(getCapital()) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const info: RunningReplay = { date, port, speed, wild, startedAt: Date.now(), ready: false, exited: false, exitCode: null, lastLog: "starting" };
    const onData = (buf: Buffer) => {
      const line = buf.toString().trim().split("\n").pop() ?? "";
      if (line) info.lastLog = line.slice(0, 160);
      if (line.includes("http://")) info.ready = true;
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("exit", (code) => {
      info.exited = true;
      info.exitCode = code;
    });
    this.running.set(date, { proc, info });
    return info;
  }

  stop(date: string): boolean {
    const r = this.running.get(date);
    if (!r) return false;
    if (!r.info.exited) r.proc.kill();
    this.running.delete(date);
    return true;
  }

  private freePort(): number {
    const used = new Set([...this.running.values()].filter((r) => !r.info.exited).map((r) => r.info.port));
    let p = BASE_PORT;
    while (used.has(p) || p === cfg.port) p++;
    return p;
  }
}
