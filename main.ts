// Tide Rider — entrypoint bot paper trading pump.fun replay (agent-fun/replay/v2).
// Grader menjalankan `node /bot/main.ts`; harness berbicara lewat stdin/stdout,
// jadi file ini tidak menulis apa pun ke disk maupun ke stdout selain reply
// protokol. Semua logika ada di strategy.ts; shim wire ada di vendor/makefun-bot.ts
// (salinan byte-per-byte SDK kit, bukan kode kami).
//
// Konfigurasi yang diperdagangkan — hasil tuning sim full-window atas 4 fail key
// (lihat DESIGN.md di workdir): hanya koin matang (minAge 300 — koin segar terukur
// dump ke pembeli), hold lebih panjang (maxHold 5000), tape pembuka lebih longgar
// (minTrades 4, minBuyers 3), dan partial take-profit lebih lambat (partialTp 0.4:
// jual separuh di +40%, sisanya trailing). Daerah itu positif bersama (+0,051 SOL
// mean, +0,017 pada fail key terburuk) dengan tetangga yang datar, bukan satu sel
// grid yang kebetulan. Satu penyempurnaan di sesi ini: stop loss 0.10 -> 0.06,
// setelah sweep mengukur dataran 0.05–0.07 (mean +0.068/+0.069/+0.066 vs +0.051
// baseline) dan worst fail key membaik +0.017 -> +0.035. Default strategy.ts
// membawa nilai yang sama; di sini ditulis ulang eksplisit supaya entrypoint
// mencatat persis apa yang diperdagangkan.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS, type Params } from './strategy.ts';

const TUNED_PARAMS: Params = {
  ...DEFAULT_PARAMS,
  minAge: 300,
  maxAge: 100_000,
  maxHold: 5000,
  minTrades: 4,
  minBuyers: 3,
  partialTp: 0.4,
  stopLoss: 0.06,
};

await runBot(createStrategy(TUNED_PARAMS));
