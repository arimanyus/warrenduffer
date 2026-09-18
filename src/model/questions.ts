import type { IndexFeatures, SymbolFeatures } from "../types.js";
import { stage1SymbolState, stage2State } from "../data/features.js";

export type Question =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string | Record<string, string>; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };

export function stage1Questions(n: number): Record<string, Question> {
  const q: Record<string, Question> = {};
  for (let i = 0; i < n; i++) {
    q[`long_${i}`] = {
      type: "noul",
      instructions: `Does \`symbols[${i}]\` show a long continuation setup: above VWAP, m15 up, book and flow leaning to buyers, not far_above VWAP?`,
    };
    q[`short_${i}`] = {
      type: "noul",
      instructions: `Does \`symbols[${i}]\` show a short continuation setup: below VWAP, m15 down, book and flow leaning to sellers, not far_below VWAP?`,
    };
  }
  q.nifty_long = {
    type: "noul",
    instructions:
      "Does `index` show a continuation setup up: m5 and m15 up, breadth mostly above VWAP, futures book leaning to buyers, not extended?",
  };
  q.nifty_short = {
    type: "noul",
    instructions:
      "Does `index` show a continuation setup down: m5 and m15 down, breadth mostly below VWAP, futures book leaning to sellers, not extended?",
  };
  q.regime = {
    type: "choice",
    instructions: "Classify the market from `index` and `breadth`.",
    criteria: {
      trend_up: "index m15 up and most of universe above VWAP",
      trend_down: "index m15 down and most below VWAP",
      range: "index flat, breadth mixed",
      volatile: "large swings both ways in m5 and m15",
    },
  };
  q.risk_off = {
    type: "noul",
    instructions: "Is `index` falling fast with breadth collapsing?",
  };
  return q;
}

export function stage1State(symbols: SymbolFeatures[], index: IndexFeatures | null): Record<string, unknown> {
  return {
    symbols: symbols.map(stage1SymbolState),
    index,
    breadth: index?.breadthAboveVwap ?? null,
  };
}

export const stage2Questions: Record<string, Question> = {
  setup: {
    type: "choice",
    instructions:
      "Classify the current state of `symbol` for a 5-30 minute intraday hold. Judge only what is visible. Do not forecast.",
    criteria: {
      long_continuation: "price above VWAP, m15 up, book and flow5m lean to buyers, index not falling",
      short_continuation: "price below VWAP, m15 down, book and flow5m lean to sellers, index not rising",
      chop: "returns flat across horizons, balanced book, no consistent side in flow5m",
      stretched: "price far from VWAP with flow fading or opposing; not a fresh entry",
    },
  },
  trend_quality: {
    type: "score",
    instructions: "How orderly is the trend in `bars1m` in the direction of m15?",
    criteria: ["Erratic or no trend", "Trend with pullbacks", "Clean directional bars"],
  },
  flow_alignment: {
    type: "score",
    instructions: "How well do `book` and `flow5m` agree with the direction of m15?",
    criteria: ["Opposing", "Mixed", "Aligned"],
  },
  index_alignment: {
    type: "score",
    instructions: "How well does `index` support the direction of m15 for `symbol`?",
    criteria: ["Opposing", "Neutral", "Supporting"],
  },
  liquidity: {
    type: "score",
    instructions: "How tradeable is `symbol` right now from `spreadBps`, `volume` and `book` depth?",
    criteria: ["Thin or wide", "Acceptable", "Deep and tight"],
  },
  one_sided: {
    type: "noul",
    instructions: "Over the last 5 minutes, do `book` and `flow5m` clearly favour one side?",
  },
};

export const positionQuestions: Record<string, Question> = {
  thesis: {
    type: "score",
    instructions: "Does the current state still match the setup `position` was entered on?",
    criteria: ["Broken", "Weakening", "Intact", "Strengthening"],
  },
  exit_now: {
    type: "noul",
    instructions: "Has flow or book flipped against `position`, or has price crossed back through VWAP?",
  },
  extended: {
    type: "score",
    instructions: "How far and fast has `symbol` moved in the direction of `position` relative to its ATR?",
    criteria: ["Not extended", "Somewhat extended", "Very extended"],
  },
};

export const attributionQuestions: Record<string, Question> = {
  cause: {
    type: "choice",
    instructions: "From `entryDecision`, `holdBars` and `exitReason`, why did this trade end as it did?",
    criteria: {
      clean_target: "moved to target without threatening the stop",
      noise_stop: "stopped by a fluctuation inside normal bar range, trend resumed",
      thesis_break: "flow or trend reversed before the stop",
      drift: "went nowhere, time stop or manual exit",
      bad_entry: "entered late or into an already extended move",
    },
  },
  entry_timing: {
    type: "score",
    instructions: "Judge the entry bar within the move visible in `holdBars`.",
    criteria: ["Early", "Good", "Late"],
  },
};

export const contextQuestions: Record<string, Question> = {
  event_today: {
    type: "noul",
    instructions:
      "Do the `headlines` say `symbol` has results, a board meeting, or another scheduled corporate event today?",
  },
  news_bias: {
    type: "choice",
    instructions: "Directional tone of `headlines` for `symbol`.",
    criteria: {
      bullish: null,
      bearish: null,
      neutral: "no clear direction",
      none: "headlines not about `symbol`",
    },
  },
  materiality: {
    type: "score",
    instructions: "How likely are `headlines` to move `symbol` today?",
    criteria: ["Routine", "Notable", "Clearly price-moving"],
  },
};

export const riskEventQuestion: Record<string, Question> = {
  risk_event_today: {
    type: "noul",
    instructions: "Do these market `headlines` describe RBI, Fed, budget, CPI, or another index-level risk event today?",
  },
};

export { stage2State };
