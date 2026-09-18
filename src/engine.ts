import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { alert } from "./alerts.js";
import { cfg, ENTRY_END_MIN, ENTRY_START_MIN, FLATTEN_MIN, risk } from "./config.js";
import { runDailyContext } from "./context.js";
import { seedBars } from "./data/bars.js";
import { barDayStart, buildFeatures, buildIndexFeatures, loadBars } from "./data/features.js";
import { LiveFeed } from "./data/feed.js";
import { buildUniverse } from "./data/universe.js";
import { contextFor, db, getCapital, insertEvent, pruneSnapshots, todayPnl } from "./db.js";
import { LiveExecutor } from "./executor/live.js";
import type { Executor, Fill } from "./executor/types.js";
import type { Broker } from "./broker.js";
import { estimateEntryFriction, fillCost } from "./kotak/costs.js";
import { INDEX_SYMBOL, INDEX_TOKEN, NIFTY50 } from "./kotak/scrip.js";
import { createModel, type Model } from "./model/index.js";
import { attributionQuestions } from "./model/questions.js";
import { canEnterMore, positionNotional, riskPerTrade, roundTick, sizeQty, stopBps, stopPrice, targetPrice, unrealized } from "./risk.js";
import { pickBest, runStage1, runStage2, type Candidate } from "./strategy/continuation.js";
import { managePosition } from "./strategy/exits.js";
import { computeGovernor, governorAllows } from "./strategy/governor.js";
import { optionSignal, optionStops, pickStrike } from "./strategy/options.js";
import { addDays, clock, istDateStr, minutesOfDay } from "./time.js";
import type { IndexFeatures, OpenPosition, OptionContract, Quote, SymbolFeatures } from "./types.js";

const EXIT_GUARD_MS = 10_000;

export class Engine {
  quotes = new Map<string, Quote>();
  positions = new Map<string, OpenPosition>();
  halted = false;
  killed = false;
  halfSizeDay = false;
  skipped = 0;
  lastDecision = 0;
  lastUniverseRebuild = 0;
  lastChain = 0;
  lastConnAlert = 0;
  universe: { symbol: string; token: string; segment: string; tickSize: number; tradingSymbol: string }[] = [];
  chain: OptionContract[] = [];
  expiry = "";
  optionCooldownUntil = 0;
  regime: string = "range";
  riskOff = 0;
  niftyLong = 0;
  niftyShort = 0;
  lastCandidates: Candidate[] = [];
  taken: Candidate | null = null;
  lastSkipReason = "";
  warmedUp = false;
  model: Model;
  exec: Executor;
  feed: LiveFeed;
  readonly canTrade: boolean;
  readonly replay: boolean;
  private fastBusy = false;
  private deciding = false;

  constructor(
    private client: Broker,
    opts: { exec?: Executor; replay?: boolean } = {},
  ) {
    this.model = createModel();
    this.replay = opts.replay ?? false;
    this.canTrade = this.replay || this.model.name === "jev" || cfg.allowMockTrading;
    this.exec = opts.exec ?? new LiveExecutor(client);
    this.exec.onFill = (f) => void this.handleFill(f).catch((e) => insertEvent("fill_err", String(e)));
    this.feed = new LiveFeed(
      client,
      () => this.universeTokens(),
      () => this.activeTokens(),
      !this.replay,
    );
  }

  universeTokens() {
    const out = this.universe.map((u) => ({ token: u.token, segment: u.segment, symbol: u.symbol }));
    out.push({ token: INDEX_TOKEN, segment: "nse_cm", symbol: INDEX_TOKEN });
    return out;
  }

  activeTokens() {
    const out: { token: string; segment: string; symbol: string }[] = [];
    for (const p of this.positions.values()) out.push({ token: p.token, segment: p.segment, symbol: p.symbol });
    for (const o of this.exec.orders.values()) out.push({ token: o.token, segment: o.segment, symbol: o.symbol });
    return out;
  }

  async start(): Promise<void> {
    await this.client.login();
    await this.client.loadScrips();
    if (!this.canTrade) {
      insertEvent("observe", "MODEL=mock: decisions run, no orders. Set ALLOW_MOCK_TRADING=1 to override.");
    }
    await this.warmup();
    this.rebuildUniverse();
    this.quotes = await this.feed.tick().catch(() => this.quotes);
    await this.reconcile();
    try {
      const ctx = await runDailyContext(this.model, this.client.allCash());
      this.halfSizeDay = ctx.halfSize;
    } catch (e) {
      insertEvent("context", String(e));
    }
    insertEvent("start", `${this.replay ? "replay" : "live"} model=${this.model.name} trade=${this.canTrade}`);
    if (!this.replay) pruneSnapshots(30 * 24 * 3600_000);
  }

