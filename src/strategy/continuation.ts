import { risk } from "../config.js";
import { insertRanking } from "../db.js";
import { stage2State } from "../data/features.js";
import type { EvalResult, Model } from "../model/index.js";
import { stage1Questions, stage1State, stage2Questions, stage2QuestionsCandles } from "../model/questions.js";
import type { IndexFeatures, Regime, Setup, SymbolFeatures, Tier } from "../types.js";
import { clock } from "../time.js";

export interface Ranked {
  symbol: string;
  side: "long" | "short";
  p: number;
}

export interface Stage1Out {
  ok: boolean;
  regime: Regime;
  riskOff: number;
  niftyLong: number;
  niftyShort: number;
  longs: Ranked[];
  shorts: Ranked[];
  /** Highest long/short probability Jev gave any name, before the threshold. Shown on the dashboard when nothing qualifies. */
  bestP: number;
}

export interface Candidate {
  symbol: string;
  side: "long" | "short";
  setup: Setup;
  setupProb: number;
  setupConf: number;
  entryScore: number;
  scores: Record<string, number>;
  oneSided: number;
  tier: Tier;
  /** All live entry gates passed. Calibration studies every candidate; the engine only trades passing ones. */
  passes: boolean;
  reject: string;
}

export interface StageOpts {
  /** Bars only (calibration, replay): drop book/flow questions and gates. */
  candlesOnly?: boolean;
}

export async function runStage1(
  model: Model,
  feats: SymbolFeatures[],
  index: IndexFeatures | null,
  opts: StageOpts = {},
): Promise<Stage1Out | null> {
  const candles = opts.candlesOnly ?? false;
  const state = stage1State(feats, index, candles);
  const r = await model.evaluate(state, stage1Questions(feats.length, candles), "stage1", null);
  if (!r.ok) return null;
  const longs: Ranked[] = [];
  const shorts: Ranked[] = [];
  let bestP = 0;
  for (let i = 0; i < feats.length; i++) {
    const lp = r.answers[`long_${i}`]?.noul ?? 0;
    const sp = r.answers[`short_${i}`]?.noul ?? 0;
    bestP = Math.max(bestP, lp, sp);
    if (lp >= risk.stage1MinProb) longs.push({ symbol: feats[i].symbol, side: "long", p: lp });
    if (sp >= risk.stage1MinProb) shorts.push({ symbol: feats[i].symbol, side: "short", p: sp });
  }
  longs.sort((a, b) => b.p - a.p);
  shorts.sort((a, b) => b.p - a.p);
  const regime = (r.answers.regime?.choice as Regime) || "range";
  const topL = longs.slice(0, 3);
  const topS = shorts.slice(0, 3);
  insertRanking(clock.now(), "long", topL);
  insertRanking(clock.now(), "short", topS);
  insertRanking(clock.now(), "regime", { regime, riskOff: r.answers.risk_off?.noul });
  let keepL = topL;
  let keepS = topS;
  if (regime === "trend_up") keepS = [];
  if (regime === "trend_down") keepL = [];
  return {
    ok: true,
    regime,
    riskOff: r.answers.risk_off?.noul ?? 0,
    niftyLong: r.answers.nifty_long?.noul ?? 0,
    niftyShort: r.answers.nifty_short?.noul ?? 0,
    longs: keepL,
    shorts: keepS,
    bestP,
  };
}

/** Returns null only if Jev failed. Otherwise a Candidate with `passes` telling whether the live gates held. */
export async function runStage2(
  model: Model,
  feat: SymbolFeatures,
  index: IndexFeatures | null,
  wanted: "long" | "short",
  opts: StageOpts = {},
): Promise<Candidate | null> {
  const candles = opts.candlesOnly ?? false;
  const questions = candles ? stage2QuestionsCandles : stage2Questions;
  const r = await model.evaluate(stage2State(feat, index, null, candles), questions, "stage2", feat.symbol);
  if (!r.ok) return null;
  const setup = (r.answers.setup?.choice as Setup) || "chop";
  const setupProb = r.answers.setup?.probabilities?.[setup] ?? 0;
  const setupConf = r.answers.setup?.confidence ?? 0;
  const scores: Record<string, number> = {
    trend_quality: normScore(r, "trend_quality", 2),
    index_alignment: normScore(r, "index_alignment", 2),
    liquidity: normScore(r, "liquidity", 2),
  };
  if (!candles) scores.flow_alignment = normScore(r, "flow_alignment", 2);
  const w: Record<string, number> = { ...risk.weights };
  let wsum = 0;
  let entryScore = 0;
  for (const [k, v] of Object.entries(scores)) {
    entryScore += (w[k] ?? 0) * v;
    wsum += w[k] ?? 0;
  }
  entryScore = wsum > 0 ? entryScore / wsum : 0;
  const oneSided = candles ? 1 : (r.answers.one_sided?.noul ?? 0);

  let reject = "";
  const match = (wanted === "long" && setup === "long_continuation") || (wanted === "short" && setup === "short_continuation");
  if (!match) reject = `setup=${setup}`;
  else if (setupProb < risk.minSetupProb) reject = `setup_p ${setupProb.toFixed(2)}`;
  else if (setupConf < risk.minSetupConfidence) reject = `setup_conf ${setupConf.toFixed(2)}`;
  else if (entryScore < risk.minEntryScore) reject = `composite ${entryScore.toFixed(2)}`;
  else if (Object.values(scores).some((x) => x < risk.minSingleScore)) reject = "a score < 0.33";
  else if (oneSided < risk.minOneSided) reject = `one_sided ${oneSided.toFixed(2)}`;

  const tier: Tier = setupProb >= risk.tierASetup && entryScore >= risk.tierAScore ? "A" : "B";
  return { symbol: feat.symbol, side: wanted, setup, setupProb, setupConf, entryScore, scores, oneSided, tier, passes: !reject, reject };
}

export function pickBest(cands: Candidate[]): Candidate | null {
  const ok = cands.filter((c) => c.passes);
  if (!ok.length) return null;
  return [...ok].sort((a, b) => b.entryScore - a.entryScore)[0] ?? null;
}

function normScore(r: EvalResult, key: string, max: number): number {
  const s = r.answers[key]?.score;
  if (s === undefined || Number.isNaN(s)) return 0;
  return Math.max(0, Math.min(1, s / max));
}
