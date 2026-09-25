import { db } from "../db.js";
import { clock } from "../time.js";
import type { WorkingOrder } from "../types.js";
import type { PlaceIntent } from "./types.js";

/** Persist an order row and return the in-memory working order for it. */
export function recordOrder(intent: PlaceIntent, brokerId: string | null, filledQty = 0): WorkingOrder {
  const now = clock.now();
  const orderType = intent.orderType ?? (intent.kind === "stop" ? "SL-L" : "L");
  const info = db
    .prepare(
      `INSERT INTO orders (broker_id, ts, symbol, token, segment, side, qty, price, trigger_price, kind, status, tag, last_modify_at, decision_id, leg, tier, stop, target, stop_bps)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      brokerId,
      now,
      intent.symbol,
      intent.token,
      intent.segment,
      intent.side,
      intent.qty,
      intent.price,
      intent.trigger ?? null,
      intent.kind,
      intent.tag,
      now,
      intent.decisionId,
      intent.leg,
      intent.tier,
      intent.stop ?? null,
      intent.target ?? null,
      intent.stopBps ?? null,
    );
  return {
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
    placedAt: now,
    lastModifyAt: now,
    filledQty,
    requotes: 0,
    decisionId: intent.decisionId,
    leg: intent.leg,
    tier: intent.tier,
    stop: intent.stop ?? null,
    target: intent.target ?? null,
    stopBps: intent.stopBps ?? null,
    tradingSymbol: intent.tradingSymbol,
    orderType,
    marketable: intent.marketable ?? false,
    confirmed: brokerId !== null,
    triggeredAt: null,
    cancelRequested: false,
    reason: intent.reason ?? null,
  };
}

export function recordFill(order: WorkingOrder, qty: number, price: number, cost: number, simulated: boolean): void {
  db.prepare("INSERT INTO fills (ts, order_id, symbol, side, qty, price, cost, simulated) VALUES (?,?,?,?,?,?,?,?)").run(
    clock.now(),
    order.id,
    order.symbol,
    order.side,
    qty,
    price,
    cost,
    simulated ? 1 : 0,
  );
}

export function setOrderStatus(order: WorkingOrder, status: WorkingOrder["status"], price?: number): void {
  order.status = status;
  if (price !== undefined) db.prepare("UPDATE orders SET status=?, price=? WHERE id=?").run(status, price, order.id);
  else db.prepare("UPDATE orders SET status=? WHERE id=?").run(status, order.id);
}
