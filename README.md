# Warren Duffer

Single Node process: Kotak Neo REST client, Jev (Vercel AI Gateway or TypeSafe) as a two-stage ranker over Nifty-50 names, paper/live executors, SQLite audit log, one-page dashboard on `127.0.0.1:8080`.

Jev classifies. Code sizes, stops, and gates. Every fill gets an exchange-side `SL-L`. Frequency is earned (friction budget + governor), not a fixed trade count.

## Setup

```bash
cp .env.example .env
# fill KOTAK_* and optionally AI_GATEWAY_API_KEY
pnpm install
pnpm start
```

Dashboard: SSH tunnel or Tailscale to `http://127.0.0.1:8080`. Kill switch: type CONFIRM on the page, or `touch kill.switch`.

`MODEL=mock` (default) runs without Jev. `MODE=paper` never sends live orders.

## Commands

| script | purpose |
| --- | --- |
| `pnpm start` | engine + dashboard |
| `pnpm calibrate` | 30-day candle study (gate 1) |
| `pnpm report` | expectancy, PF, calibration cuts |
| `pnpm gates` | check paper go-live gates |
| `pnpm typecheck` | `tsc --noEmit` |

## Go-live

1. `pnpm calibrate` — top setup bucket must beat the bottom by ≥10pp.
2. Paper ≥20 days and ≥40 trades.
3. Expectancy after costs > 0 and PF ≥ 1.2 (unlocks 30s interval + SFeed work).
4. Max paper DD ≤ ₹3,000.
5. Recheck calibration on paper decisions.
6. Live at 1 share for 5 days (plumbing only): `MODE=live LIVE_QTY=1`.
7. First live month: `LIVE_QTY=0` (normal sizing) and `DAILY_LOSS_CAP=1000`.

Options stay `OPTIONS_MODE=paper` until their own gates pass (`pnpm gates`).

## VPS

Keep the VPS clock on NTP. Bind stays localhost. Example systemd unit in `deploy/warren-duffer.service`.
