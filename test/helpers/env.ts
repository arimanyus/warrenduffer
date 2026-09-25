/**
 * Import first in every test file. Pins every setting so a developer's real .env (broker keys, Telegram,
 * live DB path) can never leak into a test run: dotenv does not override variables that are already set.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const testDir = mkdtempSync(join(tmpdir(), "wd-test-"));

const env: Record<string, string> = {
  BROKER: "kotak",
  KOTAK_ACCESS_TOKEN: "",
  KOTAK_MOBILE: "",
  KOTAK_UCC: "",
  KOTAK_MPIN: "",
  KOTAK_TOTP_SECRET: "",
  ZERODHA_API_KEY: "",
  ZERODHA_API_SECRET: "",
  ZERODHA_ACCESS_TOKEN: "",
  ZERODHA_REQUEST_TOKEN: "",
  AI_GATEWAY_API_KEY: "",
  TYPESAFE_AI_API_KEY: "",
  MODEL: "mock",
  ALLOW_MOCK_TRADING: "1",
  OPTIONS_MODE: "off",
  DECISION_INTERVAL_S: "15",
  POSITION_INTERVAL_S: "5",
  EXIT_CONFIRM_VOTES: "2",
  WILD: "0",
  ENTRY_START: "09:30",
  ENTRY_END: "15:00",
  FLATTEN_AT: "15:10",
  RISK_PER_TRADE: "300",
  MAX_NOTIONAL: "150000",
  MAX_POSITIONS: "3",
  DAILY_LOSS_CAP: "1000",
  MAX_TRADES_PER_DAY: "0",
  JEV_DAILY_TOKEN_BUDGET: "0",
  ON_RESTART: "adopt",
  RSS_FEEDS: "",
  TELEGRAM_BOT_TOKEN: "",
  TELEGRAM_CHAT_ID: "",
  DB_PATH: join(testDir, "test.db"),
  HOST: "127.0.0.1",
  PORT: "8080",
  DASHBOARD_TOKEN: "test-token",
  DASHBOARD_ALLOWED_HOSTS: "",
  ALLOW_REMOTE_DASHBOARD: "0",
  KILL_PATH: join(testDir, "kill.switch"),
  LIVE_QTY: "0",
  CAPITAL: "100000",
  RISK_PCT: "0.003",
  JEV_TIMEOUT_MS: "2500",
  WARMUP_DAYS: "25",
  MAX_REQUOTES: "3",
};

for (const [k, v] of Object.entries(env)) process.env[k] = v;
