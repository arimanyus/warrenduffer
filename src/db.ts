import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { cfg } from "./config.js";
import { clock, istDateStr } from "./time.js";
import type { DecisionRow, GovernorState } from "./types.js";

mkdirSync(dirname(cfg.dbPath) === "." ? "data" : dirname(cfg.dbPath), { recursive: true });

export const db = new Database(cfg.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 3000");

db.exec(`
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  token TEXT,
  segment TEXT,
  ltp REAL, bid REAL, ask REAL, volume REAL, tbq REAL, tsq REAL,
  bid_qty REAL, ask_qty REAL, json TEXT
);
CREATE INDEX IF NOT EXISTS idx_snap_sym_ts ON snapshots(symbol, ts);

CREATE TABLE IF NOT EXISTS bars_1m (
  symbol TEXT NOT NULL,
  ts INTEGER NOT NULL,
  open REAL, high REAL, low REAL, close REAL, volume REAL,
  PRIMARY KEY (symbol, ts)
);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  stage TEXT,
  symbol TEXT,
  question TEXT,
  answer TEXT,
  probability REAL,
  confidence REAL,
  latency_ms INTEGER,
  tokens INTEGER,
  model_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_dec_ts ON decisions(ts);

CREATE TABLE IF NOT EXISTS rankings (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  side TEXT,
  payload TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  broker_id TEXT,
  ts INTEGER NOT NULL,
  symbol TEXT,
  token TEXT,
  segment TEXT,
  side TEXT,
  qty INTEGER,
  price REAL,
  trigger_price REAL,
  kind TEXT,
  status TEXT,
  tag TEXT,
  last_modify_at INTEGER,
  decision_id INTEGER,
  leg TEXT,
  tier TEXT,
  stop REAL,
  target REAL,
  stop_bps REAL
);

CREATE TABLE IF NOT EXISTS fills (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  order_id INTEGER,
  symbol TEXT,
  side TEXT,
  qty INTEGER,
  price REAL,
  cost REAL,
  simulated INTEGER
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY,
  opened_at INTEGER,
  closed_at INTEGER,
  date TEXT,
  leg TEXT,
  symbol TEXT,
  side TEXT,
  qty INTEGER,
  entry REAL,
  exit REAL,
  pnl REAL,
  friction REAL,
  hold_s INTEGER,
  exit_reason TEXT,
  tier TEXT,
  decision_id INTEGER,
  attribution TEXT,
  entry_timing TEXT,
  regime TEXT
);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY,
  opened_at INTEGER,
  leg TEXT,
  symbol TEXT,
  token TEXT,
  segment TEXT,
  side TEXT,
  qty INTEGER,
  entry REAL,
  stop REAL,
  target REAL,
  decision_id INTEGER,
  tier TEXT,
  stop_order_id TEXT,
  entry_order_id TEXT,
  stop_bps REAL,
  thesis REAL,
  closed INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS governor_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  allowance INTEGER,
  used INTEGER,
  friction_used REAL,
  friction_budget REAL,
  reason TEXT,
  trailing_exp REAL,
  today_pnl REAL
);

CREATE TABLE IF NOT EXISTS context (
  date TEXT,
  symbol TEXT,
  event_today REAL,
  news_bias TEXT,
  news_bias_prob REAL,
  materiality REAL,
  exclude INTEGER,
  forbid_side TEXT,
  PRIMARY KEY (date, symbol)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT,
  message TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT,
  trades INTEGER DEFAULT 0,
  pnl REAL DEFAULT 0,
  decisions INTEGER DEFAULT 0,
  regime TEXT,
  note TEXT
);
`);

/** A live session is one RESUME → KILL/halt/flatten/shutdown span. */
export function openSession(note: string): number {
  const info = db.prepare("INSERT INTO sessions (started_at, note) VALUES (?, ?)").run(clock.now(), note);
  return Number(info.lastInsertRowid);
}

export function refreshSession(id: number, regime: string | null, endReason: string | null): void {
  const row = db.prepare("SELECT started_at FROM sessions WHERE id = ?").get(id) as { started_at: number } | undefined;
  if (!row) return;
  const end = clock.now();
  const t = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(pnl),0) AS p FROM trades WHERE closed_at >= ? AND closed_at <= ?").get(row.started_at, end) as { n: number; p: number };
  const d = db.prepare("SELECT COUNT(DISTINCT ts) AS n FROM decisions WHERE ts >= ? AND ts <= ? AND stage NOT LIKE 'cal:%'").get(row.started_at, end) as { n: number };
  db.prepare("UPDATE sessions SET trades=?, pnl=?, decisions=?, regime=COALESCE(?, regime), ended_at=?, end_reason=? WHERE id=?").run(
    t.n,
    t.p,
    d.n,
    regime,
    endReason ? end : null,
    endReason,
    id,
  );
}

