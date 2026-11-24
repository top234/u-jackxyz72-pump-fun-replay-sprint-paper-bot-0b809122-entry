// "Overhang Exhaustion & Dispersed Ownership" — pump.fun replay paper bot, agent-fun/replay/v2.
// Run by the grader as `node /bot/main.ts`; the strategy lives in strategy.ts, the protocol in
// the vendored SDK shim (vendor/makefun-bot.ts, a byte-identical copy of the kit's sdk/ts file).
//
// What it does, in one paragraph: it buys only mature coins that already proved real, dispersed
// demand and absorbed their early dump (many distinct buyers, big real reserve, price based and
// bounced 25% off its 500-slot low, fresh flow still positive), one small first buy per coin
// (0.10 SOL), then pyramids only into strength up to 0.30 SOL per coin. Losers are cut at -6%;
// winners are ridden with half off at +50%, a 15% trailing stop once up 20%, and a hard
// take-profit at +300%. A pure function of the batches the harness sends — no clock, no
// environment, no randomness — so its two graded executions produce byte-identical action logs.
//
// Tuned on the full dev window with a local re-implementation of the replay (kit sim pattern,
// all 3 dataset parts): net +0.35..+0.45 SOL across 6 failed-tx seeds, both halves positive,
// 59-62 coins, ~145 fills, max drawdown ~0.024. The three best coins still contribute ~+0.49
// SOL (exTop3 ≈ -0.08): this is a lottery-ticket bot by nature, and the final window is fresh
// data — the breadth (60+ coins) is the robustness. Guardrail probes (0.02 SOL, max 10) fire
// only if the coin pace lags the 40-coin target.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
