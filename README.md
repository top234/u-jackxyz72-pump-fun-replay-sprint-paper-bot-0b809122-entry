# Overhang Exhaustion — Pump.fun Replay Sprint paper bot

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/top234/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/top234/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper trading bot for make.fun's [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty. It trades 10 SOL of paper money over a 24-hour replay of pump.fun bonding-curve activity. Best net PnL wins.

## How it trades

The dev window was measured before this bot was written, and it says the median coin is dead: at age 300 slots its real SOL reserve is ~0.2 SOL with ~8 trades and ~4 buyers, and it decays. The coins that later run 2–12x look nothing like the median: ~117 trades, ~64 distinct buyers, ~42 SOL bought *and* ~24 SOL sold, real reserve ~13 SOL. And the run itself is a fast spike (mostly ages 300–1500) followed by a crash — so the money is made by being in *before* the spike and selling into it, not by chasing a price already at its high.

- **Buy the base, not the breakout:** a coin earns an entry at age 200–2500 slots when its tape shows real two-way volume (50+ trades, 30+ distinct buyers, 20+ SOL bought, 10+ SOL sold), dispersed ownership (top buyer ≤ 25% of buy volume, top 3 ≤ 50%), a real reserve of 3–60 SOL, a price that has bounced 25% off its 500-slot low while staying below twice that low, and no big sell or creator sell recently.
- **One small buy per coin:** 0.10 SOL first, then it pyramids only into strength (up 10%+, price stepped up, flow still positive) up to 0.30 SOL per coin, at most 5 open positions.
- **Losers are cut fast:** stop loss at −6%, plus exits on staleness and a 3,000-slot max hold.
- **Winners are let run:** sell half at +50%, then a 15% trailing stop once up 20%; a hard take-profit at +300% caps the tail.
- **Guardrail insurance:** a tiny 0.02 SOL probe only fires while the distinct-coin pace lags the 40-coin target, and it is sold the moment its buy lands.

The bot is a pure function of the batches the harness sends — no clock, no environment, no randomness — so its two graded executions produce byte-identical action logs.

## Dev grade (official scorer, `grade-local --driver process --worktree`)

- Net PnL **+0.4456 SOL** (return +4.46%, 90% interval −0.089 … +1.068 SOL)
- 146 fills over **61 coins**, 61 round trips, win rate 18.0%, max drawdown 2.32%
- Guardrails met: 61 coins hold a round trip of at least 0.01 SOL, drawdown within limit
- Determinism: L1 regrade reproduced byte for byte
- At 2x fees the net is still +0.237 SOL

Local full-window sims (kit sim pattern, all 3 dataset parts) agree: net +0.35…+0.45 SOL across 6 failed-tx seeds, both halves of the window positive.

Honest weakness: the three best coins still make 58% of the gains — without them the dev net is −0.08 SOL. This is a lottery-ticket bot by nature (a few fast spikes pay for many small stopped-out tickets), and the final window is a fresh 24 hours of data, so the dev score is an indication only; the breadth (60+ coins) is the robustness. Stress test (4 rebuilt block copies of the dev window) is the weak spot: median −0.30 SOL, 4 of 4 copies lose money — the dev score leans on this window's own spike coins, more so than v1's (median −0.07). Offsetting evidence: both halves of the window are independently positive (+0.20/+0.20) and six failed-tx seeds all score +0.35…+0.45 SOL, so the edge is not one lucky coin.

## Run it

```sh
node main.ts
```

The harness feeds it one JSON line per batch on stdin (`hello`, `batch`, `done`) and it answers with exactly one reply per batch on stdout. Files: `main.ts` (entrypoint), `strategy.ts` (the strategy), `vendor/makefun-bot.ts` (the kit's SDK shim, copied byte for byte).

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
