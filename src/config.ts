import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ quiet: true });

export type OptionsMode = "on" | "off";
export type ModelName = "jev" | "mock";
export type OnRestart = "adopt" | "flatten";
export type BrokerName = "kotak" | "zerodha";

export interface RiskWeights {
  trend_quality: number;
  flow_alignment: number;
  index_alignment: number;
  liquidity: number;
}

export interface RiskConfig {
  weights: RiskWeights;
  minSetupProb: number;
  minSetupConfidence: number;
  minEntryScore: number;
  minSingleScore: number;
  minOneSided: number;
  maxSpreadBps: number;
  minRvol: number;
  tierASetup: number;
  tierAScore: number;
  stage1MinProb: number;
  wildMinProb: number;
  wildTierA: number;
  wildMaxSpreadBps: number;
  riskOffHalt: number;
  exitNow: number;
  takeProfit: number;
  thesisBroken: number;
  thesisWeak: number;
  extendedTake: number;
  stopAtrMult: number;
  minStopBps: number;
  maxStopBps: number;
  targetMult: number;
  timeStopMin: number;
  entryCancelMs: number;
  optionCancelMs: number;
  optionTimeStopMin: number;
  optionTargetPct: number;
  optionStopPct: number;
  optionMinNoul: number;
  optionFrictionBudget: number;
  optionDailyLossCap: number;
  eventExclude: number;
  newsMaterial: number;
  newsBiasProb: number;
  /** Stop-limit orders rest this far past the trigger (never less than 3 ticks). */
  stopLimitBufferBps: number;
  /** A stop whose trigger has traded but that is still unfilled after this long is replaced by a marketable exit. */
  stopUnfilledMs: number;
  /** Forced exits are limits this far through the touch, re-priced until filled. */
  marketableBps: number;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : Number(v.trim());
}

