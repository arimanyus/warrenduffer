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
  "TMPV",
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

/**
 * Kotak scrip master (transformed-v1). Verified header:
 * pSymbol (token), pGroup (EQ/BE/...), pSymbolName, pTrdSymbol, pDesc, dTickSize, lLotSize, lPrecision.
 * dTickSize is in price units × 10^lPrecision (RELIANCE: 10 / 10^2 = ₹0.10).
 */
export function parseScripCsv(text: string, segment: string): Instrument[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = splitCsv(lines[0]).map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name.toLowerCase());
  const tokenI = col("pSymbol");
  const groupI = col("pGroup");
  const symI = col("pSymbolName");
  const trdI = col("pTrdSymbol");
  const descI = col("pDesc");
  const tickI = col("dTickSize");
  const lotI = col("lLotSize");
  const precI = col("lPrecision");
  if (tokenI < 0 || symI < 0 || trdI < 0) return [];
  const out: Instrument[] = [];
  for (const line of lines.slice(1)) {
    const cols = splitCsv(line);
    const token = (cols[tokenI] ?? "").trim();
    const symbol = (cols[symI] ?? "").trim();
    const trd = (cols[trdI] ?? "").trim();
    if (!token || !symbol || !trd) continue;
    if (segment === "nse_cm" && groupI >= 0 && (cols[groupI] ?? "").trim() !== "EQ") continue;
    const prec = Number(cols[precI] ?? 2);
    const rawTick = Number(cols[tickI] ?? 0);
    const tickSize = rawTick > 0 && Number.isFinite(prec) ? rawTick / 10 ** prec : 0.05;
    out.push({
      symbol,
      token,
      segment,
      tickSize,
      lotSize: Number(cols[lotI] ?? 1) || 1,
      tradingSymbol: trd,
      name: (cols[descI] ?? symbol).trim(),
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
