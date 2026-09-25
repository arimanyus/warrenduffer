import "./helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cfg, parseHhmm, risk, validateConfig, type Config, type RiskConfig } from "../src/config.js";

const times = { entryStart: 570, entryEnd: 900, flatten: 910 };
const check = (c: Partial<Config> = {}, r: Partial<RiskConfig> = {}, t: Partial<typeof times> = {}, env: NodeJS.ProcessEnv = {}) =>
  validateConfig({ ...cfg, ...c }, { ...risk, ...r } as RiskConfig, { ...times, ...t }, env);

describe("validateConfig", () => {
  it("accepts the shipped defaults", () => {
    assert.deepEqual(check(), []);
  });

  it("rejects a NaN loss cap that would otherwise disable the check", () => {
    const problems = check({ dailyLossCap: Number("1,000") });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /DAILY_LOSS_CAP/);
  });

  it("rejects fractional and zero position caps", () => {
    assert.match(check({ maxPositions: 0 }).join(), /MAX_POSITIONS/);
    assert.match(check({ maxPositions: 2.5 }).join(), /MAX_POSITIONS/);
  });

  it("rejects a risk percentage above 5%", () => {
    assert.match(check({ riskPct: 0.5 }).join(), /RISK_PCT/);
  });

  it("caps Kite warm-up at 60 days", () => {
    assert.match(check({ broker: "zerodha", warmupDays: 90 }).join(), /WARMUP_DAYS/);
    assert.deepEqual(check({ broker: "kotak", warmupDays: 90 }), []);
  });

  it("rejects out-of-order and out-of-session windows", () => {
    assert.match(check({}, {}, { entryStart: 910 }).join(), /ENTRY_START must be before ENTRY_END/);
    assert.match(check({}, {}, { entryEnd: 915 }).join(), /ENTRY_END must be before FLATTEN_AT/);
    assert.match(check({}, {}, { flatten: 925 }).join(), /15:20/);
    assert.match(check({}, {}, { entryStart: 540 }).join(), /09:15/);
    assert.match(check({}, {}, { flatten: NaN }).join(), /FLATTEN_AT must be HH:MM/);
  });

  it("refuses to expose the dashboard off-box without an explicit opt-in and a real token", () => {
    assert.match(check({ host: "0.0.0.0" }).join(), /ALLOW_REMOTE_DASHBOARD/);
    assert.match(check({ host: "0.0.0.0", allowRemoteDashboard: true, dashboardToken: "short" }).join(), /DASHBOARD_TOKEN/);
    assert.match(check({ host: "0.0.0.0", allowRemoteDashboard: true, dashboardToken: "x".repeat(32) }).join(), /DASHBOARD_ALLOWED_HOSTS/);
    assert.deepEqual(check({ host: "0.0.0.0", allowRemoteDashboard: true, dashboardToken: "x".repeat(32), dashboardAllowedHosts: ["trader.lan"] }), []);
    assert.deepEqual(check({ host: "10.0.0.5", allowRemoteDashboard: true, dashboardToken: "x".repeat(32) }), []);
  });

  it("rejects typos in enumerated settings instead of silently defaulting", () => {
    assert.match(check({}, {}, {}, { BROKER: "zerodah" }).join(), /BROKER/);
    assert.match(check({}, {}, {}, { MODEL: "jevv" }).join(), /MODEL/);
    assert.match(check({}, {}, {}, { ON_RESTART: "flaten" }).join(), /ON_RESTART/);
    assert.deepEqual(check({}, {}, {}, { BROKER: "Zerodha", MODEL: "JEV" }), []);
  });

  it("rejects missing, non-numeric and out-of-range risk.json keys", () => {
    const { maxStopBps: _drop, ...rest } = risk;
    assert.match(validateConfig(cfg, rest as RiskConfig, times, {}).join(), /maxStopBps/);
    assert.match(check({}, { exitNow: "0.7" as unknown as number }).join(), /exitNow/);
    assert.match(check({}, { minSetupProb: 55 }).join(), /minSetupProb/);
    assert.match(check({}, { minStopBps: 30, maxStopBps: 20 }).join(), /minStopBps must be ≤ maxStopBps/);
    assert.match(check({}, { weights: { ...risk.weights, liquidity: -1 } }).join(), /weights.liquidity/);
  });
});

describe("parseHhmm", () => {
  it("parses valid times", () => {
    assert.equal(parseHhmm("09:30"), 570);
    assert.equal(parseHhmm("9:30"), 570);
  });
  it("rejects anything ambiguous", () => {
    for (const v of ["0930", "09:3", "25:00", "09:60", "9.30", "", "09:30pm"]) assert.ok(Number.isNaN(parseHhmm(v)), v);
  });
});
