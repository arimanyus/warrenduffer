import { db, insertSnapshot } from "../db.js";
import { applyQuoteToBar, seedBars } from "./bars.js";
import type { Bar, Quote } from "../types.js";
import type { Broker } from "../broker.js";
import { INDEX_TOKEN } from "../symbols.js";

export interface Feed {
  kind: "live" | "replay" | "candles";
  tick(): Promise<Map<string, Quote>>;
}

export class LiveFeed implements Feed {
  kind = "live" as const;
  quotes = new Map<string, Quote>();

  constructor(
    private client: Broker,
    private universeTokens: () => { token: string; segment: string; symbol: string }[],
    private activeTokens: () => { token: string; segment: string; symbol: string }[],
    /** Replay already has the bars; polling quotes must not overwrite them. */
    private writeBars = true,
    private writeSnapshots = true,
  ) {}

  async tick(): Promise<Map<string, Quote>> {
    const uni = this.universeTokens();
    const active = this.activeTokens();
    const seen = new Set<string>();
    const req: { token: string; segment: string }[] = [];
    for (const t of [...active, ...uni]) {
      if (seen.has(t.token)) continue;
      seen.add(t.token);
      req.push({ token: t.token, segment: t.segment });
    }
    const qs = await this.client.quotes(req);
    // Positions, stops and the universe are keyed by the symbol we asked with; a broker's own symbol
    // string ("RELIANCE-EQ", display names) would silently orphan the quote from its position.
    const bySegToken = new Map<string, string>();
    const byToken = new Map<string, string>();
    for (const t of uni.concat(active)) {
      bySegToken.set(`${t.segment}:${t.token}`, t.symbol);
      if (!byToken.has(t.token)) byToken.set(t.token, t.symbol);
    }
    const persist = db.transaction((rows: Quote[]) => {
      for (const q of rows) {
        if (this.writeSnapshots) {
          insertSnapshot({
            ts: q.ts,
            symbol: q.symbol,
            token: q.token,
            segment: q.segment,
            ltp: q.ltp,
            bid: q.bid,
            ask: q.ask,
            volume: q.volume,
            tbq: q.tbq,
            tsq: q.tsq,
            bidQty: q.bids.reduce((s, l) => s + l.qty, 0),
            askQty: q.asks.reduce((s, l) => s + l.qty, 0),
            json: JSON.stringify({ bids: q.bids, asks: q.asks }),
          });
        }
        if (this.writeBars) applyQuoteToBar(q);
      }
    });
    for (const q of qs) {
      q.symbol = bySegToken.get(`${q.segment}:${q.token}`) ?? byToken.get(q.token) ?? (q.symbol || q.token);
      this.quotes.set(q.symbol, q);
    }
    if (this.writeSnapshots || this.writeBars) persist(qs);
    return this.quotes;
  }
}

export class ReplayFeed implements Feed {
  kind = "replay" as const;
  private i = 0;
  quotes = new Map<string, Quote>();

  constructor(private rows: Quote[]) {}

  async tick(): Promise<Map<string, Quote>> {
    if (this.i >= this.rows.length) return this.quotes;
    const q = this.rows[this.i++];
    this.quotes.set(q.symbol, q);
    insertSnapshot({
      ts: q.ts,
      symbol: q.symbol,
      token: q.token,
      segment: q.segment,
      ltp: q.ltp,
      bid: q.bid,
      ask: q.ask,
      volume: q.volume,
      tbq: q.tbq,
      tsq: q.tsq,
      bidQty: 0,
      askQty: 0,
      json: "{}",
    });
    applyQuoteToBar(q);
    return this.quotes;
  }
}

export class CandlesFeed implements Feed {
  kind = "candles" as const;
  quotes = new Map<string, Quote>();

  constructor(private series: Map<string, Bar[]>, private idx = 0) {
    for (const [symbol, bars] of series) seedBars(symbol, bars);
  }

  maxLen(): number {
    let m = 0;
    for (const bars of this.series.values()) m = Math.max(m, bars.length);
    return m;
  }

  at(i: number): Map<string, Quote> {
    this.idx = i;
    this.quotes.clear();
    for (const [symbol, bars] of this.series) {
      const b = bars[i];
      if (!b) continue;
      const q: Quote = {
        symbol,
        token: symbol === "Nifty 50" ? INDEX_TOKEN : symbol,
        segment: "nse_cm",
        ts: b.ts,
        ltp: b.close,
        ltq: 0,
        volume: b.volume,
        bid: b.close,
        ask: b.close,
        tbq: 0,
        tsq: 0,
        bids: [],
        asks: [],
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        tickSize: 0.05,
      };
      this.quotes.set(symbol, q);
    }
    return this.quotes;
  }

  async tick(): Promise<Map<string, Quote>> {
    const q = this.at(this.idx);
    this.idx++;
    return q;
  }
}
