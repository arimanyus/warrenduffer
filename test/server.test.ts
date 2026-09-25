import "./helpers/env.js";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { Engine } from "../src/engine.js";
import { checkRequest, createHandler, type Guard, hostnameOf, resolveStatic } from "../src/server.js";

const TOKEN = "t".repeat(32);
const guard: Guard = { token: TOKEN, allowedHosts: new Set(["127.0.0.1", "localhost", "::1"]), tokenForReads: false };

describe("hostnameOf", () => {
  it("strips ports and IPv6 brackets", () => {
    assert.equal(hostnameOf("127.0.0.1:8787"), "127.0.0.1");
    assert.equal(hostnameOf("LocalHost:1"), "localhost");
    assert.equal(hostnameOf("[::1]:8787"), "::1");
    assert.equal(hostnameOf(undefined), null);
  });
});

describe("checkRequest", () => {
  const req = (method: string, url: string, headers: Record<string, string>) => ({ method, url, headers });

  it("rejects a rebound Host header even on GET", () => {
    assert.equal(checkRequest(req("GET", "/api/state", { host: "evil.example:8787" }), guard)?.status, 421);
  });
  it("allows loopback reads without a token", () => {
    assert.equal(checkRequest(req("GET", "/api/state", { host: "127.0.0.1:8787" }), guard), null);
  });
  it("rejects writes without the token", () => {
    assert.equal(checkRequest(req("POST", "/api/unkill", { host: "127.0.0.1:8787" }), guard)?.status, 401);
    assert.equal(checkRequest(req("POST", "/api/unkill", { host: "127.0.0.1:8787", "x-wd-token": "nope" }), guard)?.status, 401);
  });
  it("does not accept the token from the query string on writes", () => {
    assert.equal(checkRequest(req("POST", `/api/unkill?token=${TOKEN}`, { host: "127.0.0.1:8787" }), guard)?.status, 401);
  });
  it("rejects a foreign Origin even with the token", () => {
    const r = checkRequest(req("POST", "/api/kill", { host: "127.0.0.1:8787", origin: "https://evil.example", "x-wd-token": TOKEN }), guard);
    assert.equal(r?.status, 403);
    assert.equal(checkRequest(req("POST", "/api/kill", { host: "127.0.0.1:8787", origin: "null", "x-wd-token": TOKEN }), guard)?.status, 403);
  });
  it("accepts a same-host write with the token", () => {
    assert.equal(checkRequest(req("POST", "/api/kill", { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787", "x-wd-token": TOKEN }), guard), null);
  });
  it("in remote mode needs the token for reads, via header or query", () => {
    const remote = { ...guard, tokenForReads: true };
    assert.equal(checkRequest(req("GET", "/api/state", { host: "127.0.0.1" }), remote)?.status, 401);
    assert.equal(checkRequest(req("GET", `/events?token=${TOKEN}`, { host: "127.0.0.1" }), remote), null);
    assert.equal(checkRequest(req("GET", "/app.js", { host: "127.0.0.1" }), remote), null);
  });
});

describe("resolveStatic", () => {
  it("serves files under web/ and nothing outside it", () => {
    assert.match(resolveStatic("/") ?? "", /web[\\/]index\.html$/);
    assert.equal(resolveStatic("/%2e%2e/.env"), null);
    assert.equal(resolveStatic("/..%2f.env"), null);
    assert.equal(resolveStatic("/%00"), null);
    assert.equal(resolveStatic("/%E0%A4%A"), null);
  });
});

describe("dashboard handler", () => {
  let server: Server;
  let port = 0;
  const calls: string[] = [];
  const engine = {
    snapshot: () => ({ openUnrealized: 0 }),
    kill: () => calls.push("kill"),
    unkill: () => calls.push("unkill"),
    setJevPaused: (p: boolean) => calls.push(`jev:${p}`),
    setWildMode: (w: boolean) => calls.push(`wild:${w}`),
    jevPaused: false,
    wild: false,
  } as unknown as Engine;

  before(async () => {
    server = createServer(createHandler({ current: () => engine, replay: null, manager: null, guard }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  const send = (method: string, path: string, body?: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      });
      r.on("error", reject);
      if (body !== undefined) r.write(body);
      r.end();
    });

  it("refuses to clear the kill switch without the token", async () => {
    const res = await send("POST", "/api/unkill");
    assert.equal(res.status, 401);
    assert.ok(!calls.includes("unkill"));
  });

  it("clears it with the token", async () => {
    const res = await send("POST", "/api/unkill", "", { "x-wd-token": TOKEN });
    assert.equal(res.status, 200);
    assert.ok(calls.includes("unkill"));
  });

  it("answers malformed JSON with 400 instead of crashing", async () => {
    for (const path of ["/api/jev", "/api/wild", "/api/capital"]) {
      const res = await send("POST", path, "{not json", { "x-wd-token": TOKEN });
      assert.equal(res.status, 400, path);
    }
    const arr = await send("POST", "/api/jev", "[1]", { "x-wd-token": TOKEN });
    assert.equal(arr.status, 400);
  });

  it("rejects oversized bodies", async () => {
    const res = await send("POST", "/api/jev", JSON.stringify({ pad: "x".repeat(70_000) }), { "x-wd-token": TOKEN });
    assert.equal(res.status, 400);
  });

  it("embeds the token only in the loopback index page", async () => {
    const res = await send("GET", "/");
    assert.equal(res.status, 200);
    assert.ok(res.body.includes(`<meta name="wd-token" content="${TOKEN}">`));
  });

  it("does not serve files outside web/", async () => {
    const res = await send("GET", "/%2e%2e/package.json");
    assert.equal(res.status, 404);
  });
});
