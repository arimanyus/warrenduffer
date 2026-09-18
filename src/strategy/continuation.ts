import { risk } from "../config.js";
import { insertRanking } from "../db.js";
import { stage2State } from "../data/features.js";
import type { EvalResult, Model } from "../model/index.js";
import { stage1Questions, stage1State, stage2Questions } from "../model/questions.js";
import type { IndexFeatures, Regime, Setup, SymbolFeatures, Tier } from "../types.js";

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
}

export async function runStage1(
  model: Model,
  feats: SymbolFeatures[],
  index: IndexFeatures | null,
): Promise<Stage1Out | null> {
  const state = stage1State(feats, index);
  const r = await model.evaluate(state, stage1Questions(feats.length), "stage1", null);
  if (!r.ok) return null;
  const longs: Ranked[] = [];
  const shorts: Ranked[] = [];
  for (let i = 0; i < feats.length; i++) {
    const lp = r.answers[`long_${i}`]?.noul ?? 0;
    const sp = r.answers[`short_${i}`]?.noul ?? 0;
    if (lp >= risk.stage1MinProb) longs.push({ symbol: feats[i].symbol, side: "long", p: lp });
    if (sp >= risk.stage1MinProb) shorts.push({ symbol: feats[i].symbol, side: "short", p: sp });
  }
  longs.sort((a, b) => b.p - a.p);
  shorts.sort((a, b) => b.p - a.p);
  const regime = (r.answers.regime?.choice as Regime) || "range";
  const topL = longs.slice(0, 3);
  const topS = shorts.slice(0, 3);
  insertRanking(Date.now(), "long", topL);
  insertRanking(Date.now(), "short", topS);
  insertRanking(Date.now(), "regime", { regime, riskOff: r.answers.risk_off?.noul });
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
  };
}

export async function runStage2(
  model: Model,
  feat: SymbolFeatures,
  index: IndexFeatures | null,
  wanted: "long" | "short",
): Promise<Candidate | null> {
  const r = await model.evaluate(stage2State(feat, index, null), stage2Questions, "stage2", feat.symbol);
  if (!r.ok) return null;
  const setup = (r.answers.setup?.choice as Setup) || "chop";
  const setupProb = r.answers.setup?.probabilities?.[setup] ?? 0;
  const setupConf = r.answers.setup?.confidence ?? 0;
  const scores = {
    trend_quality: normScore(r, "trend_quality", 2),
    flow_alignment: normScore(r, "flow_alignment", 2),
    index_alignment: normScore(r, "index_alignment", 2),
    liquidity: normScore(r, "liquidity", 2),
  };
  const entryScore =
    risk.weights.trend_quality * scores.trend_quality +
    risk.weights.flow_alignment * scores.flow_alignment +
    risk.weights.index_alignment * scores.index_alignment +
    risk.weights.liquidity * scores.liquidity;
  const match =
    (wanted === "long" && setup === "long_continuation") ||
    (wanted === "short" && setup === "short_continuation");
  if (!match) return null;
  if (setupProb < risk.minSetupProb || setupConf < risk.minSetupConfidence) return null;
  if (entryScore < risk.minEntryScore) return null;
  if (Object.values(scores).some((x) => x < risk.minSingleScore)) return null;
  const oneSided = r.answers.one_sided?.noul ?? 0;
  if (oneSided < risk.minOneSided) return null;
  const tier: Tier = setupProb >= risk.tierASetup && entryScore >= risk.tierAScore ? "A" : "B";
  return { symbol: feat.symbol, side: wanted, setup, setupProb, setupConf, entryScore, scores, oneSided, tier };
}

export function pickBest(cands: Candidate[]): Candidate | null {
  if (!cands.length) return null;
  return [...cands].sort((a, b) => b.entryScore - a.entryScore)[0] ?? null;
}

function normScore(r: EvalResult, key: string, max: number): number {
  const s = r.answers[key]?.score;
  if (s === undefined || Number.isNaN(s)) return 0;
  return Math.max(0, Math.min(1, s / max));
}
