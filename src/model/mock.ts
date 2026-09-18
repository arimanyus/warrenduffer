import { insertDecision } from "../db.js";
import type { EvalResult, Model } from "./jev.js";
import type { Question } from "./questions.js";
import { clock } from "../time.js";

export class MockModel implements Model {
  name = "mock";

  async evaluate(
    state: unknown,
    questions: Record<string, Question>,
    stage: string,
    symbol: string | null = null,
  ): Promise<EvalResult> {
    const t0 = Date.now();
    await sleep(40);
    const answers: EvalResult["answers"] = {};
    const s = state as Record<string, unknown>;
    for (const [k, q] of Object.entries(questions)) {
      if (q.type === "noul") {
        const noul = noulFrom(k, s);
        answers[k] = { type: "noul", noul };
      } else if (q.type === "choice") {
        const keys = Object.keys(q.criteria);
        const choice = choiceFrom(k, keys, s);
        const probabilities = Object.fromEntries(keys.map((c) => [c, c === choice ? 0.62 : 0.38 / Math.max(1, keys.length - 1)]));
        answers[k] = { type: "choice", choice, probabilities, confidence: 0.55 };
      } else {
        const score = scoreFrom(k, q.criteria.length, s);
        answers[k] = { type: "score", score, confidence: 0.5 };
      }
    }
    const latencyMs = Date.now() - t0;
    for (const [qk, a] of Object.entries(answers)) {
      insertDecision({
        ts: clock.now(),
        stage,
        symbol,
        question: qk,
        answer: a.choice ?? String(a.score ?? a.noul ?? ""),
        probability: a.noul ?? (a.choice && a.probabilities ? a.probabilities[a.choice] : null) ?? null,
        confidence: a.confidence ?? null,
        latencyMs,
        tokens: 0,
        modelId: "mock",
      });
    }
    return { answers, latencyMs, tokens: 0, modelId: "mock", ok: true };
  }
}

function noulFrom(k: string, s: Record<string, unknown>): number {
  if (k.startsWith("long_")) {
    const i = Number(k.slice(5));
    const sym = Array.isArray(s.symbols) ? (s.symbols[i] as Record<string, string>) : undefined;
    return sym?.m15 === "up" && (sym.vwapDist === "above" || sym.vwapDist === "near") ? 0.68 : 0.35;
  }
  if (k.startsWith("short_")) {
    const i = Number(k.slice(6));
    const sym = Array.isArray(s.symbols) ? (s.symbols[i] as Record<string, string>) : undefined;
    return sym?.m15 === "down" && (sym.vwapDist === "below" || sym.vwapDist === "near") ? 0.68 : 0.35;
  }
  if (k === "nifty_long") return label(s, "m15") === "up" ? 0.64 : 0.3;
  if (k === "nifty_short") return label(s, "m15") === "down" ? 0.64 : 0.3;
  if (k === "risk_off") return label(s, "m5") === "down" && Number((s.index as { breadthAboveVwap?: number })?.breadthAboveVwap ?? 1) < 0.3 ? 0.72 : 0.2;
  if (k === "one_sided") return 0.62;
  if (k === "exit_now") return 0.2;
  if (k === "take_profit") return 0.2;
  if (k === "event_today") return 0.15;
  if (k === "risk_event_today") return 0.1;
  return 0.45;
}

function choiceFrom(k: string, keys: string[], s: Record<string, unknown>): string {
  if (k === "regime") {
    const m15 = label(s, "m15");
    if (m15 === "up") return "trend_up";
    if (m15 === "down") return "trend_down";
    return "range";
  }
  if (k === "setup") {
    const ret = (s.returnsBps as { labels?: { m15?: string } } | undefined)?.labels?.m15;
    const vwap = (s.vwapDist as { label?: string } | undefined)?.label;
    if (ret === "up" && vwap !== "far_above") return "long_continuation";
    if (ret === "down" && vwap !== "far_below") return "short_continuation";
    return "chop";
  }
  if (k === "news_bias") return "neutral";
  if (k === "cause") return "drift";
  return keys[0] ?? "chop";
}

function scoreFrom(k: string, n: number, _s: Record<string, unknown>): number {
  if (k === "thesis") return 2.1;
  if (k === "extended") return 0.6;
  if (k === "entry_timing") return 1;
  return Math.min(n - 1, 1.2);
}

function label(s: Record<string, unknown>, key: string): string {
  const idx = s.index as { returnsBps?: Record<string, { label?: string }> } | undefined;
  return idx?.returnsBps?.[key]?.label ?? "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

