export type Side = "buy" | "sell";
export type PositionSide = "long" | "short";
export type Leg = "equity" | "options";
export type Tier = "A" | "B";
export type Regime = "trend_up" | "trend_down" | "range" | "volatile";
export type Setup =
  | "long_continuation"
  | "short_continuation"
  | "chop"
  | "stretched";
export type ExitReason =
  | "stop"
  | "target"
  | "time"
  | "exit_now"
  | "thesis_break"
  | "extended"
  | "flatten"
  | "kill"
  | "halt"
  | "cancelled";
export type OrderKind = "entry" | "stop" | "exit";
export type OrderStatus = "open" | "filled" | "cancelled" | "rejected";

export interface BookLevel {
  price: number;
  qty: number;
}

export interface Quote {
  symbol: string;
  token: string;
  segment: string;
  ts: number;
  ltp: number;
  ltq: number;
  volume: number;
  bid: number;
  ask: number;
  tbq: number;
  tsq: number;
  bids: BookLevel[];
  asks: BookLevel[];
  open: number;
  high: number;
  low: number;
  close: number;
  tickSize: number;
}

export interface Bar {
  symbol: string;
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Bucketed<T extends string> {
  value: number;
  label: T;
}

export interface SymbolFeatures {
  symbol: string;
  token: string;
  segment: string;
  ts: number;
  last: number;
  bid: number;
  ask: number;
  spreadBps: number;
  tickSize: number;
  vwapDist: Bucketed<"far_above" | "above" | "near" | "below" | "far_below">;
  dayRangePos: Bucketed<"upper" | "middle" | "lower">;
  returnsBps: {
    m1: Bucketed<"up" | "flat" | "down">;
    m5: Bucketed<"up" | "flat" | "down">;
    m15: Bucketed<"up" | "flat" | "down">;
    m60: Bucketed<"up" | "flat" | "down">;
  };
  volume: {
    rvol20d: number;
    last5mVsPrior15m: Bucketed<"heavy" | "normal" | "light">;
  };
  book: {
    imbalance: number;
    tbqTsqRatio: Bucketed<"buyers" | "balanced" | "sellers">;
  };
  flow5m: {
    upShare: number;
    approximate: true;
  };
  bars1m: string[];
  atr1m: number;
}

export interface IndexFeatures {
  last: number;
  returnsBps: {
    m1: Bucketed<"up" | "flat" | "down">;
    m5: Bucketed<"up" | "flat" | "down">;
    m15: Bucketed<"up" | "flat" | "down">;
  };
  extensionAtr: number;
  breadthAboveVwap: number;
  futuresImbalance: number;
}

export interface Instrument {
  symbol: string;
  token: string;
  segment: string;
  tickSize: number;
  lotSize: number;
  tradingSymbol: string;
  name: string;
}

export interface DecisionRow {
  id?: number;
  ts: number;
  stage: string;
  symbol: string | null;
  question: string;
  answer: string;
  probability: number | null;
  confidence: number | null;
  latencyMs: number;
  tokens: number;
  modelId: string;
}

export interface OpenPosition {
  id: number;
  leg: Leg;
  symbol: string;
  token: string;
  segment: string;
  side: PositionSide;
  qty: number;
  entryPrice: number;
  stop: number;
  target: number;
  openedAt: number;
  decisionId: number | null;
  tier: Tier;
  stopOrderId: string | null;
  entryOrderId: string | null;
  stopBps: number;
  thesis: number | null;
  exitingAt: number;
  closedQty: number;
  exitNotional: number;
  exitCost: number;
  exitReason: string | null;
  mfeBps: number;
  lastVerdict?: string;
  exitVotes: number;
  /** Earliest time a missing exchange stop may be placed again. */
  stopRetryAt: number;
  /** First time the stop was seen breached (LTP through trigger or broker-reported trigger) while still unfilled. */
  stopBreachAt: number;
  /** Per-position stop placement counter, keeps each stop tag unique. */
  stopSeq: number;
}

export interface WorkingOrder {
  id: number;
  brokerId: string | null;
  symbol: string;
  token: string;
  segment: string;
  side: Side;
  qty: number;
  price: number;
  trigger: number | null;
  kind: OrderKind;
  status: OrderStatus;
  tag: string;
  placedAt: number;
  lastModifyAt: number;
  filledQty: number;
  requotes: number;
  decisionId: number | null;
  leg: Leg;
  tier: Tier;
  stop: number | null;
  target: number | null;
  stopBps: number | null;
  tradingSymbol: string;
  orderType: "L" | "SL-L";
  /** Forced exit: kept priced through the touch and re-priced until it fills. */
  marketable: boolean;
  /** False while a place() outcome is unknown (e.g. timeout after send). The poll matches it by tag. */
  confirmed: boolean;
  /** Stop orders: when the broker first reported the trigger hit but the order still unfilled. */
  triggeredAt: number | null;
  /** A cancel was asked for while unconfirmed; it is sent as soon as the broker id is known. */
  cancelRequested: boolean;
  /** Exit reason for exit/stop orders (tags are compacted for brokers and cannot carry it). */
  reason: string | null;
}

export interface GovernorState {
  allowance: number;
  used: number;
  frictionUsed: number;
  frictionBudget: number;
  reason: string;
  trailingExpectancy: number | null;
  todayPnl: number;
  consecutiveLosses: number;
}

export interface DailyContext {
  symbol: string;
  eventToday: number;
  newsBias: "bullish" | "bearish" | "neutral" | "none";
  newsBiasProb: number;
  materiality: number;
  exclude: boolean;
  forbidSide: PositionSide | null;
}

export interface OptionContract {
  symbol: string;
  token: string;
  tradingSymbol: string;
  strike: number;
  right: "CE" | "PE";
  expiry: string;
  lotSize: number;
  tickSize: number;
  ltp: number;
  bid: number;
  ask: number;
}
