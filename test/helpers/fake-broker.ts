import type { Broker, BrokerOrder, BrokerPosition, MarginCheck, PlaceResult, Session } from "../../src/broker.js";
import type { Instrument, OptionContract, Quote, Side } from "../../src/types.js";

type PlaceArgs = Parameters<Broker["place"]>[0];
type ModifyArgs = Parameters<Broker["modify"]>[0];

/** What `place()` does with the next request. "accept-then-throw" models a timeout after the broker took the order. */
export type PlaceMode = "accept" | "reject" | "accept-then-throw" | "throw";

export interface FakeOrder extends BrokerOrder {
  token: string;
  segment: string;
  orderType: string;
}

/** In-memory broker: an order book, net positions and quotes the test drives by hand. */
export class FakeBroker implements Broker {
  session: Session | null = { baseUrl: "fake", auth: "fake", sid: "fake" };
  lastOk = Date.now();
  book: FakeOrder[] = [];
  net = new Map<string, BrokerPosition>();
  quoteBook = new Map<string, Quote>();
  placeModes: PlaceMode[] = [];
  failOrders = false;
  failPositions = false;
  realised: number | undefined = undefined;
  calls: { method: string; args: unknown }[] = [];
  private instruments = new Map<string, Instrument>();
  private seq = 1000;

