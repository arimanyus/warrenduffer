import type { EvalAnswer, EvalResult, Model } from "../../src/model/jev.js";
import type { Question } from "../../src/model/questions.js";

type Answerer = (stage: string, questions: Record<string, Question>, symbol: string | null) => Record<string, EvalAnswer>;

/** Deterministic model for engine tests. `hold()` parks every call until `release()`, to test races. */
export class ScriptedModel implements Model {
  name = "jev";
  calls: { stage: string; symbol: string | null }[] = [];
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;

  constructor(private answer: Answerer = () => ({})) {}

  setAnswerer(a: Answerer): void {
    this.answer = a;
  }

  hold(): void {
    this.gate = new Promise((r) => (this.open = r));
  }

  release(): void {
    this.open?.();
    this.gate = null;
    this.open = null;
  }

  async evaluate(_state: unknown, questions: Record<string, Question>, stage: string, symbol: string | null = null): Promise<EvalResult> {
    this.calls.push({ stage, symbol });
    if (this.gate) await this.gate;
    return { answers: this.answer(stage, questions, symbol), latencyMs: 1, tokens: 10, modelId: "scripted", ok: true };
  }
}

/** Position-management answers that keep holding. */
export function holdAnswers(): Record<string, EvalAnswer> {
  return {
    thesis: { type: "score", score: 2 },
    exit_now: { type: "noul", noul: 0.1 },
    extended: { type: "score", score: 0 },
    take_profit: { type: "noul", noul: 0.1 },
  };
}