export function listSessions(limit = 40): unknown[] {
  return db.prepare("SELECT * FROM sessions ORDER BY id DESC LIMIT ?").all(limit);
}

export function getSetting(key: string, fallback: string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

export function getCapital(): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("capital") as { value: string } | undefined;
  if (!row) {
    setSetting("capital", String(cfg.capital));
    return cfg.capital;
  }
  const n = Number(row.value);
  return Number.isFinite(n) ? Math.max(1000, Math.min(n, 50_000_000)) : cfg.capital;
}

/** WILD: enter on stage-1 conviction alone, several names per cycle, no re-entry cooldown. Persisted; env WILD=1 is the default. */
export function getWild(): boolean {
  return getSetting("wild", cfg.wild ? "1" : "0") === "1";
}

export function setWild(on: boolean): void {
  setSetting("wild", on ? "1" : "0");
  insertEvent("mode", on ? "WILD on: stage-1 entries, multi-name, no cooldown" : "WILD off: two-stage entries");
}

export function setCapital(n: number): number {
  const v = Math.max(1000, Math.min(Math.round(n), 50_000_000));
  setSetting("capital", String(v));
  insertEvent("capital", `capital set to ${v}`);
  return v;
}

export function insertEvent(kind: string, message: string): void {
  db.prepare("INSERT INTO events (ts, kind, message) VALUES (?, ?, ?)").run(clock.now(), kind, message);
}

export function insertSnapshot(s: {
  ts: number;
  symbol: string;
  token: string;
  segment: string;
  ltp: number;
  bid: number;
  ask: number;
  volume: number;
  tbq: number;
  tsq: number;
  bidQty: number;
  askQty: number;
  json: string;
}): void {
  db.prepare(
    `INSERT INTO snapshots (ts, symbol, token, segment, ltp, bid, ask, volume, tbq, tsq, bid_qty, ask_qty, json)
     VALUES (@ts, @symbol, @token, @segment, @ltp, @bid, @ask, @volume, @tbq, @tsq, @bidQty, @askQty, @json)`,
  ).run(s);
}

export function pruneSnapshots(olderThanMs: number): void {
  db.prepare("DELETE FROM snapshots WHERE ts < ?").run(clock.now() - olderThanMs);
}

export function upsertBar(b: {
  symbol: string;
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}): void {
  db.prepare(
    `INSERT INTO bars_1m (symbol, ts, open, high, low, close, volume)
     VALUES (@symbol, @ts, @open, @high, @low, @close, @volume)
     ON CONFLICT(symbol, ts) DO UPDATE SET
       high=MAX(high, excluded.high), low=MIN(low, excluded.low),
       close=excluded.close, volume=excluded.volume`,
  ).run(b);
}

/** Offline scripts (calibrate) tag their rows so the live dashboard feed and latency stats ignore them. */
let stagePrefix = "";
export function setDecisionStagePrefix(p: string): void {
  stagePrefix = p;
}

