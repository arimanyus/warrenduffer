import { authenticator } from "otplib";
import type { BrokerOrder, BrokerPosition, MarginCheck, PlaceResult, Session } from "../broker.js";
import { cfg } from "../config.js";
import { RateLimiter } from "../limiter.js";
import { INDEX_TOKEN } from "../symbols.js";
import type { Instrument, OptionContract, Quote, Side } from "../types.js";
import { asArray, kotakRefusal, parseKotakCandles, parseKotakOrders, parseKotakPositions, pick } from "./parse.js";
import { parseScripCsv } from "./scrip.js";

/** Failed re-logins back off 30 s, doubling to 5 min, so a bad TOTP/MPIN cannot hammer the login endpoint. */
const RELOGIN_BACKOFF_MS = 30_000;
const RELOGIN_BACKOFF_MAX_MS = 5 * 60_000;

const LOGIN = "https://mis.kotaksecurities.com/login/1.0/tradeApiLogin";
const VALIDATE = "https://mis.kotaksecurities.com/login/1.0/tradeApiValidate";
const FIN_KEY = "neotradeapi";

export class KotakError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export class KotakClient {
  session: Session | null = null;
  lastOk = Date.now();
  readonly limiter = new RateLimiter();
  /** Called with every raw response; used by scripts/probe.ts to verify field names. */
  onRaw?: (endpoint: string, body: unknown) => void;
  private scrips = new Map<string, Instrument>();
  private byToken = new Map<string, Instrument>();
  private foScrips: Instrument[] = [];
  private relogging = false;
  private reloginFailures = 0;
  private nextReloginAt = 0;

  constructor(
    private onSessionExpired?: () => void,
    private accessToken = cfg.kotakAccessToken,
  ) {}

  totp(): string {
    authenticator.options = { step: 30, digits: 6 };
    return authenticator.generate(cfg.kotakTotpSecret.replace(/\s+/g, ""));
  }

  async login(): Promise<Session> {
    const totp = this.totp();
    const loginRes = await this.raw("POST", LOGIN, {
      headers: this.tokenHeaders(),
      body: JSON.stringify({
        mobileNumber: cfg.kotakMobile,
        ucc: cfg.kotakUcc,
        totp,
      }),
    });
    const viewToken = pick(loginRes, ["data.token", "data.Auth", "token", "Auth", "viewToken"]);
    const viewSid = pick(loginRes, ["data.sid", "data.Sid", "sid", "Sid", "viewSid"]);
    if (!viewToken || !viewSid) throw new KotakError("login missing view token/sid", 401, loginRes);

    const valRes = await this.raw("POST", VALIDATE, {
      headers: {
        ...this.tokenHeaders(),
        sid: String(viewSid),
        Auth: String(viewToken),
      },
      body: JSON.stringify({ mpin: cfg.kotakMpin }),
    });
    const auth = pick(valRes, ["data.token", "data.Auth", "token", "Auth"]);
    const sid = pick(valRes, ["data.sid", "data.Sid", "sid", "Sid"]);
    const baseUrl = String(pick(valRes, ["data.baseUrl", "baseUrl", "data.baseURL"]) ?? "").replace(/\/$/, "");
    if (!auth || !sid || !baseUrl) throw new KotakError("validate missing session", 401, valRes);
    this.session = { baseUrl, auth: String(auth), sid: String(sid) };
    this.lastOk = Date.now();
    return this.session;
  }

  async ensureSession(): Promise<Session> {
    if (this.session) return this.session;
    return this.login();
  }

  async reloginOnce(): Promise<boolean> {
    if (this.relogging || Date.now() < this.nextReloginAt) return false;
    this.relogging = true;
    try {
      this.session = null;
      await this.login();
      this.reloginFailures = 0;
      this.nextReloginAt = 0;
      return true;
    } catch {
      this.reloginFailures++;
      this.nextReloginAt = Date.now() + Math.min(RELOGIN_BACKOFF_MAX_MS, RELOGIN_BACKOFF_MS * 2 ** (this.reloginFailures - 1));
      this.onSessionExpired?.();
      return false;
    } finally {
      this.relogging = false;
    }
  }

