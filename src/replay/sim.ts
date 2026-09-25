import type { Broker, BrokerOrder, BrokerPosition, MarginCheck, PlaceResult, Session } from "../broker.js";
import { risk } from "../config.js";
import { barTs } from "../data/bars.js";
import { db, insertEvent } from "../db.js";
import { recordFill, recordOrder, setOrderStatus } from "../executor/record.js";
import type { Executor, Fill, PlaceIntent } from "../executor/types.js";
import { fillCost } from "../costs.js";
import { INDEX_TOKEN, NIFTY50 } from "../symbols.js";
import { clock } from "../time.js";
import type { Bar, Instrument, OptionContract, Quote, WorkingOrder } from "../types.js";

/** Serves the replay day's 1-min bars as quotes at the virtual clock. No book, no orders. */
export class SimBroker implements Broker {
  session: Session | null = { baseUrl: "sim", auth: "sim", sid: "sim" };
  lastOk = Date.now();
  private instruments = new Map<string, Instrument>();
  private cursor = new Map<string, number>();

  constructor(private bars: Map<string, Bar[]>) {
    for (const sym of [...NIFTY50, INDEX_TOKEN]) {
      this.instruments.set(sym, {
        symbol: sym,
        token: sym,
        segment: "nse_cm",
        tickSize: 0.05,
        lotSize: 1,
        tradingSymbol: sym === INDEX_TOKEN ? sym : `${sym}-EQ`,
        name: sym,
      });
    }
  }

  async login(): Promise<Session> {
    return this.session!;
  }
  async loadScrips(): Promise<void> {}
  getInstrument(symbol: string): Instrument | undefined {
    return this.instruments.get(symbol);
  }
  allCash(): Instrument[] {
    return [...this.instruments.values()].filter((i) => i.symbol !== INDEX_TOKEN && this.bars.has(i.symbol));
  }

  /** Latest completed bar at or before the clock, as a quote with that bar's real OHLC. */
  async quotes(tokens: { token: string; segment: string }[]): Promise<Quote[]> {
    this.lastOk = Date.now();
    const now = clock.now();
    const out: Quote[] = [];
    for (const t of tokens) {
      const series = this.bars.get(t.token);
      if (!series) continue;
      let i = this.cursor.get(t.token) ?? -1;
      while (i + 1 < series.length && series[i + 1].ts <= now) i++;
      if (i < 0) continue;
      this.cursor.set(t.token, i);
      const b = series[i];
      let cum = 0;
      for (let k = 0; k <= i; k++) cum += series[k].volume;
      const tick = this.instruments.get(t.token)?.tickSize || 0.05;
      out.push({
        symbol: t.token,
        token: t.token,
        segment: "nse_cm",
        ts: b.ts,
        ltp: b.close,
        ltq: 0,
        volume: cum,
        bid: round2(Math.max(tick, b.close - tick)),
        ask: round2(b.close + tick),
        tbq: 0,
        tsq: 0,
        bids: [],
        asks: [],
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        tickSize: tick,
      });
    }
    return out;
  }

  async candles(): Promise<{ ts: number; open: number; high: number; low: number; close: number; volume: number }[]> {
    return [];
  }
  async expiries(): Promise<string[]> {
    return [];
  }
  async optionChain(): Promise<OptionContract[]> {
    return [];
  }
  async marginRequired(args: { qty: number; price: number }): Promise<MarginCheck> {
    const required = (args.qty * args.price) / 5;
    return { available: 1e9, required, ok: true, raw: null };
  }
  async place(): Promise<PlaceResult> {
    throw new Error("SimBroker.place: replay orders go through SimExecutor");
  }
  async modify(): Promise<unknown> {
    return null;
  }
  async cancel(): Promise<unknown> {
    return null;
  }
  async orders(): Promise<BrokerOrder[]> {
    return [];
  }
  async positions(): Promise<BrokerPosition[]> {
    return [];
  }
}

/**
 * Bar-based fills. Orders placed on bar t are judged on a later bar only.
 * Limits fill at the limit if the bar trades through, or at the open if it gaps through.
 * Stop-limits trigger when the bar crosses the trigger; a gap through the limit leaves them resting
 * as a limit (the engine's unfilled-stop watchdog then takes over). Prices never leave [low, high].
 */
export class SimExecutor implements Executor {
  name = "sim";
  orders = new Map<number, WorkingOrder>();
  onFill?: (fill: Fill) => void;
  private seq = 0;
  private lastBarTs = new Map<string, number>();