export function insertDecision(d: DecisionRow): number {
  const info = db
    .prepare(
      `INSERT INTO decisions (ts, stage, symbol, question, answer, probability, confidence, latency_ms, tokens, model_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(d.ts, stagePrefix + d.stage, d.symbol, d.question, d.answer, d.probability, d.confidence, d.latencyMs, d.tokens, d.modelId);
  return Number(info.lastInsertRowid);
}

export function insertRanking(ts: number, side: string, payload: unknown): void {
  db.prepare("INSERT INTO rankings (ts, side, payload) VALUES (?, ?, ?)").run(ts, side, JSON.stringify(payload));
}

export function insertGovernor(g: GovernorState & { ts: number }): void {
  db.prepare(
    `INSERT INTO governor_log (ts, allowance, used, friction_used, friction_budget, reason, trailing_exp, today_pnl)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(g.ts, g.allowance, g.used, g.frictionUsed, g.frictionBudget, g.reason, g.trailingExpectancy, g.todayPnl);
}

export function todayPnl(): number {
  const row = db.prepare("SELECT COALESCE(SUM(pnl),0) AS p FROM trades WHERE date = ?").get(istDateStr()) as { p: number };
  return row.p;
}

export function todayFriction(): number {
  const row = db.prepare("SELECT COALESCE(SUM(friction),0) AS f FROM trades WHERE date = ?").get(istDateStr()) as { f: number };
  return row.f;
}

export function todayEntries(leg?: string): number {
  const q = leg
    ? db.prepare("SELECT COUNT(*) AS c FROM trades WHERE date = ? AND leg = ?")
    : db.prepare("SELECT COUNT(*) AS c FROM trades WHERE date = ?");
  const row = (leg ? q.get(istDateStr(), leg) : q.get(istDateStr())) as { c: number };
  return row.c;
}

export function trailingTrades(n: number): { pnl: number }[] {
  return db.prepare("SELECT pnl FROM trades ORDER BY id DESC LIMIT ?").all(n) as { pnl: number }[];
}

export function lastCooldowns(): Map<string, number> {
  const rows = db.prepare("SELECT symbol, MAX(closed_at) AS t FROM trades GROUP BY symbol").all() as {
    symbol: string;
    t: number;
  }[];
  return new Map(rows.map((r) => [r.symbol, r.t]));
}

export function recentDecisions(limit = 200): unknown[] {
  return db.prepare("SELECT * FROM decisions WHERE stage NOT LIKE 'cal:%' ORDER BY id DESC LIMIT ?").all(limit);
}

export function recentTrades(limit = 100): unknown[] {
  return db.prepare("SELECT * FROM trades ORDER BY id DESC LIMIT ?").all(limit);
}

export function recentEvents(limit = 50): unknown[] {
  return db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit);
}

export function latestRankings(): { side: string; payload: string }[] {
  return db.prepare("SELECT side, payload FROM rankings WHERE ts = (SELECT MAX(ts) FROM rankings)").all() as {
    side: string;
    payload: string;
  }[];
}

export function latestGovernor(): unknown {
  return db.prepare("SELECT * FROM governor_log ORDER BY id DESC LIMIT 1").get();
}

export function latencyP50(): number {
  const rows = db.prepare("SELECT latency_ms FROM decisions WHERE stage NOT LIKE 'cal:%' ORDER BY id DESC LIMIT 200").all() as { latency_ms: number }[];
  if (!rows.length) return 0;
  const s = [...rows].sort((a, b) => a.latency_ms - b.latency_ms);
  return s[Math.floor(s.length / 2)]?.latency_ms ?? 0;
}

export function skippedCountToday(): number {
  const start = clock.now() - 20 * 3600_000;
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'skip' AND ts > ?")
    .get(start) as { c: number };
  return row.c;
}

