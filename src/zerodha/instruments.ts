import { INDEX_SYMBOL, splitCsv } from "../symbols.js";
import type { Instrument, OptionContract } from "../types.js";

/**
 * Kite instrument dump (GET /instruments/{NSE|NFO}). Header:
 * instrument_token, exchange_token, tradingsymbol, name, last_price, expiry, strike, tick_size, lot_size, instrument_type, segment, exchange.
 * NSE equities: segment "NSE", instrument_type "EQ", tradingsymbol is the bare NSE symbol. Index: segment "INDICES", tradingsymbol "NIFTY 50".
 */
export function buildInstruments(nseCsv: string, nfoCsv: string): { cash: Instrument[]; indexToken: string; options: OptionContract[] } {
  const cash: Instrument[] = [];
  let indexToken = "";
  for (const r of rows(nseCsv)) {
    if (r.segment === "INDICES" && r.tradingsymbol === "NIFTY 50") indexToken = r.instrument_token;
    if (r.segment !== "NSE" || r.instrument_type !== "EQ") continue;
    cash.push({
      symbol: r.tradingsymbol,
      token: r.instrument_token,
      segment: "nse_cm",
      tickSize: Number(r.tick_size) || 0.05,
      lotSize: Number(r.lot_size) || 1,
      tradingSymbol: r.tradingsymbol,
      name: r.name || r.tradingsymbol,
    });
  }
  const options: OptionContract[] = [];
  for (const r of rows(nfoCsv)) {
    if (r.name !== INDEX_SYMBOL || (r.instrument_type !== "CE" && r.instrument_type !== "PE")) continue;
    options.push({
      symbol: r.tradingsymbol,
      token: r.instrument_token,
      tradingSymbol: r.tradingsymbol,
      strike: Number(r.strike),
      right: r.instrument_type as "CE" | "PE",
      expiry: r.expiry,
      lotSize: Number(r.lot_size) || 1,
      tickSize: Number(r.tick_size) || 0.05,
      ltp: 0,
      bid: 0,
      ask: 0,
    });
  }
  return { cash, indexToken, options };
}

function rows(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = splitCsv(lines[0] ?? "").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = splitCsv(line);
    return Object.fromEntries(header.map((h, i) => [h, (cols[i] ?? "").trim()]));
  });
}
