import type { BrokerOrder, BrokerPosition } from "../broker.js";
import { parseIstTimestamp } from "../time.js";
import type { Side } from "../types.js";

type Candle = { ts: number; open: number; high: number; low: number; close: number; volume: number };

export function pick(obj: unknown, paths: string[]): unknown {
  for (const p of paths) {
    let cur: unknown = obj;
    for (const k of p.split(".")) {
      if (cur && typeof cur === "object" && k in (cur as object)) cur = (cur as Record<string, unknown>)[k];
      else {
        cur = undefined;
        break;
      }
    }
    if (cur !== undefined && cur !== null && cur !== "") return cur;
  }
  return undefined;
}

/**
 * Kotak answers a refused modify/cancel with HTTP 200 and `{ stat: "Not_Ok", stCode: 1020, emsg }`.
 * Returns the refusal message, or null for an acknowledged request.
 */
export function kotakRefusal(res: unknown): string | null {
  const stat = String(pick(res, ["stat", "data.stat"]) ?? "");
  const code = pick(res, ["stCode", "data.stCode"]);
  const refused = /not[_ ]?ok/i.test(stat) || (code !== undefined && Number(code) !== 200);
  if (!refused) return null;
  return String(pick(res, ["emsg", "errMsg", "message", "data.emsg"]) ?? `stat ${stat || "?"} stCode ${code ?? "?"}`);
}

export function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.data)) return o.data;
    if (Array.isArray(o.message)) return o.message;
  }
  return [];
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Order book rows. Fill price is the average traded price once anything has filled (`prc` is the limit).
 * The tag is what we sent as `ig`; `usrId` is the account's user id and must never be read as a tag.
 */
export function parseKotakOrders(res: unknown): BrokerOrder[] {
  return asArray(pick(res, ["data", "ord"]) ?? res)
    .map((row) => {
      const r = row as Record<string, unknown>;
      const filledQty = num(r.fldQty ?? r.filledQty);
      const avg = num(r.avgPrc ?? r.avgPrice);
      const limit = num(r.prc ?? r.price);
      return {
        orderId: String(r.nOrdNo ?? r.norentm ?? r.orderId ?? ""),
        symbol: String(r.trdSym ?? r.ts ?? r.tradingSymbol ?? "").replace(/-EQ$/i, ""),
        status: String(r.ordSt ?? r.status ?? r.st ?? ""),
        qty: num(r.qty ?? r.qt),
        filledQty,
        price: filledQty > 0 && avg > 0 ? avg : limit || avg,
        trigger: num(r.trgPrc ?? r.trigger),
        side: (String(r.trnsTp ?? r.tt ?? "").toUpperCase().startsWith("S") ? "sell" : "buy") as Side,
        product: String(r.prod ?? r.pc ?? "MIS"),
        tag: String(r.ig ?? r.tag ?? ""),
      };
    })
    .filter((o) => o.orderId);
}

/**
 * Position rows, including flat ones (a closed round trip still carries the day's realised P&L).
 * Realised = matched quantity × (average sell − average buy), from the day's buy/sell amounts.
 */
export function parseKotakPositions(res: unknown): BrokerPosition[] {
  return asArray(pick(res, ["data", "pos"]) ?? res).map((row) => {
    const r = row as Record<string, unknown>;
    const buyQty = num(r.flBuyQty ?? r.buyQty) + num(r.cfBuyQty);
    const sellQty = num(r.flSellQty ?? r.sellQty) + num(r.cfSellQty);
    const buyAmt = num(r.buyAmt) + num(r.cfBuyAmt);
    const sellAmt = num(r.sellAmt) + num(r.cfSellAmt);
    const qty = buyQty - sellQty || num(r.netQty ?? r.qty);
    const avgBuy = buyQty > 0 ? buyAmt / buyQty : 0;
    const avgSell = sellQty > 0 ? sellAmt / sellQty : 0;
    const matched = Math.min(buyQty, sellQty);
    const haveAmounts = buyAmt > 0 || sellAmt > 0;
    const realisedPnl = haveAmounts ? (matched > 0 ? matched * (avgSell - avgBuy) : 0) : undefined;
    const avgPrice = num(r.avgPrc ?? r.avgPrice) || (qty > 0 ? avgBuy : qty < 0 ? avgSell : 0);
    return {
      symbol: String(r.trdSym ?? r.ts ?? r.tradingSymbol ?? "").replace(/-EQ$/i, ""),
      token: String(r.tok ?? r.tk ?? r.token ?? ""),
      segment: String(r.exSeg ?? r.es ?? "nse_cm"),
      qty,
      avgPrice,
      product: String(r.prod ?? r.pc ?? "MIS"),
      realisedPnl: realisedPnl === undefined ? undefined : Math.round(realisedPnl * 100) / 100,
    };
  });
}

export function parseKotakCandles(res: unknown): Candle[] {
  const rows = (pick(res, ["data.candles", "candles", "data"]) as unknown[]) ?? [];
  return (Array.isArray(rows) ? rows : [])
    .map((r) => {
      if (Array.isArray(r)) {
        return { ts: parseIstTimestamp(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5] ?? 0) };
      }
      const o = r as Record<string, unknown>;
      return {
        ts: parseIstTimestamp(o.time ?? o.timestamp ?? o.datetime),
        open: Number(o.open),
        high: Number(o.high),
        low: Number(o.low),
        close: Number(o.close),
        volume: Number(o.volume ?? o.qty ?? 0),
      };
    })
    .filter((c) => Number.isFinite(c.ts) && Number.isFinite(c.close));
}