  async loadScrips(): Promise<void> {
    const sess = await this.ensureSession();
    await this.limiter.takeRequest();
    const res = await this.raw("GET", `${sess.baseUrl}/script-details/1.0/masterscrip/file-paths`, {
      headers: this.tokenHeaders(),
    });
    const paths = (pick(res, ["data.filesPaths", "filesPaths"]) as string[] | undefined) ?? [];
    this.scrips.clear();
    this.byToken.clear();
    this.foScrips = [];
    for (const url of paths) {
      const u = url.toLowerCase();
      const isCm = u.includes("nse_cm");
      const isFo = u.includes("nse_fo");
      if (!isCm && !isFo) continue;
      await this.limiter.takeRequest(true);
      const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new KotakError(`scrip master ${r.status} for ${url}`, r.status);
      const text = await r.text();
      const parsed = parseScripCsv(text, isCm ? "nse_cm" : "nse_fo");
      if (isCm) {
        for (const i of parsed) {
          this.scrips.set(i.symbol, i);
          this.byToken.set(i.token, i);
        }
      } else this.foScrips = parsed;
    }
    const index: Instrument = {
      symbol: INDEX_TOKEN,
      token: INDEX_TOKEN,
      segment: "nse_cm",
      tickSize: 0.05,
      lotSize: 1,
      tradingSymbol: INDEX_TOKEN,
      name: "Nifty 50",
    };
    this.scrips.set(INDEX_TOKEN, index);
    this.byToken.set(INDEX_TOKEN, index);
    if (!this.scrips.size) throw new KotakError("scrip master parsed 0 cash instruments", 500);
  }

  getInstrument(symbol: string): Instrument | undefined {
    return this.scrips.get(symbol);
  }

  allCash(): Instrument[] {
    return [...this.scrips.values()].filter((i) => i.segment === "nse_cm" && i.token !== INDEX_TOKEN);
  }

  foInstruments(): Instrument[] {
    return this.foScrips;
  }

  /** GET {baseUrl}/script-details/1.0/quotes/neosymbol/{seg|token,...}/all — verified 2026-09-18. Index token is its name, e.g. "Nifty 50". */
  async quotes(tokens: { token: string; segment: string }[]): Promise<Quote[]> {
    if (!tokens.length) return [];
    const sess = await this.ensureSession();
    const out: Quote[] = [];
    for (const chunk of chunks(tokens, 25)) {
      await this.limiter.takeRequest(true);
      const neo = chunk.map((t) => encodeURIComponent(`${t.segment}|${t.token}`)).join(",");
      const url = `${sess.baseUrl}/script-details/1.0/quotes/neosymbol/${neo}/all`;
      const res = await this.authed("GET", url, { headers: this.tokenHeaders(), order: false });
      const list = Array.isArray(res) ? res : asArray(pick(res, ["data", "message", "quotes"]) ?? res);
      for (const row of list) out.push(this.normalizeQuote(row));
    }
    return out.filter((q) => q.token);
  }

  async candles(token: string, segment: string, from: string, to: string, interval = "1min"): Promise<
    { ts: number; open: number; high: number; low: number; close: number; volume: number }[]
  > {
    const sess = await this.ensureSession();
    await this.limiter.takeRequest(true);
    const neo = encodeURIComponent(`${segment}|${token}`);
    const url = `${sess.baseUrl}/market-data/1.0/historical/details?neosymbol=${neo}&fromdate=${from}&todate=${to}&interval=${interval}`;
    const res = await this.authed("GET", url, { headers: this.tokenHeaders(), order: false });
    return parseKotakCandles(res);
  }

  async expiries(underlying = "NIFTY"): Promise<string[]> {
    const sess = await this.ensureSession();
    await this.limiter.takeRequest(true);
    const url = `${sess.baseUrl}/market-data/1.0/watchlist/expiries?underlying=${underlying}&exchange=nse_fo&instrument_type=option`;
    const res = await this.authed("GET", url, { headers: this.tokenHeaders(), order: false });
    const list = pick(res, ["data.expiries", "data", "expiries"]) ?? [];
    if (Array.isArray(list)) return list.map(String);
    return [];
  }

