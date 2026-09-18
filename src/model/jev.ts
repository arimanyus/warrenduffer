import { experimental_evaluate as evaluate } from "ai";
import { cfg } from "../config.js";
import { insertDecision } from "../db.js";
import type { Question } from "./questions.js";
import { clock } from "../time.js";

export interface EvalAnswer {
  type: string;
  choice?: string;
  score?: number;
  noul?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface EvalResult {
  answers: Record<string, EvalAnswer>;
  latencyMs: number;
  tokens: number;
  modelId: string;
  ok: boolean;
}

const TIMEOUT_MS = cfg.jevTimeoutMs;

export interface Model {
  name: string;
  evaluate(state: unknown, questions: Record<string, Question>, stage: string, symbol?: string | null): Promise<EvalResult>;
}

export class JevModel implements Model {
  name = "jev";

  async evaluate(
    state: unknown,
    questions: Record<string, Question>,
    stage: string,
    symbol: string | null = null,
  ): Promise<EvalResult> {
    const t0 = Date.now();
    // Whole evaluate() must finish inside TIMEOUT_MS, including one retry on a transient gateway 5xx.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      let raw: unknown;
      try {
        raw = await this.call(state, questions, ac.signal);
      } catch (e) {
        if (!isTransient(e) || ac.signal.aborted || Date.now() - t0 > TIMEOUT_MS * 0.5) throw e;
        raw = await this.call(state, questions, ac.signal);
      }
      const latencyMs = Date.now() - t0;
      const parsed = normalize(raw);
      persist(parsed, stage, symbol, latencyMs);
      return { ...parsed, latencyMs, ok: true };
    } catch (e) {
      const latencyMs = Date.now() - t0;
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      insertDecision({
        ts: clock.now(),
        stage,
        symbol,
        question: "_error",
        answer: msg.slice(0, 200),
        probability: null,
        confidence: null,
        latencyMs,
        tokens: 0,
        modelId: "jev",
      });
      return { answers: {}, latencyMs, tokens: 0, modelId: "jev", ok: false };
    } finally {
      clearTimeout(timer);
    }
  }

  private async call(rawState: unknown, questions: Record<string, Question>, abortSignal: AbortSignal): Promise<unknown> {
    // The SDK rejects undefined/NaN/Infinity anywhere in state. A JSON round-trip drops undefined and nulls the rest.
    const state: unknown = JSON.parse(JSON.stringify(rawState));
    if (cfg.aiGatewayKey) {
      return evaluate({
        model: "typesafe-ai/jev",
        state,
        questions: toSdkQuestions(questions),
        abortSignal,
        maxRetries: 0,
      } as Parameters<typeof evaluate>[0]);
    }
    if (cfg.typesafeKey) {
      const res = await fetch("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.typesafeKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "jev-latest", state, questions }),
        signal: abortSignal,
      });
      if (!res.ok) throw new Error(`typesafe ${res.status}`);
      return res.json();
    }
    throw new Error("no Jev key");
  }
}

function isTransient(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /InternalServerError|temporarily unavailable|502|503|504|ECONNRESET|overloaded|rate limit|429/i.test(msg);
}

function toSdkQuestions(questions: Record<string, Question>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, q] of Object.entries(questions)) {
    if (q.type === "noul") out[k] = { type: "boolean", instructions: q.instructions, criteria: q.criteria };
    else out[k] = q;
  }
  return out;
}

function normalize(raw: unknown): Omit<EvalResult, "latencyMs" | "ok"> {
  const r = raw as Record<string, unknown>;
  const answersIn = (r.answers ?? r.data ?? {}) as Record<string, unknown>;
  const answers: Record<string, EvalAnswer> = {};
  const confidenceMap =
    ((r.providerMetadata as { typesafe?: { confidence?: Record<string, number> } } | undefined)?.typesafe
      ?.confidence) ?? {};
  for (const [k, v] of Object.entries(answersIn)) {
    const a = v as Record<string, unknown>;
    const type = String(a.type ?? (a.probability !== undefined && a.choice === undefined && a.score === undefined ? "boolean" : "choice"));
    const noul =
      a.noul !== undefined
        ? Number(a.noul)
        : type === "boolean" || type === "noul"
          ? Number(a.probability ?? 0)
          : undefined;
    answers[k] = {
      type: type === "boolean" ? "noul" : type,
      choice: a.choice !== undefined ? String(a.choice) : undefined,
      score: a.score !== undefined ? Number(a.score) : undefined,
      noul,
      probabilities: (a.probabilities as Record<string, number> | undefined) ?? undefined,
      confidence: a.confidence !== undefined ? Number(a.confidence) : confidenceMap[k],
    };
  }
  const usage = (r.usage ?? {}) as Record<string, number>;
  return {
    answers,
    tokens: Number(usage.inputTokens ?? usage.input_tokens ?? usage.totalTokens ?? 0),
    modelId: String((r.response as { modelId?: string } | undefined)?.modelId ?? r.model ?? "typesafe-ai/jev"),
  };
}

function persist(parsed: Omit<EvalResult, "latencyMs" | "ok">, stage: string, symbol: string | null, latencyMs: number): void {
  for (const [q, a] of Object.entries(parsed.answers)) {
    const answer = a.choice ?? (a.score !== undefined ? String(a.score) : a.noul !== undefined ? String(a.noul) : "");
    const probability = a.noul ?? (a.choice && a.probabilities ? a.probabilities[a.choice] : null) ?? null;
    insertDecision({
      ts: clock.now(),
      stage,
      symbol,
      question: q,
      answer,
      probability,
      confidence: a.confidence ?? null,
      latencyMs,
      tokens: parsed.tokens,
      modelId: parsed.modelId,
    });
  }
}
