import type { Leg, Side } from "./types.js";

/** Statutory + estimated execution costs. Verified against contract notes in 1-share live. */
export const EQUITY = {
  sttSellBps: 2.5,
  exchangeBps: 0.297,
  stampBuyBps: 0.3,
  sebiBps: 0.01,
  gstOnCharges: 0.18,
  slippageBps: 1.5,
};

export const OPTIONS = {
  sttSellPct: 0.001,
  exchangePct: 0.00035,
  stampPct: 0.00003,
  sebiPct: 0.000001,
  gstOnCharges: 0.18,
  spreadPct: 0.005,
};

export function equityRoundTripBps(): number {
  const charges = EQUITY.exchangeBps * 2 + EQUITY.sebiBps * 2;
  const gst = charges * EQUITY.gstOnCharges;
  return EQUITY.sttSellBps + EQUITY.stampBuyBps + charges + gst + EQUITY.slippageBps;
}

export function equityFillCost(side: Side, qty: number, price: number): number {
  const notional = qty * price;
  const exchange = (notional * EQUITY.exchangeBps) / 1e4;
  const sebi = (notional * EQUITY.sebiBps) / 1e4;
  const stamp = side === "buy" ? (notional * EQUITY.stampBuyBps) / 1e4 : 0;
  const stt = side === "sell" ? (notional * EQUITY.sttSellBps) / 1e4 : 0;
  const gst = (exchange + sebi) * EQUITY.gstOnCharges;
  return stt + stamp + exchange + sebi + gst;
}

export function optionsFillCost(side: Side, qty: number, price: number): number {
  const notional = qty * price;
  const exchange = notional * OPTIONS.exchangePct;
  const sebi = notional * OPTIONS.sebiPct;
  const stamp = side === "buy" ? notional * OPTIONS.stampPct : 0;
  const stt = side === "sell" ? notional * OPTIONS.sttSellPct : 0;
  const gst = (exchange + sebi) * OPTIONS.gstOnCharges;
  return stt + stamp + exchange + sebi + gst;
}

export function fillCost(leg: Leg, side: Side, qty: number, price: number): number {
  return leg === "equity" ? equityFillCost(side, qty, price) : optionsFillCost(side, qty, price);
}

export function estimateEntryFriction(leg: Leg, qty: number, price: number): number {
  if (leg === "equity") return (qty * price * equityRoundTripBps()) / 1e4;
  return qty * price * (OPTIONS.sttSellPct + OPTIONS.exchangePct * 2 + OPTIONS.spreadPct + OPTIONS.stampPct);
}
