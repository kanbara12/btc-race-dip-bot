// Dip-buy ladder bot for make.fun btc-race-24h-20261117-0603 (kanbara12).
//
// Idea: the race is won by FEW well-timed trades, not by trading often.
// The previous race's winner made +1.68% on a single dip-buy; every
// round trip costs ~26 bps in fees, slippage and price impact, so this
// bot trades at most a few times per window:
//
//   - Track the trailing high (max close over the last TRAIL_BARS bars).
//   - Buy half the cash when the close dips DIP1 below that high.
//   - Buy the rest when the dip deepens to DIP2.
//   - Sell everything when the price recovers to within a hair of the
//     trailing high with a locked-in gain (the V-recovery), or on a
//     stop-loss 5% below the average entry (protects the 25% drawdown
//     guardrail). After a sell, re-arm only after a 1% bounce, so a
//     stop-loss never re-buys straight into the same falling knife.
//   - Long only, at most one open position, deterministic: no clock,
//     no randomness, no network, no files. All math is integer bigint.

import { BPS, runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const TRAIL_BARS = 240; // trailing-high lookback in bars (4 hours)
const DIP1_BPS = 150; // first tranche: 1.5% below the trailing high
const DIP2_BPS = 200; // second tranche: 2.0% below the trailing high
const SELL_NEAR_HIGH_BPS = 20; // sell when within 0.2% of the trailing high...
const MIN_GAIN_BPS = 80; // ...and the unrealised gain is at least 0.8%
const STOP_BPS = 500; // stop-loss: 5% below the average entry price
const REARM_BOUNCE_BPS = 100; // re-arm after a sell only on a 1% bounce
const MAX_SLIPPAGE_BPS = 200; // 2% slippage allowance on every order

/** Closes seen so far, in batch order. */
const closes: bigint[] = [];
/** 0 = flat, 1 = first tranche in, 2 = fully in. */
let tranche = 0;
/** Close at which the last sell was decided; null when not cooling off. */
let coolSellClose: bigint | null = null;

/** Max close over the last TRAIL_BARS bars (including the current one). */
function trailingHigh(): bigint {
  let high = 0n;
  const start = closes.length > TRAIL_BARS ? closes.length - TRAIL_BARS : 0;
  for (let i = start; i < closes.length; i++) {
    const c = closes[i]!;
    if (c > high) high = c;
  }
  return high;
}

/** Dip of `close` below `high`, in basis points (integer, truncated). */
function dipBps(close: bigint, high: bigint): bigint {
  if (high === 0n || close >= high) return 0n;
  return ((high - close) * BPS) / high;
}

/** Average entry price of the open position, in price units, or null when flat. */
function avgEntry(state: BarsState): bigint | null {
  const pos = state.positions.get(SYMBOL);
  if (pos === undefined || pos.qty === 0n) return null;
  // cost (quote units) = qty * price * 10^quote_scale / 10^(qty_scale + price_scale)
  //   => price = cost * 10^(8 + 5) / (qty * 10^6) = cost * 10^7 / qty.
  return (pos.cost * 10_000_000n) / pos.qty;
}

/** Unrealised gain of the open position, in basis points, or null when flat. */
function gainBps(state: BarsState): bigint | null {
  const pos = state.positions.get(SYMBOL);
  if (pos === undefined || pos.qty === 0n || pos.cost === 0n) return null;
  const value = state.value(SYMBOL, pos.qty);
  if (value <= pos.cost) return 0n;
  return ((value - pos.cost) * BPS) / pos.cost;
}

await runBars({
  onBatch(state, batch) {
    const close = state.close(SYMBOL);
    if (close === null) return [];
    closes.push(close);
    if (state.warmingUp) return [];

    const high = trailingHigh();
    const dip = dipBps(close, high);
    const orders: OrderInput[] = [];

    // ---- cooling off after a sell: re-arm only on a 1% bounce ----
    if (coolSellClose !== null) {
      if (close * BPS >= coolSellClose * (BPS + BigInt(REARM_BOUNCE_BPS))) {
        coolSellClose = null;
        tranche = 0;
      } else {
        return [];
      }
    }

    const pos = state.positions.get(SYMBOL);
    const holding = pos !== undefined && pos.qty > 0n;

    if (!holding) {
      // ---- flat: buy the dip in up to two tranches ----
      if (dip >= BigInt(DIP2_BPS)) {
        // Deep dip in one bar: deploy everything at once.
        const room = state.weightRoom(SYMBOL);
        const spend = state.cash < room ? state.cash : room;
        if (spend >= BigInt(state.hello.fees.min_notional_quote_units) && spend > 0n) {
          orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS });
          tranche = 2;
        }
      } else if (dip >= BigInt(DIP1_BPS) && tranche === 0) {
        const room = state.weightRoom(SYMBOL);
        const half = state.cash / 2n;
        const spend = half < room ? half : room;
        if (spend >= BigInt(state.hello.fees.min_notional_quote_units) && spend > 0n) {
          orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS });
          tranche = 1;
        }
      }
      return orders;
    }

    // ---- holding: second tranche on a deeper dip ----
    if (tranche === 1 && dip >= BigInt(DIP2_BPS)) {
      const room = state.weightRoom(SYMBOL);
      const spend = state.cash < room ? state.cash : room;
      if (spend >= BigInt(state.hello.fees.min_notional_quote_units) && spend > 0n) {
        orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS });
        tranche = 2;
      }
      return orders;
    }

    // ---- holding: exit rules ----
    const entry = avgEntry(state);
    const gain = gainBps(state);
    let sell = false;
    if (entry !== null && close * BPS <= entry * (BPS - BigInt(STOP_BPS))) {
      sell = true; // stop-loss: 5% below average entry
    } else if (gain !== null && gain >= BigInt(MIN_GAIN_BPS) && dip <= BigInt(SELL_NEAR_HIGH_BPS)) {
      sell = true; // V-recovery: back near the high with the gain locked in
    }
    if (sell) {
      orders.push({ side: 'sell', symbol: SYMBOL, qty: pos!.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      tranche = 0;
      coolSellClose = close;
    }
    return orders;
  },
});
