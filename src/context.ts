import Parser from "rss-parser";
import { risk } from "./config.js";
import { cfg } from "./config.js";
import { upsertContext } from "./db.js";
import type { Model } from "./model/index.js";
import { contextQuestions, riskEventQuestion } from "./model/questions.js";
import { aliasMap } from "./kotak/scrip.js";
import type { Instrument } from "./types.js";
import { istDateStr } from "./time.js";

const parser = new Parser();

export async function runDailyContext(model: Model, cash: Instrument[]): Promise<{ halfSize: boolean }> {
  if (!cfg.rssFeeds.length) return { halfSize: false };
  const items: { title: string; content: string }[] = [];
  for (const url of cfg.rssFeeds) {
    try {
      const feed = await parser.parseURL(url);
      for (const it of feed.items.slice(0, 40)) {
        items.push({ title: it.title ?? "", content: (it.contentSnippet ?? it.content ?? "").slice(0, 400) });
      }
    } catch (e) {
      console.error("rss", url, e);
    }
  }
  const aliases = aliasMap(cash);
  const bySym = new Map<string, string[]>();
  for (const it of items) {
    const text = `${it.title} ${it.content}`.toUpperCase();
    for (const [alias, sym] of aliases) {
      if (alias.length < 3) continue;
      if (text.includes(alias)) {
        const arr = bySym.get(sym) ?? [];
        arr.push(`${it.title}: ${it.content}`.slice(0, 400));
        bySym.set(sym, arr);
      }
    }
  }
  const date = istDateStr();
  let halfSize = false;
  const marketHeadlines = items.slice(0, 15).map((i) => i.title);
  const ev = await model.evaluate({ headlines: marketHeadlines }, riskEventQuestion, "context", "INDEX");
  if ((ev.answers.risk_event_today?.noul ?? 0) >= 0.6) halfSize = true;

  for (const [symbol, headlines] of bySym) {
    const r = await model.evaluate({ symbol, headlines: headlines.slice(0, 8) }, contextQuestions, "context", symbol);
    if (!r.ok) continue;
    const eventToday = r.answers.event_today?.noul ?? 0;
    const newsBias = (r.answers.news_bias?.choice as "bullish" | "bearish" | "neutral" | "none") ?? "none";
    const newsBiasProb = r.answers.news_bias?.probabilities?.[newsBias] ?? 0;
    const materiality = r.answers.materiality?.score ?? 0;
    const exclude = eventToday >= risk.eventExclude;
    let forbidSide: string | null = null;
    if (materiality >= risk.newsMaterial && newsBiasProb >= risk.newsBiasProb) {
      if (newsBias === "bullish") forbidSide = "short";
      if (newsBias === "bearish") forbidSide = "long";
    }
    upsertContext({
      date,
      symbol,
      eventToday,
      newsBias,
      newsBiasProb,
      materiality,
      exclude: exclude ? 1 : 0,
      forbidSide,
    });
  }
  return { halfSize };
}
