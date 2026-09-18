import { risk } from "../config.js";
import { db } from "../db.js";
import { fillCost } from "../kotak/costs.js";
import type { Quote, WorkingOrder } from "../types.js";
import type { Executor, PlaceIntent } from "./types.js";

export class PaperExecutor implements Executor {
  name = "paper";
  orders = new Map<number, WorkingOrder>();
  lastQuotes = new Map<string, Quote>();
  onFill?: (fill: { order: WorkingOrder; qty: number; price: number; cost: number }) => void;

  async place(intent: PlaceIntent): Promise<WorkingOrder> {
    const info = db
      .prepare(
        `INSERT INTO orders (broker_id, ts, symbol, token, segment, side, qty, price, trigger_price, kind, status, tag, last_modify_at, decision_id, leg, tier, stop, target, stop_bps)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        intent.symbol,
        intent.token,
        intent.segment,
        intent.side,
        intent.qty,
        intent.price,
        intent.trigger ?? null,
        intent.kind,
        intent.tag,
        Date.now(),
        intent.decisionId,
        intent.leg,
        intent.tier,
        intent.stop ?? null,
        intent.target ?? null,
        intent.stopBps ?? null,
      );
    const order: WorkingOrder = {
      id: Number(info.lastInsertRowid),
      brokerId: `paper-${info.lastInsertRowid}`,
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
      placedAt: Date.now(),
      lastModifyAt: Date.now(),
      decisionId: intent.decisionId,
      leg: intent.leg,
      tier: intent.tier,
      stop: intent.stop ?? null,
      target: intent.target ?? null,
      stopBps: intent.stopBps ?? null,
    };
    this.orders.set(order.id, order);
    return order;
  }

  async modify(order: WorkingOrder, price: number, trigger?: number): Promise<void> {
    order.price = price;
    if (trigger !== undefined) order.trigger = trigger;
    order.lastModifyAt = Date.now();
    db.prepare("UPDATE orders SET price=?, trigger_price=?, last_modify_at=? WHERE id=?").run(
      price,
      order.trigger,
      order.lastModifyAt,
      order.id,
    );
  }

  async cancel(order: WorkingOrder): Promise<void> {
    order.status = "cancelled";
    db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(order.id);
    this.orders.delete(order.id);
  }

  async tick(quotes: Map<string, Quote>): Promise<void> {
    for (const order of [...this.orders.values()]) {
      const q = quotes.get(order.symbol);
      if (!q) continue;
      const prev = this.lastQuotes.get(order.symbol);
      const filled = this.tryFill(order, q, prev);
      this.lastQuotes.set(order.symbol, q);
      if (!filled) this.expire(order);
    }
  }

  private expire(order: WorkingOrder): void {
    const limit = order.leg === "options" ? risk.optionCancelMs : risk.entryCancelMs;
    if (order.kind === "entry" && Date.now() - order.placedAt > limit) {
      void this.cancel(order);
    }
  }

  private tryFill(order: WorkingOrder, q: Quote, prev?: Quote): boolean {
    const tick = q.tickSize || 0.05;
    let fillPx: number | null = null;
    if (order.kind === "stop" && order.trigger !== null) {
      if (order.side === "sell" && q.ltp <= order.trigger) fillPx = Math.min(order.trigger, q.bid) - tick;
      if (order.side === "buy" && q.ltp >= order.trigger) fillPx = Math.max(order.trigger, q.ask) + tick;
    } else if (order.kind === "exit") {
      fillPx = order.side === "sell" ? q.bid - tick : q.ask + tick;
    } else {
      const dvol = prev ? Math.max(0, q.volume - prev.volume) : 0;
      if (order.side === "buy") {
        if (q.ltp < order.price || (q.ltp === order.price && dvol >= 2 * order.qty)) fillPx = order.price;
      } else if (q.ltp > order.price || (q.ltp === order.price && dvol >= 2 * order.qty)) fillPx = order.price;
    }
    if (fillPx === null || fillPx <= 0) return false;
    const cost = fillCost(order.leg, order.side, order.qty, fillPx);
    order.status = "filled";
    db.prepare("UPDATE orders SET status='filled', price=? WHERE id=?").run(fillPx, order.id);
    db.prepare("INSERT INTO fills (ts, order_id, symbol, side, qty, price, cost, simulated) VALUES (?,?,?,?,?,?,?,1)").run(
      Date.now(),
      order.id,
      order.symbol,
      order.side,
      order.qty,
      fillPx,
      cost,
    );
    this.orders.delete(order.id);
    this.onFill?.({ order: { ...order, price: fillPx }, qty: order.qty, price: fillPx, cost });
    return true;
  }
}
