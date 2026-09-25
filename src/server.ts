import { createServer, type IncomingHttpHeaders, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { cfg, isLoopbackHost } from "./config.js";
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

const MAX_BODY_BYTES = 64 * 1024;
const WEB_DIR = resolve(process.cwd(), "web");
const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "::1"];
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

export interface Guard {
  token: string;
  allowedHosts: Set<string>;
  /** Remote mode: every API read needs the token too, and it is never embedded in the page. */
  tokenForReads: boolean;
}

export function guardFromConfig(c = cfg): Guard {
  const allowedHosts = new Set([...LOOPBACK_NAMES, ...c.dashboardAllowedHosts]);
  if (!WILDCARD_HOSTS.has(c.host)) allowedHosts.add(hostnameOf(c.host) ?? c.host.toLowerCase());
  return {
    token: c.dashboardToken || randomBytes(24).toString("hex"),
    allowedHosts,
    tokenForReads: !isLoopbackHost(c.host),
  };
}

/** Hostname from a Host header or URL authority: lower-cased, port and IPv6 brackets stripped. */
export function hostnameOf(host: string | undefined): string | null {
  if (!host) return null;
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(1, end) : null;
  }
  if ((h.match(/:/g) ?? []).length > 1) return h;
  return h.split(":")[0] || null;
}

function tokenMatches(expected: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Host allowlist blocks DNS rebinding; Origin check blocks cross-site form posts; the token (sent as a
 * custom header, which forces a CORS preflight we never answer) blocks everything else that can mutate.
 */
export function checkRequest(
  req: { method?: string; url?: string; headers: IncomingHttpHeaders },
  guard: Guard,
): { status: number; message: string } | null {
  const host = hostnameOf(req.headers.host);
  if (!host || !guard.allowedHosts.has(host)) return { status: 421, message: "host not allowed" };
  const origin = req.headers.origin;
  const isWrite = req.method !== "GET" && req.method !== "HEAD";
  if (origin !== undefined) {
    let originHost: string | null = null;
    try {
      originHost = hostnameOf(new URL(origin).host);
    } catch {
      originHost = null;
    }
    if (!originHost || !guard.allowedHosts.has(originHost)) return { status: 403, message: "origin not allowed" };
  }
  const url = new URL(req.url ?? "/", "http://dashboard");
  const isApi = url.pathname.startsWith("/api/") || url.pathname === "/events";
  if (isWrite || (guard.tokenForReads && isApi)) {
    const header = req.headers["x-wd-token"];
    const given = typeof header === "string" ? header : !isWrite ? (url.searchParams.get("token") ?? undefined) : undefined;
    if (!tokenMatches(guard.token, given)) return { status: 401, message: "missing or bad dashboard token" };
  }
  return null;
}

/** A path under web/, or null for anything that would escape it. */
export function resolveStatic(pathname: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  } catch {
    return null;
  }
  if (rel.includes("\0")) return null;
  const full = resolve(WEB_DIR, "." + rel);
  return full.startsWith(WEB_DIR + sep) ? full : null;
}

const clients = new Set<ServerResponse>();

export interface HandlerDeps {
  current: () => Engine;
  replay: ReplayControl | null;
  manager: ReplayManager | null;
  guard: Guard;
}

