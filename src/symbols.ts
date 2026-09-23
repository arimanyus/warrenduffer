import type { Instrument } from "./types.js";

export const NIFTY50 = [
  "ADANIENT",
  "ADANIPORTS",
  "APOLLOHOSP",
  "ASIANPAINT",
  "AXISBANK",
  "BAJAJFINSV",
  "BAJFINANCE",
  "BEL",
  "BHARTIARTL",
  "BPCL",
  "BRITANNIA",
  "CIPLA",
  "COALINDIA",
  "DIVISLAB",
  "DRREDDY",
  "EICHERMOT",
  "GRASIM",
  "HCLTECH",
  "HDFCBANK",
  "HDFCLIFE",
  "HEROMOTOCO",
  "HINDALCO",
  "HINDUNILVR",
  "ICICIBANK",
  "INDUSINDBK",
  "INFY",
  "ITC",
  "JSWSTEEL",
  "KOTAKBANK",
  "LT",
  "M&M",
  "MARUTI",
  "NESTLEIND",
  "NTPC",
  "ONGC",
  "POWERGRID",
  "RELIANCE",
  "SBILIFE",
  "SBIN",
  "SHRIRAMFIN",
  "SUNPHARMA",
  "TATACONSUM",
  "TMPV",
  "TATASTEEL",
  "TCS",
  "TECHM",
  "TITAN",
  "TRENT",
  "ULTRACEMCO",
  "WIPRO",
] as const;

/** Engine-facing symbol and token for the Nifty 50 index; each broker maps it at its boundary. */
export const INDEX_TOKEN = "Nifty 50";
export const INDEX_SYMBOL = "NIFTY";

export function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function aliasMap(instruments: Instrument[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const i of instruments) {
    m.set(i.symbol.toUpperCase(), i.symbol);
    m.set(i.name.toUpperCase(), i.symbol);
    m.set(i.tradingSymbol.toUpperCase(), i.symbol);
  }
  return m;
}
