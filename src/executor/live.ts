import { risk } from "../config.js";
import { db, insertEvent } from "../db.js";
import { alert } from "../alerts.js";
import { fillCost } from "../costs.js";
import type { Quote, WorkingOrder } from "../types.js";
import {
  isCompleteStatus,
  isTerminalStatus,
  normTag,
  OrderPending,
  OrderRejected,
  type Executor,
  type Fill,
  type PlaceIntent,
} from "./types.js";
import { recordFill, recordOrder, setOrderStatus } from "./record.js";
import { clock } from "../time.js";
import type { Broker, BrokerOrder } from "../broker.js";

const POLL_MS = 2000;
/** An unconfirmed order not in the book after this long (and ≥ 2 polls) is treated as never placed. */
const UNCONFIRMED_GIVE_UP_MS = 15_000;
/** How long a given-up tag keeps being watched for; if it surfaces late it is cancelled on sight. */
const GHOST_WATCH_MS = 10 * 60_000;

export class LiveExecutor implements Executor {
  name = "live";
  orders = new Map<number, WorkingOrder>();
  onFill?: (fill: Fill) => void;
  lastBrokerPoll = 0;
  private polling = false;
  /** Broker ids this executor has tracked before; an ambiguous place must never be matched to one of these. */
  private retired = new Set<string>();
  private pollsSincePlace = new Map<number, number>();
  private cancelling = new Set<number>();
  /** Given-up orders by normalized tag: the engine has already replaced them, so a late appearance is a duplicate. */
  private ghosts = new Map<string, { order: WorkingOrder; until: number }>();

  constructor(private client: Broker) {}

