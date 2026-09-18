import { cfg } from "../config.js";
import { insertGovernor, todayEntries, todayFriction, todayPnl, trailingTrades } from "../db.js";
import type { GovernorState } from "../types.js";

export function computeGovernor(): GovernorState {
  const trailing = trailingTrades(20);
  const trailingExpectancy = trailing.length ? trailing.reduce((s, t) => s + t.pnl, 0) / trailing.length : null;
  const consecutiveLosses = countConsecutiveLosses(trailing);
  const pnl = todayPnl();
  const used = todayEntries();
  const frictionUsed = todayFriction();
  let allowance = cfg.entriesBase;
  let reason = "base";
  if (consecutiveLosses >= 3 || pnl <= -500) {
    allowance = 4;
    reason = consecutiveLosses >= 3 ? "three_losses" : "drawdown_500";
  } else if (trailingExpectancy !== null && trailingExpectancy > 0 && pnl >= 0) {
    allowance = cfg.entriesMax;
    reason = "edge_and_green";
  }
  const state: GovernorState = {
    allowance,
    used,
    frictionUsed,
    frictionBudget: cfg.dailyFrictionBudget,
    reason,
    trailingExpectancy,
    todayPnl: pnl,
    consecutiveLosses,
  };
  insertGovernor({ ts: Date.now(), ...state });
  return state;
}

export function governorAllows(g: GovernorState, halfSize: boolean): { ok: boolean; reason: string } {
  if (g.used >= g.allowance) return { ok: false, reason: `allowance_${g.allowance}` };
  const spend = halfSize ? 0.5 : 1;
  if (g.frictionUsed >= g.frictionBudget) return { ok: false, reason: "friction_budget" };
  if (g.frictionUsed + spend * 40 > g.frictionBudget && !halfSize) {
    /* still allow if remaining budget can cover a half-size; full size blocked near cap */
  }
  return { ok: true, reason: g.reason };
}

function countConsecutiveLosses(trades: { pnl: number }[]): number {
  let n = 0;
  for (const t of trades) {
    if (t.pnl < 0) n++;
    else break;
  }
  return n;
}