  async optionChain(underlying = "NIFTY", expiry?: string): Promise<OptionContract[]> {
    const sess = await this.ensureSession();
    await this.limiter.takeRequest(true);
    let url = `${sess.baseUrl}/market-data/1.0/watchlist/option-chain?exchange=nse_fo&underlying=${underlying}&instrument_type=option&count=20`;
    if (expiry) url += `&expiry=${expiry}`;
    const res = await this.authed("GET", url, { headers: this.tokenHeaders(), order: false });
    // Verified shape: { common_data: { mktLot, expiryDt }, call: [{ inst: { neoSymbol: "nse_fo|56825", symbol, optType, strkPrc, exp }, quote: { ltp, o, h, l, c, vol }, oi }], put: [...] }
    const data = (pick(res, ["data"]) ?? res) as Record<string, unknown>;
    const common = (data.common_data as Record<string, unknown> | undefined) ?? {};
    const lot = Number(common.mktLot ?? 65) || 65;
    const calls = asArray(data.call ?? data.ce ?? data.calls);
    const puts = asArray(data.put ?? data.pe ?? data.puts);
    const out: OptionContract[] = [];
    const push = (row: unknown, fallbackRight: "CE" | "PE") => {
      const r = row as Record<string, unknown>;
      const inst = (r.inst as Record<string, unknown> | undefined) ?? r;
      const quote = (r.quote as Record<string, unknown> | undefined) ?? r;
      const neo = String(inst.neoSymbol ?? "");
      const token = neo.includes("|") ? neo.split("|")[1] : String(inst.instrument_token ?? inst.token ?? "");
      const right = String(inst.optType ?? inst.option_type ?? fallbackRight).toUpperCase().includes("P") ? "PE" : "CE";
      out.push({
        symbol: String(inst.symbol ?? inst.trading_symbol ?? ""),
        token,
        tradingSymbol: String(inst.symbol ?? inst.trading_symbol ?? ""),
        strike: Number(inst.strkPrc ?? inst.strike ?? 0),
        right,
        expiry: String(inst.exp ?? common.expiryDt ?? expiry ?? ""),
        lotSize: lot,
        tickSize: 0.05,
        ltp: Number(quote.ltp ?? 0),
        bid: Number(quote.bid ?? quote.bp ?? 0),
        ask: Number(quote.ask ?? quote.sp ?? 0),
      });
    };
    for (const row of calls) push(row, "CE");
    for (const row of puts) push(row, "PE");
    return out.filter((c) => c.token && c.strike);
  }

  async marginRequired(args: {
    segment: string;
    token: string;
    tradingSymbol: string;
    side: Side;
    qty: number;
    price: number;
    orderType?: string;
    product?: string;
  }): Promise<MarginCheck> {
    const sess = await this.ensureSession();
    await this.limiter.takeOrder();
    // check-margin uses long keys (verified); place/modify use the short ones.
    const jData = {
      brkName: "KOTAK",
      brnchId: "ONLINE",
      exSeg: args.segment,
      tok: args.token,
      trdSym: args.tradingSymbol,
      trnsTp: args.side === "buy" ? "B" : "S",
      qty: String(args.qty),
      prc: px(args.price),
      prcTp: kotakOrderType(args.orderType),
      prod: args.product ?? "MIS",
      trgPrc: "0",
    };
    const res = await this.authed("POST", `${sess.baseUrl}/quick/user/check-margin`, {
      headers: this.sessionFormHeaders(),
      body: form({ jData: JSON.stringify(jData) }),
      order: true,
    });
    // Verified response is flat: { avlCash, totMrgnUsd, mrgnUsd, ordMrgn, rmsVldtd, reqdMrgn, avlMrgn, insufFund, stat, stCode }
    const availRaw = pick(res, ["avlCash", "data.avlCash", "avlMrgn", "data.avlMrgn"]);
    const reqRaw = pick(res, ["ordMrgn", "totMrgnUsd", "reqdMrgn", "data.ordMrgn", "data.totMrgnUsd", "data.reqdMrgn"]);
    const rms = String(pick(res, ["rmsVldtd", "data.rmsVldtd", "stat", "data.stat"]) ?? "");
    const insuf = Number(pick(res, ["insufFund", "data.insufFund"]) ?? 0);
    const available = Number(availRaw ?? NaN);
    const required = Number(reqRaw ?? NaN);
    const parsed = Number.isFinite(available) && Number.isFinite(required);
    const ok = parsed && rms.toUpperCase() === "OK" && insuf <= 0 && available >= required;
    return { available: parsed ? available : 0, required: parsed ? required : Infinity, ok, raw: res };
  }

