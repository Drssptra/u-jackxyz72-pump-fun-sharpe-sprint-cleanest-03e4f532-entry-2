// Selective-momentum paper bot for the pump.fun Sharpe sprint.
//
// Idea: the score is the hourly Sharpe ratio, so the bot wants many small,
// low-variance round trips, not one moonshot. The replay data says most
// coins bleed slowly from birth while a minority runs hard, and that the
// first slot of a launch pumps the price 20-130% before any bot can act —
// so buying "early" still means buying after the pump. The shape that
// loses least is picky momentum: only enter a coin that has already proved
// itself (up at least 50% from its birth price, at least 5 SOL of real
// reserves behind it, at least 5 trades, still climbing over its recent
// samples, and this batch's flow net buying), stake a fixed small slice
// (0.02 SOL), bank +15%, and cut losers fast at -2%. The tight stop is
// the whole game: prices gap several percent inside a single slot, so a
// loose stop realises -13% while a 2% stop realises about -9%, and the
// winners (about one trade in four, averaging +20%) only just cover the
// losers plus the ~3% round-trip fees. Coins are never chased past +80%
// above birth and never bought after a dump, and a coin that goes quiet
// is sold so its slot can work again.
//
// Everything here is a pure function of the batches the harness sends: no
// clock, no environment reads, no unseeded randomness, so two runs on the
// same replay answer every batch identically.

