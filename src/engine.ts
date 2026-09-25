import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { alert } from "./alerts.js";
import { brokerConfigured, cfg, ENTRY_END_MIN, ENTRY_START_MIN, FLATTEN_MIN, MARKET_CLOSE_MIN, MARKET_OPEN_MIN, risk } from "./config.js";
import { runDailyContext } from "./context.js";
import { seedBars } from "./data/bars.js";
import { barDayStart, buildFeatures, buildIndexFeatures, loadBars } from "./data/features.js";
import { LiveFeed } from "./data/feed.js";
import { buildUniverse } from "./data/universe.js";
import {
  closeStalePositions,
  contextFor,
  db,
  getCapital,
  getWild,
  insertEvent,
  openPositionRows,
  openSession,
  positionsOpenedSince,
  pruneSnapshots,
  refreshSession,
  setWild,
  todayPnl,
  tokensToday,
  type PositionRow,
} from "./db.js";
import { LiveExecutor } from "./executor/live.js";
import { isEngineTag, isStopTag, isTerminalStatus, newTag, OrderRejected, type Executor, type Fill } from "./executor/types.js";
import type { Broker, BrokerOrder, BrokerPosition } from "./broker.js";
import { fillCost } from "./costs.js";
import { INDEX_SYMBOL, INDEX_TOKEN, NIFTY50 } from "./symbols.js";
import { createModel, type Model } from "./model/index.js";
import { attributionQuestions } from "./model/questions.js";
import {
  canEnterMore,
  marketablePrice,
  openMtm,
  partialRealised,
  positionNotional,
  riskPerTrade,
  roundTick,
  roundTickDir,
  sizeQty,
  stopBps,
  stopLimitPrice,
  stopPrice,
  targetPrice,
  unrealized,
} from "./risk.js";
import { pickBest, runStage1, runStage2, type Candidate } from "./strategy/continuation.js";
import { managePosition } from "./strategy/exits.js";
import { computeGovernor, governorAllows } from "./strategy/governor.js";
import { optionSignal, optionStops, pickStrike } from "./strategy/options.js";
import { addDays, clock, istDateStr, istDayStartMs, minutesOfDay } from "./time.js";
import type { IndexFeatures, OpenPosition, OptionContract, PositionSide, Quote, Side, SymbolFeatures, Tier, WorkingOrder } from "./types.js";

