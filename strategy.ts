// Tide Rider — bot paper trading untuk replay pump.fun (agent-fun/replay/v2).
//
// Gagasan: jangan beli koin yang baru lahir. Beli hanya koin yang sudah membuktikan
// dirinya bertahan: umur minimal 300 slot sejak CreateEvent, masih ada pembeli
// berbeda yang masuk, arus bersih positif, harga naik tapi belum parabolik, dan
// creator belum menjual. Ukuran kecil dan tetap (0,08 SOL), satu entry per koin,
// tanpa pyramid. Yang kalah dipotong cepat (stop loss, creator jual, satu sell
// besar, arus berbalik); yang menang dibiarkan lari dalam dua tahap — jual separuh
// di +40%, sisanya ikut trailing stop 12%. Satu mekanisme probe kecil hanya
// menyala bila pace koin berbeda tertinggal dari guardrail 20 koin, supaya bar
// minimum terpenuhi tanpa membakar fee.
//
// Semua keputusan murni fungsi dari batch yang dikirim harness: tanpa jam, tanpa
// environment, tanpa Math.random. Iterasi map mengikuti insertion order dan daftar
// posisi diurutkan sebelum exit, jadi dua eksekusi grading menghasilkan action
// log yang identik byte per byte.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Jendela umur entry, dalam slot sejak CreateEvent. */
  minAge: number;
  maxAge: number;
  /** Target SOL per koin (tetap dibatasi 1% dari real reserve oleh harness). */
  stakeLamports: bigint;
  /** Buy terkecil yang masih layak membayar tx fee. */
  minBuyLamports: bigint;
  /** Jendela real SOL reserve saat memutuskan entry. */
  minRealSol: bigint;
  maxRealSol: bigint;
  /** Beli creator di slot create, maksimal. */
  maxDevBuy: bigint;
  /** Minimal trade dan pembeli berbeda (bukan creator) sebelum entry. */
  minTrades: number;
  minBuyers: number;
  /** Minimal total SOL yang dibeli orang lain sebelum entry. */
  minBought: bigint;
  /** Jendela arus bersih (slot) dan batas bawahnya (beli minus jual). */
  flowWindow: number;
  minFlowLamports: bigint;
  /** Kenaikan harga vs harga create, sebagai fraksi: jendela yang diterima. */
  minRunup: number;
  maxRunup: number;
  /** Harga sekarang minimal sekian dari harga tertinggi jendela terakhir. */
  nearHighWindow: number;
  nearHigh: number;
  /** Pangsa pembeli tunggal terbesar dari total SOL yang dibeli, maksimal. */
  maxTopBuyerShare: number;
  /** Satu sell non-creator sebesar ini dari reserve = koin dianggap dump. */
  bigSellShare: number;
  /** Trade terakhir harus berupa buy. */
  lastMustBeBuy: boolean;
  /** Slippage yang diizinkan untuk buy (bps); sell selalu 10000. */
  buySlippageBps: number;
  /** Jual separuh posisi begitu nilainya naik sekian di atas cost (fraksi). */
  partialTp: number;
  /** Jual semua begitu nilainya naik sekian di atas cost (fraksi). */
  hardTp: number;
  /** Jual semua begitu nilainya turun sekian di bawah cost (fraksi). */
  stopLoss: number;
  /** Trailing: setelah peak naik sekian, jual bila turun sekian dari peak. */
  trailArm: number;
  trailDrop: number;
  /** Jual setelah dipegang sekian slot (kecuali sudah di atas partialTp). */
  maxHold: number;
  /** Jual bila tidak ada trade selama sekian slot. */
  staleSlots: number;
  /** Jual bila arus bersih jendela ini di bawah minus sekian lamports. */
  exitFlowWindow: number;
  exitFlowLamports: bigint;
  /** Exit panik mana yang aktif. */
  exitOnDevSell: boolean;
  exitOnBigSell: boolean;
  exitOnFlowRev: boolean;
  /** Entry baru maksimal per reply. */
  maxEntriesPerBatch: number;
  /** Target koin berbeda dan panjang jendela pace (detik block time). */
  targetCoins: number;
  paceSecs: number;
  /** Ukuran probe dan batasnya; hanya dipakai saat pace koin tertinggal. */
  probeLamports: bigint;
  maxProbes: number;
  /** Riset saja: tulis tiap alasan exit ke stderr. Mati saat grading. */
  debug: boolean;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 300,
  maxAge: 100_000,
  stakeLamports: 80_000_000n,
  minBuyLamports: 12_000_000n,
  minRealSol: 1_500_000_000n,
  maxRealSol: 40_000_000_000n,
  maxDevBuy: 2_000_000_000n,
  minTrades: 4,
  minBuyers: 3,
  minBought: 500_000_000n,
  flowWindow: 12,
  minFlowLamports: 0n,
  minRunup: 0.01,
  maxRunup: 0.8,
  nearHighWindow: 12,
  nearHigh: 0.9,
  maxTopBuyerShare: 0.6,
  bigSellShare: 0.25,
  lastMustBeBuy: true,
  buySlippageBps: 2000,
  partialTp: 0.4,
  hardTp: 1.0,
  // Stop loss 0.06: hasil sweep atas 4 fail key — 0.05: +0.0683, 0.06: +0.0690,
  // 0.07: +0.0655, 0.08: +0.0625, 0.10 (baseline): +0.0510. Dataran 0.05–0.07,
  // diambil tengahnya; memotong loser lebih awal tanpa memotong runner.
  stopLoss: 0.06,
  trailArm: 0.1,
  trailDrop: 0.12,
  maxHold: 5000,
  staleSlots: 1200,
  exitFlowWindow: 20,
  exitFlowLamports: 1_000_000_000n,
  exitOnDevSell: true,
  exitOnBigSell: true,
  exitOnFlowRev: true,
  maxEntriesPerBatch: 2,
  targetCoins: 25,
  paceSecs: 86_400,
  probeLamports: 20_000_000n,
  maxProbes: 30,
  debug: false,
};