  async place(intent: PlaceIntent): Promise<WorkingOrder> {
    const orderType = intent.orderType ?? (intent.kind === "stop" ? "SL-L" : "L");
    let brokerId: string | null = null;
    try {
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
        void alert("order_reject", `place refused ${intent.kind} ${intent.symbol} ${JSON.stringify(res.raw).slice(0, 300)}`);
        throw new OrderRejected(`place refused ${intent.symbol}`);
      }
      brokerId = res.orderId;
    } catch (e) {
      if (e instanceof OrderRejected) throw e;
      // Timeout / network error after send: the broker may hold this order. Track it and let the book decide.
      void alert("order_unknown", `place ${intent.kind} ${intent.side} ${intent.qty} ${intent.symbol} tag ${intent.tag}: outcome unknown (${String(e).slice(0, 120)}); matching against the order book`);
    }
    const order = recordOrder({ ...intent, orderType }, brokerId);
    this.orders.set(order.id, order);
    if (!brokerId) this.pollsSincePlace.set(order.id, 0);
    insertEvent(
      "order",
      `${intent.kind} ${intent.side} ${intent.qty} ${intent.symbol} @${intent.price}${intent.trigger ? ` trg ${intent.trigger}` : ""} ${brokerId ? `#${brokerId}` : "(unconfirmed)"}`,
    );
    return order;
  }

  adopt(intent: PlaceIntent, brokerId: string, filledQty: number): WorkingOrder {
    const order = recordOrder(intent, brokerId, filledQty);
    this.orders.set(order.id, order);
    insertEvent("order", `adopted ${intent.kind} ${intent.side} ${intent.qty} ${intent.symbol} #${brokerId}`);
    return order;
  }

  async modify(order: WorkingOrder, price: number, trigger?: number, qty?: number): Promise<void> {
    if (!order.confirmed || !order.brokerId) throw new OrderPending(`modify ${order.symbol}: order not yet confirmed`);
    const newQty = qty ?? order.qty;
    await this.client.modify({
      orderId: order.brokerId,
      segment: order.segment,
      tradingSymbol: order.tradingSymbol,
      token: order.token,
      side: order.side,
      qty: newQty,
      price,
      trigger: trigger ?? order.trigger ?? undefined,
      orderType: order.orderType,
    });
    order.price = price;
    order.qty = newQty;
    if (trigger !== undefined) order.trigger = trigger;
    order.lastModifyAt = clock.now();
    order.requotes++;
    db.prepare("UPDATE orders SET price=?, trigger_price=?, qty=?, last_modify_at=? WHERE id=?").run(price, order.trigger, newQty, order.lastModifyAt, order.id);
  }

  async cancel(order: WorkingOrder): Promise<void> {
    if (!this.orders.has(order.id)) return;
    if (!order.confirmed || !order.brokerId) {
      order.cancelRequested = true;
      throw new OrderPending(`cancel ${order.symbol}: order not yet confirmed; will cancel once it appears`);
    }
    if (this.cancelling.has(order.id)) throw new OrderPending(`cancel ${order.symbol}: already in progress`);
    this.cancelling.add(order.id);
    try {
      try {
        await this.client.cancel(order.brokerId);
      } catch (e) {
        // Usually "already complete/cancelled". Read the book so a fill that beat the cancel is booked now.
        await this.settle(order).catch(() => undefined);
        if (!this.orders.has(order.id) && order.status === "cancelled") return;
        void alert("order_reject", `cancel failed ${order.kind} ${order.symbol} #${order.brokerId} ${String(e).slice(0, 160)}`);
        throw e;
      }
      // Book any partial fill that landed before the cancel took effect, so callers size follow-ups correctly.
      await this.settle(order).catch(() => undefined);
      if (this.orders.has(order.id)) this.retire(order, "cancelled");
      insertEvent("order", `cancel ${order.kind} ${order.symbol} #${order.brokerId}`);
    } finally {
      this.cancelling.delete(order.id);
    }
  }

  async cancelAll(kind?: "entry" | "stop" | "exit"): Promise<void> {
    for (const o of [...this.orders.values()]) {
      if (kind && o.kind !== kind) continue;
      try {
        await this.cancel(o);
      } catch {
        /* alerted or pending; retried by the caller's next pass */
      }
    }
  }

  async tick(_quotes: Map<string, Quote>): Promise<void> {
    if (!this.client.session || this.polling) return;
    if (clock.now() - this.lastBrokerPoll < POLL_MS) return;
    this.polling = true;
    try {
      this.lastBrokerPoll = clock.now();
      if (!this.orders.size && !this.ghosts.size) return;
      const remote = await this.client.orders();
      this.resolveUnconfirmed(remote);
      await this.cancelGhosts(remote);
      for (const order of [...this.orders.values()]) {
        if (!order.confirmed) continue;
        const r = remote.find((o) => o.orderId === order.brokerId);
        if (!r) continue;
        await this.apply(order, r);
      }
    } finally {
      this.polling = false;
    }
  }

  /** One broker order-book row applied to a tracked order: fills, terminal states, trigger detection, pending cancels. */
  private async apply(order: WorkingOrder, r: BrokerOrder): Promise<void> {
    const st = r.status.toLowerCase().trim();
    const done = isCompleteStatus(st);
    // Some books report 0 filled on a complete row; otherwise trust the reported quantity over the status.
    const filled = Math.min(order.qty, done && !(r.filledQty > 0) ? order.qty : r.filledQty);
    if (filled > order.filledQty) {
      const delta = filled - order.filledQty;
      const px = r.price || order.price;
      const cost = fillCost(order.leg, order.side, delta, px);
      order.filledQty = filled;
      recordFill(order, delta, px, cost, false);
      insertEvent("fill", `${order.kind} ${order.side} ${delta}/${order.qty} ${order.symbol} @${px}`);
      this.onFill?.({ order, qty: delta, price: px, cost });
    }
    if (done || order.filledQty >= order.qty) {
      this.retire(order, "filled", r.price || order.price);
      return;
    }
    if (st.includes("cancel") || st.includes("reject")) {
      if (st.includes("reject")) void alert("order_reject", `${order.kind} ${order.symbol} ${r.status}`);
      this.retire(order, st.includes("reject") ? "rejected" : "cancelled");
      return;
    }
    // Kite and Kotak both move a stop from "trigger pending" to exactly "open" once triggered.
    if (order.kind === "stop" && order.triggeredAt === null && st === "open") order.triggeredAt = clock.now();
    if (this.cancelling.has(order.id)) return;
    if (order.cancelRequested) {
      await this.cancel(order).catch(() => undefined);
      return;
    }
    if (order.kind === "entry" && clock.now() - order.placedAt > risk.entryCancelMs) {
      await this.cancel(order).catch(() => undefined);
    }
  }

  private async settle(order: WorkingOrder): Promise<void> {
    const remote = await this.client.orders();
    const r = remote.find((o) => o.orderId === order.brokerId);
    if (r) await this.apply(order, r);
  }

  private resolveUnconfirmed(remote: BrokerOrder[]): void {
    const known = new Set<string>();
    for (const o of this.orders.values()) if (o.brokerId) known.add(o.brokerId);
    for (const o of [...this.orders.values()]) {
      if (o.confirmed) continue;
      const want = normTag(o.tag);
      const m = want
        ? remote.find(
            (r) =>
              !known.has(r.orderId) && !this.retired.has(r.orderId) && normTag(r.tag) === want && r.side === o.side && (!r.qty || r.qty === o.qty),
          )
        : undefined;
      if (m) {
        o.brokerId = m.orderId;
        o.confirmed = true;
        known.add(m.orderId);
        this.pollsSincePlace.delete(o.id);
        db.prepare("UPDATE orders SET broker_id=? WHERE id=?").run(m.orderId, o.id);
        insertEvent("order", `confirmed ${o.kind} ${o.symbol} tag ${o.tag} as #${m.orderId}`);
        continue;
      }
      const polls = (this.pollsSincePlace.get(o.id) ?? 0) + 1;
      this.pollsSincePlace.set(o.id, polls);
      if (polls >= 2 && clock.now() - o.placedAt >= UNCONFIRMED_GIVE_UP_MS) {
        this.pollsSincePlace.delete(o.id);
        setOrderStatus(o, "rejected");
        this.orders.delete(o.id);
        if (want) this.ghosts.set(want, { order: o, until: clock.now() + GHOST_WATCH_MS });
        void alert("order_unknown", `${o.kind} ${o.symbol} tag ${o.tag} never appeared in the order book; treating it as not placed (will cancel it if it shows up)`);
      }
    }
  }

  /** A given-up order that surfaces late duplicates whatever replaced it: cancel it, and flag any fill for reconcile. */
  private async cancelGhosts(remote: BrokerOrder[]): Promise<void> {
    const now = clock.now();
    for (const [tag, g] of [...this.ghosts]) {
      if (now > g.until) {
        this.ghosts.delete(tag);
        continue;
      }
      const r = remote.find((x) => normTag(x.tag) === tag && x.side === g.order.side && !this.retired.has(x.orderId));
      if (!r) continue;
      this.ghosts.delete(tag);
      this.retired.add(r.orderId);
      if (r.filledQty > 0) {
        void alert("order_unknown", `late ${g.order.kind} ${g.order.symbol} tag ${g.order.tag} #${r.orderId} filled ${r.filledQty}; reconcile will pick up the position`);
      }
      if (isTerminalStatus(r.status)) continue;
      try {
        await this.client.cancel(r.orderId);
        void alert("order_unknown", `late ${g.order.kind} ${g.order.symbol} tag ${g.order.tag} surfaced as #${r.orderId} after give-up; cancelled it`);
      } catch (e) {
        void alert("order_reject", `late ${g.order.kind} ${g.order.symbol} #${r.orderId} surfaced after give-up and cancel failed; cancel it at the broker. ${String(e).slice(0, 120)}`);
      }
    }
  }

  private retire(order: WorkingOrder, status: WorkingOrder["status"], price?: number): void {
    setOrderStatus(order, status, price);
    this.orders.delete(order.id);
    this.pollsSincePlace.delete(order.id);
    if (order.brokerId) this.retired.add(order.brokerId);
  }
}