  constructor(symbols: { symbol: string; token: string; tickSize?: number }[] = []) {
    for (const s of symbols) {
      this.instruments.set(s.symbol, {
        symbol: s.symbol,
        token: s.token,
        segment: "nse_cm",
        tickSize: s.tickSize ?? 0.05,
        lotSize: 1,
        tradingSymbol: `${s.symbol}-EQ`,
        name: s.symbol,
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
    return [...this.instruments.values()];
  }

  setQuote(symbol: string, ltp: number, opts: { bid?: number; ask?: number; ts?: number } = {}): Quote {
    const inst = this.instruments.get(symbol);
    const token = inst?.token ?? symbol;
    const q: Quote = {
      symbol,
      token,
      segment: "nse_cm",
      ts: opts.ts ?? Date.now(),
      ltp,
      ltq: 0,
      volume: 0,
      bid: opts.bid ?? ltp - 0.05,
      ask: opts.ask ?? ltp + 0.05,
      tbq: 0,
      tsq: 0,
      bids: [],
      asks: [],
      open: ltp,
      high: ltp,
      low: ltp,
      close: ltp,
      tickSize: inst?.tickSize ?? 0.05,
    };
    this.quoteBook.set(token, q);
    return q;
  }

  async quotes(tokens: { token: string; segment: string }[]): Promise<Quote[]> {
    this.lastOk = Date.now();
    return tokens.map((t) => this.quoteBook.get(t.token)).filter((q): q is Quote => !!q).map((q) => ({ ...q }));
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
  /** Runs inside marginRequired: lets a test flip state while an entry is between checks and send. */
  onMargin?: () => void;

  async marginRequired(args: { qty: number; price: number }): Promise<MarginCheck> {
    this.calls.push({ method: "margin", args });
    this.onMargin?.();
    return { available: 1e7, required: (args.qty * args.price) / 5, ok: true, raw: null };
  }

  /** While set, place() waits on it after recording the call: models a slow order round-trip. */
  placeGate: Promise<void> | null = null;

  async place(args: PlaceArgs): Promise<PlaceResult> {
    this.calls.push({ method: "place", args });
    if (this.placeGate) await this.placeGate;
    const mode = this.placeModes.shift() ?? "accept";
    if (mode === "throw") throw new Error("network down");
    if (mode === "reject") return { orderId: null, raw: { error: "rejected" } };
    const orderId = String(this.seq++);
    this.book.push({
      orderId,
      symbol: args.tradingSymbol.replace(/-EQ$/, ""),
      token: args.token ?? "",
      segment: args.segment,
      status: args.orderType === "SL-L" ? "trigger pending" : "open",
      qty: args.qty,
      filledQty: 0,
      price: args.price,
      trigger: args.trigger ?? 0,
      side: args.side,
      product: args.product ?? "MIS",
      tag: args.tag,
      orderType: args.orderType ?? "L",
    });
    if (mode === "accept-then-throw") throw new Error("The operation was aborted due to timeout");
    return { orderId, raw: { orderId } };
  }

  /** Next modify calls: "throw" simulates a broker refusal. */
  modifyModes: ("accept" | "throw")[] = [];
  /** While set, cancel() waits on it: models a slow broker round-trip. */
  cancelGate: Promise<void> | null = null;

  async modify(args: ModifyArgs): Promise<unknown> {
    this.calls.push({ method: "modify", args });
    if ((this.modifyModes.shift() ?? "accept") === "throw") throw new Error("modify refused: RMS");
    const o = this.book.find((x) => x.orderId === args.orderId);
    if (!o || !isOpen(o.status)) throw new Error(`modify: order ${args.orderId} not open`);
    o.qty = args.qty;
    o.price = args.price;
    if (args.trigger !== undefined) o.trigger = args.trigger;
    return {};
  }

  async cancel(orderId: string): Promise<unknown> {
    this.calls.push({ method: "cancel", args: orderId });
    if (this.cancelGate) await this.cancelGate;
    const o = this.book.find((x) => x.orderId === orderId);
    if (!o || !isOpen(o.status)) throw new Error(`cancel: order ${orderId} not open`);
    o.status = "cancelled";
    return {};
  }

  async orders(): Promise<BrokerOrder[]> {
    if (this.failOrders) throw new Error("orders endpoint down");
    this.lastOk = Date.now();
    return this.book.map((o) => ({ ...o }));
  }

  async positions(): Promise<BrokerPosition[]> {
    if (this.failPositions) throw new Error("positions endpoint down");
    const rows: BrokerPosition[] = [...this.net.values()].map((p) => ({ ...p }));
    // Brokers keep a flat row for a closed round trip; that row carries the day's realised P&L.
    if (this.realised !== undefined) rows.push({ symbol: "CLOSED", token: "0", segment: "nse_cm", qty: 0, avgPrice: 0, product: "MIS", realisedPnl: this.realised });
    return rows;
  }

  /** Fill (part of) an order at `price` and move the net position. */
  fill(orderId: string, qty?: number, price?: number): void {
    const o = this.book.find((x) => x.orderId === orderId);
    if (!o) throw new Error(`fill: no order ${orderId}`);
    const q = qty ?? o.qty - o.filledQty;
    const px = price ?? o.price;
    const prevFilled = o.filledQty;
    o.filledQty += q;
    o.price = prevFilled ? (o.price * prevFilled + px * q) / o.filledQty : px;
    o.status = o.filledQty >= o.qty ? "complete" : "open";
    this.move(o.symbol, o.token, o.segment, o.side, q, px);
  }

  /** Stop order triggered at the exchange but its limit not reached: it now rests as an open limit. */
  trigger(orderId: string): void {
    const o = this.book.find((x) => x.orderId === orderId);
    if (!o) throw new Error(`trigger: no order ${orderId}`);
    o.status = "open";
  }

  setPosition(symbol: string, token: string, qty: number, avgPrice: number): void {
    if (qty === 0) this.net.delete(symbol);
    else this.net.set(symbol, { symbol, token, segment: "nse_cm", qty, avgPrice, product: "MIS" });
  }

  openOrders(): FakeOrder[] {
    return this.book.filter((o) => isOpen(o.status));
  }

  private move(symbol: string, token: string, segment: string, side: Side, qty: number, px: number): void {
    const cur = this.net.get(symbol);
    const signed = side === "buy" ? qty : -qty;
    const next = (cur?.qty ?? 0) + signed;
    if (next === 0) {
      this.net.delete(symbol);
      return;
    }
    const avg = cur && Math.sign(cur.qty) === Math.sign(next) && Math.abs(next) > Math.abs(cur.qty) ? (cur.avgPrice * Math.abs(cur.qty) + px * qty) / Math.abs(next) : (cur?.avgPrice ?? px);
    this.net.set(symbol, { symbol, token, segment, qty: next, avgPrice: cur && Math.sign(cur.qty) === Math.sign(next) ? avg : px, product: "MIS" });
  }
}

export function isOpen(status: string): boolean {
  const s = status.toLowerCase();
  return !/complete|cancel|reject|traded|executed/.test(s);
}