  async place(intent: PlaceIntent): Promise<WorkingOrder> {
    const brokerId = `sim-${++this.seq}`;
    const order = recordOrder(intent, brokerId);
    this.orders.set(order.id, order);
    insertEvent("order", `${intent.kind} ${intent.side} ${intent.qty} ${intent.symbol} @${intent.price}${intent.trigger ? ` trg ${intent.trigger}` : ""} ${brokerId}`);
    return order;
  }

  adopt(intent: PlaceIntent, brokerId: string, filledQty: number): WorkingOrder {
    const order = recordOrder(intent, brokerId, filledQty);
    this.orders.set(order.id, order);
    return order;
  }

  async modify(order: WorkingOrder, price: number, trigger?: number, qty?: number): Promise<void> {
    order.price = price;
    if (trigger !== undefined) order.trigger = trigger;
    if (qty !== undefined) order.qty = qty;
    order.lastModifyAt = clock.now();
    order.requotes++;
    db.prepare("UPDATE orders SET price=?, trigger_price=?, qty=?, last_modify_at=? WHERE id=?").run(price, order.trigger, order.qty, order.lastModifyAt, order.id);
  }

  async cancel(order: WorkingOrder): Promise<void> {
    order.status = "cancelled";
    db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(order.id);
    this.orders.delete(order.id);
    insertEvent("order", `cancel ${order.kind} ${order.symbol} ${order.brokerId}`);
  }

  async cancelAll(kind?: "entry" | "stop" | "exit"): Promise<void> {
    for (const o of [...this.orders.values()]) if (!kind || o.kind === kind) await this.cancel(o);
  }

  async tick(quotes: Map<string, Quote>): Promise<void> {
    for (const order of [...this.orders.values()]) {
      const q = quotes.get(order.symbol);
      if (!q) continue;
      const qBar = barTs(q.ts);
      if (qBar <= barTs(order.placedAt)) continue;
      const barKey = `${order.id}`;
      if (this.lastBarTs.get(barKey) === qBar) continue;
      this.lastBarTs.set(barKey, qBar);
      const px = fillAgainstBar(order, q);
      if (px !== null && px > 0) {
        const qty = order.qty - order.filledQty;
        const cost = fillCost(order.leg, order.side, qty, px);
        order.filledQty = order.qty;
        setOrderStatus(order, "filled", px);
        recordFill(order, qty, px, cost, true);
        this.orders.delete(order.id);
        insertEvent("fill", `${order.kind} ${order.side} ${qty} ${order.symbol} @${px} (sim)`);
        this.onFill?.({ order, qty, price: px, cost });
        continue;
      }
      if (order.kind === "stop" && order.triggeredAt === null && stopTriggered(order, q)) order.triggeredAt = clock.now();
      if (order.kind === "entry" && clock.now() - order.placedAt > risk.entryCancelMs) await this.cancel(order);
    }
  }
}

/** Next-bar fill that cannot print outside the bar. Exported for checks. */
export function fillAgainstBar(order: WorkingOrder, q: Quote): number | null {
  const open = q.open || q.ltp;
  const high = q.high || Math.max(open, q.close || q.ltp);
  const low = q.low || Math.min(open, q.close || q.ltp);
  let raw: number | null = null;

  const untriggeredStop = order.kind === "stop" && order.trigger !== null && order.triggeredAt === null;
  if (untriggeredStop && order.trigger !== null) {
    const t = order.trigger;
    if (!stopTriggered(order, q)) return null;
    const gapped = order.side === "sell" ? open <= t : open >= t;
    if (!gapped) {
      raw = t;
    } else if (order.side === "sell") {
      // Triggered at the open; it is now a sell limit at `price`.
      if (open >= order.price) raw = open;
      else if (high >= order.price) raw = order.price;
      else return null;
    } else {
      if (open <= order.price) raw = open;
      else if (low <= order.price) raw = order.price;
      else return null;
    }
  } else if (order.side === "buy") {
    if (low > order.price) return null;
    raw = open <= order.price ? open : order.price;
  } else {
    if (high < order.price) return null;
    raw = open >= order.price ? open : order.price;
  }

  return round2(Math.min(high, Math.max(low, raw)));
}

function stopTriggered(order: WorkingOrder, q: Quote): boolean {
  if (order.trigger === null) return false;
  const open = q.open || q.ltp;
  const high = q.high || Math.max(open, q.close || q.ltp);
  const low = q.low || Math.min(open, q.close || q.ltp);
  return order.side === "sell" ? low <= order.trigger : high >= order.trigger;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
