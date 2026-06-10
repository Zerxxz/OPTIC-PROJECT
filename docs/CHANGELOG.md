# CHANGELOG

## v0.2.0 — 2026-06-10 (Sui Overflow 2026 submission upgrade)

### Move contracts (5 → 8 modules)

**New modules:**

- `strategy_nft.move` — `StrategyNFT` + `StrategyNFTRegistry`. Strategies can now be minted as transferable NFT objects and listed on Sui Kiosk with author royalties (up to 10% bps). 6/6 unit tests.
- `backtest.move` — `BacktestRun` (input: strategy hash + fills hash + fills) and `BacktestResult` (output: Sharpe, max drawdown, win rate, all attested). 5/5 unit tests.
- `squad.move` — `Squad` + `Proposal` for multi-agent shared-Treasury DAOs with Sharpe-weighted voting, configurable quorum + pass threshold. 7/7 unit tests.

**Total Move tests: 38 → 60 (all 60 passing ✅).**

### TypeScript SDK (8 → 10 files)

**New modules:**

- `strategy-studio.ts` — LLM-powered `generateStrategySpec()` + `commitStrategy()` + `OpenRouterClient` (provider-agnostic via OpenRouter). 12/12 unit tests.
- `leaderboard.ts` — `computeLeaderboard()` reads AgentRegistry + Agent + PnL on-chain and ranks by Sharpe / PnL / volume. 8/8 unit tests.

**Refactors:**

- `client.ts` — added `forAgent()` and `forTreasury()` lazy binders; exposed `deepbook`, `predict`, `walrus`, `treasury` sub-clients.
- `index.ts` — exports the new modules.

### Orchestrator

- `orchestrator.ts` — added `mode: 'synth' | 'live'` toggle. In `live` mode the `dispatch()` method composes, signs, and submits a real PTB to Sui via `OpticClient.signAndExecute()`. The `ExecutorAgent` now re-validates and can veto in `live` mode.
- `agents/executor.ts` — proper veto logic (cap not bound, agent not active, missing pool, oversize, etc.).
- `agents/base.ts` — added `ExecutorSpecialist` interface.
- `types.ts` — added `ExecutorContext`.
- `__tests__/orchestrator.test.ts` — 12 → 19 tests (added 7 new tests for synth/live modes + executor veto).

### Walrus Site (4 → 6 pages)

- `studio.html` + `studio.js` — Strategy Studio: prompt → JSON spec → sha256 → Walrus.
- `leaderboard.html` + `leaderboard.js` — live leaderboard reading AgentRegistry + Agent + PnL from Sui RPC directly.

### Docs

- `TRACKS.md` — updated with new feature evidence.
- `ARCHITECTURE.md` — v0.2.0 architecture with new modules and flows.
- `README.md` — updated test count and feature list.

## v0.1.0 — 2026-06-08 (initial submission)

- 5 Move modules: core, treasury, deepbook_adapter, walrus_adapter, predict_adapter
- TypeScript SDK with zkLogin
- TypeScript orchestrator with quant/risk/executor agents
- Walrus Site (4 pages: home, how, tracks, decisions)
- 38/38 Move unit tests + 12/12 orchestrator tests
