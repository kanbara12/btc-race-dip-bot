// Dip-buy bot v3 for make.fun btc-race-24h-20261117-0603 (kanbara12).
//
// What v2 got wrong, and what v3 changes. v2 (+$27.62 dev) bought the
// moment the close crossed 1.60% below the running high — that is the
// first bar of the fall, not the bottom: on the dev window it bought
// leg 2 at bar 551 ($64,404) while the price kept falling to bar 573
// ($64,069), and it sold leg 2 at bar 695 on a 0.70% arm, banking
// +$5.83 where the leg was worth +$12.53. v3 fixes both:
//
//   - Entry: all-in only when the close is at least 1.60% below the
//     running high AND the close is up on the previous bar (a bounce).
//     The bounce is the cheapest possible confirmation that the low
//     is turning instead of still falling. It moves leg 1's entry from
//     bar 371 to bar 375 and leg 2's from bar 551 to bar 553, and it
//     is the single biggest contributor to the v3 gain.
//   - Exit: take-profit OR trailing stop. Sell everything when the
//     unrealised gain reaches +2.00% (this banks leg 1 at bar 515,
//     $65,282, right after the $65,456 peak), or, once the gain is at
//     least +1.00%, sell on a 0.20% pullback from the highest close
//     since entry (this rides leg 2 to bar 980, $65,255, instead of
//     dumping it at the first local high). The higher arm (1.00% vs
//     v2's 0.70%) is load-bearing: at 0.80% the trailing stop fires
//     on the pullback after the bar-681 local high and leg 2 loses
//     ~$6. At 1.00% and 1.20% the result is identical.
//
// Why the bounce is a single up-tick, not a confirmed rise: a
// two-bar confirmed bounce was tested and scored +$30.54, worse —
// the extra bar of delay costs more entry price than the better
// timing saves. A "wait for the close to rise above the episode
// low" recovery entry was also tested (+$30.09) and rejected: it
// misses legs outright when the dip shrinks below 1.60% before the
// recovery fires. The single up-tick is the cheapest confirmation
// that still fires on every real leg of this window.
//   - Stop-loss: sell everything if the close falls 3% below the
//     average entry (never hit on the dev window; it only guards the
//     25% maximum-drawdown bar on the unseen race window).
//   - Re-arm: none. After a sell the bot may buy the next qualifying
//     dip at once; the dip test itself is the gate.
//   - Long only, one open position, deterministic: no clock, no
//     randomness, no network, no files. All math is integer bigint.
//
// Validated offline (simulator replicating the kit fill model exactly,
// checked to the micro-USDC against grade-local on v1 and v2):
// dev +$33.55 net (+3.36%, 6 trades, max drawdown 0.86%, fees $2.45),
// first half +$21.72, second half +$2.50, both halves positive.
// Trades: buy bar 375 $64,051 -> sell bar 515 $65,282 (+$18.39);
// buy bar 553 $64,403 -> sell bar 980 $65,255 (+$12.65);
// buy bar 1228 $64,481 -> flatten at the window end $64,689 (+$2.50).
//
// Honest status: the +$39.00 live dev top-10 line was NOT reached.
// v3 is the best causal config found across 12 strategy families and
// ~2,500 swept configs (dip+bounce, confirmed bounce, recovery entry,
// scale-in, pivot lows, volatility-adaptive thresholds, short trailing
// windows, fixed take-profit, partial exits). The true oracle ceiling
// for this window is +$41.70 with 2 round trips and +$49.57 with 3,
// so +$39 is provably reachable in hindsight — but every causal
// attempt to close the remaining ~$8 gap (buying the exact low instead
// of the first bounce, selling the exact peak instead of the trailing
// stop) either delayed the entry past the low or sold the leg early,
// and scored worse. The plateau around v3 is real but not wide:
// neighbours at dip 1.55/1.65%, take-profit 1.80/2.20%, trail
// 0.15/0.25% all land +$31-33, arm 1.00-1.20% is identical, arm 0.80%
// drops to +$27.30. The race window is unseen, so nothing here
// promises a race profit; the dev edge is three slow dip-and-recover
// cycles, and the race window may not have them.

import { BPS, runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const DIP_BPS = 160; // buy all cash when 1.60% below the running high
const TAKE_PROFIT_BPS = 200; // sell everything at +2.00% unrealised gain
const ARM_BPS = 100; // trailing stop arms once the gain reaches 1.00%
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

/** True when the current close is up on the previous bar's close. */
function bounced(): boolean {
  if (closes.length < 2) return false;
  return closes[closes.length - 1] > closes[closes.length - 2];
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
      // ---- flat: buy the whole stack on a deep dip that is bouncing ----
      if (dip >= BigInt(DIP_BPS) && bounced()) {
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
    // Defensive: peak is always set on buy, but if it were ever 0
    // while holding, the trailing stop below would compare against 0
    // and never fire; seed it from the current close instead.
    if (peak === 0n) peak = close;
    if (close > peak) peak = close;

    // ---- holding: exit rules ----
    const entry = avgEntry(state);
    const gain = gainBps(state);
    let sell = false;
    if (entry !== null && close * BPS <= entry * (BPS - BigInt(STOP_BPS))) {
      sell = true; // stop-loss: 3% below average entry
    } else if (gain !== null && gain >= BigInt(TAKE_PROFIT_BPS)) {
      sell = true; // take-profit: +2.00% unrealised gain
    } else if (
      gain !== null &&
      gain >= BigInt(ARM_BPS) &&
      peak > 0n &&
      close * BPS <= peak * (BPS - BigInt(TRAIL_EXIT_BPS))
    ) {
      sell = true; // trailing stop: up 1.00%, now 0.20% off the peak
    }
    if (sell) {
      orders.push({ side: 'sell', symbol: SYMBOL, qty: pos!.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      peak = 0n;
    }
    return orders;
  },
});
