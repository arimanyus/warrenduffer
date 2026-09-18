import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { alert } from "./alerts.js";
import { cfg, ENTRY_END_MIN, ENTRY_START_MIN, FLATTEN_MIN, risk } from "./config.js";
import { runDailyContext } from "./context.js";
import { buildFeatures, buildIndexFeatures } from "./data/features.js";
import { LiveFeed } from "./data/feed.js";
import { buildUniverse } from "./data/universe.js";
import { contextFor, db, insertEvent, pruneSnapshots, todayPnl } from "./db.js";
import { LiveExecutor } from "./executor/live.js";
import type { KotakClient } from "./kotak/client.js";
import { estimateEntryFriction, fillCost } from "./kotak/costs.js";
import { INDEX_SYMBOL, INDEX_TOKEN } from "./kotak/scrip.js";
import { createModel, type Model } from "./model/index.js";
import { attributionQuestions } from "./model/questions.js";
import { canEnterMore, roundTick, sizeQty, stopBps, stopPrice, targetPrice, unrealized } from "./risk.js";
import { pickBest, runStage1, runStage2, type Candidate } from "./strategy/continuation.js";
import { managePosition } from "./strategy/exits.js";
import { computeGovernor, governorAllows } from "./strategy/governor.js";
import { optionSignal, optionStops, pickStrike } from "./strategy/options.js";
import { istDateStr, minutesOfDay } from "./time.js";
import type { IndexFeatures, OpenPosition, OptionContract, Quote, SymbolFeatures, WorkingOrder } from "./types.js";

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
  lastFlatCheck = 0;
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
  model: Model;
  exec: LiveExecutor;
  feed: LiveFeed;
  lastStage2: Record<string, unknown> = {};

  constructor(private client: KotakClient) {
    this.model = createModel();
    this.exec = new LiveExecutor(client);
    this.exec.onFill = (f) => this.handleFill(f);
    this.feed = new LiveFeed(
      client,
      () => this.universeTokens(),
      () => this.activeTokens(),
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
    return out;
  }

  async start(): Promise<void> {
    await this.client.login();
    await this.client.loadScrips();
    this.rebuildUniverse();
    await this.reconcile();
    try {
      const ctx = await runDailyContext(this.model, this.client.allCash());
      this.halfSizeDay = ctx.halfSize;
    } catch (e) {
      insertEvent("context", String(e));
    }
    insertEvent("start", `live model=${this.model.name}`);
    pruneSnapshots(30 * 24 * 3600_000);
  }

  rebuildUniverse(): void {
    this.universe = buildUniverse({
      cash: this.client.allCash(),
      quotes: this.quotes,
      openSymbols: new Set(this.positions.keys()),
      cooldownMs: 15 * 60_000,
    });
    this.lastUniverseRebuild = Date.now();
  }

  async tick(): Promise<void> {
    this.checkKill();
    if (minutesOfDay() >= FLATTEN_MIN && this.positions.size) await this.flattenAll("flatten");
    if (todayPnl() <= -cfg.dailyLossCap && !this.halted) {
      this.halted = true;
      await alert("halt", `daily loss cap ${todayPnl()}`);
      await this.flattenAll("halt");
    }
    if (this.client.lastOk && Date.now() - this.client.lastOk > 30_000 && this.positions.size && Date.now() - this.lastConnAlert > 60_000) {
      this.lastConnAlert = Date.now();
      await alert("connectivity", "no kotak response >30s with open position");
    }
    if (this.client.session || cfg.kotakAccessToken) {
      try {
        this.quotes = await this.feed.tick();
      } catch (e) {
        insertEvent("quote_err", String(e));
      }
    }
    await this.exec.tick(this.quotes);
    this.manageEntries();
    await this.hardExits();
    if (Date.now() - this.lastUniverseRebuild > 60_000) this.rebuildUniverse();
    if (cfg.optionsMode === "on" && Date.now() - this.lastChain > 60_000) {
      try {
        const exps = await this.client.expiries();
        this.expiry = exps[0] ?? "";
        this.chain = await this.client.optionChain(INDEX_SYMBOL, this.expiry);
      } catch (e) {
        insertEvent("chain_err", String(e));
      }
      this.lastChain = Date.now();
    }
    const intervalMs = cfg.decisionIntervalS * 1000;
    if (Date.now() - this.lastDecision >= intervalMs) {
      this.lastDecision = Date.now();
      const t0 = Date.now();
      try {
        await this.decide();
      } catch (e) {
        insertEvent("decide_err", String(e));
        this.skipped++;
      }
      if (Date.now() - t0 > 10_000) {
        insertEvent("skip", "decision >10s");
        this.skipped++;
      }
    }
  }

  private async decide(): Promise<void> {
    if (this.killed || this.halted) return;
    const feats: SymbolFeatures[] = [];
    if (!this.universe.length) return;
    for (const u of this.universe) {
      const q = this.quotes.get(u.symbol);
      if (!q) continue;
      const f = buildFeatures(u.symbol, q);
      if (f) feats.push(f);
    }
    const niftyQ = this.quotes.get(INDEX_TOKEN);
    const above = feats.filter((f) => f.vwapDist.label === "above" || f.vwapDist.label === "far_above").length;
    const breadth = feats.length ? above / feats.length : 0.5;
    const fut = this.quotes.get("NIFTY-FUT");
    const futImb = fut ? (fut.tbq - fut.tsq) / Math.max(1, fut.tbq + fut.tsq) : 0;
    const index: IndexFeatures | null = buildIndexFeatures(niftyQ, futImb, breadth);
    const s1 = await runStage1(this.model, feats, index);
    if (!s1) {
      this.skipped++;
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
    if (!inWindow || s1.riskOff >= risk.riskOffHalt) return;

    const featMap = new Map(feats.map((f) => [f.symbol, f]));
    const cands: Candidate[] = [];
    for (const r of [...s1.longs, ...s1.shorts]) {
      const f = featMap.get(r.symbol);
      if (!f) continue;
      if (f.spreadBps > risk.maxSpreadBps || f.volume.rvol20d < risk.minRvol) continue;
      const ctx = contextFor(istDateStr()).get(r.symbol);
      if (ctx?.forbidSide === r.side) continue;
      const c = await runStage2(this.model, f, index, r.side);
      if (c) cands.push(c);
    }
    this.lastCandidates = cands;
    const best = pickBest(cands);
    this.taken = best;
    if (best && !this.positions.has(best.symbol)) await this.enterEquity(best, featMap.get(best.symbol)!);

    if (cfg.optionsMode === "on") {
      const sig = optionSignal({
        niftyLong: s1.niftyLong,
        niftyShort: s1.niftyShort,
        regime: s1.regime,
        riskOff: s1.riskOff,
      });
      if (sig && Date.now() > this.optionCooldownUntil && ![...this.positions.values()].some((p) => p.leg === "options")) {
        await this.enterOption(sig.right, niftyQ?.ltp ?? 0);
      }
    }
  }

  private async enterEquity(c: Candidate, f: SymbolFeatures): Promise<void> {
    const inst = this.universe.find((u) => u.symbol === c.symbol) ?? this.client.getInstrument(c.symbol);
    if (!inst) return;
    const sb = stopBps(f.atr1m, f.last);
    if (sb === null) return;
    const tier = this.halfSizeDay && c.tier === "A" ? "B" : c.tier;
    const qty = sizeQty(f.last, sb, tier);
    if (qty < 1) return;
    const g = computeGovernor();
    const ga = governorAllows(g);
    if (!ga.ok) return;
    const cap = canEnterMore(this.positions.size);
    if (!cap.ok) return;
    const side = c.side === "long" ? "buy" : "sell";
    const px = side === "buy" ? f.bid : f.ask;
    const stop = stopPrice(c.side, px, sb, f.tickSize);
    const target = targetPrice(c.side, px, sb, f.tickSize);
    try {
      const m = await this.client.marginRequired({
        segment: inst.segment,
        token: inst.token,
        tradingSymbol: inst.tradingSymbol,
        side,
        qty,
        price: px,
      });
      if (!m.ok || m.required > m.available * 0.8) return;
    } catch {
      return;
    }
    await this.exec.place({
      symbol: c.symbol,
      token: inst.token,
      segment: inst.segment,
      tradingSymbol: inst.tradingSymbol,
      side,
      qty,
      price: px,
      kind: "entry",
      tag: `cont-${c.symbol}-${Date.now()}`,
      decisionId: null,
      leg: "equity",
      tier,
      stop,
      target,
      stopBps: sb,
    });
  }

  private async enterOption(right: "CE" | "PE", spot: number): Promise<void> {
    const c = pickStrike(this.chain, right, spot, this.expiry);
    if (!c) return;
    const optPnl = (db.prepare("SELECT COALESCE(SUM(pnl),0) AS p FROM trades WHERE date=? AND leg='options'").get(istDateStr()) as { p: number }).p;
    if (optPnl <= -risk.optionDailyLossCap) return;
    const { stop, target } = optionStops(c.bid || c.ltp);
    await this.exec.place({
      symbol: c.tradingSymbol || c.symbol,
      token: c.token,
      segment: "nse_fo",
      tradingSymbol: c.tradingSymbol,
      side: "buy",
      qty: c.lotSize,
      price: c.bid || c.ltp,
      kind: "entry",
      tag: `opt-${right}-${Date.now()}`,
      decisionId: null,
      leg: "options",
      tier: "B",
      stop,
      target,
      stopBps: risk.optionStopPct * 1e4,
    });
  }

  private async handleFill(f: { order: WorkingOrder; qty: number; price: number; cost: number }): Promise<void> {
    if (f.order.kind === "entry") {
      const side = f.order.side === "buy" ? "long" : "short";
      const info = db
        .prepare(
          `INSERT INTO positions (opened_at, leg, symbol, token, segment, side, qty, entry, stop, target, decision_id, tier, entry_order_id, stop_bps, closed)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
        )
        .run(
          Date.now(),
          f.order.leg,
          f.order.symbol,
          f.order.token,
          f.order.segment,
          side,
          f.qty,
          f.price,
          f.order.stop,
          f.order.target,
          f.order.decisionId,
          f.order.tier,
          String(f.order.id),
          f.order.stopBps,
        );
      const pos: OpenPosition = {
        id: Number(info.lastInsertRowid),
        leg: f.order.leg,
        symbol: f.order.symbol,
        token: f.order.token,
        segment: f.order.segment,
        side,
        qty: f.qty,
        entryPrice: f.price,
        stop: f.order.stop ?? f.price,
        target: f.order.target ?? f.price,
        openedAt: Date.now(),
        decisionId: f.order.decisionId,
        tier: f.order.tier,
        stopOrderId: null,
        entryOrderId: String(f.order.id),
        stopBps: f.order.stopBps ?? 10,
        thesis: 2,
      };
      this.positions.set(pos.symbol, pos);
      const inst = this.client.getInstrument(pos.symbol);
      const stopSide = side === "long" ? "sell" : "buy";
      const tick = this.quotes.get(pos.symbol)?.tickSize ?? 0.05;
      try {
        const stopOrd = await this.exec.place({
          symbol: pos.symbol,
          token: pos.token,
          segment: pos.segment,
          tradingSymbol: inst?.tradingSymbol ?? pos.symbol,
          side: stopSide,
          qty: pos.qty,
          price: roundTick(side === "long" ? pos.stop - 3 * tick : pos.stop + 3 * tick, tick),
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
        await alert("order_reject", `SL-L failed ${pos.symbol} ${e}`);
      }
    } else {
      const pos = this.positions.get(f.order.symbol);
      if (pos) await this.closeTrade(pos, f.price, f.cost, f.order.kind === "stop" ? "stop" : "target");
    }
  }

  private async exitPosition(pos: OpenPosition, reason: string): Promise<void> {
    const q = this.quotes.get(pos.symbol);
    if (!q) return;
    const inst = this.client.getInstrument(pos.symbol);
    const side = pos.side === "long" ? "sell" : "buy";
    const px = side === "sell" ? q.bid : q.ask;
    if (pos.stopOrderId) {
      const stop = this.findOrder(pos.stopOrderId);
      if (stop) await this.exec.cancel(stop);
    }
    await this.exec.place({
      symbol: pos.symbol,
      token: pos.token,
      segment: pos.segment,
      tradingSymbol: inst?.tradingSymbol ?? pos.symbol,
      side,
      qty: pos.qty,
      price: px,
      kind: "exit",
      tag: `exit-${pos.id}-${reason}`,
      decisionId: pos.decisionId,
      leg: pos.leg,
      tier: pos.tier,
    });
  }

  private async moveStopBreakeven(pos: OpenPosition): Promise<void> {
    const q = this.quotes.get(pos.symbol);
    const tick = q?.tickSize ?? 0.05;
    pos.stop = pos.entryPrice;
    db.prepare("UPDATE positions SET stop=? WHERE id=?").run(pos.stop, pos.id);
    const stop = pos.stopOrderId ? this.findOrder(pos.stopOrderId) : undefined;
    if (stop) {
      await this.exec.modify(stop, roundTick(pos.side === "long" ? pos.stop - 3 * tick : pos.stop + 3 * tick, tick), pos.stop);
    }
  }

  private findOrder(id: string): WorkingOrder | undefined {
    const orders = this.exec.orders;
    if (!orders) return undefined;
    return [...orders.values()].find((o) => String(o.id) === id || o.brokerId === id);
  }

  private async hardExits(): Promise<void> {
    for (const pos of [...this.positions.values()]) {
      const q = this.quotes.get(pos.symbol);
      if (!q) continue;
      const holdMin = (Date.now() - pos.openedAt) / 60_000;
      const u = unrealized(pos, q);
      if (pos.leg === "options" && holdMin >= risk.optionTimeStopMin && u <= 0) {
        await this.exitPosition(pos, "time");
        continue;
      }
      if (pos.side === "long" && q.ltp <= pos.stop) {
        await this.exitPosition(pos, "stop");
        continue;
      }
      if (pos.side === "short" && q.ltp >= pos.stop) {
        await this.exitPosition(pos, "stop");
      }
    }
  }

  private manageEntries(): void {
    const orders = this.exec.orders;
    if (!orders) return;
    for (const o of orders.values()) {
      if (o.kind !== "entry") continue;
      const q = this.quotes.get(o.symbol);
      if (!q) continue;
      const want = o.side === "buy" ? q.bid : q.ask;
      if (want && Math.abs(want - o.price) >= (q.tickSize || 0.05) && Date.now() - o.lastModifyAt > 5000) {
        void this.exec.modify(o, want);
      }
    }
  }

  private async closeTrade(pos: OpenPosition, exitPx: number, exitCost: number, reason: string): Promise<void> {
    if (!this.positions.has(pos.symbol)) return;
    this.positions.delete(pos.symbol);
    const signed = pos.side === "long" ? 1 : -1;
    const gross = (exitPx - pos.entryPrice) * pos.qty * signed;
    const entryCost = fillCost(pos.leg, pos.side === "long" ? "buy" : "sell", pos.qty, pos.entryPrice);
    const pnl = gross - entryCost - exitCost;
    const friction = estimateEntryFriction(pos.leg, pos.qty, pos.entryPrice);
    db.prepare(
      `INSERT INTO trades (opened_at, closed_at, date, leg, symbol, side, qty, entry, exit, pnl, friction, hold_s, exit_reason, tier, decision_id, regime)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      pos.openedAt,
      Date.now(),
      istDateStr(),
      pos.leg,
      pos.symbol,
      pos.side,
      pos.qty,
      pos.entryPrice,
      exitPx,
      pnl,
      friction,
      Math.round((Date.now() - pos.openedAt) / 1000),
      reason,
      pos.tier,
      pos.decisionId,
      this.regime,
    );
    db.prepare("UPDATE positions SET closed=1 WHERE id=?").run(pos.id);
    if (pos.leg === "options") this.optionCooldownUntil = Date.now() + 10 * 60_000;
    void this.attribute(pos, reason);
  }

  private async attribute(pos: OpenPosition, reason: string): Promise<void> {
    try {
      const r = await this.model.evaluate(
        {
          entryDecision: { side: pos.side, tier: pos.tier },
          holdBars: [],
          exitReason: reason,
        },
        attributionQuestions,
        "attr",
        pos.symbol,
      );
      if (!r.ok) return;
      db.prepare("UPDATE trades SET attribution=?, entry_timing=? WHERE symbol=? AND closed_at > ?").run(
        r.answers.cause?.choice ?? null,
        r.answers.entry_timing?.score ?? null,
        pos.symbol,
        Date.now() - 5000,
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
      void alert("kill", "kill switch file");
      void this.flattenAll("kill");
    }
  }

  kill(): void {
    writeFileSync(cfg.killPath, "1");
    this.checkKill();
  }

  unkilled(): void {
    if (existsSync(cfg.killPath)) unlinkSync(cfg.killPath);
    this.killed = false;
  }

  async reconcile(): Promise<void> {
    try {
      const pos = await this.client.positions();
      const ords = await this.client.orders();
      if (cfg.onRestart === "flatten") {
        for (const p of pos) {
          if (p.qty === 0) continue;
          await this.client.place({
            segment: p.segment,
            tradingSymbol: p.symbol,
            token: p.token,
            side: p.qty > 0 ? "sell" : "buy",
            qty: Math.abs(p.qty),
            price: this.quotes.get(p.symbol)?.bid ?? 0,
            tag: "restart-flat",
          });
        }
        return;
      }
      for (const p of pos) {
        if (!p.qty) continue;
        const side = p.qty > 0 ? "long" : "short";
        const q = this.quotes.get(p.symbol.replace(/-EQ$/i, ""));
        const px = p.avgPrice || q?.ltp || 0;
        const sb = 12;
        const info = db
          .prepare(
            `INSERT INTO positions (opened_at, leg, symbol, token, segment, side, qty, entry, stop, target, decision_id, tier, stop_bps, closed)
             VALUES (?,?,?,?,?,?,?,?,?,?,NULL,'B',?,0)`,
          )
          .run(Date.now(), "equity", p.symbol, p.token, p.segment, side, Math.abs(p.qty), px, stopPrice(side, px, sb, 0.05), targetPrice(side, px, sb, 0.05), sb);
        this.positions.set(p.symbol, {
          id: Number(info.lastInsertRowid),
          leg: "equity",
          symbol: p.symbol,
          token: p.token,
          segment: p.segment,
          side,
          qty: Math.abs(p.qty),
          entryPrice: px,
          stop: stopPrice(side, px, sb, 0.05),
          target: targetPrice(side, px, sb, 0.05),
          openedAt: Date.now(),
          decisionId: null,
          tier: "B",
          stopOrderId: null,
          entryOrderId: null,
          stopBps: sb,
          thesis: 2,
        });
      }
      for (const o of ords) {
        const st = o.status.toLowerCase();
        if (st.includes("open") && !o.tag.startsWith("sl-") && !o.tag.startsWith("cont-")) {
          await this.client.cancel(o.orderId);
        }
      }
    } catch (e) {
      await alert("session", `reconcile failed ${e}`);
    }
  }

  snapshot() {
    return {
      mode: "live",
      optionsMode: cfg.optionsMode,
      model: this.model.name,
      session: !!this.client.session,
      halted: this.halted,
      killed: this.killed,
      regime: this.regime,
      riskOff: this.riskOff,
      niftyLong: this.niftyLong,
      niftyShort: this.niftyShort,
      skipped: this.skipped,
      positions: [...this.positions.values()].map((p) => {
        const q = this.quotes.get(p.symbol);
        return {
          ...p,
          ltp: q?.ltp ?? null,
          unrealized: q ? unrealized(p, q) : null,
        };
      }),
      candidates: this.lastCandidates,
      taken: this.taken,
    };
  }
}

