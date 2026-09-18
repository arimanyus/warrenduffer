/**
 * Read-only Kotak probe. Logs in, then prints the raw shape of every endpoint the engine relies on,
 * so field names in src/kotak/client.ts can be verified against real payloads before any order is sent.
 * Places NO orders. The margin check is a query, not an order.
 */
import { KotakClient } from "../src/kotak/client.js";
import { INDEX_TOKEN } from "../src/kotak/scrip.js";
import { addDays, istDateStr } from "../src/time.js";

function show(label: string, body: unknown, max = 1800): void {
  const s = JSON.stringify(body, null, 1) ?? String(body);
  console.log(`\n=== ${label} ===`);
  console.log(s.length > max ? `${s.slice(0, max)}\n… (${s.length} chars)` : s);
}

async function main(): Promise<void> {
  const client = new KotakClient();
  client.onRaw = (ep, body) => {
    if (ep.includes("tradeApi")) show(`RAW ${ep} (keys only)`, Object.keys((body as Record<string, unknown>) ?? {}));
  };
  const sess = await client.login();
  console.log("login ok, baseUrl", sess.baseUrl);

  await client.loadScrips();
  const rel = client.getInstrument("RELIANCE");
  show("scrip RELIANCE", rel);
  console.log("cash instruments parsed:", client.allCash().length, "fo:", client.foInstruments().length);
  if (!rel) {
    console.log("RELIANCE not found: scrip master column mapping is wrong. See parseScripCsv in src/kotak/scrip.ts");
  }

  client.onRaw = (ep, body) => show(`RAW ${ep}`, body);
  const tokens = [{ token: rel?.token ?? "2885", segment: "nse_cm" }, { token: INDEX_TOKEN, segment: "nse_cm" }];
  const qs = await client.quotes(tokens);
  show("normalized quotes", qs);

  const to = istDateStr();
  const rows = await client.candles(rel?.token ?? "2885", "nse_cm", addDays(to, -2), to, "1min");
  show("normalized candles (last 3)", rows.slice(-3));
  console.log("candles:", rows.length);

  show("normalized orders", await client.orders());
  show("normalized positions", await client.positions());
  show("limits", await client.limits());

  if (rel && qs[0]?.ltp) {
    const m = await client.marginRequired({
      segment: "nse_cm",
      token: rel.token,
      tradingSymbol: rel.tradingSymbol,
      side: "buy",
      qty: 1,
      price: qs[0].ltp,
    });
    show("normalized margin (1 share RELIANCE, no order placed)", { available: m.available, required: m.required, ok: m.ok });
  }

  try {
    const exps = await client.expiries();
    show("expiries", exps.slice(0, 4));
    const chain = await client.optionChain("NIFTY", exps[0]);
    show("normalized chain (first 4)", chain.slice(0, 4));
  } catch (e) {
    console.log("options endpoints failed:", String(e));
  }
  console.log("\nprobe done. Fix any empty/NaN fields above before trading.");
}

void main().catch((e) => {
  console.error("probe failed:", e);
  process.exit(1);
});