export function upsertContext(row: {
  date: string;
  symbol: string;
  eventToday: number;
  newsBias: string;
  newsBiasProb: number;
  materiality: number;
  exclude: number;
  forbidSide: string | null;
}): void {
  db.prepare(
    `INSERT INTO context (date, symbol, event_today, news_bias, news_bias_prob, materiality, exclude, forbid_side)
     VALUES (@date, @symbol, @eventToday, @newsBias, @newsBiasProb, @materiality, @exclude, @forbidSide)
     ON CONFLICT(date, symbol) DO UPDATE SET
       event_today=excluded.event_today, news_bias=excluded.news_bias,
       news_bias_prob=excluded.news_bias_prob, materiality=excluded.materiality,
       exclude=excluded.exclude, forbid_side=excluded.forbid_side`,
  ).run(row);
}

export function contextFor(date: string): Map<string, { exclude: boolean; forbidSide: string | null }> {
  const rows = db.prepare("SELECT * FROM context WHERE date = ?").all(date) as {
    symbol: string;
    exclude: number;
    forbid_side: string | null;
  }[];
  return new Map(rows.map((r) => [r.symbol, { exclude: !!r.exclude, forbidSide: r.forbid_side }]));
}

export function latencyP90(): number {
  const rows = db.prepare("SELECT latency_ms FROM decisions WHERE stage NOT LIKE 'cal:%' ORDER BY id DESC LIMIT 200").all() as { latency_ms: number }[];
  if (!rows.length) return 0;
  const s = [...rows].sort((a, b) => a.latency_ms - b.latency_ms);
  return s[Math.floor(s.length * 0.9)]?.latency_ms ?? 0;
}

export function tokensToday(): number {
  const start = clock.now() - 20 * 3600_000;
  const row = db.prepare("SELECT COALESCE(SUM(tokens),0) AS t FROM decisions WHERE ts > ? AND stage NOT LIKE 'cal:%'").get(start) as { t: number };
  return row.t;
}

export function computeStats(): {
  netPnl: number;
  todayPnl: number;
  trades: number;
  todayTrades: number;
  wins: number;
  todayWins: number;
  hit: number;
  todayHit: number;
  expectancy: number;
  profitFactor: number;
  maxDd: number;
  avgHoldS: number;
  avgWin: number;
  avgLoss: number;
  friction: number;
  curve: { t: number; eq: number }[];
} {
  const trades = allTrades();
  const today = istDateStr();
  const day = trades.filter((t) => t.date === today);
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const dayWins = day.filter((t) => t.pnl > 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  let eq = 0;
  let peak = 0;
  let dd = 0;
  const curve: { t: number; eq: number }[] = [{ t: trades[0]?.opened_at ?? clock.now(), eq: 0 }];
  for (const t of trades) {
    eq += t.pnl;
    peak = Math.max(peak, eq);
    dd = Math.min(dd, eq - peak);
    curve.push({ t: t.closed_at, eq });
  }
  return {
    netPnl: eq,
    todayPnl: day.reduce((s, t) => s + t.pnl, 0),
    trades: trades.length,
    todayTrades: day.length,
    wins: wins.length,
    todayWins: dayWins.length,
    hit: trades.length ? wins.length / trades.length : 0,
    todayHit: day.length ? dayWins.length / day.length : 0,
    expectancy: trades.length ? eq / trades.length : 0,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? 99 : 0,
    maxDd: dd,
    avgHoldS: trades.length ? trades.reduce((s, t) => s + t.hold_s, 0) / trades.length : 0,
    avgWin: wins.length ? gp / wins.length : 0,
    avgLoss: losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0,
    friction: trades.reduce((s, t) => s + t.friction, 0),
    curve,
  };
}

export function allTrades(): {
  id: number;
  opened_at: number;
  closed_at: number;
  date: string;
  leg: string;
  symbol: string;
  side: string;
  qty: number;
  entry: number;
  exit: number;
  pnl: number;
  friction: number;
  hold_s: number;
  exit_reason: string;
  tier: string;
  attribution: string | null;
  entry_timing: string | null;
  regime: string | null;
}[] {
  return db.prepare("SELECT * FROM trades ORDER BY id").all() as ReturnType<typeof allTrades>;
}
