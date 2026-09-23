import { cfg } from "./config.js";
import { KotakClient } from "./kotak/client.js";
import type { Instrument, OptionContract, Quote, Side } from "./types.js";
import { ZerodhaClient } from "./zerodha/client.js";

export interface Session {
  baseUrl: string;
  auth: string;
  sid: string;
}

export interface PlaceResult {
  orderId: string | null;
  raw: unknown;
}

export interface BrokerOrder {
  orderId: string;
  symbol: string;
  status: string;
  qty: number;
  filledQty: number;
  price: number;
  trigger: number;
  side: Side;
  product: string;
  tag: string;
}

export interface BrokerPosition {
  symbol: string;
  token: string;
  segment: string;
  qty: number;
  avgPrice: number;
  product: string;
}

export interface MarginCheck {
  available: number;
  required: number;
  ok: boolean;
  raw: unknown;
}

/** What the engine, feed and executor need from a broker. KotakClient and ZerodhaClient implement it; SimBroker implements it for replay. */
export interface Broker {
  session: Session | null;
  lastOk: number;
  login(): Promise<Session>;
  loadScrips(): Promise<void>;
  getInstrument(symbol: string): Instrument | undefined;
  allCash(): Instrument[];
  quotes(tokens: { token: string; segment: string }[]): Promise<Quote[]>;
  candles(token: string, segment: string, from: string, to: string, interval?: string): Promise<
    { ts: number; open: number; high: number; low: number; close: number; volume: number }[]
  >;
  expiries(underlying?: string): Promise<string[]>;
  optionChain(underlying?: string, expiry?: string): Promise<OptionContract[]>;
  marginRequired(args: {
    segment: string;
    token: string;
    tradingSymbol: string;
    side: Side;
    qty: number;
    price: number;
  }): Promise<MarginCheck>;
  place(args: {
    segment: string;
    tradingSymbol: string;
    token?: string;
    side: Side;
    qty: number;
    price: number;
    orderType?: "L" | "SL-L";
    trigger?: number;
    product?: string;
    tag: string;
  }): Promise<PlaceResult>;
  modify(args: {
    orderId: string;
    segment: string;
    tradingSymbol: string;
    token?: string;
    side: Side;
    qty: number;
    price: number;
    trigger?: number;
    orderType?: "L" | "SL-L";
  }): Promise<unknown>;
  cancel(orderId: string): Promise<unknown>;
  orders(): Promise<BrokerOrder[]>;
  positions(): Promise<BrokerPosition[]>;
}

export function createBroker(onSessionLost?: () => void): KotakClient | ZerodhaClient {
  return cfg.broker === "zerodha" ? new ZerodhaClient(onSessionLost) : new KotakClient(onSessionLost);
}
