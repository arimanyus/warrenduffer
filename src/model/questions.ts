import type { IndexFeatures, SymbolFeatures } from "../types.js";
import { stage1SymbolState, stage2State } from "../data/features.js";
import { clock } from "../time.js";

const clockNow = () => clock.now();

export type Question =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string | Record<string, string>; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };

/** candlesOnly: calibration/replay have no book or flow, so those clauses are dropped rather than fed as "balanced/mixed". */
export function stage1Questions(n: number, candlesOnly = false): Record<string, Question> {
  const q: Record<string, Question> = {};
  const buyers = candlesOnly ? "volume heavy or normal" : "book and flow leaning to buyers";
  const sellers = candlesOnly ? "volume heavy or normal" : "book and flow leaning to sellers";
  for (let i = 0; i < n; i++) {
    q[`long_${i}`] = {
      type: "noul",
      instructions: `Does \`symbols[${i}]\` show a long continuation setup: above VWAP, m15 up, ${buyers}, not far_above VWAP?`,
    };
    q[`short_${i}`] = {
      type: "noul",
      instructions: `Does \`symbols[${i}]\` show a short continuation setup: below VWAP, m15 down, ${sellers}, not far_below VWAP?`,
    };
  }
  const fut = candlesOnly ? "" : " futures book leaning to buyers,";
  const futS = candlesOnly ? "" : " futures book leaning to sellers,";
  q.nifty_long = {
    type: "noul",
    instructions: `Does \`index\` show a continuation setup up: m5 and m15 up, breadth mostly above VWAP,${fut} not extended?`,
  };
  q.nifty_short = {
    type: "noul",
    instructions: `Does \`index\` show a continuation setup down: m5 and m15 down, breadth mostly below VWAP,${futS} not extended?`,
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

export function stage1State(symbols: SymbolFeatures[], index: IndexFeatures | null, candlesOnly = false): Record<string, unknown> {
  const legend: Record<string, string> = {
    vwapDist: "far_above|above|near|below|far_below, buckets from ATR",
    m1_m60: "up|flat|down beyond ±8bps",
    rvol: "today volume vs prior days to this minute",
  };
  if (!candlesOnly) {
    legend.book = "buyers|balanced|sellers from total bid/ask qty";
    legend.flow5m = "approximate; from polled volume deltas signed by price change";
  }
  const rows = symbols.map(stage1SymbolState).map((s) => {
    if (!candlesOnly) return s;
    const { book: _b, flow5m: _f, spreadBps: _s, ...rest } = s as Record<string, unknown>;
    return rest;
  });
  const idx = index && candlesOnly ? { ...index, futuresImbalance: undefined } : index;
  return {
    time: new Date(nowForState()).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    dataset: candlesOnly ? "1-minute candles only; no order book, no trade flow" : "live quotes with L5 book",
    legend,
    symbols: rows,
    index: idx,
    breadth: index?.breadthAboveVwap ?? null,
  };
}

function nowForState(): number {
  return clockNow();
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

/** Same study, bar data only: no flow_alignment, no one_sided, setup criteria without book/flow clauses. */
export const stage2QuestionsCandles: Record<string, Question> = {
  setup: {
    type: "choice",
    instructions:
      "Classify the current state of `symbol` for a 5-30 minute intraday hold from price, VWAP, volume and `bars1m`. Judge only what is visible. Do not forecast.",
    criteria: {
      long_continuation: "price above VWAP, m15 up, recent bars closing near their highs with volume, index not falling",
      short_continuation: "price below VWAP, m15 down, recent bars closing near their lows with volume, index not rising",
      chop: "returns flat across horizons, bars overlapping with no direction",
      stretched: "price far from VWAP after a fast move with volume fading; not a fresh entry",
    },
  },
  trend_quality: stage2Questions.trend_quality,
  index_alignment: stage2Questions.index_alignment,
  liquidity: {
    type: "score",
    instructions: "How tradeable is `symbol` right now from `volume` (rvol and last 5m vs prior)?",
    criteria: ["Thin", "Acceptable", "Active"],
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
  take_profit: {
    type: "noul",
    instructions:
      "Should `position` be closed now to bank its gain? Yes when `position.unrealisedBps` is positive and the move is done or fading: `givebackFromPeakBps` growing, `flow5m` and `book` no longer favour the position, `bars1m` losing momentum, or `symbol` is far from VWAP with flow opposing. No when the move is still orderly and one-sided. Judge only what is visible. Do not forecast.",
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
