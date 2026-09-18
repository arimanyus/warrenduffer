import { cfg, risk } from "../config.js";
import { db } from "../db.js";
import { alert } from "../alerts.js";
import type { KotakClient } from "../kotak/client.js";
import { fillCost } from "../kotak/costs.js";
import type { Quote, WorkingOrder } from "../types.js";
import type { Executor, PlaceIntent } from "./types.js";

export class LiveExecutor implements Executor {
  name = "live";
  orders = new Map<number, WorkingOrder>();
  onFill?: (fill: { order: WorkingOrder; qty: number; price: number; cost: number }) => void;
  lastBrokerPoll = 0;

  constructor(private client: KotakClient) {}

  async place(intent: PlaceIntent): Promise<WorkingOrder> {
    const res = await this.client.place({
      segment: intent.segment,
      tradingSymbol: intent.tradingSymbol,
      token: intent.token,
      side: intent.side,
      qty: intent.qty,
      price: intent.price,
      orderType: intent.orderType ?? (intent.kind === "stop" ? "SL-L" : "L"),
      trigger: intent.trigger,
      tag: intent.tag,
    });
    if (!res.orderId) {
      await alert("order_reject", `place failed ${intent.symbol} ${JSON.stringify(res.raw)}`);
      throw new Error("place failed");
    }
    const info = db
      .prepare(
        `INSERT INTO orders (broker_id, ts, symbol, token, segment, side, qty, price, trigger_price, kind, status, tag, last_modify_at, decision_id, leg, tier, stop, target, stop_bps)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        res.orderId,
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
    if (!order.brokerId) return;
    await this.client.modify({
      orderId: order.brokerId,
      qty: order.qty,
      price,
      trigger,
      orderType: order.kind === "stop" ? "SL-L" : "L",
    });
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
    if (order.brokerId) {
      try {
        await this.client.cancel(order.brokerId);
      } catch (e) {
        await alert("order_reject", `cancel failed ${order.symbol} ${e}`);
      }
    }
    order.status = "cancelled";
    db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(order.id);
    this.orders.delete(order.id);
  }

  async tick(_quotes: Map<string, Quote>): Promise<void> {
    if (Date.now() - this.lastBrokerPoll < 2000) return;
    this.lastBrokerPoll = Date.now();
    const remote = await this.client.orders();
    for (const order of [...this.orders.values()]) {
      const r = remote.find((o) => o.orderId === order.brokerId);
      if (!r) continue;
      const st = r.status.toLowerCase();
      if (st.includes("complete") || st.includes("traded") || r.filledQty >= order.qty) {
        const px = r.price || order.price;
        const cost = fillCost(order.leg, order.side, order.qty, px);
        order.status = "filled";
        db.prepare("UPDATE orders SET status='filled', price=? WHERE id=?").run(px, order.id);
        db.prepare(
          "INSERT INTO fills (ts, order_id, symbol, side, qty, price, cost, simulated) VALUES (?,?,?,?,?,?,?,0)",
        ).run(Date.now(), order.id, order.symbol, order.side, order.qty, px, cost);
        this.orders.delete(order.id);
        this.onFill?.({ order: { ...order, price: px }, qty: order.qty, price: px, cost });
      } else if (st.includes("cancel") || st.includes("reject")) {
        if (st.includes("reject")) await alert("order_reject", `${order.symbol} ${r.status}`);
        order.status = st.includes("reject") ? "rejected" : "cancelled";
        db.prepare("UPDATE orders SET status=? WHERE id=?").run(order.status, order.id);
        this.orders.delete(order.id);
      }
      if (order.kind === "entry" && Date.now() - order.placedAt > risk.entryCancelMs) {
        await this.cancel(order);
      }
    }
    void cfg;
  }
}
