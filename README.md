# Warren Duffer

Single Node process: broker REST client (Kotak Neo or Zerodha Kite), Jev (TypeSafe AI via Vercel AI Gateway) as a two-stage ranker over Nifty-50 names, live MIS orders, SQLite audit log, terminal-style dashboard on `127.0.0.1:8080`. Jev classifies, ranks, and decides take-profit. Code sizes, places the stop, and enforces the loss halt.

**Risk warning.** This software places real orders with real money through your broker account. There is no paper-trading mode. It is experimental, provided "as is" under the MIT license with no warranty, and is not investment advice. Automated intraday trading can lose money quickly. You are responsible for every order it sends, your broker's API terms, and the SEBI rules that apply to you. Start with `LIVE_QTY=1`. Not affiliated with Kotak Securities, Zerodha, Vercel or TypeSafe.

## Architecture

<img width="1536" height="1024" alt="ChatGPT Image Sep 23, 2026, 10_26_07 AM" src="https://github.com/user-attachments/assets/bb3b0491-517b-4abc-a0da-0c70baa6c77c" />

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
| `pnpm test` | unit + engine tests against a fake broker, temp DB, virtual clock |

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
| `DAILY_LOSS_CAP` | `1000` | flatten and halt when realised (worse of local and broker) + open MTM reaches −cap |
| `MAX_TRADES_PER_DAY` | `0` | hard cap on entries per IST day; `0` = governor only |
| `JEV_DAILY_TOKEN_BUDGET` | `0` | stop new Jev calls past this many tokens a day; `0` = unlimited |
| `LIVE_QTY` | `0` | `1` forces one share; `0` uses the sizer |
| `WILD` | `0` | `1` loosens gates |
| `OPTIONS_MODE` | `off` | `on` enables the options leg |
| `ON_RESTART` | `adopt` | `adopt` or `flatten` open MIS |
| `TELEGRAM_BOT_TOKEN` | | alert bot |
| `TELEGRAM_CHAT_ID` | | alert chat |
| `RSS_FEEDS` | | comma-separated news feeds |
| `HOST` | `127.0.0.1` | dashboard bind address; anything non-loopback needs `ALLOW_REMOTE_DASHBOARD=1` |
| `PORT` | `8080` | dashboard port |
| `ALLOW_REMOTE_DASHBOARD` | `0` | `1` permits a non-loopback `HOST`; every API call then needs the token |
| `DASHBOARD_TOKEN` | random per start | token for dashboard writes; required (≥16 chars) in remote mode |
| `DASHBOARD_ALLOWED_HOSTS` | | extra comma-separated hostnames/IPs accepted in the `Host` header |
| `DB_PATH` | `data/harness.db` | SQLite file |
| `KILL_PATH` | `kill.switch` | kill-switch file |

Every numeric setting, enum, and entry window is validated at start; a typo stops the process with a list of problems instead of silently disabling a check.

`risk.json` execution keys: `stopLimitBufferBps` (SL-L limit distance past the trigger, at least 3 ticks), `stopUnfilledMs` (how long a triggered or breached stop may stay unfilled before the engine forces a marketable exit), `marketableBps` (how far through the touch forced exits and flatten orders are priced; they are re-priced every 2 s until filled).

## Safety

- Kill switch file (`KILL_PATH`) and dashboard Kill/Resume.
- Exchange `SL-L` per position, sized to the filled quantity. A stop that fails to place is retried with backoff; if price breaches it or it triggers without filling for `stopUnfilledMs`, the engine alerts and forces a marketable exit.
- Kill, halt, and flatten cancel working entries and keep re-pricing marketable exits every tick until the book is flat.
- `DAILY_LOSS_CAP` flattens and halts on realised + open mark-to-market.
- 15:10 flatten.
- Margin check: required ≤ 80% of available; kill/halt/window are re-checked after the margin call.
- Observe mode for mock.
- An order whose placement times out is matched by tag on the next order-book poll instead of being assumed rejected.
- A reconciler compares broker positions and orders with local state every 30 s and repairs a mismatch seen twice in a row.
- `ON_RESTART=adopt|flatten` — on start the engine adopts MIS positions and their resting stops, cancels only its own stale orders, and alerts on orders it didn't place. Don't trade the same account by hand during a session.
- An uncaught exception trips the kill switch, attempts a flatten, alerts, and exits non-zero for systemd to restart.
- Connectivity and no-session alerts.
- Dashboard binds to localhost by default; it checks `Host`/`Origin` headers and needs a token for every write.
- Replay never writes the live DB.

## VPS

NTP on. Bind stays localhost; reach the dashboard over an SSH tunnel. `deploy/warren-duffer.service` runs `tsx` as a dedicated `warren` user with `TZ=Asia/Kolkata` and a read-only filesystem except `data/`, where it pins `DB_PATH` and `KILL_PATH`; adjust `User=` and paths to your box. For Zerodha, update `.env` and restart the service every morning.

## Contributing

Issues and PRs welcome. `pnpm typecheck`, `pnpm test`, and `pnpm smoke` must pass (CI runs all three). Never commit `.env` or `data/`. A new broker is `src/<broker>/client.ts` implementing `Broker`, plus a branch in `createBroker()`. Keep the engine broker-agnostic (`nse_cm`/`nse_fo`, bare NSE symbols, tags and order types mapped in the client). When changing normalisers, include redacted `pnpm probe` output.

## License

MIT. See `LICENSE`.
