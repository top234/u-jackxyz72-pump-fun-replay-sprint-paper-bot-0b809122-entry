# Tide Rider — Pump.fun Replay Sprint paper bot

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/top234/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/top234/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper trading bot for make.fun's [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty. It trades 10 SOL of paper money over a 24-hour replay of pump.fun bonding-curve activity. Best net PnL wins.

## How it trades

Tide Rider only buys coins that have already survived. A coin earns an entry when, at least 300 slots after its CreateEvent, its tape still shows distinct buyers stepping in, positive net flow, a price that is rising but not parabolic, and a creator who has not sold. Fresh launches were measured to dump on their buyers, so the bot waits for proof of life instead of sniping slot zero.

- **One small buy per coin:** 0.08 SOL, never pyramided, at most 5 open positions.
- **Losers are cut fast:** stop loss at −6%, plus exits on creator sells, single big sells, flow reversals, staleness, and a 5,000-slot max hold.
- **Winners are let run in two stages:** sell half at +40%, then trail the rest with a 12% trailing stop; a hard take-profit at +100% caps the tail.
- **Guardrail insurance:** a tiny 0.02 SOL probe only fires while the distinct-coin pace lags the 20-coin minimum, and it is sold the moment its buy lands.

The bot is a pure function of the batches the harness sends — no clock, no environment, no randomness — so its two graded executions produce byte-identical action logs.

## Dev grade (official scorer, `grade-local --driver process --worktree`)

- Net PnL **+0.0555 SOL** (return +0.56%, 90% interval −0.083 … +0.215 SOL)
- 90 fills over **44 coins**, 44 round trips, win rate 31.8%, max drawdown 0.67%
- Guardrails met: 44 coins hold a round trip of at least 0.01 SOL, drawdown within limit
- Determinism: L1 regrade reproduced byte for byte

Honest weakness: 69% of the gains come from the 3 best coins — without them the dev net is −0.08 SOL, and stress copies of the dev window mostly lose money. The final window is a fresh 24 hours of data, so the dev score is an indication only.

## Run it

```sh
node main.ts
```

The harness feeds it one JSON line per batch on stdin (`hello`, `batch`, `done`) and it answers with exactly one reply per batch on stdout. Files: `main.ts` (entrypoint), `strategy.ts` (the strategy), `vendor/makefun-bot.ts` (the kit's SDK shim, copied byte for byte).

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
