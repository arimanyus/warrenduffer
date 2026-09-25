import type { Leg, PositionSide, Quote, Side, Tier, WorkingOrder } from "../types.js";

export interface PlaceIntent {
  symbol: string;
  token: string;
  segment: string;
  tradingSymbol: string;
  side: Side;
  qty: number;
  price: number;
  kind: "entry" | "stop" | "exit";
  trigger?: number;
  orderType?: "L" | "SL-L";
  /** Unique per placement, alphanumeric, ≤ 20 chars: brokers echo it back and ambiguous places are matched on it. */
  tag: string;
  decisionId: number | null;
  leg: Leg;
  tier: Tier;
  stop?: number;
  target?: number;
  stopBps?: number;
  marketable?: boolean;
  reason?: string;
}

export interface Fill {
  order: WorkingOrder;
  qty: number;
  price: number;
  cost: number;
}

export interface Executor {
  name: string;
  orders: Map<number, WorkingOrder>;
  /**
   * Throws OrderRejected only when the broker definitively refused. If the outcome is unknown the order is
   * returned unconfirmed and tracked until the order book settles it.
   */
  place(intent: PlaceIntent): Promise<WorkingOrder>;
  /** Throws OrderPending for an unconfirmed order. */
  modify(order: WorkingOrder, price: number, trigger?: number, qty?: number): Promise<void>;
  /** Throws if the order may still be live (cancel failed, or unconfirmed). Fills seen while cancelling are emitted first. */
  cancel(order: WorkingOrder): Promise<void>;
  cancelAll(kind?: "entry" | "stop" | "exit"): Promise<void>;
  tick(quotes: Map<string, Quote>): Promise<void>;
  /** Track an order that already exists at the broker (restart, reconciliation). */
  adopt(intent: PlaceIntent, brokerId: string, filledQty: number): WorkingOrder;
  onFill?: (fill: Fill) => void;
}

export class OrderRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderRejected";
  }
}

export class OrderPending extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderPending";
  }
}

export function opposite(side: PositionSide): Side {
  return side === "long" ? "sell" : "buy";
}

export function sideOf(pos: PositionSide): Side {
  return pos === "long" ? "buy" : "sell";
}

/** Tags as brokers store them: Kite keeps ≤20 alphanumerics; comparisons must survive that. */
export function normTag(tag: string): string {
  return tag.replace(/[^A-Za-z0-9]/g, "").toLowerCase().slice(0, 20);
}

/** Stop tags: "wds…" now; "sl-…" from earlier versions still resting at the broker after an upgrade. */
export function isStopTag(tag: string): boolean {
  return /^(wds|sl)/i.test(tag);
}

/** Every order this engine sends carries the "wd" prefix, so reconciliation never touches manual orders. */
export function isEngineTag(tag: string): boolean {
  return /^wd[a-z0-9]+$/.test(normTag(tag)) || /^sl-?\d+$/i.test(tag);
}

let tagSeq = 0;

/** Compact unique tag: "wd" + kind letter + base36 time + counter (≤ 16 chars). */
export function newTag(kind: "e" | "o" | "x" | "s" | "r", nowMs: number): string {
  tagSeq = (tagSeq + 1) % 1296;
  return `wd${kind}${nowMs.toString(36)}${tagSeq.toString(36).padStart(2, "0")}`;
}

export function isTerminalStatus(status: string): boolean {
  return isCompleteStatus(status) || /cancel|reject/i.test(status);
}

/** Fully done. "Partially traded" and similar working states must not count as a complete fill. */
export function isCompleteStatus(status: string): boolean {
  return !/partial/i.test(status) && /\b(complete|completed|traded|executed)\b/i.test(status);
}
