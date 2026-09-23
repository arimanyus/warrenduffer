# Warren Duffer

Single Node process: broker REST client (Kotak Neo or Zerodha Kite), Jev (TypeSafe AI via Vercel AI Gateway) as a two-stage ranker over Nifty-50 names, live MIS orders, SQLite audit log, terminal-style dashboard on `127.0.0.1:8080`. Jev classifies, ranks, and decides take-profit. Code sizes, places the stop, and enforces the loss halt.

**Risk warning.** This software places real orders with real money through your broker account. There is no paper-trading mode. It is experimental, provided "as is" under the MIT license with no warranty, and is not investment advice. Automated intraday trading can lose money quickly. You are responsible for every order it sends, your broker's API terms, and the SEBI rules that apply to you. Start with `LIVE_QTY=1`. Not affiliated with Kotak Securities, Zerodha, Vercel or TypeSafe.

## Architecture

```
.env -> config -> createBroker() -> KotakClient | ZerodhaClient      (src/broker.ts: Broker interface)
                         |
main.ts -> Engine (src/engine.ts), 2 s fast loop: quotes, fills, stops, 15:10 flatten, kill
             |- LiveFeed (src/data)        -> bars_1m, snapshots (SQLite, data/harness.db)
             |- Jev (src/model)            -> stage 1 rank -> stage 2 confirm -> hold/exit
             |- risk + governor            -> size, stop, loss halt
             '- LiveExecutor               -> broker place/modify/cancel/orders
server.ts + web/  -> dashboard 127.0.0.1:8080
scripts/replay.ts -> SimBroker + SimExecutor on a virtual clock (src/replay)
```

`src/kotak` and `src/zerodha` are the broker clients. `src/data` is quotes, bars, and the universe. `src/model` is Jev. `src/strategy` is rank, exits, and the governor. `src/executor` places and polls orders. `src/replay` is the virtual-clock sim. `src/{broker,config,costs,symbols,limiter,risk,db,server}.ts` is the shared core. `web/` is the dashboard. `scripts/` is probe, calibrate, replay, report, gates, smoke, and the Zerodha login step. `risk.json` holds model thresholds and exit tuning.

## Brokers

| | Kotak Neo | Zerodha Kite Connect |
|---|---|---|
| `BROKER` | `kotak` (default) | `zerodha` |
| Login | Automatic TOTP + MPIN at start, once more on expiry | Manual daily `pnpm zerodha:login` (Kite forbids automated login) |
| Session expiry | Re-logins once | ~06:00 IST daily; engine halts entries, alerts, needs new token + restart |
| Market data | Included | Needs Kite Connect market-data access |
| 1-min history (warm-up, calibrate, replay fetch) | Included | Needs historical-data add-on; minute data capped at 60 days → keep `WARMUP_DAYS` ≤ 60 |
| Order tags | As-is | Sanitised to ≤20 alphanumerics (`sl-12` → `SL12`) |
| Brokerage in PnL | Statutory only (matches a ₹0-brokerage plan) | Statutory only; Kite intraday brokerage is **not** deducted |
| Status | Verified live | Written against Kite v3 docs, not yet verified live: run `pnpm probe`, then `LIVE_QTY=1` |

Kotak: Trade API access token, mobile with `+91`, UCC, MPIN, base32 TOTP secret.

Zerodha:

1. Create an app on the Kite developer console; set redirect URL (e.g. `http://127.0.0.1/`).
2. Put `ZERODHA_API_KEY`, `ZERODHA_API_SECRET` in `.env`, `BROKER=zerodha`.
3. Each trading day: `pnpm zerodha:login` → open URL → log in → copy `request_token` from the redirect URL.
4. `pnpm zerodha:login <request_token>`.
5. Paste `ZERODHA_ACCESS_TOKEN` into `.env`.
6. `pnpm start` (or restart the service).

`ZERODHA_REQUEST_TOKEN` is a one-shot alternative (single-use, minutes). `ZERODHA_ACCESS_TOKEN` wins if both are set. Zerodha auto-squares-off MIS near 15:20 for a fee — keep `FLATTEN_AT` earlier (default 15:10). Brokers may require API order traffic from a registered static IP; check your broker's developer console.

## Jev