const EXIT_GUARD_MS = 10_000;
const FORCED_EXIT_GUARD_MS = 3_000;
/** Exits the engine must complete regardless of price: priced through the touch and chased until filled. */
const FORCED_EXITS = new Set(["stop", "flatten", "halt", "kill", "reconcile", "restart"]);
/** A passive (Jev / target / time) exit still resting after this long is converted to a marketable one. */
const PASSIVE_EXIT_MAX_MS = 20_000;
const CHASE_MS = 2_000;
const STOP_RETRY_MS = 30_000;
const RECONCILE_MS = 30_000;
/** Quotes are stamped on receipt; older than this means the feed has stopped refreshing. */
const QUOTE_STALE_MS = 10_000;
const NO_SESSION_ALERT_MS = 5 * 60_000;
const ADOPT_STOP_BPS = 12;
/** How far a forced exit with no live quote may walk from the last known price (inside NSE price bands). */
const STALE_EXIT_MAX_BPS = 300;

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
  lastPositionCheck = 0;
  wild = getWild();
  jevPaused = false;
  sessionId: number | null = null;
  lastSessionRefresh = 0;
  lastIndex: IndexFeatures | null = null;
  lastStage1: { longs: unknown[]; shorts: unknown[]; top: string } | null = null;
  /** IST trading day the per-day state (halt, broker realised, budgets) belongs to. */
  day: string;
  /** Sum of the broker's own realised P&L for the day, refreshed by reconciliation. */
  brokerRealised: number | null = null;
  lastReconcile = 0;
  private lastNoSessionAlert = 0;
  private tokenBudgetHit = false;
  private reconciling = false;
  /** Position-quantity disagreements must be seen on two consecutive reconciles before anything is repaired. */
  private mismatches = new Map<string, number>();
  private orphanStrikes = new Map<string, number>();
  /** Fills are applied strictly in arrival order; exits and reconciliation await this before sizing. */
  private fillQueue: Promise<void> = Promise.resolve();
  /** Symbols with an exit between "stop cancelled" and "exit placed"; nothing may re-arm or send a second exit. */
  private exitInFlight = new Set<string>();
  private managing = false;
  model: Model;
  exec: Executor;
  feed: LiveFeed;
  readonly canTrade: boolean;
  readonly replay: boolean;
  /** Replay seek: fills, stops and flatten only; no Jev, no universe rebuild. */
  seeking = false;
  private fastBusy = false;
  private deciding = false;

  constructor(
    private client: Broker,
    opts: { exec?: Executor; replay?: boolean; model?: Model } = {},
  ) {
    this.model = opts.model ?? createModel();
    this.replay = opts.replay ?? false;
    this.canTrade = this.replay || this.model.name === "jev" || cfg.allowMockTrading;
    this.exec = opts.exec ?? new LiveExecutor(client);
    this.exec.onFill = (f) => {
      this.fillQueue = this.fillQueue.then(() => this.handleFill(f)).catch((e) => void alert("fill_err", `${f.order.symbol} ${String(e)}`));
    };
    this.day = istDateStr();
    this.feed = new LiveFeed(
      client,
      () => this.universeTokens(),
      () => this.activeTokens(),
      !this.replay,
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
    this.day = istDateStr();
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
    if (!existsSync(cfg.killPath) && this.canTrade) this.beginSession("start");
    if (!this.replay) pruneSnapshots(30 * 24 * 3600_000);
  }

  /** Load recent 1-min candles so RVOL, ADR and ATR have history from the first minute. */
  private async warmup(): Promise<void> {
    if (this.replay) {
      const have = db.prepare("SELECT COUNT(*) AS c FROM bars_1m WHERE symbol = ? AND ts < ?").get("Nifty 50", barDayStart()) as { c: number };
      this.warmedUp = have.c > 300;
      return;
    }
    const to = istDateStr();
    const symbols: string[] = [...NIFTY50, INDEX_TOKEN];
    const lastBar = db.prepare("SELECT MAX(ts) AS t, COUNT(*) AS c FROM bars_1m WHERE symbol = ?");
    let loaded = 0;
    let skipped = 0;
    for (const sym of symbols) {
      const inst = this.client.getInstrument(sym);
      if (!inst) continue;
      const { t, c } = lastBar.get(sym) as { t: number | null; c: number };
      const stale = !t || clock.now() - t > 10 * 60_000;
      if (c > 2000 && !stale) {
        skipped++;
        continue;
      }
      // Full history if the symbol is new; otherwise just today's gap since the last stored bar.
      const from = c > 2000 && t ? istDateStr(t) : addDays(to, -cfg.warmupDays);
      try {
        const rows = await this.client.candles(inst.token, "nse_cm", from, to, "1min");
        seedBars(sym, rows.map((r) => ({ symbol: sym, ...r })));
        loaded++;
      } catch (e) {
        insertEvent("warmup_err", `${sym} ${String(e).slice(0, 120)}`);
      }
    }
    this.warmedUp = loaded + skipped > 0;
    insertEvent("warmup", `${loaded} symbols fetched, ${skipped} already current`);
  }

  rebuildUniverse(): void {
    this.universe = buildUniverse({
      cash: this.client.allCash(),
      quotes: this.quotes,
      openSymbols: new Set(this.positions.keys()),
      // WILD grinds: a name can be re-entered as soon as it closes if Jev still rates it.
      cooldownMs: this.wild ? 0 : 15 * 60_000,
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
    // Jev paused: no entry scans, no Jev exits. Stops, fills, flatten and kill keep running in the fast loop.
    if (this.jevPaused || this.seeking) return;
    // Hold / sell / breakeven on open positions: its own faster cadence, independent of entry scans.
    const posMs = cfg.positionIntervalS * 1000;
    if (!this.managing && this.positions.size && clock.now() - this.lastPositionCheck >= posMs) {
      this.lastPositionCheck = clock.now();
      this.managing = true;
      const run = this.managePositions()
        .catch((e) => insertEvent("manage_err", String(e)))
        .finally(() => {
          this.managing = false;
        });
      if (awaitDecision) await run;
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
            insertEvent("skip", `decision took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
            this.skipped++;
          }
        });
      if (awaitDecision) await run;
    }
  }

  /** One Jev call per open equity position: thesis, exit_now, extended, take_profit → exit / breakeven / hold. */
  private async managePositions(): Promise<void> {
    if (this.killed || this.halted || !this.client.session || minutesOfDay() >= FLATTEN_MIN) return;
    const index = this.lastIndex;
    // One Jev call per position, all in flight at once; act on the answers in order.
    // Options legs are managed by price (stop, target, time); equity features mean nothing for a contract.
    const asked = [...this.positions.values()]
      .filter((pos) => pos.leg === "equity" && pos.closedQty < pos.qty)
      .map((pos) => {
        const q = this.quotes.get(pos.symbol);
        const f = q ? buildFeatures(pos.symbol, q) : null;
        if (!q || !f) return null;
        return { pos, verdict: managePosition(this.model, pos, f, index, unrealized(pos, q)) };
      })
      .filter((x) => x !== null);
    for (const { pos, verdict } of asked) {
      const d = await verdict;
      if (!this.positions.has(pos.symbol)) continue;
      pos.thesis = d.thesis;
      db.prepare("UPDATE positions SET thesis=? WHERE id=?").run(d.thesis, pos.id);
      const wantsOut = d.action === "exit" || d.action === "take_profit";
      // At a 5 s cadence one noisy answer must not close a trade: two consecutive exit votes (~10 s) are required.
      // Time stops and hard stops bypass this; they are not Jev opinions.
      pos.exitVotes = wantsOut ? pos.exitVotes + 1 : 0;
      const votesNeeded = this.wild ? 1 : cfg.exitConfirmVotes;
      const confirmed = wantsOut && (pos.exitVotes >= votesNeeded || d.reason === "time");
      pos.lastVerdict = `${d.action}${wantsOut && !confirmed ? ` (${pos.exitVotes}/${votesNeeded})` : ""} · thesis ${d.thesis.toFixed(1)} · exit ${d.exitNow.toFixed(2)} · tp ${d.takeProfit.toFixed(2)}`;
      if (confirmed) {
        await this.exitPosition(pos, d.reason);
      } else if (d.action === "breakeven") {
        await this.moveStopBreakeven(pos);
      }
    }
  }

  private async fastLoop(): Promise<void> {
    this.checkKill();
    this.rollDay();
    if (this.client.session || brokerConfigured()) {
      try {
        this.quotes = await this.feed.tick();
      } catch (e) {
        insertEvent("quote_err", String(e));
      }
    }
    if (!this.client.session) {
      this.alertNoSession();
      return;
    }
    try {
      await this.exec.tick(this.quotes);
    } catch (e) {
      insertEvent("poll_err", String(e));
    }
    await this.fillQueue;
    const pastFlatten = minutesOfDay() >= FLATTEN_MIN;
    if (pastFlatten && !this.positions.size && !this.exec.orders.size && this.sessionId !== null && !this.replay) {
      this.endSession("close");
    }
    if (this.sessionId !== null && clock.now() - this.lastSessionRefresh > 30_000) {
      this.lastSessionRefresh = clock.now();
      refreshSession(this.sessionId, this.regime, null);
    }
    const dayPnl = this.dayPnl();
    if (!this.halted && dayPnl <= -cfg.dailyLossCap) {
      this.halted = true;
      this.endSession("halt");
      void alert("halt", `daily loss cap: day P&L ${dayPnl.toFixed(0)} (realised + open) ≤ -${cfg.dailyLossCap}`);
    }
    // Kill, halt and the flatten time are states, not events: keep driving every position out until flat.
    const forced = this.killed ? "kill" : this.halted ? "halt" : pastFlatten ? "flatten" : null;
    if (forced) {
      await this.exec.cancelAll("entry");
      await this.flattenAll(forced);
    }
    if (!this.replay && Date.now() - this.client.lastOk > 30_000 && this.positions.size && Date.now() - this.lastConnAlert > 60_000) {
      this.lastConnAlert = Date.now();
      void alert("connectivity", `no ${cfg.broker} response >30s with open position`);
    }
    await this.chaseExits();
    await this.manageEntries();
    await this.hardExits();
    await this.periodicReconcile();
    if (!this.seeking && clock.now() - this.lastUniverseRebuild > 60_000) this.rebuildUniverse();
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

  /** A process that runs across midnight must not carry yesterday's halt, broker P&L or budgets into today. */
  private rollDay(): void {
    const d = istDateStr();
    if (d === this.day) return;
    this.day = d;
    this.halted = false;
    this.brokerRealised = null;
    this.tokenBudgetHit = false;
    this.optionCooldownUntil = 0;
    this.halfSizeDay = false;
    this.mismatches.clear();
    this.orphanStrikes.clear();
    insertEvent("day", `new trading day ${d}`);
    if (this.replay) return;
    pruneSnapshots(30 * 24 * 3600_000);
    void runDailyContext(this.model, this.client.allCash())
      .then((ctx) => {
        this.halfSizeDay = ctx.halfSize;
      })
      .catch((e) => insertEvent("context", String(e)));
    if (!this.killed && this.canTrade && !existsSync(cfg.killPath)) this.beginSession("new day");
  }

  private alertNoSession(): void {
    if (this.replay || !this.positions.size) return;
    const m = minutesOfDay();
    if (m < MARKET_OPEN_MIN || m > MARKET_CLOSE_MIN) return;
    if (Date.now() - this.lastNoSessionAlert < NO_SESSION_ALERT_MS) return;
    this.lastNoSessionAlert = Date.now();
    void alert("session", `no ${cfg.broker} session with ${this.positions.size} open position(s); exchange stops rest but the engine cannot exit, chase or flatten`);
  }

  /**
   * Day P&L for the loss cap: the worse of our booked trades and the broker's realised figure,
   * plus open mark-to-market. A position sliding against us counts before it is closed.
   */
  /**
   * Loss-cap P&L: realised (the worse of our books and the broker's) plus open remainder MTM. Partial exits are
   * realised on both sides (broker rows carry them while the symbol is still open), so they are not in the MTM.
   */
  dayPnl(): number {
    let partials = 0;
    let mtm = 0;
    for (const p of this.positions.values()) {
      partials += partialRealised(p) - p.exitCost;
      const q = this.quotes.get(p.symbol);
      if (q) mtm += openMtm(p, q);
    }
    const local = todayPnl() + partials;
    const realised = this.brokerRealised === null ? local : Math.min(local, this.brokerRealised);
    return realised + mtm;
  }

  private async decide(): Promise<void> {
    if (this.killed || this.halted || !this.client.session) return;
    if (!this.universe.length) return;
    if (this.model.name === "jev" && cfg.jevDailyTokenBudget > 0 && tokensToday() >= cfg.jevDailyTokenBudget) {
      if (!this.tokenBudgetHit) {
        this.tokenBudgetHit = true;
        void alert("budget", `Jev daily token budget ${cfg.jevDailyTokenBudget} reached; no new entries today (open positions keep their stops and management)`);
      }
      this.lastSkipReason = "Jev daily token budget reached";
      return;
    }
    const feats: SymbolFeatures[] = [];
    const missing: string[] = [];
    for (const u of this.universe) {
      const q = this.quotes.get(u.symbol);
      const f = q ? buildFeatures(u.symbol, q) : null;
      if (f) feats.push(f);
      else missing.push(`${u.symbol}${q ? "(no features)" : "(no quote)"}`);
    }
    if (missing.length) this.lastSkipReason = `${missing.length} names without data: ${missing.slice(0, 6).join(", ")}`;
    if (!feats.length) return;
    const niftyQ = this.quotes.get(INDEX_TOKEN);
    const above = feats.filter((f) => f.vwapDist.label === "above" || f.vwapDist.label === "far_above").length;
    const breadth = feats.length ? above / feats.length : 0.5;
    const index: IndexFeatures | null = buildIndexFeatures(niftyQ, 0, breadth);
    const s1 = await runStage1(this.model, feats, index, { candlesOnly: this.replay });
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
    this.lastIndex = index;
    this.lastStage1 = { longs: s1.longs, shorts: s1.shorts, top: s1.bestP.toFixed(2) };

    if (!this.inEntryWindow()) {
      this.lastSkipReason = `outside entry window ${fmtMin(ENTRY_START_MIN)}–${fmtMin(ENTRY_END_MIN)} (ENTRY_START/ENTRY_END in .env)`;
      return;
    }
    if (s1.riskOff >= risk.riskOffHalt) {
      this.lastSkipReason = `risk_off ${s1.riskOff.toFixed(2)}`;
      return;
    }

    const featMap = new Map(feats.map((f) => [f.symbol, f]));
    const cands: Candidate[] = [];
    const filtered: string[] = [];
    const ctx = contextFor(istDateStr());
    for (const r of [...s1.longs, ...s1.shorts]) {
      const f = featMap.get(r.symbol);
      if (!f) continue;
      // WILD keeps only a wide spread sanity cap; RVOL and the tight spread gate are two-stage-mode filters.
      if (f.spreadBps > (this.wild ? risk.wildMaxSpreadBps : risk.maxSpreadBps)) {
        filtered.push(`${r.symbol} spread ${f.spreadBps.toFixed(1)}bps`);
        continue;
      }
      if (!this.wild && f.volume.rvol20d < risk.minRvol) {
        filtered.push(`${r.symbol} rvol ${f.volume.rvol20d.toFixed(2)}`);
        continue;
      }
      if (ctx.get(r.symbol)?.forbidSide === r.side) {
        filtered.push(`${r.symbol} news`);
        continue;
      }
      if (this.wild) {
        // WILD: stage-1 conviction is the whole decision. No stage 2; size by p; several names per cycle.
        if (r.p < risk.wildMinProb) {
          filtered.push(`${r.symbol} p ${r.p.toFixed(2)} < ${risk.wildMinProb}`);
          continue;
        }
        cands.push({
          symbol: r.symbol,
          side: r.side,
          setup: r.side === "long" ? "long_continuation" : "short_continuation",
          setupProb: r.p,
          setupConf: 1,
          entryScore: r.p,
          scores: {},
          oneSided: 1,
          tier: r.p >= risk.wildTierA ? "A" : "B",
          passes: true,
          reject: "",
        });
        continue;
      }
      const c = await runStage2(this.model, f, index, r.side, { candlesOnly: this.replay });
      if (c) cands.push(c);
    }
    this.lastCandidates = cands;
    if (this.wild) {
      const room = cfg.maxPositions - this.exposureCount();
      const picks = cands
        .filter((c) => !this.positions.has(c.symbol) && !this.hasOpenEntry(c.symbol))
        .sort((a, b) => b.entryScore - a.entryScore)
        .slice(0, Math.max(0, room));
      this.taken = picks[0] ?? null;
      for (const c of picks) await this.enterEquity(c, featMap.get(c.symbol)!);
      if (!picks.length) {
        this.lastSkipReason = room <= 0 ? "at position cap" : filtered.length ? `wild: ${filtered.join(", ")}` : `wild: no name ≥ ${risk.wildMinProb} (best ${s1.bestP.toFixed(2)})`;
      } else if (this.lastSkipReason.startsWith("wild")) {
        this.lastSkipReason = "";
      }
      return;
    }
    const best = pickBest(cands);
    this.taken = best;
    if (best && !this.positions.has(best.symbol) && !this.hasOpenEntry(best.symbol)) {
      await this.enterEquity(best, featMap.get(best.symbol)!);
    } else if (!best) {
      this.lastSkipReason = cands.length
        ? `stage2 rejected: ${cands.map((c) => `${c.symbol} ${c.reject}`).join(", ")}`
        : filtered.length
          ? `pre-filter: ${filtered.join(", ")}`
          : `no name ≥ ${risk.stage1MinProb} in stage1 (best ${s1.bestP.toFixed(2)})`;
    }

    if (cfg.optionsMode === "on") {
      const sig = optionSignal({ niftyLong: s1.niftyLong, niftyShort: s1.niftyShort, regime: s1.regime, riskOff: s1.riskOff });
      if (sig && clock.now() > this.optionCooldownUntil && ![...this.positions.values()].some((p) => p.leg === "options") && !this.hasOpenEntry(undefined, "options")) {
        await this.enterOption(sig.right, niftyQ?.ltp ?? 0);
      }
    }
  }

  private inEntryWindow(): boolean {
    const m = minutesOfDay();
    return m >= ENTRY_START_MIN && m <= ENTRY_END_MIN && m < FLATTEN_MIN;
  }

  private hasOpenEntry(symbol?: string, leg?: "equity" | "options"): boolean {
    return [...this.exec.orders.values()].some((o) => o.kind === "entry" && (symbol === undefined || o.symbol === symbol) && (leg === undefined || o.leg === leg));
  }

  /** Open positions plus names with a working entry: what the position cap must count. */
  exposureCount(): number {
    const names = new Set(this.positions.keys());
    for (const o of this.exec.orders.values()) if (o.kind === "entry") names.add(o.symbol);
    return names.size;
  }

  /** Positions opened today plus working entries for new names: the MAX_TRADES_PER_DAY count. */
  tradesToday(): number {
    let pending = 0;
    for (const o of this.exec.orders.values()) if (o.kind === "entry" && !this.positions.has(o.symbol)) pending++;
    return positionsOpenedSince(istDayStartMs()) + pending;
  }

  /**
   * Re-checked immediately before an entry is sent: margin and Jev awaits take seconds, and a kill,
   * halt, flatten or cap breach in that gap must win.
   */
  private entryBlocker(symbol: string): string | null {
    if (existsSync(cfg.killPath)) this.checkKill();
    if (this.killed) return "killed";
    if (this.halted) return "halted";
    if (!this.inEntryWindow()) return "outside entry window";
    if (this.positions.has(symbol) || this.hasOpenEntry(symbol)) return `${symbol} already open`;
    const cap = canEnterMore(this.exposureCount(), this.dayPnl());
    if (!cap.ok) return cap.reason;
    if (cfg.maxTradesPerDay > 0 && this.tradesToday() >= cfg.maxTradesPerDay) return `MAX_TRADES_PER_DAY ${cfg.maxTradesPerDay} reached`;
    return null;
  }

  private quoteIsStale(q: Quote | undefined): boolean {
    if (!q) return true;
    return !this.replay && clock.now() - q.ts > QUOTE_STALE_MS;
  }

  private async enterEquity(c: Candidate, f: SymbolFeatures): Promise<void> {
    if (!this.canTrade) {
      this.lastSkipReason = `observe: would ${c.side} ${c.symbol} (${c.tier})`;
      insertEvent("observe", this.lastSkipReason);
      return;
    }
    const inst = this.universe.find((u) => u.symbol === c.symbol) ?? this.client.getInstrument(c.symbol);
    if (!inst) return;
    if (this.quoteIsStale(this.quotes.get(c.symbol))) {
      this.lastSkipReason = `${c.symbol} quote stale`;
      return;
    }
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
    // WILD ignores the pace governor; the daily loss halt, capital box and position cap still apply.
    if (!ga.ok && !this.wild) {
      this.lastSkipReason = `governor ${ga.reason}`;
      return;
    }
    const blocked = this.entryBlocker(c.symbol);
    if (blocked) {
      this.lastSkipReason = blocked;
      return;
    }
    const side = c.side === "long" ? "buy" : "sell";
    // WILD scalps: cross the spread so the entry fills now. Two-stage rests on the touch and re-quotes.
    const px = this.wild ? (side === "buy" ? f.ask : f.bid) : side === "buy" ? f.bid : f.ask;
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
    const late = this.entryBlocker(c.symbol);
    if (late) {
      this.lastSkipReason = late;
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
        tag: newTag("e", clock.now()),
        decisionId: null,
        leg: "equity",
        tier,
        stop,
        target,
        stopBps: sb,
      });
      this.lastSkipReason = "";
    } catch (e) {
      this.lastSkipReason = `${c.symbol} entry ${e instanceof OrderRejected ? "rejected" : "failed"}`;
    }
  }

  private async enterOption(right: "CE" | "PE", spot: number): Promise<void> {
    if (!this.canTrade) return;
    const c = pickStrike(this.chain, right, spot, this.expiry);
    if (!c) return;
    const optPnl = (db.prepare("SELECT COALESCE(SUM(pnl),0) AS p FROM trades WHERE date=? AND leg='options'").get(istDateStr()) as { p: number }).p;
    if (optPnl <= -risk.optionDailyLossCap) return;
    const symbol = c.tradingSymbol || c.symbol;
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
    if (this.entryBlocker(symbol)) return;
    const tick = c.tickSize || 0.05;
    const px = roundTick(c.bid || c.ltp, tick);
    const { stop, target } = optionStops(px, tick);
    try {
      await this.exec.place({
        symbol,
        token: c.token,
        segment: "nse_fo",
        tradingSymbol: c.tradingSymbol,
        side: "buy",
        qty: c.lotSize,
        price: px,
        kind: "entry",
        tag: newTag("o", clock.now()),
        decisionId: null,
        leg: "options",
        tier: "B",
        stop,
        target,
        stopBps: risk.optionStopPct * 1e4,
      });
    } catch {
      /* alerted in executor */
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
        await this.syncStopQty(existing);
        return;
      }
      if (existing) {
        void alert("orphan_fill", `${o.side} entry fill for ${o.symbol} against an open ${existing.side}; reconciliation will repair`);
        return;
      }
      const tick = this.quotes.get(o.symbol)?.tickSize ?? 0.05;
      const pos = this.createPosition({
        leg: o.leg,
        symbol: o.symbol,
        token: o.token,
        segment: o.segment,
        side,
        qty: f.qty,
        entry: f.price,
        // Stops are set from the fill, not the intended price: a WILD entry that crossed the spread keeps its full stop distance.
        stop: o.stopBps !== null && o.leg === "equity" ? stopPrice(side, f.price, o.stopBps, tick) : (o.stop ?? f.price),
        target: o.stopBps !== null && o.leg === "equity" ? targetPrice(side, f.price, o.stopBps, tick) : (o.target ?? f.price),
        decisionId: o.decisionId,
        tier: o.tier,
        stopBps: o.stopBps ?? 10,
        entryOrderId: String(o.id),
      });
      await this.placeStop(pos);
      return;
    }
    const pos = this.positions.get(o.symbol);
    if (!pos) {
      void alert("orphan_fill", `${o.kind} fill for ${o.symbol} with no tracked position; check broker positions`);
      return;
    }
    pos.closedQty += f.qty;
    pos.exitNotional += f.qty * f.price;
    pos.exitCost += f.cost;
    if (!pos.exitReason) pos.exitReason = o.kind === "stop" ? "stop" : (o.reason ?? "exit");
    if (pos.closedQty > pos.qty) {
      void alert("overfill", `${o.symbol} exits filled ${pos.closedQty} against ${pos.qty}: the broker position has flipped; reconciliation will flatten the excess`);
    }
    if (pos.closedQty >= pos.qty) {
      await this.closeTrade(pos);
    } else {
      await this.syncStopQty(pos);
    }
  }

  /** Keep the resting stop's quantity equal to the open quantity (entry adds, partial exits). */
  private async syncStopQty(pos: OpenPosition): Promise<void> {
    const stopOrd = this.stopOrderFor(pos);
    const open = pos.qty - pos.closedQty;
    if (!stopOrd || open <= 0) return;
    const want = stopOrd.filledQty + open;
    if (stopOrd.qty === want || !stopOrd.confirmed) return;
    try {
      await this.exec.modify(stopOrd, stopOrd.price, stopOrd.trigger ?? undefined, want);
    } catch (e) {
      // A stop for more than we hold flips the position when it fires; replace it rather than leave it.
      void alert("order_reject", `stop qty modify failed ${pos.symbol} (${stopOrd.qty}→${want}); replacing the stop. ${e}`);
      try {
        await this.exec.cancel(stopOrd);
      } catch {
        return; // still resting or unconfirmed: hardExits retries the sync next tick
      }
      pos.stopOrderId = null;
      await this.placeStop(pos);
    }
  }

  private createPosition(p: {
    leg: OpenPosition["leg"];
    symbol: string;
    token: string;
    segment: string;
    side: PositionSide;
    qty: number;
    entry: number;
    stop: number;
    target: number;
    decisionId: number | null;
    tier: Tier;
    stopBps: number;
    entryOrderId: string | null;
    openedAt?: number;
    existingId?: number;
  }): OpenPosition {
    const openedAt = p.openedAt ?? clock.now();
    let id = p.existingId;
    if (id === undefined) {
      const info = db
        .prepare(
          `INSERT INTO positions (opened_at, leg, symbol, token, segment, side, qty, entry, stop, target, decision_id, tier, entry_order_id, stop_bps, closed)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
        )
        .run(openedAt, p.leg, p.symbol, p.token, p.segment, p.side, p.qty, p.entry, p.stop, p.target, p.decisionId, p.tier, p.entryOrderId, p.stopBps);
      id = Number(info.lastInsertRowid);
    } else {
      db.prepare("UPDATE positions SET qty=?, entry=?, stop=?, target=? WHERE id=?").run(p.qty, p.entry, p.stop, p.target, id);
    }
    const pos: OpenPosition = {
      id,
      leg: p.leg,
      symbol: p.symbol,
      token: p.token,
      segment: p.segment,
      side: p.side,
      qty: p.qty,
      entryPrice: p.entry,
      stop: p.stop,
      target: p.target,
      openedAt,
      decisionId: p.decisionId,
      tier: p.tier,
      stopOrderId: null,
      entryOrderId: p.entryOrderId,
      stopBps: p.stopBps,
      thesis: 2,
      exitingAt: 0,
      closedQty: 0,
      exitNotional: 0,
      exitCost: 0,
      exitReason: null,
      mfeBps: 0,
      exitVotes: 0,
      stopRetryAt: 0,
      stopBreachAt: 0,
      stopSeq: 0,
    };
    this.positions.set(pos.symbol, pos);
    return pos;
  }

  private async placeStop(pos: OpenPosition): Promise<void> {
    if (!this.positions.has(pos.symbol) || pos.closedQty >= pos.qty) return;
    // A stop beside a working exit sells the same shares twice.
    if (this.exitInFlight.has(pos.symbol) || this.workingExit(pos.symbol)) return;
    const inst = this.client.getInstrument(pos.symbol);
    const stopSide = pos.side === "long" ? "sell" : "buy";
    const tick = this.quotes.get(pos.symbol)?.tickSize ?? 0.05;
    pos.stopSeq++;
    try {
      const stopOrd = await this.exec.place({
        symbol: pos.symbol,
        token: pos.token,
        segment: pos.segment,
        tradingSymbol: inst?.tradingSymbol ?? pos.symbol,
        side: stopSide,
        qty: pos.qty - pos.closedQty,
        price: stopLimitPrice(pos.side, pos.stop, tick),
        trigger: pos.stop,
        orderType: "SL-L",
        kind: "stop",
        tag: newTag("s", clock.now()),
        decisionId: pos.decisionId,
        leg: pos.leg,
        tier: pos.tier,
        reason: "stop",
      });
      pos.stopOrderId = String(stopOrd.id);
      pos.stopBreachAt = 0;
      db.prepare("UPDATE positions SET stop_order_id=? WHERE id=?").run(pos.stopOrderId, pos.id);
    } catch (e) {
      pos.stopRetryAt = clock.now() + STOP_RETRY_MS;
      void alert("order_reject", `SL-L failed ${pos.symbol}; engine price-stop is the only protection, retrying in ${STOP_RETRY_MS / 1000}s. ${e}`);
    }
  }

  private stopOrderFor(pos: OpenPosition): WorkingOrder | undefined {
    return pos.stopOrderId ? this.findOrder(pos.stopOrderId) : undefined;
  }

  private workingExit(symbol: string): WorkingOrder | undefined {
    return [...this.exec.orders.values()].find((o) => o.kind === "exit" && o.symbol === symbol);
  }

  /**
   * Cancels the resting stop, then sends the exit. Forced reasons (stop, flatten, halt, kill, reconcile,
   * restart) are marketable limits that chaseExits() keeps re-pricing; others rest at the touch and are
   * escalated to marketable if still unfilled after PASSIVE_EXIT_MAX_MS.
   */
  private async exitPosition(pos: OpenPosition, reason: string): Promise<void> {
    if (pos.closedQty >= pos.qty || !this.positions.has(pos.symbol)) return;
    // Jev management runs beside the fast loop; only one caller may be between "cancel stop" and "exit placed".
    // A forced caller that loses the race upgrades the resulting working exit on its next pass.
    if (this.exitInFlight.has(pos.symbol)) return;
    const forced = FORCED_EXITS.has(reason);
    const working = this.workingExit(pos.symbol);
    if (working) {
      if (forced && !working.marketable) {
        working.marketable = true;
        working.lastModifyAt = 0;
      }
      if (!working.marketable) {
        const q = this.quotes.get(pos.symbol);
        const touch = q ? (working.side === "sell" ? q.bid || q.ltp : q.ask || q.ltp) : 0;
        if (touch && Math.abs(touch - working.price) >= (q?.tickSize || 0.05) && clock.now() - working.lastModifyAt >= CHASE_MS) {
          await this.exec.modify(working, touch).catch((e) => insertEvent("requote_err", `${pos.symbol} exit ${e}`));
        }
      }
      return;
    }
    if (clock.now() - pos.exitingAt < (forced ? FORCED_EXIT_GUARD_MS : EXIT_GUARD_MS)) return;
    const last = this.quotes.get(pos.symbol);
    let q: Pick<Quote, "bid" | "ask" | "ltp" | "tickSize"> | undefined = last && (last.bid || last.ask || last.ltp) ? last : undefined;
    if (!q) {
      insertEvent("exit_err", `${pos.symbol} no quote for ${reason}`);
      // A forced exit must still go out; chaseExits walks it through the market from this anchor.
      if (!forced) return;
      q = { bid: pos.entryPrice, ask: pos.entryPrice, ltp: pos.entryPrice, tickSize: last?.tickSize || 0.05 };
    }
    pos.exitingAt = clock.now();
    this.exitInFlight.add(pos.symbol);
    let rearm = false;
    try {
      const stopOrd = this.stopOrderFor(pos);
      if (stopOrd) {
        try {
          await this.exec.cancel(stopOrd);
        } catch {
          // The stop may have just filled, or is unconfirmed. Let the poll settle it; retry after the guard.
          return;
        }
      }
      // A cancel can book a last-moment stop fill; size the exit from settled quantities.
      await this.fillQueue;
      if (!this.positions.has(pos.symbol) || this.workingExit(pos.symbol)) return;
      const remaining = pos.qty - pos.closedQty;
      if (remaining <= 0) return;
      const now = this.quotes.get(pos.symbol);
      const fresh = now && (now.bid || now.ask || now.ltp) ? now : q;
      const inst = this.client.getInstrument(pos.symbol);
      const side: Side = pos.side === "long" ? "sell" : "buy";
      const px = forced ? marketablePrice(side, fresh) : side === "sell" ? fresh.bid || fresh.ltp : fresh.ask || fresh.ltp;
      try {
        await this.exec.place({
          symbol: pos.symbol,
          token: pos.token,
          segment: pos.segment,
          tradingSymbol: inst?.tradingSymbol ?? pos.symbol,
          side,
          qty: remaining,
          price: px,
          kind: "exit",
          tag: newTag("x", clock.now()),
          decisionId: pos.decisionId,
          leg: pos.leg,
          tier: pos.tier,
          marketable: forced,
          reason,
        });
        pos.stopOrderId = null;
        db.prepare("UPDATE positions SET stop_order_id=NULL WHERE id=?").run(pos.id);
      } catch (e) {
        // Refused outright and the stop is already cancelled: restore protection now, not after the retry delay.
        void alert("order_reject", `exit (${reason}) refused for ${pos.symbol}; re-arming the stop. ${e}`);
        pos.stopOrderId = null;
        rearm = true;
      }
    } finally {
      this.exitInFlight.delete(pos.symbol);
    }
    if (rearm) await this.placeStop(pos);
  }

  /** Re-price marketable exits every CHASE_MS until filled; escalate stale passive exits. */
  private async chaseExits(): Promise<void> {
    for (const o of [...this.exec.orders.values()]) {
      if (o.kind !== "exit" || !o.confirmed) continue;
      if (!o.marketable && clock.now() - o.placedAt >= PASSIVE_EXIT_MAX_MS) {
        o.marketable = true;
        o.lastModifyAt = 0;
        insertEvent("exit", `${o.symbol} passive exit unfilled after ${PASSIVE_EXIT_MAX_MS / 1000}s; making it marketable`);
      }
      if (!o.marketable || clock.now() - o.lastModifyAt < CHASE_MS) continue;
      const q = this.quotes.get(o.symbol);
      const tick = q?.tickSize || 0.05;
      let want: number;
      if (q && (q.bid || q.ask || q.ltp) && !this.quoteIsStale(q)) {
        want = marketablePrice(o.side, q);
      } else {
        // No live price (feed down, frozen quote): step the limit further through each pass, bounded,
        // so a market that has gapped away from the last quote cannot strand a forced exit.
        const anchor = q?.ltp || o.price;
        const stepped = marketablePrice(o.side, { bid: o.price, ask: o.price, ltp: o.price, tickSize: tick });
        const bound =
          o.side === "sell"
            ? roundTickDir(anchor * (1 - STALE_EXIT_MAX_BPS / 1e4), tick, "down")
            : roundTickDir(anchor * (1 + STALE_EXIT_MAX_BPS / 1e4), tick, "up");
        want = o.side === "sell" ? Math.max(stepped, bound) : Math.min(stepped, bound);
      }
      // Only chase the market: a resting sell above `want` (or buy below it) has been left behind.
      const behind = o.side === "sell" ? want <= o.price - tick / 2 : want >= o.price + tick / 2;
      if (!behind) continue;
      try {
        await this.exec.modify(o, want);
      } catch (e) {
        insertEvent("requote_err", `${o.symbol} chase ${e}`);
      }
    }
  }

  private async moveStopBreakeven(pos: OpenPosition): Promise<void> {
    if (pos.stop === pos.entryPrice || this.exitInFlight.has(pos.symbol) || this.workingExit(pos.symbol)) return;
    const tick = this.quotes.get(pos.symbol)?.tickSize ?? 0.05;
    const stopOrd = this.stopOrderFor(pos);
    const newStop = roundTick(pos.entryPrice, tick);
    if (stopOrd) {
      try {
        await this.exec.modify(stopOrd, stopLimitPrice(pos.side, newStop, tick), newStop);
      } catch (e) {
        void alert("order_reject", `breakeven modify failed ${pos.symbol} ${e}`);
        return;
      }
    }
    pos.stop = newStop;
    pos.stopBreachAt = 0;
    db.prepare("UPDATE positions SET stop=? WHERE id=?").run(pos.stop, pos.id);
    insertEvent("stop", `${pos.symbol} stop -> breakeven ${newStop}`);
  }

  private findOrder(id: string) {
    return [...this.exec.orders.values()].find((o) => String(o.id) === id || o.brokerId === id);
  }

  /**
   * Price-based protection that does not trust the exchange stop alone:
   * - no stop resting: re-arm it (with backoff), or exit now if price is already through it;
   * - stop resting but breached / triggered and still unfilled after stopUnfilledMs (gap through the
   *   stop-limit, freeze, rejection): cancel it and send a marketable exit;
   * - options: time stop and target.
   */
  private async hardExits(): Promise<void> {
    const forcedMode = this.killed || this.halted || minutesOfDay() >= FLATTEN_MIN;
    for (const pos of [...this.positions.values()]) {
      if (pos.closedQty >= pos.qty || this.exitInFlight.has(pos.symbol)) continue;
      const q = this.quotes.get(pos.symbol);
      const ltp = q?.ltp ?? 0;
      const breached = ltp > 0 && (pos.side === "long" ? ltp <= pos.stop : ltp >= pos.stop);
      const stopOrd = this.stopOrderFor(pos);
      const working = this.workingExit(pos.symbol);
      if (!stopOrd) {
        pos.stopBreachAt = 0;
        if (working) continue;
        if (breached) {
          await this.exitPosition(pos, "stop");
          continue;
        }
        if (!forcedMode && clock.now() >= pos.stopRetryAt) await this.placeStop(pos);
      }
      if (!q || !ltp) continue;
      const signed = pos.side === "long" ? 1 : -1;
      const favBps = ((ltp - pos.entryPrice) / pos.entryPrice) * 1e4 * signed;
      if (favBps > pos.mfeBps) pos.mfeBps = favBps;
      if (pos.leg === "options") {
        const holdMin = (clock.now() - pos.openedAt) / 60_000;
        if (holdMin >= risk.optionTimeStopMin && unrealized(pos, q) <= 0) {
          await this.exitPosition(pos, "time");
          continue;
        }
        const targetHit = pos.side === "long" ? ltp >= pos.target : ltp <= pos.target;
        if (targetHit) {
          await this.exitPosition(pos, "target");
          continue;
        }
      }
      const resting = this.stopOrderFor(pos);
      if (!resting) continue;
      if (resting.qty - resting.filledQty !== pos.qty - pos.closedQty && clock.now() - resting.lastModifyAt >= CHASE_MS) {
        await this.syncStopQty(pos);
        if (this.stopOrderFor(pos) !== resting) continue;
      }
      if (breached || resting.triggeredAt !== null) {
        if (!pos.stopBreachAt) pos.stopBreachAt = resting.triggeredAt ?? clock.now();
        if (clock.now() - pos.stopBreachAt >= risk.stopUnfilledMs) {
          void alert("stop_unfilled", `${pos.symbol} stop ${pos.stop} breached ${((clock.now() - pos.stopBreachAt) / 1000).toFixed(1)}s ago and unfilled (ltp ${ltp}); replacing with a marketable exit`);
          await this.exitPosition(pos, "stop");
        }
      } else {
        pos.stopBreachAt = 0;
      }
    }
  }

  /** Re-quote a passive entry when the touch moves, at most MAX_REQUOTES times, then cancel. */
  private async manageEntries(): Promise<void> {
    if (this.killed || this.halted) return;
    for (const o of [...this.exec.orders.values()]) {
      if (o.kind !== "entry" || !o.confirmed) continue;
      if (this.wild) continue;
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
    const qty = Math.min(pos.closedQty, pos.qty);
    const exitPx = pos.exitNotional / Math.max(1, pos.closedQty);
    const signed = pos.side === "long" ? 1 : -1;
    const gross = (exitPx - pos.entryPrice) * qty * signed;
    const entryCost = fillCost(pos.leg, pos.side === "long" ? "buy" : "sell", qty, pos.entryPrice);
    const pnl = gross - entryCost - pos.exitCost;
    const friction = entryCost + pos.exitCost;
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
        qty,
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
    insertEvent("trade", `${pos.symbol} ${pos.side} ${qty} ${reason} pnl ${pnl.toFixed(0)}`);
    if (pos.leg === "options") this.optionCooldownUntil = clock.now() + 10 * 60_000;
    const stopOrd = this.stopOrderFor(pos);
    if (stopOrd) await this.exec.cancel(stopOrd).catch(() => undefined);
    if (!this.replay) void this.attribute(pos, reason, Number(info.lastInsertRowid));
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
    if (existsSync(cfg.killPath)) this.tripKill();
  }

  private tripKill(): void {
    if (this.killed) return;
    this.killed = true;
    void alert("kill", "kill switch: cancelling entries and flattening every position until flat");
    this.endSession("kill");
  }

  kill(): void {
    try {
      writeFileSync(cfg.killPath, "1");
    } catch (e) {
      void alert("kill", `could not write ${cfg.killPath} (${e}); kill is held in memory only and will not survive a restart`);
    }
    this.tripKill();
  }

  unkill(): void {
    if (existsSync(cfg.killPath)) unlinkSync(cfg.killPath);
    this.killed = false;
    insertEvent("kill", "kill switch cleared");
    this.beginSession("resume");
  }

  /** Sessions: one row per RESUME → KILL / halt / 15:10 flatten / shutdown span. */
  private beginSession(note: string): void {
    if (this.sessionId !== null || this.replay || !this.client.session) return;
    this.sessionId = openSession(`${note} · ${this.wild ? "WILD" : "2-stage"} · ${this.model.name} · cap ${getCapital()} · qty ${cfg.liveQty || "auto"}`);
    insertEvent("session", `#${this.sessionId} started (${note})`);
  }

  private endSession(reason: string): void {
    if (this.sessionId === null) return;
    refreshSession(this.sessionId, this.regime, reason);
    insertEvent("session", `#${this.sessionId} ended (${reason})`);
    this.sessionId = null;
  }

  setJevPaused(on: boolean): void {
    this.jevPaused = on;
    this.lastSkipReason = on ? "jev paused" : "";
    insertEvent("mode", on ? "Jev paused: no new decisions; stops and flatten still active" : "Jev resumed");
  }

  setWildMode(on: boolean): void {
    this.wild = on;
    setWild(on);
    this.rebuildUniverse();
  }

  /** Called from main on SIGINT/SIGTERM so the open session is closed with a reason. */
  shutdown(): void {
    this.endSession("shutdown");
  }

  /** Fatal path: trip the kill switch and keep ticking (which flattens) until flat or out of time. */
  async emergencyFlatten(timeoutMs: number, pollMs = 2000): Promise<boolean> {
    this.kill();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await this.tick();
      } catch (e) {
        console.error("emergency tick", e);
      }
      if (!this.positions.size) return true;
      await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
    }
    return !this.positions.size;
  }

  private updateBrokerRealised(bp: BrokerPosition[]): void {
    // Only intraday rows: a CNC/NRML sale elsewhere in the account is not this engine's loss.
    const rows = bp.filter((p) => /MIS/i.test(p.product) && typeof p.realisedPnl === "number" && Number.isFinite(p.realisedPnl));
    if (rows.length) this.brokerRealised = rows.reduce((s, p) => s + (p.realisedPnl ?? 0), 0);
  }

  /** Track a broker position locally, reusing the DB row (entry, stop, tier) from before a restart when it matches. */
  private adoptPosition(p: BrokerPosition, row?: PositionRow): OpenPosition | null {
    const side: PositionSide = p.qty > 0 ? "long" : "short";
    const qty = Math.abs(p.qty);
    const q = this.quotes.get(p.symbol);
    const px = p.avgPrice || q?.ltp || 0;
    if (!px) {
      void alert("reconcile", `cannot adopt ${p.symbol} ${p.qty}: no average price or quote`);
      return null;
    }
    const tick = q?.tickSize ?? this.client.getInstrument(p.symbol)?.tickSize ?? 0.05;
    const leg = p.segment.includes("fo") ? "options" : "equity";
    const reuse = row && row.side === side;
    const sb = reuse && row.stop_bps ? row.stop_bps : ADOPT_STOP_BPS;
    const pos = this.createPosition({
      leg,
      symbol: p.symbol,
      token: p.token,
      segment: p.segment,
      side,
      qty,
      entry: reuse ? row.entry : px,
      stop: reuse ? row.stop : stopPrice(side, px, sb, tick),
      target: reuse ? row.target : targetPrice(side, px, sb, tick),
      decisionId: reuse ? row.decision_id : null,
      tier: reuse && (row.tier === "A" || row.tier === "B") ? row.tier : "B",
      stopBps: sb,
      entryOrderId: null,
      openedAt: reuse ? row.opened_at : undefined,
      existingId: reuse ? row.id : undefined,
    });
    insertEvent("reconcile", `adopted ${p.symbol} ${side} ${qty} @${pos.entryPrice} stop ${pos.stop}${reuse ? " (restored)" : ""}`);
    return pos;
  }

  /** Adopt a resting engine stop at the broker for `pos`, fixing its quantity if needed. */
  private async adoptRestingStop(pos: OpenPosition, ords: BrokerOrder[]): Promise<boolean> {
    const stopSide: Side = pos.side === "long" ? "sell" : "buy";
    const tracked = new Set([...this.exec.orders.values()].map((o) => o.brokerId));
    const r = ords.find((o) => o.symbol === pos.symbol && o.side === stopSide && isStopTag(o.tag) && !isTerminalStatus(o.status) && !tracked.has(o.orderId));
    if (!r) return false;
    const tick = this.quotes.get(pos.symbol)?.tickSize ?? 0.05;
    const trigger = r.trigger || pos.stop;
    const order = this.exec.adopt(
      {
        symbol: pos.symbol,
        token: pos.token,
        segment: pos.segment,
        tradingSymbol: this.client.getInstrument(pos.symbol)?.tradingSymbol ?? pos.symbol,
        side: stopSide,
        qty: r.qty,
        price: r.price || stopLimitPrice(pos.side, trigger, tick),
        trigger,
        orderType: "SL-L",
        kind: "stop",
        tag: r.tag,
        decisionId: pos.decisionId,
        leg: pos.leg,
        tier: pos.tier,
        reason: "stop",
      },
      r.orderId,
      r.filledQty,
    );
    if (/^open$/i.test(r.status.trim())) order.triggeredAt = clock.now();
    pos.stop = trigger;
    pos.stopOrderId = String(order.id);
    db.prepare("UPDATE positions SET stop_order_id=?, stop=? WHERE id=?").run(pos.stopOrderId, pos.stop, pos.id);
    await this.syncStopQty(pos);
    return true;
  }

  /** Startup: adopt live broker positions (restoring stops), close stale DB rows, cancel stale engine orders. */
  async reconcile(): Promise<void> {
    try {
      const bp = await this.client.positions();
      const ords = await this.client.orders();
      this.updateBrokerRealised(bp);
      const mis = bp.filter((p) => p.qty !== 0 && p.product.toUpperCase().includes("MIS"));
      if (mis.length) {
        const qs = await this.client.quotes(mis.map((p) => ({ token: p.token, segment: p.segment })));
        const bySym = new Map(mis.map((p) => [`${p.segment}:${p.token}`, p.symbol]));
        for (const q of qs) this.quotes.set(bySym.get(`${q.segment}:${q.token}`) ?? q.symbol ?? q.token, q);
      }
      const rows = openPositionRows();
      const adoptedIds: number[] = [];
      const adoptedStops = new Set<string>();
      for (const p of mis) {
        const pos = this.adoptPosition(p, rows.find((r) => r.symbol === p.symbol));
        if (!pos) continue;
        adoptedIds.push(pos.id);
        const hadStop = await this.adoptRestingStop(pos, ords);
        if (hadStop) {
          const o = this.stopOrderFor(pos);
          if (o?.brokerId) adoptedStops.add(o.brokerId);
        }
        if (cfg.onRestart === "flatten") {
          await this.exitPosition(pos, "restart");
          insertEvent("reconcile", `flattening ${p.symbol} ${p.qty} (ON_RESTART=flatten)`);
        } else if (!hadStop) {
          await this.placeStop(pos);
        }
      }
      const stale = closeStalePositions(adoptedIds);
      if (stale) insertEvent("reconcile", `closed ${stale} stale DB position row(s) the broker no longer holds`);
      const manual: string[] = [];
      for (const o of ords) {
        if (isTerminalStatus(o.status) || adoptedStops.has(o.orderId)) continue;
        if (this.exec.orders.size && [...this.exec.orders.values()].some((w) => w.brokerId === o.orderId)) continue;
        if (!isEngineTag(o.tag)) {
          manual.push(`${o.symbol} ${o.side} ${o.qty} #${o.orderId}`);
          continue;
        }
        await this.client.cancel(o.orderId).catch((e) => insertEvent("reconcile", `cancel ${o.orderId} failed ${e}`));
        insertEvent("reconcile", `cancelled stale engine order ${o.orderId} ${o.symbol} ${o.tag}`);
      }
      if (manual.length) void alert("reconcile", `left ${manual.length} non-engine open order(s) alone: ${manual.join(", ")}`);
    } catch (e) {
      void alert("session", `reconcile failed ${e}`);
    }
  }

  /**
   * Every RECONCILE_MS: broker positions and order book vs local state. A disagreement seen twice in a row
   * (and not explained by an order in flight) is repaired toward the broker, which is the truth.
   */
  private async periodicReconcile(): Promise<void> {
    if (this.replay || this.seeking || this.reconciling || clock.now() - this.lastReconcile < RECONCILE_MS) return;
    this.lastReconcile = clock.now();
    this.reconciling = true;
    try {
      const bp = await this.client.positions();
      const ords = await this.client.orders();
      await this.fillQueue;
      this.updateBrokerRealised(bp);
      const net = new Map<string, BrokerPosition>();
      for (const p of bp) if (p.qty !== 0 && p.product.toUpperCase().includes("MIS")) net.set(p.symbol, p);
      const inFlight = (sym: string) =>
        [...this.exec.orders.values()].some((o) => o.symbol === sym && (!o.confirmed || o.filledQty > 0 || clock.now() - o.lastModifyAt < 5_000 || (o.kind !== "stop" && o.kind !== "entry")));
      for (const sym of new Set([...this.positions.keys(), ...net.keys()])) {
        const pos = this.positions.get(sym);
        const b = net.get(sym);
        const localQty = pos ? (pos.side === "long" ? 1 : -1) * (pos.qty - pos.closedQty) : 0;
        const brokerQty = b?.qty ?? 0;
        if (localQty === brokerQty || inFlight(sym)) {
          this.mismatches.delete(sym);
          continue;
        }
        if (this.mismatches.get(sym) !== brokerQty) {
          this.mismatches.set(sym, brokerQty);
          continue;
        }
        this.mismatches.delete(sym);
        await this.repair(sym, pos, b, localQty, brokerQty, ords);
      }
      this.cancelOrphans(ords);
    } catch (e) {
      insertEvent("reconcile_err", String(e));
    } finally {
      this.reconciling = false;
    }
  }

  private async repair(sym: string, pos: OpenPosition | undefined, b: BrokerPosition | undefined, localQty: number, brokerQty: number, ords: BrokerOrder[]): Promise<void> {
    void alert("reconcile", `${sym}: local ${localQty}, broker ${brokerQty}; repairing toward the broker`);
    const sameSide = pos && brokerQty !== 0 && Math.sign(brokerQty) === Math.sign(localQty);
    if (pos && sameSide) {
      pos.qty = pos.closedQty + Math.abs(brokerQty);
      db.prepare("UPDATE positions SET qty=? WHERE id=?").run(pos.qty, pos.id);
      await this.syncStopQty(pos);
      return;
    }
    if (pos) {
      // Closed (or flipped) outside our view: book the remainder at the last price and drop our stop.
      const q = this.quotes.get(sym);
      const px = q?.ltp || pos.entryPrice;
      const remaining = pos.qty - pos.closedQty;
      pos.closedQty += remaining;
      pos.exitNotional += remaining * px;
      pos.exitCost += fillCost(pos.leg, pos.side === "long" ? "sell" : "buy", remaining, px);
      pos.exitReason = pos.exitReason ?? "reconcile";
      await this.closeTrade(pos);
    }
    if (b) {
      const adopted = this.adoptPosition(b);
      if (!adopted) return;
      // Our long became a broker short (or vice versa): an overfill, never a decision. Take it off, don't manage it.
      if (pos) {
        void alert("reconcile", `${sym} flipped to ${brokerQty} at the broker; flattening the excess`);
        await this.exitPosition(adopted, "reconcile");
        return;
      }
      const forced = this.killed || this.halted || minutesOfDay() >= FLATTEN_MIN;
      if (!(await this.adoptRestingStop(adopted, ords)) && !forced) await this.placeStop(adopted);
    }
  }

  /** Engine-tagged orders open at the broker that nothing tracks (e.g. an ambiguous place given up on): cancel on the second sighting. */
  private cancelOrphans(ords: BrokerOrder[]): void {
    // An unconfirmed order on a symbol may be any of that symbol's untracked rows; leave the symbol until it resolves.
    const pendingSymbols = new Set([...this.exec.orders.values()].filter((o) => !o.confirmed).map((o) => o.symbol));
    const tracked = new Set([...this.exec.orders.values()].map((o) => o.brokerId));
    const seen = new Set<string>();
    for (const o of ords) {
      if (isTerminalStatus(o.status) || tracked.has(o.orderId) || !isEngineTag(o.tag) || pendingSymbols.has(o.symbol)) continue;
      seen.add(o.orderId);
      const strikes = (this.orphanStrikes.get(o.orderId) ?? 0) + 1;
      this.orphanStrikes.set(o.orderId, strikes);
      if (strikes < 2) continue;
      this.orphanStrikes.delete(o.orderId);
      void this.client
        .cancel(o.orderId)
        .then(() => alert("reconcile", `cancelled untracked engine order #${o.orderId} ${o.symbol} ${o.side} ${o.qty} (${o.tag})`))
        .catch((e) => insertEvent("reconcile_err", `cancel orphan ${o.orderId} ${e}`));
    }
    for (const id of [...this.orphanStrikes.keys()]) if (!seen.has(id)) this.orphanStrikes.delete(id);
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
      broker: cfg.broker,
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
      sessionId: this.sessionId,
      wild: this.wild,
      jevPaused: this.jevPaused,
      universeSize: this.universe.length,
      quotesLive: this.quotes.size,
      capital,
      usedNotional: used,
      freeCapital: Math.max(0, capital - used),
      openUnrealized: this.openUnrealized(),
      dayPnl: this.dayPnl(),
      brokerRealised: this.brokerRealised,
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
        confirmed: o.confirmed,
        marketable: o.marketable,
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
          hasStop: this.stopOrderFor(p) !== undefined,
        };
      }),
      candidates: this.lastCandidates,
      taken: this.taken,
    };
  }
}

function fmtMin(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
