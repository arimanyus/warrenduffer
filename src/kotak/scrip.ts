import type { Instrument } from "../types.js";

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
  "TATAMOTORS",
  "TATASTEEL",
  "TCS",
  "TECHM",
  "TITAN",
  "TRENT",
  "ULTRACEMCO",
  "WIPRO",
] as const;

export const INDEX_TOKEN = "Nifty 50";
export const INDEX_SYMBOL = "NIFTY";

export function parseScripCsv(text: string, segment: string): Instrument[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = splitCsv(lines[0]).map((h) => h.trim().toLowerCase());
  const idx = (names: string[]) => header.findIndex((h) => names.some((n) => h === n || h.includes(n)));
  const tokenI = idx(["psymbol", "token", "instrumenttoken", "instrument_token", "pinst"]);
  const symI = idx(["psymbolname", "symbolname", "symbol", "name"]);
  const trdI = idx(["ptrdsymbol", "tradingsymbol", "trading_symbol", "trdsymbol"]);
  const tickI = idx(["ticksize", "tick_size", "pticksize"]);
  const lotI = idx(["lotsize", "lot_size", "plotsize"]);
  const nameI = idx(["pdesc", "description", "company", "scripname"]);
  const out: Instrument[] = [];
  for (const line of lines.slice(1)) {
    const cols = splitCsv(line);
    const token = cols[tokenI] ?? "";
    const symbol = (cols[symI] ?? "").replace(/-EQ$/i, "").trim();
    if (!token || !symbol) continue;
    out.push({
      symbol,
      token: token.trim(),
      segment,
      tickSize: Number(cols[tickI] ?? 0.05) || 0.05,
      lotSize: Number(cols[lotI] ?? 1) || 1,
      tradingSymbol: (cols[trdI] ?? `${symbol}-EQ`).trim(),
      name: (cols[nameI] ?? symbol).trim(),
    });
  }
  return out;
}

function splitCsv(line: string): string[] {
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
