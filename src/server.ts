import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { cfg } from "./config.js";
import {
  computeStats,
  getCapital,
  latencyP50,
  latencyP90,
  latestGovernor,
  latestRankings,
  listSessions,
  recentDecisions,
  recentEvents,
  recentTrades,
  setCapital,
  skippedCountToday,
  todayEntries,
  todayFriction,
  todayPnl,
  tokensToday,
} from "./db.js";
import type { Engine } from "./engine.js";
import type { ReplayControl } from "./replay/control.js";
import { ReplayManager } from "./replay/manager.js";
import { barDayStart } from "./data/features.js";
import { clock } from "./time.js";

const clients = new Set<ServerResponse>();
let replayCtl: ReplayControl | null = null;
let manager: ReplayManager | null = null;

export function startServer(engine: Engine, replay?: ReplayControl, port = cfg.port): void {
  replayCtl = replay ?? null;
  manager = replay ? null : new ReplayManager();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${cfg.host}:${port}`);
    if (url.pathname === "/api/state") return json(res, state(engine));
    if (url.pathname === "/api/sessions" && manager) {
      return json(res, { live: listSessions(), sessions: manager.sessions(), running: manager.list() });
    }
    if (url.pathname === "/api/sessions/start" && req.method === "POST" && manager) {
      const m = manager;
      void readBody(req).then((raw) => {
        try {
          const body = JSON.parse(raw) as { date: string; speed?: number; wild?: boolean };
          json(res, { ok: true, replay: m.start(body.date, Number(body.speed ?? 60), !!body.wild) });
        } catch (e) {
          res.writeHead(400);
          res.end(String(e));
        }
      });
      return;
    }
    if (url.pathname === "/api/sessions/stop" && req.method === "POST" && manager) {
      const m = manager;
      void readBody(req).then((raw) => {
        const body = JSON.parse(raw) as { date: string };
        json(res, { ok: m.stop(body.date) });
      });
      return;
    }
    if (url.pathname === "/api/replay" && req.method === "POST") {
      void readBody(req).then((raw) => {
        if (!replayCtl) {
          res.writeHead(404);
          res.end("not a replay");
          return;
        }
        try {
          replayCtl.command(JSON.parse(raw) as { speed?: number; paused?: boolean; seek?: number });
          json(res, { ok: true, replay: replayCtl.state() });
        } catch {
          res.writeHead(400);
          res.end("bad replay command");
        }
      });
      return;
    }
    if (url.pathname === "/api/kill" && req.method === "POST") {
      engine.kill();
      return json(res, { ok: true });
    }
    if (url.pathname === "/api/unkill" && req.method === "POST") {
      engine.unkill();
      return json(res, { ok: true });
    }
    if (url.pathname === "/api/jev" && req.method === "POST") {
      void readBody(req).then((raw) => {
        const body = JSON.parse(raw || "{}") as { paused?: boolean };
        engine.setJevPaused(!!body.paused);
        json(res, { ok: true, jevPaused: engine.jevPaused });
      });
      return;
    }
    if (url.pathname === "/api/wild" && req.method === "POST") {
      void readBody(req).then((raw) => {
        const body = JSON.parse(raw || "{}") as { on?: boolean };
        engine.setWildMode(!!body.on);
        json(res, { ok: true, wild: engine.wild });
      });
      return;
    }
    if (url.pathname === "/api/capital" && req.method === "POST") {
      void readBody(req).then((raw) => {
        try {
          const body = JSON.parse(raw) as { capital?: number };
          const capital = setCapital(Number(body.capital));
          json(res, { ok: true, capital });
        } catch {
          res.writeHead(400);
          res.end("bad capital");
        }
      });
      return;
    }
    if (url.pathname === "/events") return sse(req, res, engine);
    return staticFile(res, url.pathname);
  });
  server.listen(port, cfg.host, () => {
    console.log(`Warren Duffer${replay ? ` REPLAY ${replay.date}` : ""} http://${cfg.host}:${port}`);
  });
  setInterval(() => broadcast(engine), replay ? 500 : 2000);
}

function state(engine: Engine) {
  const snap = engine.snapshot();
  const stats = computeStats();
  const curve = [...stats.curve];
  if (snap.openUnrealized) {
    if (curve.length === 1) curve[0] = { t: barDayStart(), eq: 0 };
    curve.push({ t: clock.now(), eq: stats.netPnl + snap.openUnrealized });
  }
  return {
    ...snap,
    todayPnl: todayPnl(),
    todayFriction: todayFriction(),
    todayEntries: todayEntries(),
    latencyP50: latencyP50(),
    latencyP90: latencyP90(),
    tokensToday: tokensToday(),
    skippedToday: skippedCountToday(),
    governor: latestGovernor(),
    rankings: latestRankings().map((r) => ({ side: r.side, payload: tryJson(r.payload) })),
    trades: recentTrades(80),
    decisions: recentDecisions(200),
    events: recentEvents(60),
    serverTime: clock.now(),
    replay: replayCtl?.state() ?? null,
    dailyLossCap: cfg.dailyLossCap,
    capital: getCapital(),
    stats,
    curve,
  };
}

function sse(req: IncomingMessage, res: ServerResponse, engine: Engine): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify(state(engine))}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
}

function broadcast(engine: Engine): void {
  const payload = `data: ${JSON.stringify(state(engine))}\n\n`;
  for (const c of clients) c.write(payload);
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function staticFile(res: ServerResponse, pathname: string): void {
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  const path = join(process.cwd(), "web", file);
  try {
    const data = readFileSync(path);
    const ext = extname(path);
    const type = ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : "text/html";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
