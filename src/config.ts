import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv();

export type Mode = "paper" | "live";
export type OptionsMode = "paper" | "off";
export type ModelName = "jev" | "mock";
export type OnRestart = "adopt" | "flatten";

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
  riskOffHalt: number;
  exitNow: number;
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
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : Number(v);
}

function str(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

const riskPath = resolve(process.cwd(), "risk.json");
export const risk: RiskConfig = JSON.parse(readFileSync(riskPath, "utf8")) as RiskConfig;

export const cfg = {
  kotakAccessToken: str("KOTAK_ACCESS_TOKEN"),
  kotakMobile: str("KOTAK_MOBILE"),
  kotakUcc: str("KOTAK_UCC"),
  kotakMpin: str("KOTAK_MPIN"),
  kotakTotpSecret: str("KOTAK_TOTP_SECRET"),
  aiGatewayKey: str("AI_GATEWAY_API_KEY"),
  typesafeKey: str("TYPESAFE_AI_API_KEY"),
  model: (str("MODEL", "mock") as ModelName) === "jev" ? "jev" : "mock",
  mode: (str("MODE", "paper") as Mode) === "live" ? "live" : "paper",
  optionsMode: (str("OPTIONS_MODE", "paper") as OptionsMode) === "off" ? "off" : "paper",
  universe: str("UNIVERSE", "nifty50"),
  decisionIntervalS: num("DECISION_INTERVAL_S", 60),
  riskPerTrade: num("RISK_PER_TRADE", 300),
  maxNotional: num("MAX_NOTIONAL", 150000),
  maxPositions: num("MAX_POSITIONS", 3),
  dailyLossCap: num("DAILY_LOSS_CAP", 1000),
  dailyFrictionBudget: num("DAILY_FRICTION_BUDGET", 400),
  entriesBase: num("ENTRIES_BASE", 8),
  entriesMax: num("ENTRIES_MAX", 16),
  onRestart: (str("ON_RESTART", "adopt") as OnRestart) === "flatten" ? "flatten" : "adopt",
  rssFeeds: str("RSS_FEEDS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  telegramBotToken: str("TELEGRAM_BOT_TOKEN"),
  telegramChatId: str("TELEGRAM_CHAT_ID"),
  dbPath: str("DB_PATH", "data/harness.db"),
  host: str("HOST", "127.0.0.1"),
  port: num("PORT", 8080),
  killPath: str("KILL_PATH", "kill.switch"),
  liveQty: num("LIVE_QTY", 0),
};

export const ENTRY_START_MIN = 9 * 60 + 30;
export const ENTRY_END_MIN = 14 * 60 + 30;
export const FLATTEN_MIN = 15 * 60 + 10;
export const MARKET_OPEN_MIN = 9 * 60 + 15;
export const MARKET_CLOSE_MIN = 15 * 60 + 30;
