import type { Broker } from "../broker.js";
import { risk } from "../config.js";
import { db, insertEvent } from "../db.js";
import type { Executor, Fill, PlaceIntent } from "../executor/types.js";
import type { BrokerOrder, BrokerPosition, MarginCheck, PlaceResult, Session } from "../kotak/client.js";
import { fillCost } from "../kotak/costs.js";
import { INDEX_TOKEN, NIFTY50 } from "../kotak/scrip.js";
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

  /** Latest completed bar at or before the clock, as a quote with bar OHLC and cumulative day volume. */
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
      const tick = 0.05;
      out.push({
        symbol: t.token,
        token: t.token,
        segment: "nse_cm",
        ts: now,
        ltp: b.close,
        ltq: 0,
        volume: cum,
        bid: b.close - tick / 2 > 0 ? round2(b.close - tick) : b.close,
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
 * Bar-based fills, pessimistic. Orders placed at bar t's close are judged against bar t+1:
 * passive limit fills only if the bar trades through it; stops fill at the worse of trigger and close;
 * exits at touch fill at the worse of the touch and the close.
 */
export class SimExecutor implements Executor {
  name = "sim";
  orders = new Map<number, WorkingOrder>();
  onFill?: (fill: Fill) => void;
  private seq = 0;
  private lastBarTs = new Map<string, number>();

  async place(intent: PlaceIntent): Promise<WorkingOrder> {
    const brokerId = `sim-${++this.seq}`;
    const info = db
      .prepare(
        `INSERT INTO orders (broker_id, ts, symbol, token, segment, side, qty, price, trigger_price, kind, status, tag, last_modify_at, decision_id, leg, tier, stop, target, stop_bps)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        brokerId,
        clock.now(),
        intent.symbol,
        intent.token,
        intent.segment,
        intent.side,
        intent.qty,
        intent.price,
        intent.trigger ?? null,
        intent.kind,
        intent.tag,
        clock.now(),
        intent.decisionId,
        intent.leg,
        intent.tier,
        intent.stop ?? null,
        intent.target ?? null,
        intent.stopBps ?? null,
      );
    const order: WorkingOrder = {
      id: Number(info.lastInsertRowid),
      brokerId,
      symbol: intent.symbol,
      token: intent.token,
      segment: intent.segment,
      side: intent.side,
      qty: intent.qty,
      price: intent.price,
      trigger: intent.trigger ?? null,
      kind: intent.kind,
      status: "open",
      tag: intent.tag,
      placedAt: clock.now(),
      lastModifyAt: clock.now(),
      filledQty: 0,
      requotes: 0,
      decisionId: intent.decisionId,
      leg: intent.leg,
      tier: intent.tier,
      stop: intent.stop ?? null,
      target: intent.target ?? null,
      stopBps: intent.stopBps ?? null,
    };
    this.orders.set(order.id, order);
    insertEvent("order", `${intent.kind} ${intent.side} ${intent.qty} ${intent.symbol} @${intent.price}${intent.trigger ? ` trg ${intent.trigger}` : ""} ${brokerId}`);
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
      // Only judge an order against a bar that closed after it was placed.
      if (q.ts <= order.placedAt) continue;
      const barKey = `${order.id}`;
      if (this.lastBarTs.get(barKey) === q.ts) continue;
      this.lastBarTs.set(barKey, q.ts);
      const tick = q.tickSize || 0.05;
      let px: number | null = null;
      if (order.kind === "stop" && order.trigger !== null) {
        if (order.side === "sell" && q.low <= order.trigger) px = Math.max(order.price, Math.min(order.trigger, q.close)) - tick;
        if (order.side === "buy" && q.high >= order.trigger) px = Math.min(order.price, Math.max(order.trigger, q.close)) + tick;
      } else if (order.kind === "exit") {
        px = order.side === "sell" ? Math.min(order.price, q.close) - tick : Math.max(order.price, q.close) + tick;
      } else if (order.side === "buy" ? q.low < order.price : q.high > order.price) {
        px = order.price;
      }
      if (px !== null && px > 0) {
        px = round2(px);
        const cost = fillCost(order.leg, order.side, order.qty, px);
        order.filledQty = order.qty;
        order.status = "filled";
        db.prepare("UPDATE orders SET status='filled', price=? WHERE id=?").run(px, order.id);
        db.prepare("INSERT INTO fills (ts, order_id, symbol, side, qty, price, cost, simulated) VALUES (?,?,?,?,?,?,?,1)").run(
          clock.now(),
          order.id,
          order.symbol,
          order.side,
          order.qty,
          px,
          cost,
        );
        this.orders.delete(order.id);
        insertEvent("fill", `${order.kind} ${order.side} ${order.qty} ${order.symbol} @${px} (sim)`);
        this.onFill?.({ order, qty: order.qty, price: px, cost });
        continue;
      }
      if (order.kind === "entry" && clock.now() - order.placedAt > risk.entryCancelMs) await this.cancel(order);
    }
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