  /** Load recent 1-min candles so RVOL, ADR and ATR have history from the first minute. */
  private async warmup(): Promise<void> {
    const to = istDateStr();
    const from = addDays(to, -cfg.warmupDays);
    const have = db.prepare("SELECT COUNT(*) AS c FROM bars_1m WHERE symbol = ? AND ts < ?").get("Nifty 50", barDayStart()) as { c: number };
    if (have.c > 2000 || this.replay) {
      this.warmedUp = have.c > 300;
      return;
    }
    const symbols: string[] = [...NIFTY50, INDEX_TOKEN];
    let loaded = 0;
    for (const sym of symbols) {
      const inst = this.client.getInstrument(sym);
      if (!inst) continue;
      try {
        const rows = await this.client.candles(inst.token, "nse_cm", from, to, "1min");
        seedBars(sym, rows.map((r) => ({ symbol: sym, ...r })));
        loaded++;
      } catch (e) {
        insertEvent("warmup_err", `${sym} ${e}`);
      }
    }
    this.warmedUp = loaded > 0;
    insertEvent("warmup", `${loaded}/${symbols.length} symbols, ${cfg.warmupDays}d of 1m candles`);
  }

  rebuildUniverse(): void {
    this.universe = buildUniverse({
      cash: this.client.allCash(),
      quotes: this.quotes,
      openSymbols: new Set(this.positions.keys()),
      cooldownMs: 15 * 60_000,
    });
    this.lastUniverseRebuild = clock.now();
  }

  /**
   * 2-second loop: quotes, order polling, price stops, entry re-quotes, caps. Never blocks on Jev.
   * Replay passes awaitDecision so each virtual minute finishes deciding before the clock advances.
   */
  async tick(awaitDecision = false): Promise<void> {
    if (this.fastBusy) return;
    this.fastBusy = true;
    try {
      await this.fastLoop();
    } finally {
      this.fastBusy = false;
    }
    const intervalMs = cfg.decisionIntervalS * 1000;
    if (!this.deciding && clock.now() - this.lastDecision >= intervalMs) {
      this.lastDecision = clock.now();
      this.deciding = true;
      const t0 = Date.now();
      const run = this.decide()
        .catch((e) => {
          insertEvent("decide_err", String(e));
          this.skipped++;
        })
        .finally(() => {
          this.deciding = false;
          if (Date.now() - t0 > 10_000 && !this.replay) {
            insertEvent("skip", "decision >10s");
            this.skipped++;
          }
        });
      if (awaitDecision) await run;
    }
  }

  private async fastLoop(): Promise<void> {
    this.checkKill();
    if (this.client.session || cfg.kotakAccessToken) {
      try {
        this.quotes = await this.feed.tick();
      } catch (e) {
        insertEvent("quote_err", String(e));
      }
    }
    if (!this.client.session) return;
    if (minutesOfDay() >= FLATTEN_MIN && (this.positions.size || this.exec.orders.size)) {
      await this.exec.cancelAll("entry");
      await this.flattenAll("flatten");
    }
    if (todayPnl() <= -cfg.dailyLossCap && !this.halted) {
      this.halted = true;
      await alert("halt", `daily loss cap ${todayPnl().toFixed(0)}`);
      await this.exec.cancelAll("entry");
      await this.flattenAll("halt");
    }
    if (!this.replay && Date.now() - this.client.lastOk > 30_000 && this.positions.size && Date.now() - this.lastConnAlert > 60_000) {
      this.lastConnAlert = Date.now();
      await alert("connectivity", "no kotak response >30s with open position");
    }
    try {
      await this.exec.tick(this.quotes);
    } catch (e) {
      insertEvent("poll_err", String(e));
    }
    await this.manageEntries();
    await this.hardExits();
    if (clock.now() - this.lastUniverseRebuild > 60_000) this.rebuildUniverse();
    if (cfg.optionsMode === "on" && clock.now() - this.lastChain > 60_000) {
      this.lastChain = clock.now();
      try {
        const exps = await this.client.expiries();
        this.expiry = exps[0] ?? "";
        this.chain = await this.client.optionChain(INDEX_SYMBOL, this.expiry);
      } catch (e) {
        insertEvent("chain_err", String(e));
      }
    }
  }