export function createHandler(deps: HandlerDeps): RequestListener {
  const { current, replay, manager, guard } = deps;
  return (req, res) => {
    const blocked = checkRequest(req, guard);
    if (blocked) return text(res, blocked.status, blocked.message);
    const engine = current();
    const url = new URL(req.url ?? "/", "http://dashboard");
    const post = req.method === "POST";
    const path = url.pathname;

    if (path === "/api/state") return json(res, state(engine, replay));
    if (path === "/api/sessions" && manager) {
      return json(res, { live: listSessions(), sessions: manager.sessions(), running: manager.list() });
    }
    if (path === "/api/kill" && post) {
      engine.kill();
      return json(res, { ok: true });
    }
    if (path === "/api/unkill" && post) {
      engine.unkill();
      return json(res, { ok: true });
    }
    if (path === "/api/sessions/start" && post && manager) {
      return withBody(req, res, (b) => {
        const date = String(b.date ?? "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequest("date must be YYYY-MM-DD");
        return { ok: true, replay: manager.start(date, Number(b.speed ?? 60), !!b.wild) };
      });
    }
    if (path === "/api/sessions/stop" && post && manager) {
      return withBody(req, res, (b) => ({ ok: manager.stop(String(b.date ?? "")) }));
    }
    if (path === "/api/replay" && post) {
      if (!replay) return text(res, 404, "not a replay");
      return withBody(req, res, (b) => {
        replay.command(b as { speed?: number; paused?: boolean; seek?: number });
        return { ok: true, replay: replay.state() };
      });
    }
    if (path === "/api/jev" && post) {
      return withBody(req, res, (b) => {
        engine.setJevPaused(!!b.paused);
        return { ok: true, jevPaused: engine.jevPaused };
      });
    }
    if (path === "/api/wild" && post) {
      return withBody(req, res, (b) => {
        engine.setWildMode(!!b.on);
        return { ok: true, wild: engine.wild };
      });
    }
    if (path === "/api/capital" && post) {
      return withBody(req, res, (b) => {
        const capital = Number(b.capital);
        if (b.capital === undefined || b.capital === null || b.capital === "" || !Number.isFinite(capital)) throw new BadRequest("capital must be a number");
        return { ok: true, capital: setCapital(capital) };
      });
    }
    if (path === "/events") return sse(req, res, engine, replay);
    if (post || path.startsWith("/api/")) return text(res, 404, "not found");
    return staticFile(res, path, guard);
  };
}

/** Replay passes a getter because a backward seek rebuilds its Engine. */
export function startServer(target: Engine | (() => Engine), replay?: ReplayControl, port = cfg.port): void {
  const current = typeof target === "function" ? target : () => target;
  const guard = guardFromConfig();
  const handler = createHandler({ current, replay: replay ?? null, manager: replay ? null : new ReplayManager(), guard });
  const server = createServer(handler);
  server.listen(port, cfg.host, () => {
    console.log(`Warren Duffer${replay ? ` REPLAY ${replay.date}` : ""} http://${cfg.host}:${port}`);
    if (guard.tokenForReads) console.log("dashboard is remote: open it and enter DASHBOARD_TOKEN when prompted");
  });
  setInterval(() => broadcast(current(), replay ?? null), replay ? 500 : 2000);
}

class BadRequest extends Error {}

function withBody(req: IncomingMessage, res: ServerResponse, fn: (body: Record<string, unknown>) => unknown): void {
  readBody(req)
    .then((raw) => {
      let body: unknown;
      try {
        body = raw.trim() ? JSON.parse(raw) : {};
      } catch {
        throw new BadRequest("body must be JSON");
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequest("body must be a JSON object");
      json(res, fn(body as Record<string, unknown>));
    })
    .catch((e: unknown) => {
      if (res.headersSent) return;
      text(res, 400, e instanceof Error ? e.message : String(e));
    });
}

function state(engine: Engine, replay: ReplayControl | null) {
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
    replay: replay?.state() ?? null,
    dailyLossCap: cfg.dailyLossCap,
    capital: getCapital(),
    stats,
    curve,
  };
}

function sse(req: IncomingMessage, res: ServerResponse, engine: Engine, replay: ReplayControl | null): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify(state(engine, replay))}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
}

function broadcast(engine: Engine, replay: ReplayControl | null): void {
  if (!clients.size) return;
  const payload = `data: ${JSON.stringify(state(engine, replay))}\n\n`;
  for (const c of clients) c.write(payload);
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function staticFile(res: ServerResponse, pathname: string, guard: Guard): void {
  const path = resolveStatic(pathname);
  if (!path) return text(res, 404, "not found");
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch {
    return text(res, 404, "not found");
  }
  const ext = extname(path);
  const type = ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : "text/html; charset=utf-8";
  const headers: Record<string, string> = { "Content-Type": type, "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff" };
  if (ext === ".html" && !guard.tokenForReads) {
    headers["Cache-Control"] = "no-store";
    const html = data.toString("utf8").replace("</head>", `<meta name="wd-token" content="${guard.token}">\n</head>`);
    res.writeHead(200, headers);
    res.end(html);
    return;
  }
  res.writeHead(200, headers);
  res.end(data);
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) return reject(new BadRequest("body too large"));
      chunks.push(Buffer.from(c));
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}