`MODEL=jev` with `AI_GATEWAY_API_KEY` (model `typesafe-ai/jev` via the `ai` SDK's `experimental_evaluate`) or `TYPESAFE_AI_API_KEY`. `MODEL=mock` is observe mode unless `ALLOW_MOCK_TRADING=1`. Thresholds live in `risk.json`.

## First run

```bash
cp .env.example .env
pnpm install
pnpm probe
pnpm calibrate
pnpm start
```

Dashboard: SSH tunnel or Tailscale to `http://127.0.0.1:8080`. Set the capital Jev can deploy in the header. Kill = cancel all entries and flatten; Resume clears it.

## Sizing

- Risk per trade = `max(RISK_PER_TRADE, capital × RISK_PCT)`; qty = risk ÷ stop distance, capped by `MAX_NOTIONAL` and free capital.
- `LIVE_QTY=1` for the plumbing week, then `0`.
- Winners have no target; exits are Jev (`take_profit`, `thesis`, `exit_now`), the exchange `SL-L`, or 15:10.
- No trade-count cap while the day is green; 4 after three straight losses or −₹500; `DAILY_LOSS_CAP` flattens.

## Replay

```bash
pnpm replay -- --date 2026-09-15 --speed 60      # one bar per second
pnpm replay -- --date 2026-09-15 --speed 0       # as fast as Jev answers
```

Runs the real decision loop over that day's 1-min bars on a virtual clock, with bar-based simulated fills (pessimistic), on `127.0.0.1:8081` beside the live dashboard. Transport bar: pause/play, 1×/10×/60×/300×/MAX, click the progress bar to seek. Bars come from the live DB's warm-up history or broker candles (Zerodha: historical add-on). Writes to `data/replay-<date>.db`, never the live DB. No book or flow data exists in bars, so replay shows how Jev reads price/volume state, not the full live feature set.

## Commands

| script | purpose |
| --- | --- |
| `pnpm probe` | read-only broker payload check |
| `pnpm start` | engine + dashboard |
| `pnpm replay -- --date D --speed N` | replay a session |
| `pnpm calibrate` | candle study (gate 1) |
| `pnpm report` | expectancy, PF, cuts |
| `pnpm gates` | live gates |
| `pnpm smoke` | offline pipeline check, scratch DB |
| `pnpm zerodha:login` | print the Kite login URL, or exchange a request token |
| `pnpm typecheck` | `tsc --noEmit` |

## Configuration

| env var | default | meaning |
| --- | --- | --- |
| `BROKER` | `kotak` | `kotak` or `zerodha` |
| `KOTAK_ACCESS_TOKEN` | | Trade API access token |
| `KOTAK_MOBILE` | | mobile, with `+91` |
| `KOTAK_UCC` | | client code |
| `KOTAK_MPIN` | | MPIN |
| `KOTAK_TOTP_SECRET` | | base32 TOTP secret |
| `ZERODHA_API_KEY` | | Kite app api key |
| `ZERODHA_API_SECRET` | | Kite app secret |
| `ZERODHA_ACCESS_TOKEN` | | daily access token; wins over the request token |
| `ZERODHA_REQUEST_TOKEN` | | one-shot login token, single-use, minutes |
| `AI_GATEWAY_API_KEY` | | Vercel AI Gateway key for Jev |
| `TYPESAFE_AI_API_KEY` | | direct TypeSafe key, alternative to the gateway |
| `MODEL` | `mock` | `jev` or `mock` |
| `JEV_TIMEOUT_MS` | `2500` | Jev call timeout |
| `ALLOW_MOCK_TRADING` | `0` | `1` lets `MODEL=mock` send orders |
| `ENTRY_START` | `09:30` | first entry, IST |
| `ENTRY_END` | `15:00` | last entry, IST |
| `FLATTEN_AT` | `15:10` | flatten open MIS, IST |
| `DECISION_INTERVAL_S` | `15` | seconds between rank cycles |
| `POSITION_INTERVAL_S` | `5` | seconds between position checks |
| `EXIT_CONFIRM_VOTES` | `2` | consecutive exit votes required |
| `MAX_REQUOTES` | `3` | entry re-quotes before cancel |
| `WARMUP_DAYS` | `25` | history pulled at start |
| `CAPITAL` | `100000` | capital the sizer may deploy |
| `RISK_PER_TRADE` | `300` | rupee floor for risk per trade |
| `RISK_PCT` | `0.003` | risk as a fraction of capital |
| `MAX_NOTIONAL` | `150000` | cap on one position |
| `MAX_POSITIONS` | `3` | open positions at once |
| `DAILY_LOSS_CAP` | `1000` | flatten and halt |
| `LIVE_QTY` | `0` | `1` forces one share; `0` uses the sizer |
| `WILD` | `0` | `1` loosens gates |
| `OPTIONS_MODE` | `off` | `on` enables the options leg |
| `ON_RESTART` | `adopt` | `adopt` or `flatten` open MIS |
| `TELEGRAM_BOT_TOKEN` | | alert bot |
| `TELEGRAM_CHAT_ID` | | alert chat |
| `RSS_FEEDS` | | comma-separated news feeds |
| `HOST` | `127.0.0.1` | dashboard bind address |
| `PORT` | `8080` | dashboard port |
| `DB_PATH` | `data/harness.db` | SQLite file |
| `KILL_PATH` | `kill.switch` | kill-switch file |

`UNIVERSE`, `DAILY_FRICTION_BUDGET`, `ENTRIES_BASE`, `ENTRIES_MAX` are parsed but not read by the current code.

## Safety

- Kill switch file (`KILL_PATH`) and dashboard Kill/Resume.
- Exchange `SL-L` per position; the engine price stop runs only when none is resting.
- `DAILY_LOSS_CAP` flattens and halts.
- 15:10 flatten.
- Margin check: required ≤ 80% of available.
- Observe mode for mock.
- `ON_RESTART=adopt|flatten` — on start the engine cancels open orders it doesn't own and adopts MIS positions, so don't trade the same account by hand during a session.
- Connectivity alert.
- Dashboard is localhost-only.
- Replay never writes the live DB.

## VPS

NTP on. Bind stays localhost. `deploy/warren-duffer.service`. For Zerodha, update `.env` and restart the service every morning.

## Contributing

Issues and PRs welcome. `pnpm typecheck` and `pnpm smoke` must pass. Never commit `.env` or `data/`. A new broker is `src/<broker>/client.ts` implementing `Broker`, plus a branch in `createBroker()`. Keep the engine broker-agnostic (`nse_cm`/`nse_fo`, bare NSE symbols, tags and order types mapped in the client). When changing normalisers, include redacted `pnpm probe` output.

## License

MIT. See `LICENSE`.
