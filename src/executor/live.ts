import { risk } from "../config.js";
import { db, insertEvent } from "../db.js";
import { alert } from "../alerts.js";
import { fillCost } from "../costs.js";
import type { Quote, WorkingOrder } from "../types.js";
import type { Executor, Fill, PlaceIntent } from "./types.js";
import { clock } from "../time.js";
import type { Broker } from "../broker.js";

const tradingSymbols = new Map<number, string>();

export class LiveExecutor implements Executor {
  name = "live";
  orders = new Map<number, WorkingOrder>();
  onFill?: (fill: Fill) => void;
  lastBrokerPoll = 0;
  private polling = false;

  constructor(private client: Broker) {}

  async place(intent: PlaceIntent): Promise<WorkingOrder> {
    const orderType = intent.orderType ?? (intent.kind === "stop" ? "SL-L" : "L");
    const res = await this.client.place({
      segment: intent.segment,
      tradingSymbol: intent.tradingSymbol,
      token: intent.token,
      side: intent.side,
      qty: intent.qty,
      price: intent.price,
      orderType,
      trigger: intent.trigger,
      tag: intent.tag,
    });
    if (!res.orderId) {
      await alert("order_reject", `place failed ${intent.symbol} ${JSON.stringify(res.raw).slice(0, 300)}`);
      throw new Error("place failed");
    }
    const info = db
      .prepare(
        `INSERT INTO orders (broker_id, ts, symbol, token, segment, side, qty, price, trigger_price, kind, status, tag, last_modify_at, decision_id, leg, tier, stop, target, stop_bps)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        res.orderId,
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
      brokerId: res.orderId,
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
      tif: intent.tif ?? "LMT",
    };
    tradingSymbols.set(order.id, intent.tradingSymbol);
    this.orders.set(order.id, order);
    insertEvent("order", `${intent.kind} ${intent.side} ${intent.qty} ${intent.symbol} @${intent.price}${intent.trigger ? ` trg ${intent.trigger}` : ""} #${res.orderId}`);
    return order;
  }

  async modify(order: WorkingOrder, price: number, trigger?: number, qty?: number): Promise<void> {
    if (!order.brokerId) return;
    const newQty = qty ?? order.qty;
    await this.client.modify({
      orderId: order.brokerId,
      segment: order.segment,
      tradingSymbol: tradingSymbols.get(order.id) ?? order.symbol,
      token: order.token,
      side: order.side,
      qty: newQty,
      price,
      trigger,
      orderType: order.kind === "stop" ? "SL-L" : "L",
    });
    order.price = price;
    order.qty = newQty;
    if (trigger !== undefined) order.trigger = trigger;
    order.lastModifyAt = clock.now();
    order.requotes++;
    db.prepare("UPDATE orders SET price=?, trigger_price=?, qty=?, last_modify_at=? WHERE id=?").run(
      price,
      order.trigger,
      newQty,
      order.lastModifyAt,
      order.id,
    );
  }

  async cancel(order: WorkingOrder): Promise<void> {
    if (order.brokerId) {
      try {
        await this.client.cancel(order.brokerId);
      } catch (e) {
        await alert("order_reject", `cancel failed ${order.symbol} ${e}`);
        throw e;
      }
    }
    order.status = "cancelled";
    db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(order.id);
    this.orders.delete(order.id);
    insertEvent("order", `cancel ${order.kind} ${order.symbol} #${order.brokerId}`);
  }

  async cancelAll(kind?: "entry" | "stop" | "exit"): Promise<void> {
    for (const o of [...this.orders.values()]) {
      if (kind && o.kind !== kind) continue;
      try {
        await this.cancel(o);
      } catch {
        /* alerted */
      }
    }
  }

  async tick(_quotes: Map<string, Quote>): Promise<void> {
    if (!this.client.session || this.polling) return;
    if (clock.now() - this.lastBrokerPoll < 2000) return;
    this.polling = true;
    try {
      this.lastBrokerPoll = clock.now();
      if (!this.orders.size) return;
      const remote = await this.client.orders();
      for (const order of [...this.orders.values()]) {
        const r = remote.find((o) => o.orderId === order.brokerId);
        if (!r) continue;
        const st = r.status.toLowerCase();
        const done = st.includes("complete") || st.includes("traded") || st.includes("executed");
        const filled = Math.min(order.qty, done ? Math.max(r.filledQty, order.qty) : r.filledQty);
        if (filled > order.filledQty) {
          const delta = filled - order.filledQty;
          const px = r.price || order.price;
          const cost = fillCost(order.leg, order.side, delta, px);
          order.filledQty = filled;
          db.prepare("INSERT INTO fills (ts, order_id, symbol, side, qty, price, cost, simulated) VALUES (?,?,?,?,?,?,?,0)").run(
            clock.now(),
            order.id,
            order.symbol,
            order.side,
            delta,
            px,
            cost,
          );
          insertEvent("fill", `${order.kind} ${order.side} ${delta}/${order.qty} ${order.symbol} @${px}`);
          this.onFill?.({ order, qty: delta, price: px, cost });
        }
        if (done || order.filledQty >= order.qty) {
          order.status = "filled";
          db.prepare("UPDATE orders SET status='filled', price=? WHERE id=?").run(r.price || order.price, order.id);
          this.orders.delete(order.id);
          continue;
        }
        if (st.includes("cancel") || st.includes("reject")) {
          if (st.includes("reject")) await alert("order_reject", `${order.symbol} ${r.status}`);
          order.status = st.includes("reject") ? "rejected" : "cancelled";
          db.prepare("UPDATE orders SET status=? WHERE id=?").run(order.status, order.id);
          this.orders.delete(order.id);
          continue;
        }
        if (order.kind === "entry" && clock.now() - order.placedAt > risk.entryCancelMs) {
          try {
            await this.cancel(order);
          } catch {
            /* alerted; retry next poll */
          }
        }
      }
    } finally {
      this.polling = false;
    }
  }
}