function str(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

const riskPath = resolve(process.cwd(), "risk.json");
export const risk: RiskConfig = JSON.parse(readFileSync(riskPath, "utf8")) as RiskConfig;

export const cfg = {
  broker: (str("BROKER", "kotak").toLowerCase() === "zerodha" ? "zerodha" : "kotak") as BrokerName,
  kotakAccessToken: str("KOTAK_ACCESS_TOKEN"),
  kotakMobile: str("KOTAK_MOBILE"),
  kotakUcc: str("KOTAK_UCC"),
  kotakMpin: str("KOTAK_MPIN"),
  kotakTotpSecret: str("KOTAK_TOTP_SECRET"),
  zerodhaApiKey: str("ZERODHA_API_KEY"),
  zerodhaApiSecret: str("ZERODHA_API_SECRET"),
  zerodhaAccessToken: str("ZERODHA_ACCESS_TOKEN"),
  zerodhaRequestToken: str("ZERODHA_REQUEST_TOKEN"),
  aiGatewayKey: str("AI_GATEWAY_API_KEY"),
  typesafeKey: str("TYPESAFE_AI_API_KEY"),
  model: (str("MODEL", "mock").toLowerCase() === "jev" ? "jev" : "mock") as ModelName,
  optionsMode: (str("OPTIONS_MODE", "off") === "on" ? "on" : "off") as OptionsMode,
  decisionIntervalS: num("DECISION_INTERVAL_S", 15),
  positionIntervalS: num("POSITION_INTERVAL_S", 5),
  exitConfirmVotes: num("EXIT_CONFIRM_VOTES", 2),
  wild: str("WILD") === "1",
  riskPerTrade: num("RISK_PER_TRADE", 300),
  maxNotional: num("MAX_NOTIONAL", 150000),
  maxPositions: num("MAX_POSITIONS", 3),
  dailyLossCap: num("DAILY_LOSS_CAP", 1000),
  maxTradesPerDay: num("MAX_TRADES_PER_DAY", 0),
  jevDailyTokenBudget: num("JEV_DAILY_TOKEN_BUDGET", 0),
  onRestart: (str("ON_RESTART", "adopt") === "flatten" ? "flatten" : "adopt") as OnRestart,
  rssFeeds: str("RSS_FEEDS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  telegramBotToken: str("TELEGRAM_BOT_TOKEN"),
  telegramChatId: str("TELEGRAM_CHAT_ID"),
  dbPath: str("DB_PATH", "data/harness.db"),
  host: str("HOST", "127.0.0.1"),
  port: num("PORT", 8080),
  dashboardToken: str("DASHBOARD_TOKEN"),
  dashboardAllowedHosts: str("DASHBOARD_ALLOWED_HOSTS")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  allowRemoteDashboard: str("ALLOW_REMOTE_DASHBOARD") === "1",
  killPath: str("KILL_PATH", "kill.switch"),
  liveQty: num("LIVE_QTY", 0),
  capital: num("CAPITAL", 100000),
  riskPct: num("RISK_PCT", 0.003),
  jevTimeoutMs: num("JEV_TIMEOUT_MS", 2500),
  allowMockTrading: str("ALLOW_MOCK_TRADING") === "1",
  warmupDays: num("WARMUP_DAYS", 25),
  maxRequotes: num("MAX_REQUOTES", 3),
};

export type Config = typeof cfg;

/** Enough credentials for the selected broker to attempt a session. */
export function brokerConfigured(): boolean {
  if (cfg.broker === "zerodha") return !!cfg.zerodhaApiKey && (!!cfg.zerodhaAccessToken || (!!cfg.zerodhaRequestToken && !!cfg.zerodhaApiSecret));
  return !!cfg.kotakAccessToken && !!cfg.kotakUcc;
}

/** Strict HH:MM (24h). Anything else is NaN so validation rejects it instead of guessing. */
export function parseHhmm(v: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return NaN;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : NaN;
}

/** Entry window in IST. Default 09:30–15:00; the 15:10 flatten is the hard stop for MIS. */
export const ENTRY_START_MIN = parseHhmm(str("ENTRY_START", "09:30"));
export const ENTRY_END_MIN = parseHhmm(str("ENTRY_END", "15:00"));
export const FLATTEN_MIN = parseHhmm(str("FLATTEN_AT", "15:10"));
export const MARKET_OPEN_MIN = 9 * 60 + 15;
export const MARKET_CLOSE_MIN = 15 * 60 + 30;
/** Brokers auto-square-off MIS from about 15:20; the engine must be flat before that. */
const LATEST_FLATTEN_MIN = 15 * 60 + 20;

const PROBABILITY_KEYS = [
  "minSetupProb",
  "minSetupConfidence",
  "minEntryScore",
  "minSingleScore",
  "minOneSided",
  "tierASetup",
  "tierAScore",
  "stage1MinProb",
  "wildMinProb",
  "wildTierA",
  "riskOffHalt",
  "exitNow",
  "takeProfit",
  "optionMinNoul",
  "eventExclude",
  "newsBiasProb",
] as const;

const POSITIVE_RISK_KEYS = [
  "maxSpreadBps",
  "wildMaxSpreadBps",
  "stopAtrMult",
  "minStopBps",
  "maxStopBps",
  "targetMult",
  "timeStopMin",
  "entryCancelMs",
  "optionCancelMs",
  "optionTimeStopMin",
  "optionTargetPct",
  "optionStopPct",
  "optionFrictionBudget",
  "optionDailyLossCap",
  "stopLimitBufferBps",
  "stopUnfilledMs",
  "marketableBps",
] as const;

const NON_NEGATIVE_RISK_KEYS = ["minRvol", "thesisBroken", "thesisWeak", "extendedTake", "newsMaterial"] as const;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase());
}

/**
 * Every setting that feeds a safety check. A NaN compares false against everything, so an unvalidated
 * typo such as DAILY_LOSS_CAP="1,000" would silently disable the cap. Returns human-readable problems.
 */
