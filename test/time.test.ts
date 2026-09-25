import "./helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RateLimiter } from "../src/limiter.js";
import { istDateStr, istDayStartMs, minutesOfDay, parseIstTimestamp } from "../src/time.js";

const iso = (ms: number) => new Date(ms).toISOString();

describe("parseIstTimestamp", () => {
  it("honours explicit offsets in both forms", () => {
    assert.equal(iso(parseIstTimestamp("2026-09-15T09:15:00+0530")), "2026-09-15T03:45:00.000Z");
    assert.equal(iso(parseIstTimestamp("2026-09-15T09:15:00+05:30")), "2026-09-15T03:45:00.000Z");
    assert.equal(iso(parseIstTimestamp("2026-09-15T03:45:00Z")), "2026-09-15T03:45:00.000Z");
  });
  it("treats wall-clock strings as IST", () => {
    assert.equal(iso(parseIstTimestamp("2026-09-15 09:15:00")), "2026-09-15T03:45:00.000Z");
    assert.equal(iso(parseIstTimestamp("2026-09-15T09:15")), "2026-09-15T03:45:00.000Z");
    assert.equal(iso(parseIstTimestamp("15-Sep-2026 09:15:00")), "2026-09-15T03:45:00.000Z");
  });
  it("accepts epoch seconds and milliseconds", () => {
    const ms = Date.parse("2026-09-15T03:45:00Z");
    assert.equal(parseIstTimestamp(ms), ms);
    assert.equal(parseIstTimestamp(ms / 1000), ms);
    assert.equal(parseIstTimestamp(String(ms / 1000)), ms);
  });
  it("returns NaN for junk", () => {
    assert.ok(Number.isNaN(parseIstTimestamp("")));
    assert.ok(Number.isNaN(parseIstTimestamp("yesterday")));
  });
});

describe("IST day helpers", () => {
  it("finds IST midnight for a time just after it", () => {
    const t = Date.parse("2026-09-15T18:31:00Z"); // 00:01 IST on the 16th
    assert.equal(istDateStr(t), "2026-09-16");
    assert.equal(iso(istDayStartMs(t)), "2026-09-15T18:30:00.000Z");
    assert.equal(minutesOfDay(t), 1);
  });
});

describe("RateLimiter", () => {
  it("keeps a reserve that low-priority requests cannot use", async () => {
    const l = new RateLimiter(5, 10, 0.2);
    for (let i = 0; i < 8; i++) await l.takeRequest(true);
    const pending = l.takeRequest(true);
    const blocked = await Promise.race([pending.then(() => "took"), new Promise((r) => setTimeout(() => r("waited"), 300))]);
    assert.equal(blocked, "waited");
    await l.takeRequest();
    await l.takeRequest();
    assert.equal(l.used(), 10);

    // Slide the window forward so the parked request drains instead of holding the process for a minute.
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      await pending;
    } finally {
      Date.now = realNow;
    }
  });
});