import type { Batch, BotState, BuyInput, OrderInput, Pubkey, SellInput } from './vendor/makefun-bot.ts';
import { LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';

// ---- tunables (all in lamports / basis points / slots) -----------------

// One stake: 0.02 SOL. A round trip must be at least 0.01 SOL to count
// toward the 20-distinct-mints bar, and the per-order tx fee (0.000105 SOL)
// plus ~1.25% of curve fees each way means a 0.02 SOL stake pays roughly
// 3% a round trip; the exits below are sized so a win covers many losses.
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 50n;
// Never open a position smaller than this; below it the fees eat the trade
// and the round trip may not clear the 0.01 SOL bar.
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n;
// How far a fill may slip from the price at decision time (15%).
const MAX_SLIPPAGE_BPS = 1500;

// Entry: a coin is a candidate from its first sight until this many slots
// later; after that it is stale and no longer an early entry. The window
// is deliberately short: with only five position slots and new coins
// arriving constantly, an old waiting coin is a late entry, and late
// entries lose — so a coin whose window has passed is dropped for good.
const ENTRY_WINDOW_SLOTS = 200;
// The coin must already be up at least 50% from the first price we saw
// (proof it is a real pump, not noise) but no more than 80% above it
// (never chase a coin that already mooned while it waited for a slot),
// and must not have dumped more than 15% from that first price.
const ENTRY_MIN_RISE_BPS = 5000;
const ENTRY_MAX_RISE_BPS = 8000;
// It must have real money behind it (at least 5 SOL of real reserves),
// at least 5 trades, still be climbing at least 3% across the recent
// samples we kept, and this batch's flow must be net buying.
const ENTRY_MIN_TRADES = 5;
const ENTRY_MIN_REAL_SOL = 5n * LAMPORTS_PER_SOL;
const ENTRY_MOMENTUM_BPS = 300;
// How many recent price samples to keep per mint for the momentum read.
const SAMPLE_WINDOW = 10;

// Exits, all measured against the true cost per token paid (fees included).
const TAKE_PROFIT_BPS = 1500; // bank the win at +15%
const STOP_LOSS_BPS = 200; // cut the loser at -2%: prices gap inside a
// slot, so a loose stop realises far worse than its trigger.
const TRAIL_ARM_BPS = 3000; // once the peak is +30% over entry...
const TRAIL_DROP_BPS = 1500; // ...exit if it falls 15% back from the peak
const STALE_SLOTS = 1200; // free the slot when a coin goes quiet
const STALE_EXIT_BPS = 300; // ...unless it is still up 3% or more
const COOLDOWN_SLOTS = 1200; // wait this long before re-entering a mint

// ---- per-mint bookkeeping ----------------------------------------------

interface PriceSample {
  slot: number;
  price: number; // lamports per token, virtual_quote / virtual_token
}

interface OpenTrade {
  /** Lamports paid per token on the buy fill, fees included. */
  costPerToken: number;
  /** Highest price seen since entry, for the trailing stop. */
  peak: number;
  /** Slot the buy fill was observed, for the staleness exit. */
  enteredSlot: number;
}

interface MintBook {
  /** First price ever seen on this curve. */
  firstPrice: number | null;
  /** Slot this mint was first seen. */
  firstSlot: number | null;
  /** Recent price samples, oldest first, capped at SAMPLE_WINDOW. */
  samples: PriceSample[];
  /** Trades seen on the curve so far. */
  trades: number;
  /** Set while a position in this mint is open. */
  trade: OpenTrade | null;
  /** Do not re-enter before this slot. */
  cooldownUntil: number;
}

/** Price of a curve in lamports per token, or null when it cannot be read. */
function curvePrice(state: BotState, mint: Pubkey): number | null {
  const curve = state.curves.get(mint);
  if (curve === undefined) return null;
  if (curve.virtual_token_reserves <= 0n || curve.virtual_quote_reserves <= 0n) return null;
  return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
}

/** Return of `now` against `then`, in basis points (rounded toward zero). */
function riseBps(now: number, then: number): number {
  if (then <= 0 || now <= 0) return 0;
  return Math.floor(((now - then) / then) * 10_000);
}

export function createStrategy(): {
  onBatch(state: BotState, batch: Batch): OrderInput[];
} {
  const books = new Map<Pubkey, MintBook>();

  function book(mint: Pubkey): MintBook {
    let b = books.get(mint);
    if (b === undefined) {
      b = { firstPrice: null, firstSlot: null, samples: [], trades: 0, trade: null, cooldownUntil: 0 };
      books.set(mint, b);
    }
    return b;
  }

  return {
    onBatch(state, batch) {
      const { caps } = state.hello;
      const txFee = state.txFeeLamports();
      const orders: OrderInput[] = [];

      // ---- 1. Fold in the fills that resolved since the last batch. ----
      for (const fill of batch.fills) {
        const b = books.get(fill.mint);
        if (b === undefined) continue;
        if (fill.status !== 'filled') continue;
        if (fill.side === 'buy') {
          const tokens = Number(BigInt(fill.token_amount));
          const paid = Number(BigInt(fill.quote_lamports));
          if (tokens > 0 && paid > 0) {
            const cost = paid / tokens;
            b.trade = { costPerToken: cost, peak: cost, enteredSlot: batch.slot };
          }
        } else {
          // Any sell — ours or a harness close on completion / flatten —
          // ends the trade and starts the cooldown for this mint.
          b.trade = null;
          b.cooldownUntil = batch.slot + COOLDOWN_SLOTS;
        }
      }

      // ---- 2. Refresh what we know from this batch's events. -----------
      // Buy/sell volume per mint inside this batch, for the entry filter.
      const buyVol = new Map<Pubkey, bigint>();
      const sellVol = new Map<Pubkey, bigint>();
      for (const event of batch.events) {
        const b = book(event.mint);
        if (b.firstSlot === null) b.firstSlot = batch.slot;
        if (event.event === 'TradeEvent') {
          b.trades += 1;
          const vol = BigInt(event.sol_amount);
          if (event.is_buy) buyVol.set(event.mint, (buyVol.get(event.mint) ?? 0n) + vol);
          else sellVol.set(event.mint, (sellVol.get(event.mint) ?? 0n) + vol);
        }
        if (b.firstPrice === null && event.event !== 'CompleteEvent') {
          // The birth price comes from the event itself, not from the
          // batch-end reserves: a launch's first slot already pumps the
          // price 20-130%, and measuring the rise from the pumped price
          // would set the entry bar far too high. A CreateEvent carries
          // the true birth price; a first sight via a trade uses that
          // trade's post-trade price, as the harness's own accounting does.
          const vt = BigInt(event.virtual_token_reserves);
          const vq = BigInt(event.virtual_quote_reserves);
          if (vt > 0n && vq > 0n) b.firstPrice = Number(vq) / Number(vt);
        }
        // One sample per batch per mint, at the batch-end price; a mark
        // with an older slot than the samples already kept is ignored so
        // the window stays in slot order.
        const price = curvePrice(state, event.mint);
        if (price !== null) {
          const last = b.samples[b.samples.length - 1];
          if (last !== undefined && last.slot === batch.slot) last.price = price;
          else if (last === undefined || last.slot < batch.slot) {
            b.samples.push({ slot: batch.slot, price });
            if (b.samples.length > SAMPLE_WINDOW) b.samples.shift();
          }
        }
      }
      // Marks carry the latest reserves for held / pending mints even when
      // they had no event this batch, so exits are priced on fresh data
      // and the trailing peak stays current.
      for (const mark of batch.marks) {
        const b = books.get(mark.mint);
        if (b !== undefined && b.trade !== null) {
          const price = curvePrice(state, mark.mint);
          if (price !== null && price > b.trade.peak) b.trade.peak = price;
        }
      }

      // ---- 3. Exits first: protect the bankroll before opening more. --
      const pendingSell = new Set<Pubkey>();
      const pendingBuy = new Set<Pubkey>();
      for (const p of state.pending.values()) {
        if (p.order.side === 'sell') pendingSell.add(p.order.mint);
        else pendingBuy.add(p.order.mint);
      }
      for (const [mint, holding] of state.positions) {
        if (pendingSell.has(mint)) continue;
        const b = books.get(mint);
        const price = curvePrice(state, mint);
        if (b === undefined || b.trade === null || price === null) continue;
        const { costPerToken, peak, enteredSlot } = b.trade;
        if (price > peak) b.trade.peak = price;
        const gainBps = riseBps(price, costPerToken);
        const fromPeakBps = riseBps(price, b.trade.peak);
        const stale = batch.slot - enteredSlot > STALE_SLOTS;
        let reason: string | null = null;
        if (gainBps >= TAKE_PROFIT_BPS) reason = 'take-profit';
        else if (gainBps <= -STOP_LOSS_BPS) reason = 'stop-loss';
        else if (b.trade.peak >= costPerToken * (1 + TRAIL_ARM_BPS / 10_000) && fromPeakBps <= -TRAIL_DROP_BPS) reason = 'trailing-stop';
        else if (stale && gainBps < STALE_EXIT_BPS) reason = 'stale';
        if (reason === null) continue;
        if (orders.length >= caps.max_orders_per_batch) break;
        const sell: SellInput = {
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        };
        orders.push(sell);
        pendingSell.add(mint);
      }

      // ---- 4. Entries: picky momentum, newest first. -------------------
      // Candidates are visited newest first: with only five position slots
      // and new coins arriving constantly, the freshest coin is the
      // earliest entry, and an older waiting coin is a late entry that
      // loses — so fresh coins take the free slots, and a coin whose
      // window has passed is dropped for good.
      let freeCash = state.freeCashLamports();
      let slots = caps.max_open_positions - state.committedPositionCount();
      const waiting = [...books.entries()].reverse();
      for (const [mint, b] of waiting) {
        if (orders.length >= caps.max_orders_per_batch) break;
        if (slots <= 0) break;
        if (b.firstSlot === null) continue;
        if (batch.slot - b.firstSlot > ENTRY_WINDOW_SLOTS) continue;
        if (state.positions.has(mint) || pendingBuy.has(mint)) continue;
        if (batch.slot < b.cooldownUntil) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (b.trades < ENTRY_MIN_TRADES) continue;
        if (b.firstPrice === null || b.samples.length < 3) continue;
        if (curve.real_quote_reserves < ENTRY_MIN_REAL_SOL) continue;
        const price = curvePrice(state, mint);
        if (price === null) continue;
        // Already up a lot from birth, but not already run away.
        const fromBirthBps = riseBps(price, b.firstPrice);
        if (fromBirthBps < ENTRY_MIN_RISE_BPS || fromBirthBps > ENTRY_MAX_RISE_BPS) continue;
        // Still climbing over the recent samples.
        const oldest = b.samples[0];
        if (riseBps(price, oldest.price) < ENTRY_MOMENTUM_BPS) continue;
        // This batch's flow is net buying, not distribution.
        const buys = buyVol.get(mint) ?? 0n;
        const sells = sellVol.get(mint) ?? 0n;
        if (buys <= sells) continue;
        // The size cap must let us put on a meaningful stake.
        const cap = state.maxBuyLamports(mint);
        if (cap < MIN_BUY_LAMPORTS) continue;
        const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
        if (freeCash < amount + txFee) continue;
        const buy: BuyInput = {
          side: 'buy',
          mint,
          quote_lamports: amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        };
        orders.push(buy);
        pendingBuy.add(mint);
        freeCash -= amount + txFee;
        slots -= 1;
      }

      return orders;
    },
  };
}