  private async decide(): Promise<void> {
    if (this.killed || this.halted || !this.client.session) return;
    if (!this.universe.length) return;
    const feats: SymbolFeatures[] = [];
    for (const u of this.universe) {
      const q = this.quotes.get(u.symbol);
      if (!q) continue;
      const f = buildFeatures(u.symbol, q);
      if (f) feats.push(f);
    }
    if (!feats.length) return;
    const niftyQ = this.quotes.get(INDEX_TOKEN);
    const above = feats.filter((f) => f.vwapDist.label === "above" || f.vwapDist.label === "far_above").length;
    const breadth = feats.length ? above / feats.length : 0.5;
    const index: IndexFeatures | null = buildIndexFeatures(niftyQ, 0, breadth);
    const s1 = await runStage1(this.model, feats, index);
    if (!s1) {
      this.skipped++;
      this.lastSkipReason = "stage1 failed";
      insertEvent("skip", "stage1 failed");
      return;
    }
    this.regime = s1.regime;
    this.riskOff = s1.riskOff;
    this.niftyLong = s1.niftyLong;
    this.niftyShort = s1.niftyShort;

    for (const pos of [...this.positions.values()]) {
      const q = this.quotes.get(pos.symbol);
      const f = q ? buildFeatures(pos.symbol, q) : null;
      if (!q || !f) continue;
      const u = unrealized(pos, q);
      const d = await managePosition(this.model, pos, f, index, u);
      pos.thesis = d.thesis;
      db.prepare("UPDATE positions SET thesis=? WHERE id=?").run(d.thesis, pos.id);
      if (d.action === "exit" || d.action === "take_profit") {
        await this.exitPosition(pos, d.reason);
      } else if (d.action === "breakeven") {
        await this.moveStopBreakeven(pos);
      }
    }

    const inWindow = minutesOfDay() >= ENTRY_START_MIN && minutesOfDay() <= ENTRY_END_MIN;
    if (!inWindow) {
      this.lastSkipReason = "outside entry window";
      return;
    }
    if (s1.riskOff >= risk.riskOffHalt) {
      this.lastSkipReason = `risk_off ${s1.riskOff.toFixed(2)}`;
      return;
    }

    const featMap = new Map(feats.map((f) => [f.symbol, f]));
    const cands: Candidate[] = [];
    const ctx = contextFor(istDateStr());
    for (const r of [...s1.longs, ...s1.shorts]) {
      const f = featMap.get(r.symbol);
      if (!f) continue;
      if (f.spreadBps > risk.maxSpreadBps || f.volume.rvol20d < risk.minRvol) continue;
      if (ctx.get(r.symbol)?.forbidSide === r.side) continue;
      const c = await runStage2(this.model, f, index, r.side);
      if (c) cands.push(c);
    }
    this.lastCandidates = cands;
    const best = pickBest(cands);
    this.taken = best;
    if (best && !this.positions.has(best.symbol) && !this.hasOpenEntry(best.symbol)) {
      await this.enterEquity(best, featMap.get(best.symbol)!);
    } else if (!best) {
      this.lastSkipReason = `${s1.longs.length + s1.shorts.length} stage1, 0 passed stage2`;
    }

    if (cfg.optionsMode === "on") {
      const sig = optionSignal({ niftyLong: s1.niftyLong, niftyShort: s1.niftyShort, regime: s1.regime, riskOff: s1.riskOff });
      if (sig && clock.now() > this.optionCooldownUntil && ![...this.positions.values()].some((p) => p.leg === "options")) {
        await this.enterOption(sig.right, niftyQ?.ltp ?? 0);
      }
    }
  }

  private hasOpenEntry(symbol: string): boolean {
    return [...this.exec.orders.values()].some((o) => o.kind === "entry" && o.symbol === symbol);
  }

