import { createHash } from "node:crypto";
import type { Broker, BrokerOrder, BrokerPosition, MarginCheck, PlaceResult, Session } from "../broker.js";
import { cfg } from "../config.js";
import { RateLimiter } from "../limiter.js";
import { INDEX_SYMBOL, INDEX_TOKEN } from "../symbols.js";
import { istDateStr } from "../time.js";
import type { BookLevel, Instrument, OptionContract, Quote, Side } from "../types.js";
import { buildInstruments } from "./instruments.js";

const BASE = "https://api.kite.trade";

type Bucket = "quote" | "hist" | "order" | "other";
type Body = { form?: Record<string, string>; json?: unknown };
type Candle = { ts: number; open: number; high: number; low: number; close: number; volume: number };

export class ZerodhaError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type = "",
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export class ZerodhaClient implements Broker {
  session: Session | null = null;
  lastOk = Date.now();
  /** Called with every successful API response; used by scripts/probe.ts. Login responses never reach it. */
  onRaw?: (endpoint: string, body: unknown) => void;
  private scrips = new Map<string, Instrument>();
  private byToken = new Map<string, Instrument>();
  private foScrips: Instrument[] = [];
  private chain: OptionContract[] = [];
  private indexToken = "";
  /** Kite tokens die daily and can't be renewed headlessly; once dead, stay dead until restart. */
  private dead = false;
  /** Kite v3: quote 1/s, historical 3/s, orders 10/s and 200/min, everything else 10/s. */
  private readonly lim: Record<Bucket, RateLimiter> = {
    quote: new RateLimiter(1, 60),
    hist: new RateLimiter(3, 180),
    order: new RateLimiter(10, 200),
    other: new RateLimiter(10, 600),
  };

  constructor(
    private onSessionLost?: () => void,
    private accessToken = cfg.zerodhaAccessToken,
  ) {}

  async login(): Promise<Session> {
    if (this.dead) throw new ZerodhaError("kite session expired: run pnpm zerodha:login, set ZERODHA_ACCESS_TOKEN, restart", 403, "TokenException");
    try {
      if (!this.accessToken) this.accessToken = await exchangeRequestToken(cfg.zerodhaApiKey, cfg.zerodhaRequestToken, cfg.zerodhaApiSecret);
      const auth = `token ${cfg.zerodhaApiKey}:${this.accessToken}`;
      const profile = (await kite("GET", "/user/profile", auth)) as { user_id?: string } | null;
      this.session = { baseUrl: BASE, auth, sid: String(profile?.user_id ?? "") };
      this.lastOk = Date.now();
      return this.session;
    } catch (e) {
      if (isTokenError(e)) this.dead = true;
      throw e;
    }
  }

  async ensureSession(): Promise<Session> {
    return this.session ?? this.login();
  }

  async loadScrips(): Promise<void> {
    const { cash, indexToken, options } = buildInstruments(await this.csv("/instruments/NSE"), await this.csv("/instruments/NFO"));
    if (!cash.length || !indexToken) throw new ZerodhaError(`instruments: ${cash.length} NSE equities, NIFTY 50 ${indexToken ? "found" : "missing"}`, 500);
    this.scrips.clear();
    this.byToken.clear();
    for (const i of cash) {
      this.scrips.set(i.symbol, i);
      this.byToken.set(i.token, i);
    }
    const index: Instrument = { symbol: INDEX_TOKEN, token: INDEX_TOKEN, segment: "nse_cm", tickSize: 0.05, lotSize: 1, tradingSymbol: "NIFTY 50", name: "Nifty 50" };
    this.scrips.set(INDEX_TOKEN, index);
    this.byToken.set(INDEX_TOKEN, index);
    this.indexToken = indexToken;
    this.chain = options;
    this.foScrips = options.map((c) => ({
      symbol: c.symbol,
      token: c.token,
      segment: "nse_fo",
      tickSize: c.tickSize,
      lotSize: c.lotSize,
      tradingSymbol: c.tradingSymbol,
      name: `${INDEX_SYMBOL} ${c.expiry} ${c.strike} ${c.right}`,
    }));
    for (const i of this.foScrips) this.byToken.set(i.token, i);
  }

  getInstrument(symbol: string): Instrument | undefined {
    return this.scrips.get(symbol);
  }

  allCash(): Instrument[] {
    return [...this.scrips.values()].filter((i) => i.token !== INDEX_TOKEN);
  }

  foInstruments(): Instrument[] {
    return this.foScrips;
  }

  /** GET /quote?i=NSE:RELIANCE&i=NSE:NIFTY%2050 (max 500 per call). Tokens missing from the dump are skipped. */
  async quotes(tokens: { token: string; segment: string }[]): Promise<Quote[]> {
    const known = tokens.filter((t) => this.byToken.has(t.token));
    const out: Quote[] = [];
    for (const chunk of chunks(known, 500)) {
      const keys = chunk.map((t) => `${exchangeOf(t.segment)}:${this.byToken.get(t.token)!.tradingSymbol}`);
      const data = ((await this.call("GET", `/quote?${quoteQuery(keys)}`, "quote")) ?? {}) as Record<string, unknown>;
      chunk.forEach((t, j) => {
        const row = data[keys[j]];
        if (row) out.push(parseQuote(row, t.token, t.segment, this.byToken.get(t.token)));
      });
    }
    return out;
  }

  /** from/to are IST dates (YYYY-MM-DD). Needs the Kite historical add-on; minute data is capped at 60 days per call. */
  async candles(token: string, _segment: string, from: string, to: string, interval = "1min"): Promise<Candle[]> {
    const id = token === INDEX_TOKEN ? this.indexToken : token;
    const q = new URLSearchParams({ from: `${from} 09:15:00`, to: `${to} 15:30:00` });
    return parseCandles(await this.call("GET", `/instruments/historical/${id}/${kiteInterval(interval)}?${q}`, "hist"));
  }

  async expiries(underlying = INDEX_SYMBOL): Promise<string[]> {
    if (underlying !== INDEX_SYMBOL) return [];
    const today = istDateStr();
    return [...new Set(this.chain.map((c) => c.expiry))].filter((e) => e >= today).sort();
  }

  /** Kite has no chain endpoint: contracts come from the NFO dump, prices from /quote. */
  async optionChain(underlying = INDEX_SYMBOL, expiry?: string): Promise<OptionContract[]> {
    const exp = expiry || (await this.expiries(underlying))[0];
    const rows = this.chain.filter((c) => c.expiry === exp);
    const qs = new Map((await this.quotes(rows.map((c) => ({ token: c.token, segment: "nse_fo" })))).map((q) => [q.token, q]));
    return rows.map((c) => {
      const q = qs.get(c.token);
      return { ...c, ltp: q?.ltp ?? 0, bid: q?.bid ?? 0, ask: q?.ask ?? 0 };
    });
  }

  async marginRequired(args: Parameters<Broker["marginRequired"]>[0]): Promise<MarginCheck> {
    const order = {
      exchange: exchangeOf(args.segment),
      tradingsymbol: args.tradingSymbol,
      transaction_type: args.side === "buy" ? "BUY" : "SELL",
      variety: "regular",
      product: "MIS",
      order_type: "LIMIT",
      quantity: args.qty,
      price: Number(px(args.price)),
      trigger_price: 0,
    };
    const margins = await this.call("POST", "/margins/orders", "other", { json: [order] });
    const funds = await this.call("GET", "/user/margins/equity", "other");
    return marginCheck(margins, funds);
  }

  async place(args: Parameters<Broker["place"]>[0]): Promise<PlaceResult> {
    try {
      const data = (await this.call("POST", "/orders/regular", "order", { form: orderForm(args) })) as { order_id?: string } | null;
      return { orderId: data?.order_id ? String(data.order_id) : null, raw: data };
    } catch (e) {
      // Kite answered with a rejection: a null orderId makes the executor alert. Network errors and dead sessions still throw.
      if (e instanceof ZerodhaError && !isTokenError(e)) return { orderId: null, raw: e.body ?? e.message };
      throw e;
    }
  }

  async modify(args: Parameters<Broker["modify"]>[0]): Promise<unknown> {
    return this.call("PUT", `/orders/regular/${args.orderId}`, "order", { form: modifyForm(args) });
  }

  async cancel(orderId: string): Promise<unknown> {
    return this.call("DELETE", `/orders/regular/${orderId}`, "order");
  }

  async orders(): Promise<BrokerOrder[]> {
    return parseOrders(await this.call("GET", "/orders", "other"));
  }

  async positions(): Promise<BrokerPosition[]> {
    return parsePositions(await this.call("GET", "/portfolio/positions", "other"));
  }

  async limits(): Promise<{ available: number; raw: unknown }> {
    const funds = await this.call("GET", "/user/margins/equity", "other");
    return { available: Number((funds as { net?: number } | null)?.net ?? 0), raw: funds };
  }

  private async call(method: string, path: string, bucket: Bucket, body: Body = {}): Promise<unknown> {
    const sess = await this.ensureSession();
    await this.lim[bucket].takeOrder();
    try {
      const data = await kite(method, path, sess.auth, body);
      this.lastOk = Date.now();
      this.onRaw?.(path.split("?")[0], data);
      return data;
    } catch (e) {
      if (isTokenError(e) && this.session) {
        this.session = null;
        this.dead = true;
        this.onSessionLost?.();
      }
      throw e;
    }
  }

  /** Instrument dumps are CSV, not the JSON envelope. */
  private async csv(path: string): Promise<string> {
    const sess = await this.ensureSession();
    await this.lim.other.takeOrder();
    const res = await fetch(BASE + path, { headers: { "X-Kite-Version": "3", Authorization: sess.auth }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new ZerodhaError(`kite ${res.status} ${path}`, res.status);
    return res.text();
  }
}

async function kite(method: string, path: string, auth: string, body: Body = {}): Promise<unknown> {
  const headers: Record<string, string> = { "X-Kite-Version": "3" };
  if (auth) headers.Authorization = auth;
  let payload: string | undefined;
  if (body.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(body.form).toString();
  } else if (body.json !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body.json);
  }
  const res = await fetch(BASE + path, { method, headers, body: payload, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { message: text.slice(0, 200) };
  }
  if (!res.ok || json.status === "error") {
    const type = String(json.error_type ?? "");
    throw new ZerodhaError(`kite ${res.status} ${type}: ${String(json.message ?? "")}`, res.status, type, json);
  }
  return json.data ?? null;
}

/** 403 is also PermissionException (e.g. no market-data plan); only TokenException means the session is gone. */
function isTokenError(e: unknown): boolean {
  return e instanceof ZerodhaError && e.type === "TokenException";
}

export async function exchangeRequestToken(apiKey: string, requestToken: string, apiSecret: string): Promise<string> {
  if (!apiKey || !requestToken || !apiSecret) throw new ZerodhaError("set ZERODHA_ACCESS_TOKEN, or ZERODHA_API_KEY + ZERODHA_API_SECRET + a request_token", 401);
  const checksum = createHash("sha256").update(apiKey + requestToken + apiSecret).digest("hex");
  const data = (await kite("POST", "/session/token", "", { form: { api_key: apiKey, request_token: requestToken, checksum } })) as { access_token?: string } | null;
  if (!data?.access_token) throw new ZerodhaError("session/token returned no access_token", 500);
  return data.access_token;
}

export function loginUrl(apiKey: string): string {
  return `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(apiKey)}`;
}

/** Kite tags are ≤20 alphanumeric chars. Only the stop prefix must round-trip: reconcile() keeps open orders tagged "sl-". */
export function kiteTag(tag: string): string {
  return tag.replace(/^sl-/, "SL").replace(/[^A-Za-z0-9]/g, "").slice(0, 20);
}

export function engineTag(tag: string): string {
  return /^sl\d+$/i.test(tag) ? `sl-${tag.slice(2)}` : tag;
}

export function exchangeOf(segment: string): string {
  return segment === "nse_fo" ? "NFO" : "NSE";
}

export function segmentOf(exchange: string): string {
  return exchange === "NFO" ? "nse_fo" : exchange === "NSE" ? "nse_cm" : "";
}

export function quoteQuery(keys: string[]): string {
  return keys.map((k) => `i=${encodeURIComponent(k)}`).join("&");
}

export function parseQuote(row: unknown, token: string, segment: string, inst?: Instrument): Quote {
  const r = (row ?? {}) as Record<string, unknown>;
  const ohlc = (r.ohlc ?? {}) as Record<string, unknown>;
  const depth = (r.depth ?? {}) as Record<string, unknown>;
  const bids = levels(depth.buy);
  const asks = levels(depth.sell);
  const ltp = Number(r.last_price ?? 0);
  return {
    symbol: inst?.symbol ?? token,
    token,
    segment,
    ts: Date.now(),
    ltp,
    ltq: Number(r.last_quantity ?? 0),
    volume: Number(r.volume ?? 0),
    bid: bids[0]?.price || ltp,
    ask: asks[0]?.price || ltp,
    tbq: Number(r.buy_quantity ?? 0),
    tsq: Number(r.sell_quantity ?? 0),
    bids,
    asks,
    open: Number(ohlc.open ?? 0),
    high: Number(ohlc.high ?? 0),
    low: Number(ohlc.low ?? 0),
    close: Number(ohlc.close ?? ltp),
    tickSize: inst?.tickSize ?? 0.05,
  };
}

export function parseOrders(data: unknown): BrokerOrder[] {
  return (Array.isArray(data) ? data : [])
    .map((row): BrokerOrder => {
      const r = row as Record<string, unknown>;
      return {
        orderId: String(r.order_id ?? ""),
        symbol: String(r.tradingsymbol ?? ""),
        status: String(r.status ?? ""),
        qty: Number(r.quantity ?? 0),
        filledQty: Number(r.filled_quantity ?? 0),
        price: Number(r.average_price) || Number(r.price ?? 0),
        trigger: Number(r.trigger_price ?? 0),
        side: String(r.transaction_type ?? "").toUpperCase() === "SELL" ? "sell" : "buy",
        product: String(r.product ?? "MIS"),
        tag: engineTag(String(r.tag ?? "")),
      };
    })
    .filter((o) => o.orderId);
}

export function parsePositions(data: unknown): BrokerPosition[] {
  const net = (data as { net?: unknown[] } | null)?.net;
  return (Array.isArray(net) ? net : [])
    .map((row): BrokerPosition => {
      const r = row as Record<string, unknown>;
      return {
        symbol: String(r.tradingsymbol ?? ""),
        token: String(r.instrument_token ?? ""),
        segment: segmentOf(String(r.exchange ?? "")),
        qty: Number(r.quantity ?? 0),
        avgPrice: Number(r.average_price ?? 0),
        product: String(r.product ?? "MIS"),
      };
    })
    .filter((p) => p.qty !== 0 && p.segment);
}

export function parseCandles(data: unknown): Candle[] {
  const candles = (data as { candles?: unknown[] } | null)?.candles;
  return (Array.isArray(candles) ? candles : [])
    .map((r) => {
      const a = r as unknown[];
      return {
        ts: Date.parse(String(a[0])),
        open: Number(a[1]),
        high: Number(a[2]),
        low: Number(a[3]),
        close: Number(a[4]),
        volume: Number(a[5] ?? 0),
      };
    })
    .filter((c) => Number.isFinite(c.ts) && Number.isFinite(c.close));
}

export function marginCheck(orderMargins: unknown, funds: unknown): MarginCheck {
  const required = Number((Array.isArray(orderMargins) ? (orderMargins[0] as { total?: number } | undefined)?.total : undefined) ?? NaN);
  const available = Number((funds as { net?: number } | null)?.net ?? NaN);
  const parsed = Number.isFinite(available) && Number.isFinite(required);
  return { available: parsed ? available : 0, required: parsed ? required : Infinity, ok: parsed && available >= required, raw: { orderMargins, funds } };
}

export function orderForm(args: Parameters<Broker["place"]>[0]): Record<string, string> {
  const order_type = kiteOrderType(args.orderType);
  const form: Record<string, string> = {
    exchange: exchangeOf(args.segment),
    tradingsymbol: args.tradingSymbol,
    transaction_type: args.side === "buy" ? "BUY" : "SELL",
    order_type,
    quantity: String(args.qty),
    product: args.product ?? "MIS",
    price: px(args.price),
    validity: "DAY",
  };
  if (order_type === "SL") form.trigger_price = px(args.trigger ?? 0);
  const tag = kiteTag(args.tag);
  if (tag) form.tag = tag;
  return form;
}

export function modifyForm(args: Parameters<Broker["modify"]>[0]): Record<string, string> {
  const order_type = kiteOrderType(args.orderType);
  const form: Record<string, string> = {
    order_type,
    quantity: String(args.qty),
    price: px(args.price),
    validity: "DAY",
  };
  if (order_type === "SL" && args.trigger !== undefined) form.trigger_price = px(args.trigger);
  return form;
}

function kiteOrderType(t?: string): string {
  return t === "SL-L" ? "SL" : "LIMIT";
}

function kiteInterval(i: string): string {
  return i === "1min" ? "minute" : i.replace(/min$/, "minute");
}

function levels(raw: unknown): BookLevel[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => {
      const o = x as { price?: unknown; quantity?: unknown };
      return { price: Number(o.price ?? 0), qty: Number(o.quantity ?? 0) };
    })
    .filter((l) => l.price > 0);
}

function chunks<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Prices go out as 2-decimal strings; never "715.9000000000001". */
function px(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}