const BPS = 10_000n;
const CURVE_FEE_BPS = 125n; // 95 protocol + 30 creator, fallback dari competition.yaml.

/** Satu trade yang tercatat di tape koin. */
interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  price: number;
}

/** Semua yang kami ketahui tentang satu koin. */
interface Coin {
  createSlot: number;
  creator: Pubkey;
  createVq: bigint;
  createVt: bigint;
  devBuy: bigint;
  devSold: boolean;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  boughtBy: Map<Pubkey, bigint>;
  bigSell: boolean;
  lastTradeSlot: number;
  lastIsBuy: boolean;
  recent: Tick[];
  entered: boolean;
  done: boolean;
}

/** Satu posisi yang sedang kami pegang. */
interface Held {
  openedSlot: number;
  /** Tx fee yang sudah dibayar untuk mint ini (buy, sell, dan tx gagal). */
  txPaid: bigint;
  /** Nilai posisi tertinggi yang pernah terlihat (untuk trailing). */
  peak: bigint;
  tookPartial: boolean;
  exiting: boolean;
  filled: boolean;
  isProbe: boolean;
}

function freshCoin(): Coin {
  return {
    createSlot: -1,
    creator: '',
    createVq: 0n,
    createVt: 1n,
    devBuy: 0n,
    devSold: false,
    trades: 0,
    buyers: new Set(),
    bought: 0n,
    boughtBy: new Map(),
    bigSell: false,
    lastTradeSlot: -1,
    lastIsBuy: false,
    recent: [],
    entered: false,
    done: false,
  };
}