  private async enterEquity(c: Candidate, f: SymbolFeatures): Promise<void> {
    if (!this.canTrade) {
      this.lastSkipReason = `observe: would ${c.side} ${c.symbol} (${c.tier})`;
      insertEvent("observe", this.lastSkipReason);
      return;
    }
    const inst = this.universe.find((u) => u.symbol === c.symbol) ?? this.client.getInstrument(c.symbol);
    if (!inst) return;
    const sb = stopBps(f.atr1m, f.last);
    if (sb === null) {
      this.lastSkipReason = `${c.symbol} ATR stop >${risk.maxStopBps}bps`;
      return;
    }
    const tier = this.halfSizeDay && c.tier === "A" ? "B" : c.tier;
    const capital = getCapital();
    const qty = sizeQty(f.last, sb, tier, capital - this.usedNotional(), capital);
    if (qty < 1) {
      this.lastSkipReason = `${c.symbol} qty 0 (capital)`;
      return;
    }
    const g = computeGovernor();
    const ga = governorAllows(g);
    if (!ga.ok) {
      this.lastSkipReason = `governor ${ga.reason}`;
      return;
    }
    const cap = canEnterMore(this.positions.size);
    if (!cap.ok) {
      this.lastSkipReason = cap.reason;
      return;
    }
    const side = c.side === "long" ? "buy" : "sell";
    const px = side === "buy" ? f.bid : f.ask;
    const stop = stopPrice(c.side, px, sb, f.tickSize);
    const target = targetPrice(c.side, px, sb, f.tickSize);
    try {
      const m = await this.client.marginRequired({ segment: inst.segment, token: inst.token, tradingSymbol: inst.tradingSymbol, side, qty, price: px });
      if (!m.ok || m.required > m.available * 0.8) {
        this.lastSkipReason = `${c.symbol} margin ${m.required.toFixed(0)}/${m.available.toFixed(0)}`;
        return;
      }
    } catch (e) {
      this.lastSkipReason = `${c.symbol} margin check failed`;
      insertEvent("margin_err", String(e));
      return;
    }
    try {
      await this.exec.place({
        symbol: c.symbol,
        token: inst.token,
        segment: inst.segment,
        tradingSymbol: inst.tradingSymbol,
        side,
        qty,
        price: px,
        kind: "entry",
        tag: `cont-${c.symbol}-${clock.now()}`,
        decisionId: null,
        leg: "equity",
        tier,
        stop,
        target,
        stopBps: sb,
      });
      this.lastSkipReason = "";
    } catch {
      /* alerted in executor */
    }
  }

  private async enterOption(right: "CE" | "PE", spot: number): Promise<void> {
    if (!this.canTrade) return;
    const c = pickStrike(this.chain, right, spot, this.expiry);
    if (!c) return;
    const optPnl = (db.prepare("SELECT COALESCE(SUM(pnl),0) AS p FROM trades WHERE date=? AND leg='options'").get(istDateStr()) as { p: number }).p;
    if (optPnl <= -risk.optionDailyLossCap) return;
    // Chain has no book: pull a live quote for the strike and enforce the 1% spread rule here.
    try {
      const [q] = await this.client.quotes([{ token: c.token, segment: "nse_fo" }]);
      if (!q?.bid || !q.ask) return;
      if ((q.ask - q.bid) / ((q.ask + q.bid) / 2) > 0.01) return;
      c.bid = q.bid;
      c.ask = q.ask;
      c.ltp = q.ltp || c.ltp;
    } catch {
      return;
    }
    const prem = (c.bid || c.ltp) * c.lotSize;
    if (prem > getCapital() - this.usedNotional()) return;
    const { stop, target } = optionStops(c.bid || c.ltp);
    try {
      await this.exec.place({
        symbol: c.tradingSymbol || c.symbol,
        token: c.token,
        segment: "nse_fo",
        tradingSymbol: c.tradingSymbol,
        side: "buy",
        qty: c.lotSize,
        price: c.bid || c.ltp,
        kind: "entry",
        tag: `opt-${right}-${clock.now()}`,
        decisionId: null,
        leg: "options",
        tier: "B",
        stop,
        target,
        stopBps: risk.optionStopPct * 1e4,
      });
    } catch {
      /* alerted */
    }
  }

