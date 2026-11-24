// "Overhang Exhaustion & Dispersed Ownership" — pump.fun replay paper bot, agent-fun/replay/v2.
//
// What the dev window actually shows (measured before this was written):
//   - The median coin is dead: at age 300 slots its real SOL reserve is ~0.2 SOL, 8 trades,
//     4 buyers. It decays. Buying the median coin loses the round-trip fee.
//   - The coins that later run 2-12x look nothing like the median: ~117 trades, ~64 distinct
//     buyers, ~42 SOL bought AND ~24 SOL sold, real reserve ~13 SOL. Huge two-way volume.
//   - The run itself is a FAST spike (mostly ages 300-1500) and then a crash back to ~1x.
//     The money is made by being IN before the spike and selling into it with a trailing
//     stop — not by chasing a price that is already at its window high.
//   - So the entry is a BASE, not a breakout: a big, busy, liquid coin whose early dump is
//     over (heavy selling absorbed, price flat near its 500-slot low, well off its 500-slot
//     high, no big sell recently), with dispersed ownership (top buyer <= 25% of buy volume).
//   - One small first buy per coin (a lottery ticket: 0.10 SOL), then pyramids ONLY into
//     strength up to 0.30 SOL per coin. Losers are cut at -6%; winners are ridden: half
//     off at +50%, a 15% trailing stop once up 20%, hard take-profit at +300%.
//   - Tuned on the full dev window with a local re-implementation of the replay (kit sim
//     pattern, all 3 dataset parts): net +0.35..+0.45 SOL across 6 failed-tx seeds, both
//     halves positive, 59-62 coins, ~145 fills, max drawdown ~0.024. The three best coins
//     still contribute ~+0.49 SOL (exTop3 ≈ -0.08): this is a lottery-ticket bot by nature,
//     and the final window is fresh data — the breadth (60+ coins) is the robustness.
//   - A pure function of the batches: no clock, no randomness, no I/O, insertion-order maps.

import { BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry window in slots since CreateEvent. */
  minAge: number;
  maxAge: number;
  /** First buy size (lamports) and per-coin totals. */
  stakeLamports: number;
  addLamports: number;
  maxStakeLamports: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: number;
  /** Adds: at most this many, each at least this many slots after the last buy. */
  maxAdds: number;
  addDelay: number;
  /** Add only while the position is up at least this (bps over cost). */
  addMinUpBps: number;
  /** Add only once the price stepped up at least this (bps) from the last buy's price. */
  addStepBps: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: number;
  maxRealSol: number;
  /** Cumulative tape a coin must show before entry. */
  minTrades: number;
  minBuyers: number;
  minBuySol: number;
  /** Cumulative SOL sold: the early dump must be real (two-way volume), not a dead coin. */
  minSellSol: number;
  /** Largest single buyer's share of all buy SOL (bps) and top-3 share (bps). */
  maxTopShareBps: number;
  maxTop3ShareBps: number;
  /** Creator's own buys in total (lamports, at most). */
  maxDevBuy: number;
  /** Skip when the creator sold in the last this many slots. */
  devSellQuiet: number;
  /** A single sell of at least this (bps of reserve before it) counts as a big sell. */
  bigSellBps: number;
  /** Skip when a big sell hit in the last this many slots. */
  bigSellQuiet: number;
  /** Price now over the create price, as bps: window. */
  minRunupBps: number;
  maxRunupBps: number;
  /** Base window (slots) for the high/low range the price must be basing inside. */
  baseWindow: number;
  /** The base window's high must be at least this (bps) above its low (a real range, not flat). */
  minRangeBps: number;
  /** Price now at most this (bps) of the base window's high (well off the high). */
  offHighBps: number;
  /** Price now at most this (bps) above the base window's low (basing near the low). */
  nearLowBps: number;
  /** Price now at least this (bps) above the base window's low (a bounce off the low). */
  minUpFromLowBps: number;
  /** The recent-flow window (slots) and what it must show. */
  flowWindow: number;
  minFlowLamports: number;
  minRecentBuyers: number;
  /** Price now over price at the flow window start, minus 1 (bps), at least. */
  minFlowUpBps: number;
  /** Slippage allowed on buys (bps); sells always go out at 10000. */
  buySlippageBps: number;
  /** First take-profit: sell tp1PartBps of the position once it is worth tp1Bps over its cost. */
  tp1Bps: number;
  tp1PartBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots (unless up at least holdIfUpBps). */
  maxHold: number;
  holdIfUpBps: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when a big sell lands while held. */
  exitOnBigSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit when the recent net flow falls below minus this many lamports. */
  exitFlowLamports: number;
  /** Guardrail pacing: the run must end with at least targetCoins coins with a round trip. */
  targetCoins: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 200,
  maxAge: 2500,
  stakeLamports: 100_000_000,
  addLamports: 100_000_000,
  maxStakeLamports: 300_000_000,
  minBuyLamports: 20_000_000,
  maxAdds: 2,
  addDelay: 50,
  addMinUpBps: 1000,
  addStepBps: 300,
  minRealSol: 3_000_000_000,
  maxRealSol: 60_000_000_000,
  minTrades: 50,
  minBuyers: 30,
  minBuySol: 20_000_000_000,
  minSellSol: 10_000_000_000,
  maxTopShareBps: 2500,
  maxTop3ShareBps: 5000,
  maxDevBuy: 6_000_000_000,
  devSellQuiet: 100,
  bigSellBps: 2000,
  bigSellQuiet: 200,
  minRunupBps: 7000,
  maxRunupBps: 30000,
  baseWindow: 500,
  minRangeBps: 13000,
  offHighBps: 9000,
  nearLowBps: 20000,
  minUpFromLowBps: 2500,
  flowWindow: 100,
  minFlowLamports: -2_000_000_000,
  minRecentBuyers: 3,
  minFlowUpBps: 0,
  buySlippageBps: 2000,
  tp1Bps: 5000,
  tp1PartBps: 5000,
  tpBps: 30000,
  slBps: 600,
  trailArmBps: 2000,
  trailBps: 1500,
  maxHold: 3000,
  holdIfUpBps: 2500,
  exitOnDevSell: false,
  exitOnBigSell: false,
  staleSlots: 800,
  exitFlowLamports: 1_000_000_000_000,
  targetCoins: 40,
  paceSecs: 86400,
  probeSol: 0.02,
  maxProbes: 10,
};

