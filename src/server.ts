import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { cfg } from "./config.js";
import {
  latencyP50,
  latestGovernor,
  latestRankings,
  recentDecisions,
  recentEvents,
  recentTrades,
  skippedCountToday,
  todayEntries,
  todayFriction,
  todayPnl,
} from "./db.js";
import type { Engine } from "./engine.js";

const clients = new Set<ServerResponse>();

export function startServer(engine: Engine): void {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${cfg.host}:${cfg.port}`);
    if (url.pathname === "/api/state") return json(res, state(engine));
    if (url.pathname === "/api/kill" && req.method === "POST") {
      engine.kill();
      return json(res, { ok: true });
    }
    if (url.pathname === "/events") return sse(req, res, engine);
    return staticFile(res, url.pathname);
  });
  server.listen(cfg.port, cfg.host, () => {
    console.log(`Warren Duffer http://${cfg.host}:${cfg.port}`);
  });
  setInterval(() => broadcast(engine), 2000);
}

function state(engine: Engine) {
  return {
    ...engine.snapshot(),
    todayPnl: todayPnl(),
    todayFriction: todayFriction(),
    todayEntries: todayEntries(),
    latencyP50: latencyP50(),
    skippedToday: skippedCountToday(),
    governor: latestGovernor(),
    rankings: latestRankings().map((r) => ({ side: r.side, payload: tryJson(r.payload) })),
    trades: recentTrades(80),
    decisions: recentDecisions(200),
    events: recentEvents(40),
    dailyLossCap: cfg.dailyLossCap,
    frictionBudget: cfg.dailyFrictionBudget,
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