  async place(args: {
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
  }): Promise<PlaceResult> {
    const sess = await this.ensureSession();
    await this.limiter.takeOrder();
    const jData: Record<string, string> = {
      am: "NO",
      dq: "0",
      es: args.segment,
      mp: "0",
      pc: args.product ?? "MIS",
      pf: "N",
      pr: px(args.price),
      pt: kotakOrderType(args.orderType),
      qt: String(args.qty),
      rt: "DAY",
      tp: px(args.trigger ?? 0),
      ts: args.tradingSymbol,
      tt: args.side === "buy" ? "B" : "S",
      ig: args.tag,
    };
    if (args.token) jData.tk = args.token;
    const res = await this.authed("POST", `${sess.baseUrl}/quick/order/rule/ms/place`, {
      headers: this.sessionFormHeaders(),
      body: form({ jData: JSON.stringify(jData) }),
      order: true,
    });
    const orderId = pick(res, ["nOrdNo", "data.nOrdNo", "norentm", "data.orderId", "orderId"]);
    return { orderId: orderId ? String(orderId) : null, raw: res };
  }

  async modify(args: {
    orderId: string;
    segment: string;
    tradingSymbol: string;
    token?: string;
    side: Side;
    qty: number;
    price: number;
    trigger?: number;
    orderType?: "L" | "SL-L";
    product?: string;
    validity?: string;
  }): Promise<unknown> {
    const sess = await this.ensureSession();
    await this.limiter.takeOrder();
    const jData: Record<string, string> = {
      no: args.orderId,
      es: args.segment,
      ts: args.tradingSymbol,
      tt: args.side === "buy" ? "B" : "S",
      qt: String(args.qty),
      pr: px(args.price),
      tp: px(args.trigger ?? 0),
      pt: kotakOrderType(args.orderType),
      pc: args.product ?? "MIS",
      vd: args.validity ?? "DAY",
      dq: "0",
      mp: "0",
      am: "NO",
      dd: "NA",
    };
    if (args.token) jData.tk = args.token;
    const res = await this.authed("POST", `${sess.baseUrl}/quick/order/vr/modify`, {
      headers: this.sessionFormHeaders(),
      body: form({ jData: JSON.stringify(jData) }),
      order: true,
    });
    const refused = kotakRefusal(res);
    if (refused) throw new KotakError(`modify refused: ${refused}`, 200, res);
    return res;
  }

  async cancel(orderId: string): Promise<unknown> {
    const sess = await this.ensureSession();
    await this.limiter.takeOrder();
    const jData = { no: orderId };
    const res = await this.authed("POST", `${sess.baseUrl}/quick/order/cancel`, {
      headers: this.sessionFormHeaders(),
      body: form({ jData: JSON.stringify(jData) }),
      order: true,
    });
    const refused = kotakRefusal(res);
    if (refused) throw new KotakError(`cancel refused: ${refused}`, 200, res);
    return res;
  }

  async orders(): Promise<BrokerOrder[]> {
    const sess = await this.ensureSession();
    await this.limiter.takeRequest();
    const res = await this.authed("GET", `${sess.baseUrl}/quick/user/orders`, {
      headers: this.sessionHeaders(),
      order: false,
    });
    return parseKotakOrders(res);
  }

  async positions(): Promise<BrokerPosition[]> {
    const sess = await this.ensureSession();
    await this.limiter.takeRequest();
    const res = await this.authed("GET", `${sess.baseUrl}/quick/user/positions`, {
      headers: this.sessionHeaders(),
      order: false,
    });
    return parseKotakPositions(res);
  }

  async limits(): Promise<{ available: number; raw: unknown }> {
    const sess = await this.ensureSession();
    await this.limiter.takeRequest();
    const res = await this.authed("POST", `${sess.baseUrl}/quick/user/limits`, {
      headers: this.sessionFormHeaders(),
      body: form({ jData: JSON.stringify({ seg: "ALL", exch: "ALL", prod: "ALL" }) }),
      order: false,
    });
    return { available: Number(pick(res, ["Net", "data.Net", "avlCash"]) ?? 0), raw: res };
  }

  private tokenHeaders(): Record<string, string> {
    return {
      Authorization: this.accessToken,
      "neo-fin-key": FIN_KEY,
      "Content-Type": "application/json",
    };
  }

  private sessionHeaders(): Record<string, string> {
    if (!this.session) throw new KotakError("no session", 401);
    return {
      Auth: this.session.auth,
      sid: this.session.sid,
      "neo-fin-key": FIN_KEY,
      "Content-Type": "application/json",
    };
  }

  private sessionFormHeaders(): Record<string, string> {
    return { ...this.sessionHeaders(), "Content-Type": "application/x-www-form-urlencoded" };
  }