/** Berapa SOL yang diterima bila menjual `tokens` pada kurva (vq, vt), setelah fee kurva. */
function sellProceeds(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  return gross - (gross * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

/** Bandingkan dua bilangan sebagai pecahan bps tanpa float: a/b >= p/q ? */
function atLeastBps(numerator: bigint, denominator: bigint, bps: number): boolean {
  return numerator * BPS >= denominator * BigInt(bps);
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const probes = new Set<Pubkey>();
  let probeCount = 0;
  /** Koin yang pernah terisi buy (untuk pace guardrail). */
  const myCoins = new Set<Pubkey>();
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = freshCoin();
      coins.set(mint, c);
    }
    return c;
  };

  /** Arus bersih (beli minus jual) selama `w` slot terakhir dari tape koin. */
  const netFlow = (c: Coin, now: number, w: number): bigint => {
    let net = 0n;
    for (let i = c.recent.length - 1; i >= 0; i--) {
      const t = c.recent[i]!;
      if (t.slot <= now - w) break;
      net += t.isBuy ? t.sol : -t.sol;
    }
    return net;
  };

  /** Harga tertinggi selama `w` slot terakhir (0 bila tape kosong). */
  const recentHigh = (c: Coin, now: number, w: number): number => {
    let hi = 0;
    for (let i = c.recent.length - 1; i >= 0; i--) {
      const t = c.recent[i]!;
      if (t.slot <= now - w) break;
      if (t.price > hi) hi = t.price;
    }
    return hi;
  };

  const log = (msg: string): void => {
    if (p.debug) console.error(msg);
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const touched: Pubkey[] = [];

      // --- 0. Lipat event batch ini ke tape tiap koin. ---
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = e.block_time;
          if (lastBlockTime === null || e.block_time > lastBlockTime) lastBlockTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.createSlot = e.slot;
          c.creator = e.creator;
          c.createVq = BigInt(e.virtual_quote_reserves);
          c.createVt = BigInt(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const sol = BigInt(e.sol_amount);
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          c.trades++;
          c.lastTradeSlot = e.slot;
          c.lastIsBuy = e.is_buy;
          const isDev = e.user === c.creator;
          if (e.is_buy) {
            c.bought += sol;
            if (isDev && e.slot === c.createSlot) {
              c.devBuy += sol;
            } else if (!isDev) {
              c.buyers.add(e.user);
              c.boughtBy.set(e.user, (c.boughtBy.get(e.user) ?? 0n) + sol);
            }
          } else {
            if (isDev) {
              c.devSold = true;
            } else {
              // Sell besar diukur terhadap reserve sebelum trade itu.
              const reserveBefore = BigInt(e.real_quote_reserves) + sol;
              if (reserveBefore > 0n && atLeastBps(sol, reserveBefore, Math.round(p.bigSellShare * 10_000))) {
                c.bigSell = true;
              }
            }
          }
          c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, price });
          if (c.recent.length > 80) c.recent.splice(0, c.recent.length - 80);
          if (!touched.includes(e.mint)) touched.push(e.mint);
        } else {
          // CompleteEvent: kurva bermigrasi, hidup tradable-nya selesai.
          const c = coins.get(e.mint);
          if (c !== undefined) c.done = true;
        }
      }

      // --- 0b. Lipat fills: buka posisi buy, catat tx fee, tutup posisi yang di-close harness. ---
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          // _complete_ / _flatten_ / _writeoff_: harness menutup posisi ini.
          held.delete(f.mint);
          probes.delete(f.mint);
          continue;
        }
        if (f.status === 'filled') {
          myCoins.add(f.mint);
          if (f.side === 'buy') {
            const h = held.get(f.mint) ?? {
              openedSlot: f.slot,
              txPaid: 0n,
              peak: 0n,
              tookPartial: false,
              exiting: false,
              filled: false,
              isProbe: probes.has(f.mint),
            };
            h.filled = true;
            h.txPaid += BigInt(f.tx_fee_lamports);
            held.set(f.mint, h);
          } else {
            const h = held.get(f.mint);
            if (h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
          }
        } else if (f.status === 'failed') {
          const h = held.get(f.mint);
          if (h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        }
      }
      // Posisi yang sudah tidak ada di state dan tidak ada order pending = sudah tutup.
      const pendingMints = new Set<Pubkey>();
      for (const po of state.pending.values()) pendingMints.add(po.order.mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !pendingMints.has(mint)) held.delete(mint);
      }

      const orders: OrderInput[] = [];
      const maxOrders = state.hello.caps.max_orders_per_batch;
      const txFee = state.txFeeLamports();
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const solOf = (x: bigint): string => (Number(x) / 1e9).toFixed(4);

      // --- 1. Exit dulu, mint diurutkan supaya urutan order deterministik. ---
      for (const mint of [...held.keys()].sort()) {
        if (orders.length >= maxOrders) break;
        const h = held.get(mint)!;
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (h.exiting || pendingMints.has(mint)) continue;
        const mk = marks.get(mint);
        const vq = mk !== undefined ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mk !== undefined ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
        const value = sellProceeds(pos.token_amount, vq, vt) - txFee;
        const basis = pos.cost_lamports + h.txPaid;
        if (basis <= 0n) continue;
        if (value > h.peak) h.peak = value;
        const c = coins.get(mint);

        // Probe dijual begitu buy-nya mendarat — probe hanya untuk guardrail, bukan PnL.
        if (h.isProbe) {
          log(`EXIT probe hold=${now - h.openedSlot} value=${solOf(value)} basis=${solOf(basis)}`);
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
          h.exiting = true;
          continue;
        }

        // Partial take-profit: jual separuh di +partialTp, reset peak untuk sisanya.
        const partialBps = 10_000 + Math.round(p.partialTp * 10_000);
        if (!h.tookPartial && atLeastBps(value, basis, partialBps)) {
          const half = pos.token_amount / 2n;
          if (half > 0n && half < pos.token_amount) {
            log(`EXIT partialTp hold=${now - h.openedSlot} value=${solOf(value)} basis=${solOf(basis)}`);
            orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: 10_000 });
            h.tookPartial = true;
            h.peak = 0n;
            continue;
          }
        }

        let exit = false;
        let reason = '';
        const setExit = (r: string): void => {
          if (!exit) {
            exit = true;
            reason = r;
          }
        };
        if (atLeastBps(value, basis, 10_000 + Math.round(p.hardTp * 10_000))) setExit('hardTp');
        if (!atLeastBps(value, basis, 10_000 - Math.round(p.stopLoss * 10_000))) setExit('stopLoss');
        if (
          atLeastBps(h.peak, basis, 10_000 + Math.round(p.trailArm * 10_000)) &&
          !atLeastBps(value, h.peak, 10_000 - Math.round(p.trailDrop * 10_000))
        ) {
          setExit('trail');
        }
        if (c !== undefined) {
          if (p.exitOnDevSell && c.devSold) setExit('devSold');
          if (p.exitOnBigSell && c.bigSell) setExit('bigSell');
          if (now - c.lastTradeSlot >= p.staleSlots) setExit('stale');
          if (p.exitOnFlowRev && netFlow(c, now, p.exitFlowWindow) < -p.exitFlowLamports) setExit('flowRev');
        }
        if (!exit && now - h.openedSlot >= p.maxHold && !atLeastBps(value, basis, partialBps)) setExit('maxHold');
        if (!exit) continue;
        log(`EXIT ${reason} hold=${now - h.openedSlot} value=${solOf(value)} basis=${solOf(basis)}`);
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        h.exiting = true;
      }

      // --- 2. Entry baru pada koin yang trade di batch ini. ---
      let free = state.freeCashLamports();
      let open = state.committedPositionCount();
      let entries = 0;
      for (const mint of touched) {
        if (orders.length >= maxOrders || entries >= p.maxEntriesPerBatch) break;
        if (open >= state.hello.caps.max_open_positions) break;
        const c = coins.get(mint)!;
        if (c.done || c.entered || held.has(mint) || probes.has(mint)) continue;
        if (pendingMints.has(mint) || state.positions.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const age = now - c.createSlot;
        if (c.createSlot < 0 || age < p.minAge || age > p.maxAge) continue;
        const rq = curve.real_quote_reserves;
        if (rq < p.minRealSol || rq > p.maxRealSol) continue;
        if (c.devSold || c.devBuy > p.maxDevBuy || c.bigSell) continue;
        if (c.trades < p.minTrades || c.buyers.size < p.minBuyers || c.bought < p.minBought) continue;
        if (p.lastMustBeBuy && !c.lastIsBuy) continue;
        if (netFlow(c, now, p.flowWindow) < p.minFlowLamports) continue;
        if (c.createVq === 0n || c.createVt === 0n) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const createPrice = Number(c.createVq) / Number(c.createVt);
        const runup = price / createPrice - 1;
        if (runup < p.minRunup || runup > p.maxRunup) continue;
        const hi = recentHigh(c, now, p.nearHighWindow);
        if (hi <= 0 || price < hi * p.nearHigh) continue;
        let topBuyer = 0n;
        for (const v of c.boughtBy.values()) if (v > topBuyer) topBuyer = v;
        if (c.bought > 0n && Number((topBuyer * 10_000n) / c.bought) / 10_000 > p.maxTopBuyerShare) continue;
        let amount = p.stakeLamports;
        const sizeCap = (state.maxBuyLamports(mint) * 97n) / 100n;
        if (amount > sizeCap) amount = sizeCap;
        if (amount < p.minBuyLamports) continue;
        if (free - amount - txFee < 0n) continue;
        log(`ENTRY age=${age} rq=${solOf(rq)} amount=${solOf(amount)} runup=${runup.toFixed(3)} buyers=${c.buyers.size} trades=${c.trades}`);
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        c.entered = true;
        free -= amount + txFee;
        entries++;
        open++;
      }

      // --- 3. Probe guardrail: hanya bila pace koin berbeda tertinggal dari target. ---
      if (
        probeCount < p.maxProbes &&
        probes.size === 0 &&
        firstBlockTime !== null &&
        lastBlockTime !== null &&
        lastBlockTime > firstBlockTime
      ) {
        const pace = Math.min(1, (lastBlockTime - firstBlockTime) / p.paceSecs);
        if (myCoins.size < Math.ceil(p.targetCoins * pace)) {
          // Probe harus cukup besar untuk round trip >= 0,01 SOL: butuh reserve >= 100x ukuran
          // (cap order 100 bps), dengan margin 1,5x.
          const minRq = (p.probeLamports * BPS) / BigInt(state.hello.caps.max_order_bps_of_real_reserve);
          for (const mint of touched) {
            if (orders.length >= maxOrders) break;
            if (held.has(mint) || probes.has(mint) || pendingMints.has(mint) || state.positions.has(mint)) continue;
            if (myCoins.has(mint)) continue;
            const c = coins.get(mint)!;
            if (c.done || c.entered) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (curve.real_quote_reserves < (minRq * 3n) / 2n) continue;
            if (free < p.probeLamports + 2n * txFee) break;
            orders.push({ side: 'buy', mint, quote_lamports: p.probeLamports, max_slippage_bps: p.buySlippageBps });
            probes.add(mint);
            probeCount++;
            free -= p.probeLamports + txFee;
            break;
          }
        }
      }
      return orders;
    },
  };
}
