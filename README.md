# Warren Duffer

Single Node process: Kotak Neo REST client, Jev (Vercel AI Gateway or TypeSafe) as a two-stage ranker over Nifty-50 names, live orders, SQLite audit log, one-page dashboard on `127.0.0.1:8080`.

Jev classifies, and it decides take-profit. Code sizes and places the stop. No daily trade-count cap while the day is green; after three losses or −₹500 the pace contracts. Daily loss halt still flattens.

Orders go to Kotak. There is no paper / simulated-fill path.

## Setup

```bash
cp .env.example .env
# fill KOTAK_* and optionally AI_GATEWAY_API_KEY
pnpm install
pnpm start
```

Dashboard: SSH tunnel or Tailscale to `http://127.0.0.1:8080`. Kill switch: type CONFIRM on the page, or `touch kill.switch`.

`MODEL=mock` (default) runs without Jev. `OPTIONS_MODE=off` (default) does not send F&O orders; set `on` to trade Nifty options live.

## Commands

| script | purpose |
| --- | --- |
| `pnpm start` | engine + dashboard |
| `pnpm calibrate` | 30-day candle study (gate 1) |
| `pnpm report` | expectancy, PF, calibration cuts |
| `pnpm gates` | check live gates |
| `pnpm typecheck` | `tsc --noEmit` |

## Sizing

- First week plumbing: `LIVE_QTY=1`
- After that: `LIVE_QTY=0` (risk/notional sizing) and `DAILY_LOSS_CAP=1000`

## VPS

Keep the VPS clock on NTP. Bind stays localhost. Example systemd unit in `deploy/warren-duffer.service`.