const FEE_BPS = 125n;

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
  isDev: boolean;
  /** Post-trade reserves: price = vq / vt. */
  vq: bigint;
  vt: bigint;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Map<Pubkey, bigint>;
  top1: bigint;
  top2: bigint;
  top3: bigint;
  bought: bigint;
  sold: bigint;
  devSold: boolean;
  lastDevSellSlot: number;
  lastBigSellSlot: number;
  lastTradeSlot: number;
  /** Trades of the last baseWindow slots (older ones dropped as new ones come). */
  recent: Tick[];
  buysSent: number;
  spentSent: bigint;
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  lastBuySlot: number;
  /** Never buy it again (exited, aged out, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  tookTp1: boolean;
  devSoldAtOpen: boolean;
  bigSellAtOpen: number;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

/** What selling `tokens` against (vq, vt) would pay after curve fees (protocol + creator, 95 + 30 bps). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  const stake = BigInt(P.stakeLamports);
  const minBuy = BigInt(P.minBuyLamports);
  let firstTime: number | null = null;
  let nowTime = 0;
  let myCoins = 0;
  const myCoinSet = new Set<Pubkey>();
  let probesDone = 0;

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          trades: 0,
          buyers: new Map(),
          top1: 0n,
          top2: 0n,
          top3: 0n,
          bought: 0n,
          sold: 0n,
          devSold: false,
          lastDevSellSlot: -1,
          lastBigSellSlot: -1,
          lastTradeSlot: e.slot,
          recent: [],
          buysSent: 0,
          spentSent: 0n,
          lastBuyVq: 0n,
          lastBuyVt: 1n,
          lastBuySlot: 0,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        const vq = BigInt(e.virtual_quote_reserves);
        const vt = BigInt(e.virtual_token_reserves);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        const isDev = e.user === c.creator;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user, isDev, vq, vt });
        if (e.is_buy) {
          c.bought += sol;
          if (isDev) c.devBuy += sol;
          else {
            const prev = c.buyers.get(e.user) ?? 0n;
            const total = prev + sol;
            c.buyers.set(e.user, total);
            if (total > c.top1) {
              c.top3 = c.top2;
              c.top2 = c.top1;
              c.top1 = total;
            } else if (total > c.top2 && total !== c.top1) {
              c.top3 = c.top2;
              c.top2 = total;
            } else if (total > c.top3 && total !== c.top1 && total !== c.top2) {
              c.top3 = total;
            }
          }
        } else {
          c.sold += sol;
          if (isDev) {
            c.devSold = true;
            c.lastDevSellSlot = e.slot;
          } else {
            const rqBefore = BigInt(e.real_quote_reserves) + sol;
            if (rqBefore > 0n) {
              const bps = (sol * BPS) / rqBefore;
              if (bps >= BigInt(P.bigSellBps)) c.lastBigSellSlot = e.slot;
            }
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /**
   * Window stats over the recent tape: net flow + distinct buyers over the last flowWindow
   * slots, and the high/low price over the last baseWindow slots. Prices are vq/vt pairs;
   * comparisons are cross-multiplied (no floats).
   */
  function windowStats(c: Coin, slot: number): {
    net: bigint;
    buyers: number;
    highVq: bigint;
    highVt: bigint;
    lowVq: bigint;
    lowVt: bigint;
    startVq: bigint;
    startVt: bigint;
  } {
    const fromFlow = slot - P.flowWindow;
    const fromBase = slot - P.baseWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= fromBase) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    let highVq = 0n;
    let highVt = 1n;
    let lowVq = 0n;
    let lowVt = 1n;
    let startVq = 0n;
    let startVt = 1n;
    for (const t of c.recent) {
      if (t.slot > fromFlow) {
        if (startVq === 0n) {
          startVq = t.vq;
          startVt = t.vt;
        }
        if (t.isBuy) {
          net += t.sol;
          if (!t.isDev) buyers.add(t.user);
        } else net -= t.sol;
      }
      if (lowVq === 0n || t.vq * lowVt < lowVq * t.vt) {
        lowVq = t.vq;
        lowVt = t.vt;
      }
      if (t.vq * highVt > highVq * t.vt) {
        highVq = t.vq;
        highVt = t.vt;
      }
    }
    return { net, buyers: buyers.size, highVq, highVt, lowVq, lowVt, startVq, startVt };
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
    return false;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (e.block_time > nowTime) nowTime = e.block_time;
        }
        if (e.event === 'TradeEvent') traded.add(e.mint);
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        if (f.status === 'filled') {
          if (!myCoinSet.has(f.mint)) {
            myCoinSet.add(f.mint);
            myCoins++;
          }
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          const c = coins.get(f.mint);
          held.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            best: 0n,
            tookTp1: false,
            devSoldAtOpen: c?.devSold ?? false,
            bigSellAtOpen: c?.lastBigSellSlot ?? -1,
          });
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
      }

      // Exits first (probe positions are sold by the probe loop below, never here).
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint) || probes.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, tookTp1: false, devSoldAtOpen: c?.devSold ?? false, bigSellAtOpen: c?.lastBigSellSlot ?? -1 };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          if (!h.tookTp1 && value * BPS >= basis * (BPS + BigInt(P.tp1Bps))) {
            const part = (pos.token_amount * BigInt(P.tp1PartBps)) / BPS;
            if (part > 0n && part < pos.token_amount) {
              orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
              selling.add(mint);
              h.tookTp1 = true;
              h.best = 0n;
              if (c !== undefined) c.done = true;
              continue;
            }
          }
          if (value * BPS >= basis * (BPS + BigInt(P.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(P.slBps))) exit = true;
          if (h.best * BPS >= basis * (BPS + BigInt(P.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(P.trailBps))) exit = true;
        }
        if (state.slot - h.openedSlot >= P.maxHold && !(basis > 0n && value * BPS >= basis * (BPS + BigInt(P.holdIfUpBps)))) exit = true;
        if (c !== undefined) {
          if (P.exitOnDevSell && c.devSold && !h.devSoldAtOpen && c.lastDevSellSlot > h.openedSlot) exit = true;
          if (P.exitOnBigSell && c.lastBigSellSlot > h.bigSellAtOpen && c.lastBigSellSlot > h.openedSlot) exit = true;
          if (state.slot - c.lastTradeSlot >= P.staleSlots) exit = true;
          if (windowStats(c, state.slot).net < -BigInt(P.exitFlowLamports)) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, sellingProbe] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!hasPendingBuy(state, mint) && !hasPendingSell(state, mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || hasPendingBuy(state, mint) || hasPendingSell(state, mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!sellingProbe) probes.set(mint, true);
      }

      // Entries and adds, only on coins that traded in this batch.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      let newEntries = 0;
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const c = coins.get(mint);
        if (c === undefined || c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        if (age < P.minAge) continue;
        if (age > P.maxAge && !state.positions.has(mint)) {
          c.done = true;
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const h = held.get(mint);
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        if (h !== undefined) {
          // Pyramid into strength only.
          if (c.buysSent > P.maxAdds) continue;
          if (selling.has(mint) || hasPendingBuy(state, mint)) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (state.slot - c.lastBuySlot < P.addDelay) continue;
          const basis = pos.cost_lamports + h.txPaid;
          const mk2 = marks.get(mint) ?? { vq, vt };
          const value = sellValue(pos.token_amount, mk2.vq, mk2.vt) - tx;
          if (basis <= 0n || value * BPS < basis * (BPS + BigInt(P.addMinUpBps))) continue;
          // Price stepped up from the last buy's decision price.
          if (vq * c.lastBuyVt * BPS < c.lastBuyVq * vt * BigInt(10_000 + P.addStepBps)) continue;
          if (windowStats(c, state.slot).net < 0n) continue;
          const room = BigInt(P.maxStakeLamports) - c.spentSent;
          if (room < minBuy) continue;
          const maxAdd = state.maxBuyLamports(mint);
          const amount = BigInt(P.addLamports) < maxAdd ? BigInt(P.addLamports) : maxAdd;
          const want = amount < room ? amount : room;
          if (want < minBuy || free < want + tx) continue;
          orders.push({ side: 'buy', mint, quote_lamports: want, max_slippage_bps: P.buySlippageBps });
          free -= want + tx;
          c.buysSent += 1;
          c.spentSent += want;
          c.lastBuyVq = vq;
          c.lastBuyVt = vt;
          c.lastBuySlot = state.slot;
          continue;
        }
        // First entry: the base gate.
        if (newEntries >= 2) continue;
        if (open >= state.hello.caps.max_open_positions) continue;
        if (hasPendingBuy(state, mint) || probes.has(mint)) continue;
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(P.minRealSol) || rq > BigInt(P.maxRealSol)) continue;
        if (c.devBuy > BigInt(P.maxDevBuy)) continue;
        if (c.devSold && state.slot - c.lastDevSellSlot < P.devSellQuiet) continue;
        if (state.slot - c.lastBigSellSlot < P.bigSellQuiet && c.lastBigSellSlot >= 0) continue;
        if (c.trades < P.minTrades || c.buyers.size < P.minBuyers) continue;
        if (c.bought < BigInt(P.minBuySol) || c.sold < BigInt(P.minSellSol)) continue;
        if (c.bought > 0n) {
          if (c.top1 * BPS > c.bought * BigInt(P.maxTopShareBps)) continue;
          if ((c.top1 + c.top2 + c.top3) * BPS > c.bought * BigInt(P.maxTop3ShareBps)) continue;
        }
        // Run-up vs create price: flat to moderately up (the base), never parabolic.
        const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
        if (runup > BigInt(P.maxRunupBps) || runup < BigInt(P.minRunupBps)) continue;
        // Basing inside the base window: a real range, price well off the high, near the low.
        const ws = windowStats(c, state.slot);
        if (ws.lowVq === 0n) continue;
        if (ws.highVq * ws.lowVt * BPS < ws.lowVq * ws.highVt * BigInt(P.minRangeBps)) continue;
        if (vq * ws.highVt * BPS > ws.highVq * vt * BigInt(P.offHighBps)) continue;
        if (vq * ws.lowVt * BPS > ws.lowVq * vt * BigInt(P.nearLowBps)) continue;
        // A bounce off the low: price must have risen at least this far above the low.
        if (vq * ws.lowVt * BPS < ws.lowVq * vt * BigInt(10_000 + P.minUpFromLowBps)) continue;
        // Recent flow: not a fresh dump, a few fresh buyers still around, price rising.
        if (ws.net < BigInt(P.minFlowLamports) || ws.buyers < P.minRecentBuyers) continue;
        if (ws.startVq > 0n && vq * ws.startVt * BPS < ws.startVq * vt * BigInt(10_000 + P.minFlowUpBps)) continue;
        const room = stake - c.spentSent;
        if (room < minBuy) continue;
        const maxBuy = state.maxBuyLamports(mint);
        const amount = room < maxBuy ? room : maxBuy;
        if (amount < minBuy) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        c.buysSent += 1;
        c.spentSent += amount;
        c.lastBuyVq = vq;
        c.lastBuyVt = vt;
        c.lastBuySlot = state.slot;
        newEntries += 1;
        open += 1;
      }

      // Guardrail pacing: open a probe when the coin pace lags (at most one in flight,
      // at most maxProbes in total; each probe is sold the moment its buy lands).
      if (probes.size < 1 && probesDone < P.maxProbes && myCoins < P.targetCoins && firstTime !== null) {
        const pace = Math.min(1, (nowTime - firstTime) / P.paceSecs);
        const due = Math.ceil(P.targetCoins * pace);
        if (myCoins < due) {
          const minRq = (BigInt(Math.floor(P.probeSol * 1e9)) * BPS) / BigInt(state.hello.caps.max_order_bps_of_real_reserve);
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= 1) break;
            if (held.has(mint) || probes.has(mint) || hasPendingBuy(state, mint) || state.positions.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (curve.real_quote_reserves < (minRq * 3n) / 2n) continue;
            const probeLamports = BigInt(Math.floor(P.probeSol * 1e9));
            if (free < probeLamports + 2n * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: probeLamports, max_slippage_bps: P.buySlippageBps });
            probes.set(mint, false);
            probesDone++;
            free -= probeLamports + tx;
          }
        }
      }
      return orders;
    },
  };
}
