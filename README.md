# Warren Duffer

Single Node process: Kotak Neo REST client, Jev (Vercel AI Gateway) as a two-stage ranker over Nifty-50 names, live orders, SQLite audit log, terminal-style dashboard on `127.0.0.1:8080`.

Jev classifies, ranks, and decides take-profit. Code sizes, places the stop, and enforces the loss halt. Orders go to Kotak; there is no paper path. `MODEL=mock` runs in **observe** mode (decisions logged, no orders) unless `ALLOW_MOCK_TRADING=1`.

## First run, in order

```bash
cp .env.example .env          # KOTAK_*, AI_GATEWAY_API_KEY, MODEL=jev
pnpm install
pnpm probe                    # read-only: prints raw Kotak payloads. Fix any empty/NaN field before trading.
pnpm calibrate                # 30d candle study of Jev's setup buckets
pnpm start                    # engine + dashboard
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

Runs the real decision loop over that day's 1-min bars on a virtual clock, with bar-based simulated fills (pessimistic), on `127.0.0.1:8081` beside the live dashboard. Transport bar: pause/play, 1×/10×/60×/300×/MAX, click the progress bar to seek. Bars come from the live DB's warm-up history or Kotak candles. Writes to `data/replay-<date>.db`, never the live DB. No book or flow data exists in bars, so replay shows how Jev reads price/volume state, not the full live feature set.

## Commands

| script | purpose |
| --- | --- |
| `pnpm probe` | read-only Kotak payload check |
| `pnpm start` | engine + dashboard |
| `pnpm replay -- --date D --speed N` | replay a session |
| `pnpm calibrate` | candle study (gate 1) |
| `pnpm report` | expectancy, PF, cuts |
| `pnpm gates` | live gates |
| `pnpm typecheck` | `tsc --noEmit` |

## VPS

NTP on. Bind stays localhost. `deploy/warren-duffer.service`.