  private async handleFill(f: Fill): Promise<void> {
    const o = f.order;
    if (o.kind === "entry") {
      const side = o.side === "buy" ? "long" : "short";
      const existing = this.positions.get(o.symbol);
      if (existing && existing.side === side) {
        const total = existing.qty + f.qty;
        existing.entryPrice = (existing.entryPrice * existing.qty + f.price * f.qty) / total;
        existing.qty = total;
        db.prepare("UPDATE positions SET qty=?, entry=? WHERE id=?").run(total, existing.entryPrice, existing.id);
        const stopOrd = existing.stopOrderId ? this.findOrder(existing.stopOrderId) : undefined;
        if (stopOrd) {
          try {
            await this.exec.modify(stopOrd, stopOrd.price, stopOrd.trigger ?? undefined, total);
          } catch (e) {
            await alert("order_reject", `stop qty modify failed ${o.symbol} ${e}`);
          }
        }
        return;
      }
      const info = db
        .prepare(
          `INSERT INTO positions (opened_at, leg, symbol, token, segment, side, qty, entry, stop, target, decision_id, tier, entry_order_id, stop_bps, closed)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
        )
        .run(clock.now(), o.leg, o.symbol, o.token, o.segment, side, f.qty, f.price, o.stop, o.target, o.decisionId, o.tier, String(o.id), o.stopBps);
      const pos: OpenPosition = {
        id: Number(info.lastInsertRowid),
        leg: o.leg,
        symbol: o.symbol,
        token: o.token,
        segment: o.segment,
        side,
        qty: f.qty,
        entryPrice: f.price,
        stop: o.stop ?? f.price,
        target: o.target ?? f.price,
        openedAt: clock.now(),
        decisionId: o.decisionId,
        tier: o.tier,
        stopOrderId: null,
        entryOrderId: String(o.id),
        stopBps: o.stopBps ?? 10,
        thesis: 2,
        exitingAt: 0,
        closedQty: 0,
        exitNotional: 0,
        exitCost: 0,
        exitReason: null,
        mfeBps: 0,
      };
      this.positions.set(pos.symbol, pos);
      await this.placeStop(pos);
      return;
    }
    const pos = this.positions.get(o.symbol);
    if (!pos) {
      await alert("orphan_fill", `${o.kind} fill for ${o.symbol} with no tracked position; check Kotak positions`);
      return;
    }
    pos.closedQty += f.qty;
    pos.exitNotional += f.qty * f.price;
    pos.exitCost += f.cost;
    if (!pos.exitReason) pos.exitReason = o.kind === "stop" ? "stop" : reasonFromTag(o.tag);
    if (pos.closedQty >= pos.qty) {
      await this.closeTrade(pos);
    } else if (o.kind === "exit") {
      const stopOrd = pos.stopOrderId ? this.findOrder(pos.stopOrderId) : undefined;
      if (stopOrd) {
        try {
          await this.exec.modify(stopOrd, stopOrd.price, stopOrd.trigger ?? undefined, pos.qty - pos.closedQty);
        } catch {
          /* alerted */
        }
      }
    }
  }

  private async placeStop(pos: OpenPosition): Promise<void> {
    const inst = this.client.getInstrument(pos.symbol);
    const stopSide = pos.side === "long" ? "sell" : "buy";
    const tick = this.quotes.get(pos.symbol)?.tickSize ?? 0.05;
    try {
      const stopOrd = await this.exec.place({
        symbol: pos.symbol,
        token: pos.token,
        segment: pos.segment,
        tradingSymbol: inst?.tradingSymbol ?? `${pos.symbol}-EQ`,
        side: stopSide,
        qty: pos.qty - pos.closedQty,
        price: roundTick(pos.side === "long" ? pos.stop - 3 * tick : pos.stop + 3 * tick, tick),
        trigger: pos.stop,
        orderType: "SL-L",
        kind: "stop",
        tag: `sl-${pos.id}`,
        decisionId: pos.decisionId,
        leg: pos.leg,
        tier: pos.tier,
      });
      pos.stopOrderId = String(stopOrd.id);
      db.prepare("UPDATE positions SET stop_order_id=? WHERE id=?").run(pos.stopOrderId, pos.id);
    } catch (e) {
      await alert("order_reject", `SL-L failed ${pos.symbol}; engine price-stop is the only protection. ${e}`);
    }
  }

  /**
   * Cancels the resting stop, then sends a limit at the touch. If an exit is already working,
   * re-quote it to the new touch instead of stacking a second one. One action per 10 s per position.
   */
  private async exitPosition(pos: OpenPosition, reason: string): Promise<void> {
    if (clock.now() - pos.exitingAt < EXIT_GUARD_MS) return;
    if (pos.closedQty >= pos.qty) return;
    const q = this.quotes.get(pos.symbol);
    if (!q) {
      insertEvent("exit_err", `${pos.symbol} no quote for ${reason}`);
      return;
    }
    pos.exitingAt = clock.now();
    const working = [...this.exec.orders.values()].find((o) => o.kind === "exit" && o.symbol === pos.symbol);
    if (working) {
      const touch = working.side === "sell" ? q.bid || q.ltp : q.ask || q.ltp;
      if (touch && Math.abs(touch - working.price) >= (q.tickSize || 0.05)) {
        await this.exec.modify(working, touch).catch((e) => insertEvent("requote_err", `${pos.symbol} exit ${e}`));
      }
      return;
    }
    const stopOrd = pos.stopOrderId ? this.findOrder(pos.stopOrderId) : undefined;
    if (stopOrd) {
      try {
        await this.exec.cancel(stopOrd);
      } catch {
        // Cancel failed: the stop may have just filled. Let the poll settle it; retry after the guard.
        return;
      }
    }
    const inst = this.client.getInstrument(pos.symbol);
    const side = pos.side === "long" ? "sell" : "buy";
    const px = side === "sell" ? q.bid || q.ltp : q.ask || q.ltp;
    try {
      await this.exec.place({
        symbol: pos.symbol,
        token: pos.token,
        segment: pos.segment,
        tradingSymbol: inst?.tradingSymbol ?? `${pos.symbol}-EQ`,
        side,
        qty: pos.qty - pos.closedQty,
        price: px,
        kind: "exit",
        tag: `exit-${pos.id}-${reason}`,
        decisionId: pos.decisionId,
        leg: pos.leg,
        tier: pos.tier,
      });
      pos.stopOrderId = null;
    } catch {
      // Exit rejected and stop already cancelled: put the stop back.
      await this.placeStop(pos);
    }
  }

  private async moveStopBreakeven(pos: OpenPosition): Promise<void> {
    if (pos.stop === pos.entryPrice) return;
    const tick = this.quotes.get(pos.symbol)?.tickSize ?? 0.05;
    const stopOrd = pos.stopOrderId ? this.findOrder(pos.stopOrderId) : undefined;
    const newStop = roundTick(pos.entryPrice, tick);
    if (stopOrd) {
      try {
        await this.exec.modify(stopOrd, roundTick(pos.side === "long" ? newStop - 3 * tick : newStop + 3 * tick, tick), newStop);
      } catch (e) {
        await alert("order_reject", `breakeven modify failed ${pos.symbol} ${e}`);
        return;
      }
    }
    pos.stop = newStop;
    db.prepare("UPDATE positions SET stop=? WHERE id=?").run(pos.stop, pos.id);
    insertEvent("stop", `${pos.symbol} stop -> breakeven ${newStop}`);
  }

  private findOrder(id: string) {
    return [...this.exec.orders.values()].find((o) => String(o.id) === id || o.brokerId === id);
  }

  /** Engine-side price stop only when there is no exchange SL-L resting. Otherwise the exchange owns the stop. */
  private async hardExits(): Promise<void> {
    for (const pos of [...this.positions.values()]) {
      const q = this.quotes.get(pos.symbol);
      if (!q?.ltp) continue;
      const signed = pos.side === "long" ? 1 : -1;
      const favBps = ((q.ltp - pos.entryPrice) / pos.entryPrice) * 1e4 * signed;
      if (favBps > pos.mfeBps) pos.mfeBps = favBps;
      const holdMin = (clock.now() - pos.openedAt) / 60_000;
      const u = unrealized(pos, q);
      if (pos.leg === "options" && holdMin >= risk.optionTimeStopMin && u <= 0) {
        await this.exitPosition(pos, "time");
        continue;
      }
      const hasStop = pos.stopOrderId !== null && this.findOrder(pos.stopOrderId) !== undefined;
      if (hasStop) continue;
      const hit = pos.side === "long" ? q.ltp <= pos.stop : q.ltp >= pos.stop;
      if (hit) await this.exitPosition(pos, "stop");
    }
  }

  /** Re-quote a passive entry when the touch moves, at most MAX_REQUOTES times, then cancel. */
  private async manageEntries(): Promise<void> {
    if (this.killed || this.halted) return;
    for (const o of [...this.exec.orders.values()]) {
      if (o.kind !== "entry") continue;
      const q = this.quotes.get(o.symbol);
      if (!q) continue;
      const tick = q.tickSize || 0.05;
      const want = o.side === "buy" ? q.bid : q.ask;
      if (!want || Math.abs(want - o.price) < tick || clock.now() - o.lastModifyAt < 5000) continue;
      try {
        if (o.requotes >= cfg.maxRequotes) {
          await this.exec.cancel(o);
          insertEvent("order", `${o.symbol} entry cancelled after ${o.requotes} re-quotes`);
        } else {
          await this.exec.modify(o, want);
        }
      } catch (e) {
        insertEvent("requote_err", `${o.symbol} ${e}`);
      }
    }
  }

  private async closeTrade(pos: OpenPosition): Promise<void> {
    if (!this.positions.has(pos.symbol)) return;
    this.positions.delete(pos.symbol);
    const exitPx = pos.exitNotional / Math.max(1, pos.closedQty);
    const signed = pos.side === "long" ? 1 : -1;
    const gross = (exitPx - pos.entryPrice) * pos.closedQty * signed;
    const entryCost = fillCost(pos.leg, pos.side === "long" ? "buy" : "sell", pos.closedQty, pos.entryPrice);
    const pnl = gross - entryCost - pos.exitCost;
    const friction = estimateEntryFriction(pos.leg, pos.closedQty, pos.entryPrice);
    const reason = pos.exitReason ?? "unknown";
    const info = db
      .prepare(
        `INSERT INTO trades (opened_at, closed_at, date, leg, symbol, side, qty, entry, exit, pnl, friction, hold_s, exit_reason, tier, decision_id, regime)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        pos.openedAt,
        clock.now(),
        istDateStr(),
        pos.leg,
        pos.symbol,
        pos.side,
        pos.closedQty,
        pos.entryPrice,
        exitPx,
        pnl,
        friction,
        Math.round((clock.now() - pos.openedAt) / 1000),
        reason,
        pos.tier,
        pos.decisionId,
        this.regime,
      );
    db.prepare("UPDATE positions SET closed=1 WHERE id=?").run(pos.id);
    insertEvent("trade", `${pos.symbol} ${pos.side} ${pos.closedQty} ${reason} pnl ${pnl.toFixed(0)}`);
    if (pos.leg === "options") this.optionCooldownUntil = clock.now() + 10 * 60_000;
    const stopOrd = pos.stopOrderId ? this.findOrder(pos.stopOrderId) : undefined;
    if (stopOrd) await this.exec.cancel(stopOrd).catch(() => undefined);
    void this.attribute(pos, reason, Number(info.lastInsertRowid));
  }

  private async attribute(pos: OpenPosition, reason: string, tradeId: number): Promise<void> {
    try {
      const bars = loadBars(pos.symbol, 200).filter((b) => b.ts >= pos.openedAt - 5 * 60_000);
      const holdBars = bars.map((b) => `${new Date(b.ts).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} ${b.open.toFixed(2)} ${b.high.toFixed(2)} ${b.low.toFixed(2)} ${b.close.toFixed(2)}`);
      const r = await this.model.evaluate(
        {
          entryDecision: { side: pos.side, tier: pos.tier, entry: pos.entryPrice, stop: pos.stop, mfeBps: Math.round(pos.mfeBps) },
          holdBars,
          barsFormat: "hh:mm open high low close, first 5 bars are before entry",
          exitReason: reason,
        },
        attributionQuestions,
        "attr",
        pos.symbol,
      );
      if (!r.ok) return;
      db.prepare("UPDATE trades SET attribution=?, entry_timing=? WHERE id=?").run(
        r.answers.cause?.choice ?? null,
        r.answers.entry_timing?.score ?? null,
        tradeId,
      );
    } catch {
      /* ignore */
    }
  }

  private async flattenAll(reason: string): Promise<void> {
    for (const pos of [...this.positions.values()]) await this.exitPosition(pos, reason);
  }

  private checkKill(): void {
    if (existsSync(cfg.killPath) && !this.killed) {
      this.killed = true;
      void alert("kill", "kill switch");
      void this.exec.cancelAll("entry").then(() => this.flattenAll("kill"));
    }
  }

  kill(): void {
    writeFileSync(cfg.killPath, "1");
    this.checkKill();
  }

  unkill(): void {
    if (existsSync(cfg.killPath)) unlinkSync(cfg.killPath);
    this.killed = false;
    insertEvent("kill", "kill switch cleared");
  }

  /** Adopt live Kotak positions, place a missing SL-L for each, cancel unknown open entries. */
  async reconcile(): Promise<void> {
    try {
      const pos = await this.client.positions();
      const ords = await this.client.orders();
      const mis = pos.filter((p) => p.qty !== 0 && p.product.toUpperCase().includes("MIS"));
      if (mis.length) {
        const qs = await this.client.quotes(mis.map((p) => ({ token: p.token, segment: p.segment })));
        for (const q of qs) this.quotes.set(q.symbol || q.token, q);
      }
      for (const o of ords) {
        const st = o.status.toLowerCase();
        if (st.includes("open") || st.includes("pending")) {
          if (o.tag.startsWith("sl-")) continue;
          await this.client.cancel(o.orderId).catch((e) => insertEvent("reconcile", `cancel ${o.orderId} failed ${e}`));
          insertEvent("reconcile", `cancelled unknown open order ${o.orderId} ${o.symbol}`);
        }
      }
      for (const p of mis) {
        const side = p.qty > 0 ? "long" : "short";
        const q = this.quotes.get(p.symbol);
        const px = p.avgPrice || q?.ltp || 0;
        if (!px) continue;
        if (cfg.onRestart === "flatten") {
          await this.client.place({
            segment: p.segment,
            tradingSymbol: `${p.symbol}-EQ`,
            token: p.token,
            side: side === "long" ? "sell" : "buy",
            qty: Math.abs(p.qty),
            price: side === "long" ? q?.bid || px : q?.ask || px,
            tag: "restart-flat",
          });
          insertEvent("reconcile", `flattened ${p.symbol} ${p.qty}`);
          continue;
        }
        const tick = q?.tickSize ?? 0.05;
        const sb = 12;
        const stop = stopPrice(side, px, sb, tick);
        const info = db
          .prepare(
            `INSERT INTO positions (opened_at, leg, symbol, token, segment, side, qty, entry, stop, target, decision_id, tier, stop_bps, closed)
             VALUES (?,?,?,?,?,?,?,?,?,?,NULL,'B',?,0)`,
          )
          .run(clock.now(), "equity", p.symbol, p.token, p.segment, side, Math.abs(p.qty), px, stop, targetPrice(side, px, sb, tick), sb);
        const adopted: OpenPosition = {
          id: Number(info.lastInsertRowid),
          leg: "equity",
          symbol: p.symbol,
          token: p.token,
          segment: p.segment,
          side,
          qty: Math.abs(p.qty),
          entryPrice: px,
          stop,
          target: targetPrice(side, px, sb, tick),
          openedAt: clock.now(),
          decisionId: null,
          tier: "B",
          stopOrderId: null,
          entryOrderId: null,
          stopBps: sb,
          thesis: 2,
          exitingAt: 0,
          closedQty: 0,
          exitNotional: 0,
          exitCost: 0,
          exitReason: null,
          mfeBps: 0,
        };
        this.positions.set(p.symbol, adopted);
        const existingStop = ords.find((o) => o.symbol === p.symbol && o.tag.startsWith("sl-") && o.status.toLowerCase().includes("pending"));
        if (!existingStop) await this.placeStop(adopted);
        insertEvent("reconcile", `adopted ${p.symbol} ${side} ${Math.abs(p.qty)} @${px}`);
      }
    } catch (e) {
      await alert("session", `reconcile failed ${e}`);
    }
  }

  usedNotional(): number {
    let s = 0;
    for (const p of this.positions.values()) s += positionNotional(p);
    for (const o of this.exec.orders.values()) if (o.kind === "entry") s += (o.qty - o.filledQty) * o.price;
    return s;
  }

  openUnrealized(): number {
    let u = 0;
    for (const p of this.positions.values()) {
      const q = this.quotes.get(p.symbol);
      if (q) u += unrealized(p, q);
    }
    return u;
  }

  snapshot() {
    const capital = getCapital();
    const used = this.usedNotional();
    return {
      mode: this.replay ? "replay" : this.canTrade ? "live" : "observe",
      optionsMode: cfg.optionsMode,
      model: this.model.name,
      session: !!this.client.session,
      warmedUp: this.warmedUp,
      halted: this.halted,
      killed: this.killed,
      regime: this.regime,
      riskOff: this.riskOff,
      niftyLong: this.niftyLong,
      niftyShort: this.niftyShort,
      skipped: this.skipped,
      lastSkipReason: this.lastSkipReason,
      universeSize: this.universe.length,
      quotesLive: this.quotes.size,
      capital,
      usedNotional: used,
      freeCapital: Math.max(0, capital - used),
      openUnrealized: this.openUnrealized(),
      riskPerTrade: riskPerTrade(capital),
      maxPositions: cfg.maxPositions,
      decisionIntervalS: cfg.decisionIntervalS,
      lastDecision: this.lastDecision,
      openOrders: [...this.exec.orders.values()].map((o) => ({
        symbol: o.symbol,
        kind: o.kind,
        side: o.side,
        qty: o.qty,
        filled: o.filledQty,
        price: o.price,
        trigger: o.trigger,
        requotes: o.requotes,
        ageS: Math.round((clock.now() - o.placedAt) / 1000),
      })),
      positions: [...this.positions.values()].map((p) => {
        const q = this.quotes.get(p.symbol);
        return {
          ...p,
          ltp: q?.ltp ?? null,
          unrealized: q ? unrealized(p, q) : null,
          notional: positionNotional(p),
          holdMin: (clock.now() - p.openedAt) / 60_000,
          hasStop: p.stopOrderId !== null && this.findOrder(p.stopOrderId) !== undefined,
        };
      }),
      candidates: this.lastCandidates,
      taken: this.taken,
    };
  }
}

function reasonFromTag(tag: string): string {
  const m = /^exit-\d+-(.+)$/.exec(tag);
  return m ? m[1] : "exit";
}
