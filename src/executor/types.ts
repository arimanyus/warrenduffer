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
  tag: string;
  decisionId: number | null;
  leg: Leg;
  tier: Tier;
  stop?: number;
  target?: number;
  stopBps?: number;
  tif?: "MKT" | "LMT";
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
  place(intent: PlaceIntent): Promise<WorkingOrder>;
  modify(order: WorkingOrder, price: number, trigger?: number, qty?: number): Promise<void>;
  cancel(order: WorkingOrder): Promise<void>;
  cancelAll(kind?: "entry" | "stop" | "exit"): Promise<void>;
  tick(quotes: Map<string, Quote>): Promise<void>;
  onFill?: (fill: Fill) => void;
}

export function opposite(side: PositionSide): Side {
  return side === "long" ? "sell" : "buy";
}

export function sideOf(pos: PositionSide): Side {
  return pos === "long" ? "buy" : "sell";
}
