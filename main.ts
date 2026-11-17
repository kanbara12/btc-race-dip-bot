// Dip-buy bot v2 for make.fun btc-race-24h-20261117-0603 (kanbara12).
//
// What the dev window taught us (offline simulator, validated to the
// micro-USDC against grade-local on v1): the window is three slow
// dip-and-recover cycles, each 1.5-2.1% deep and 1-2.5% tall. v1 caught
// only ~1.5 of them for +$8.19 because it sold on a full V-recovery to
// the trailing high with a small locked gain, and then waited for a 1%
// bounce before it would buy again. The dev top 10 (+$39-49) ride two
// or three full cycles. v2 is built to do exactly that:
//
//   - Entry: all-in, all at once, when the close sits at least 1.60%
//     below the highest close seen so far in the window (the running
//     high, not a short window: a short window follows the price down
//     and erases the dip signal). One deep dip, one full-size entry.
//   - Exit: a trailing stop. Once the position is up at least 0.70%,
//     sell everything the moment the close pulls back 0.20% from the
//     highest close since entry. No fixed take-profit: the big leg of
//     this window runs +2.2% and a fixed +1.5% target leaves money
//     behind, while the trailing stop banks whatever the leg gives.
//   - Stop-loss: sell everything if the close falls 3% below the
//     average entry (never hit on the dev window; it only guards the
//     25% maximum-drawdown bar on the unseen race window).
//   - Re-arm: none. After a sell the bot may buy the next qualifying
//     dip at once; the dip test itself is the gate, and on the dev
//     window a sell always leaves the price far above the next dip.
//   - Long only, one open position, deterministic: no clock, no
//     randomness, no network, no files. All math is integer bigint.
//
// Validated offline (simulator replicating the kit fill model, checked
// to the micro-USDC against grade-local on v1): dev +$27.62 net
// (+2.76%, 6 trades, max drawdown 1.10%, fees $2.44), first half
// +$21.91, second half +$5.63, both halves positive. The parameters
// (dip 1.60%, arm 0.70%, trail 0.20%) are the robust plateau across
// the sweep, not the sharpest dev point: neighbouring settings
// (dip 1.55-1.65%, arm 0.70-0.90%, trail 0.20-0.30%) all land
// +$25-31, while the sharper alternatives (fixed take-profit,
// shallow 1.0-1.2% dips, two-leg scale-in) cap at +$19-22. The
// +$35 top-10 dev line is still above this bot: the oracle ceiling
// for three perfect round trips on this window is ~+$47, and v2
// banks about 60% of it. The race window is unseen, so nothing
// here promises a race profit.

import { BPS, runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const DIP_BPS = 160; // buy all cash when 1.60% below the running high
const ARM_BPS = 70; // trailing stop arms once the gain reaches 0.70%
const TRAIL_EXIT_BPS = 20; // ...then sell on a 0.20% pullback from the peak
const STOP_BPS = 300; // stop-loss: 3% below the average entry price
const MAX_SLIPPAGE_BPS = 200; // 2% slippage allowance on every order

/** Closes seen so far, in batch order. */
const closes: bigint[] = [];
/** Highest close since the current position was opened (0 when flat). */
let peak = 0n;

/** Highest close seen so far in the window (including the current one). */
function runningHigh(): bigint {
  let high = 0n;
  for (const c of closes) {
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

    const high = runningHigh();
    const dip = dipBps(close, high);
    const orders: OrderInput[] = [];

    const pos = state.positions.get(SYMBOL);
    const holding = pos !== undefined && pos.qty > 0n;

    if (!holding) {
      // ---- flat: buy the whole stack on a deep dip ----
      if (dip >= BigInt(DIP_BPS)) {
        const room = state.weightRoom(SYMBOL);
        const spend = state.cash < room ? state.cash : room;
        if (spend >= BigInt(state.hello.fees.min_notional_quote_units) && spend > 0n) {
          orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS });
          peak = close;
        }
      }
      return orders;
    }

    // ---- holding: track the peak since entry ----
    if (close > peak) peak = close;

    // ---- holding: exit rules ----
    const entry = avgEntry(state);
    const gain = gainBps(state);
    let sell = false;
    if (entry !== null && close * BPS <= entry * (BPS - BigInt(STOP_BPS))) {
      sell = true; // stop-loss: 3% below average entry
    } else if (
      gain !== null &&
      gain >= BigInt(ARM_BPS) &&
      peak > 0n &&
      close * BPS <= peak * (BPS - BigInt(TRAIL_EXIT_BPS))
    ) {
      sell = true; // trailing stop: up 0.70%, now 0.20% off the peak
    }
    if (sell) {
      orders.push({ side: 'sell', symbol: SYMBOL, qty: pos!.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      peak = 0n;
    }
    return orders;
  },
});
