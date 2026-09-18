import { insertGovernor, todayEntries, todayFriction, todayPnl, trailingTrades } from "../db.js";
import type { GovernorState } from "../types.js";
import { clock } from "../time.js";

const UNLIMITED = -1;

export function computeGovernor(): GovernorState {
  const trailing = trailingTrades(20);
  const trailingExpectancy = trailing.length ? trailing.reduce((s, t) => s + t.pnl, 0) / trailing.length : null;
  const consecutiveLosses = countConsecutiveLosses(trailing);
  const pnl = todayPnl();
  const used = todayEntries();
  const frictionUsed = todayFriction();
  let allowance = UNLIMITED;
  let reason = "green_uncapped";
  if (pnl < 0) {
    if (consecutiveLosses >= 3 || pnl <= -500) {
      allowance = 4;
      reason = consecutiveLosses >= 3 ? "three_losses" : "drawdown_500";
    } else {
      allowance = UNLIMITED;
      reason = "red_still_open";
    }
  }
  const state: GovernorState = {
    allowance,
    used,
    frictionUsed,
    frictionBudget: pnl >= 0 ? UNLIMITED : frictionUsed,
    reason,
    trailingExpectancy,
    todayPnl: pnl,
    consecutiveLosses,
  };
  insertGovernor({ ts: clock.now(), ...state });
  return state;
}

export function governorAllows(g: GovernorState): { ok: boolean; reason: string } {
  if (g.todayPnl >= 0) return { ok: true, reason: g.reason };
  if (g.allowance >= 0 && g.used >= g.allowance) return { ok: false, reason: `allowance_${g.allowance}` };
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
