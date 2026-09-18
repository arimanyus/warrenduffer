import { risk } from "../config.js";
import { stage2State } from "../data/features.js";
import type { Model } from "../model/index.js";
import { positionQuestions } from "../model/questions.js";
import type { IndexFeatures, OpenPosition, SymbolFeatures } from "../types.js";
import { clock } from "../time.js";

export type ExitAction = "exit" | "breakeven" | "take_profit" | "hold";

export interface ExitDecision {
  action: ExitAction;
  reason: string;
  thesis: number;
  exitNow: number;
  extended: number;
  takeProfit: number;
}

export async function managePosition(
  model: Model,
  pos: OpenPosition,
  feat: SymbolFeatures,
  index: IndexFeatures | null,
  unrealised: number,
): Promise<ExitDecision> {
  const holdMin = (clock.now() - pos.openedAt) / 60_000;
  if (holdMin >= risk.timeStopMin && unrealised <= 0) {
    return { action: "exit", reason: "time", thesis: pos.thesis ?? 2, exitNow: 0, extended: 0, takeProfit: 0 };
  }

  const signed = pos.side === "long" ? 1 : -1;
  const pnlBps = ((feat.last - pos.entryPrice) / pos.entryPrice) * 1e4 * signed;
  const stopBpsAway = ((feat.last - pos.stop) / feat.last) * 1e4 * signed;
  const state = stage2State(feat, index, {
    side: pos.side,
    entry: pos.entryPrice,
    stop: pos.stop,
    unrealisedBps: Math.round(pnlBps),
    unrealisedR: Math.round((pnlBps / Math.max(1, pos.stopBps)) * 100) / 100,
    maxFavourableBps: Math.round(pos.mfeBps),
    givebackFromPeakBps: Math.round(pos.mfeBps - pnlBps),
    stopDistanceBps: Math.round(stopBpsAway),
    minutesHeld: Math.round(holdMin),
    stopAtBreakeven: pos.stop === pos.entryPrice,
  });
  const r = await model.evaluate(state, positionQuestions, "position", pos.symbol);
  if (!r.ok) return { action: "hold", reason: "jev_fail", thesis: pos.thesis ?? 2, exitNow: 0, extended: 0, takeProfit: 0 };

  const thesis = r.answers.thesis?.score ?? 2;
  const exitNow = r.answers.exit_now?.noul ?? 0;
  const extended = r.answers.extended?.score ?? 0;
  const takeProfit = r.answers.take_profit?.noul ?? 0;
  const stopDist = Math.abs(pos.entryPrice - pos.stop);

  if (thesis < risk.thesisBroken || exitNow >= risk.exitNow) {
    return {
      action: "exit",
      reason: thesis < risk.thesisBroken ? "thesis_break" : "exit_now",
      thesis,
      exitNow,
      extended,
      takeProfit,
    };
  }
  if (takeProfit >= risk.takeProfit) {
    return { action: "take_profit", reason: "jev_take_profit", thesis, exitNow, extended, takeProfit };
  }
  if (thesis < risk.thesisWeak && unrealised >= 0.5 * stopDist * pos.qty) {
    return { action: "breakeven", reason: "weaken_be", thesis, exitNow, extended, takeProfit };
  }
  return { action: "hold", reason: "intact", thesis, exitNow, extended, takeProfit };
}