  private async authed(
    method: string,
    url: string,
    init: { headers: Record<string, string>; body?: string; order: boolean },
  ): Promise<unknown> {
    try {
      const res = await this.raw(method, url, init);
      this.lastOk = Date.now();
      return res;
    } catch (e) {
      if (e instanceof KotakError && e.status === 403) {
        const ok = await this.reloginOnce();
        if (ok) return this.raw(method, url, init);
      }
      throw e;
    }
  }

  private async raw(
    method: string,
    url: string,
    init: { headers: Record<string, string>; body?: string },
  ): Promise<unknown> {
    const res = await fetch(url, { method, headers: init.headers, body: init.body, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { text };
    }
    this.onRaw?.(url.replace(/^https?:\/\/[^/]+/, "").split("?")[0], json);
    if (res.status === 403) throw new KotakError("session expired", 403, json);
    if (!res.ok) throw new KotakError(`kotak ${res.status}`, res.status, json);
    const code = pick(json, ["stCode", "data.stCode", "stat"]);
    if (code && Number(code) === 403) throw new KotakError("session expired", 403, json);
    return json;
  }

  /**
   * Verified payload: exchange_token, display_symbol ("RELIANCE-EQ" / "Nifty 50-IN"), exchange, ltp,
   * last_traded_quantity, total_buy, total_sell, last_volume, ohlc{open,high,low,close},
   * depth{buy:[{price,quantity,orders}],sell:[...]}. Index rows have zero depth/volume.
   */
  private normalizeQuote(row: unknown): Quote {
    const r = row as Record<string, unknown>;
    const ohlc = (r.ohlc as Record<string, unknown> | undefined) ?? {};
    const depth = (r.depth as Record<string, unknown> | undefined) ?? {};
    const bids = levels(depth.buy ?? r.buy ?? r.bids);
    const asks = levels(depth.sell ?? r.sell ?? r.asks);
    const ltp = Number(r.ltp ?? r.last_traded_price ?? r.iv ?? 0);
    const bid = bids[0]?.price ?? Number(r.buy_price ?? r.bp ?? 0);
    const ask = asks[0]?.price ?? Number(r.sell_price ?? r.sp ?? 0);
    const token = String(r.exchange_token ?? r.instrument_token ?? r.tk ?? r.token ?? "");
    const display = String(r.display_symbol ?? r.trading_symbol ?? r.ts ?? r.trdSym ?? "");
    const inst = this.byToken.get(token);
    return {
      symbol: inst?.symbol ?? (token === INDEX_TOKEN ? INDEX_TOKEN : display.replace(/-(EQ|IN)$/i, "")),
      token,
      segment: String(r.exchange ?? r.exchange_segment ?? r.es ?? "nse_cm"),
      ts: Date.now(),
      ltp,
      ltq: Number(r.last_traded_quantity ?? r.ltq ?? 0),
      volume: Number(r.last_volume ?? r.volume ?? r.v ?? 0),
      bid: bid || ltp,
      ask: ask || ltp,
      tbq: Number(r.total_buy ?? r.total_buy_quantity ?? r.tbq ?? 0),
      tsq: Number(r.total_sell ?? r.total_sell_quantity ?? r.tsq ?? 0),
      bids,
      asks,
      open: Number(ohlc.open ?? r.open ?? r.op ?? r.openingPrice ?? 0),
      high: Number(ohlc.high ?? r.high ?? r.h ?? r.highPrice ?? 0),
      low: Number(ohlc.low ?? r.low ?? r.lo ?? r.lowPrice ?? 0),
      close: Number(ohlc.close ?? r.close ?? r.c ?? r.ic ?? ltp),
      tickSize: inst?.tickSize ?? 0.05,
    };
  }
}

function levels(raw: unknown): { price: number; qty: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => {
      const o = x as Record<string, unknown>;
      return { price: Number(o.price ?? o.p ?? 0), qty: Number(o.quantity ?? o.qty ?? o.q ?? 0) };
    })
    .filter((l) => l.price > 0);
}

function chunks<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Kotak order-type codes (verified via check-margin): L, MKT, SL (= stop-loss limit), SL-M. "SL-L" is rejected with stCode 1020. */
function kotakOrderType(t?: string): string {
  if (!t || t === "L") return "L";
  if (t === "SL-L" || t === "SL") return "SL";
  return t;
}

/** Prices go to Kotak as 2-decimal strings; never "715.9000000000001". */
function px(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}