export function validateConfig(
  c: Config = cfg,
  r: RiskConfig = risk,
  times: { entryStart: number; entryEnd: number; flatten: number } = { entryStart: ENTRY_START_MIN, entryEnd: ENTRY_END_MIN, flatten: FLATTEN_MIN },
  rawEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  const out: string[] = [];
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const posInt = (name: string, v: number, max = Infinity) => {
    if (!Number.isInteger(v) || v < 1 || v > max) out.push(`${name} must be a whole number ≥ 1${max < Infinity ? ` and ≤ ${max}` : ""} (got ${v})`);
  };
  const nonNegInt = (name: string, v: number) => {
    if (!Number.isInteger(v) || v < 0) out.push(`${name} must be a whole number ≥ 0 (got ${v})`);
  };
  const positive = (name: string, v: number) => {
    if (!finite(v) || v <= 0) out.push(`${name} must be a number > 0 (got ${v})`);
  };
  const oneOf = (name: string, allowed: string[]) => {
    const v = rawEnv[name];
    if (v !== undefined && v.trim() !== "" && !allowed.includes(v.trim().toLowerCase())) out.push(`${name} must be one of ${allowed.join("|")} (got "${v}")`);
  };

  oneOf("BROKER", ["kotak", "zerodha"]);
  oneOf("MODEL", ["jev", "mock"]);
  oneOf("ON_RESTART", ["adopt", "flatten"]);
  oneOf("OPTIONS_MODE", ["on", "off"]);
  oneOf("WILD", ["0", "1"]);
  oneOf("ALLOW_MOCK_TRADING", ["0", "1"]);

  posInt("DECISION_INTERVAL_S", c.decisionIntervalS);
  posInt("POSITION_INTERVAL_S", c.positionIntervalS);
  posInt("EXIT_CONFIRM_VOTES", c.exitConfirmVotes);
  posInt("MAX_POSITIONS", c.maxPositions);
  posInt("WARMUP_DAYS", c.warmupDays, c.broker === "zerodha" ? 60 : Infinity);
  posInt("PORT", c.port, 65535);
  posInt("JEV_TIMEOUT_MS", c.jevTimeoutMs);
  nonNegInt("LIVE_QTY", c.liveQty);
  nonNegInt("MAX_REQUOTES", c.maxRequotes);
  nonNegInt("MAX_TRADES_PER_DAY", c.maxTradesPerDay);
  nonNegInt("JEV_DAILY_TOKEN_BUDGET", c.jevDailyTokenBudget);
  positive("RISK_PER_TRADE", c.riskPerTrade);
  positive("MAX_NOTIONAL", c.maxNotional);
  positive("DAILY_LOSS_CAP", c.dailyLossCap);
  positive("CAPITAL", c.capital);
  if (!finite(c.riskPct) || c.riskPct <= 0 || c.riskPct > 0.05) out.push(`RISK_PCT must be > 0 and ≤ 0.05 (got ${c.riskPct})`);

  const { entryStart, entryEnd, flatten } = times;
  if (!finite(entryStart)) out.push("ENTRY_START must be HH:MM");
  if (!finite(entryEnd)) out.push("ENTRY_END must be HH:MM");
  if (!finite(flatten)) out.push("FLATTEN_AT must be HH:MM");
  if (finite(entryStart) && finite(entryEnd) && finite(flatten)) {
    if (entryStart < MARKET_OPEN_MIN) out.push("ENTRY_START must be at or after 09:15");
    if (!(entryStart < entryEnd)) out.push("ENTRY_START must be before ENTRY_END");
    if (!(entryEnd < flatten)) out.push("ENTRY_END must be before FLATTEN_AT");
    if (flatten > LATEST_FLATTEN_MIN) out.push("FLATTEN_AT must be at or before 15:20 (broker MIS auto square-off)");
  }

  if (!isLoopbackHost(c.host) && !c.allowRemoteDashboard) {
    out.push(`HOST=${c.host} exposes the dashboard (which can clear the kill switch) beyond this machine; keep 127.0.0.1 and tunnel, or set ALLOW_REMOTE_DASHBOARD=1 and DASHBOARD_TOKEN`);
  }
  if (!isLoopbackHost(c.host) && c.allowRemoteDashboard && c.dashboardToken.length < 16) {
    out.push("ALLOW_REMOTE_DASHBOARD=1 requires DASHBOARD_TOKEN of at least 16 characters");
  }
  if (["0.0.0.0", "::", "[::]"].includes(c.host) && c.allowRemoteDashboard && !c.dashboardAllowedHosts.length) {
    out.push(`HOST=${c.host} needs DASHBOARD_ALLOWED_HOSTS (the hostnames or IPs you browse to) so Host-header checks can pass`);
  }

  const rr = r as unknown as Record<string, unknown>;
  const w = (r?.weights ?? {}) as unknown as Record<string, unknown>;
  for (const k of ["trend_quality", "flow_alignment", "index_alignment", "liquidity"]) {
    if (!finite(w[k]) || (w[k] as number) < 0) out.push(`risk.json weights.${k} must be a number ≥ 0`);
  }
  for (const k of PROBABILITY_KEYS) {
    if (!finite(rr[k]) || (rr[k] as number) < 0 || (rr[k] as number) > 1) out.push(`risk.json ${k} must be a number in [0, 1]`);
  }
  for (const k of POSITIVE_RISK_KEYS) {
    if (!finite(rr[k]) || (rr[k] as number) <= 0) out.push(`risk.json ${k} must be a number > 0`);
  }
  for (const k of NON_NEGATIVE_RISK_KEYS) {
    if (!finite(rr[k]) || (rr[k] as number) < 0) out.push(`risk.json ${k} must be a number ≥ 0`);
  }
  if (finite(r?.minStopBps) && finite(r?.maxStopBps) && r.minStopBps > r.maxStopBps) out.push("risk.json minStopBps must be ≤ maxStopBps");
  return out;
}

const problems = validateConfig();
if (problems.length) {
  throw new Error(`Invalid configuration; refusing to start:\n  - ${problems.join("\n  - ")}`);
}
