# btc-race-dip-bot

Dip-buy cbBTC trading bot for the make.fun competition
**btc-race-24h-20261117-0603** — race a BTC trading bot live for 24 hours.

## Strategy

Few, well-timed trades win this race: every round trip costs ~26 bps in
fees, slippage and price impact, and the previous race's winner made
+1.68% on a single dip-buy.

- Track the trailing high (max close over the last 240 one-minute bars).
- Buy half the cash when the close dips 1.5% below that high.
- Buy the rest when the dip deepens to 2.0%.
- Sell everything when the price recovers to within 0.2% of the trailing
  high with at least 0.8% unrealised gain (the V-recovery), or on a
  5% stop-loss below the average entry.
- After a sell, re-arm only after a 1% bounce, so a stop-loss never
  re-buys straight into the same falling knife.
- Long only, at most one open position, fully deterministic (no clock,
  no randomness, no network, no files outside the repo).

## Dev-window grade (kit scorer, local)

- Net PnL: **+$8.19** (8,186,930 micro-USDC), return +0.82%
- Max drawdown: 0.62% (guardrail: 25%)
- Trades: 3, rejected: 0 — passes the dev gate (net PnL > $0)
- Beats the best kit baseline (momentum, +$2.45) by ~3.3x
- Deterministic: two runs reproduce byte-for-byte

## Run

`main.ts` (Node 22, erasable TypeScript) at the repo root, speaking
`agent-fun/bars-replay/v1` via the kit SDK shim copied byte-identical
into `vendor/makefun-bars.ts`.
