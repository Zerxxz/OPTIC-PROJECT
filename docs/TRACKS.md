# OPTIC · Tracks

## Agentic Web (core · $30K + bonuses)

| Criterion | Evidence |
|---|---|
| **Autonomous agent** | `core::Agent` Move object with `status: active|paused|liquidated` state machine |
| **Multi-step decision loop** | `Orchestrator.runCycle()` runs fetch → quant → risk → executor → merge → validate → dispatch → log |
| **User intent delegation** | Owner uploads strategy to Walrus, commits hash on-chain; agent only operates on committed strategy |
| **Recovery / safety** | Capability-gated actions, daily-loss circuit breaker, vol-triggered hedge, defence-in-depth validation, **proper executor veto** in live mode |
| **Web/SNS surface** | Walrus Site at `optic.sui` (zkLogin, SuiNS names), **Strategy Studio** (LLM-powered strategy generator), **OPTIC Leaderboard** (live on-chain ranking) |
| **Verifiable on-chain AI** | `sdk/strategy-studio.ts` translates natural language → deterministic StrategySpec → sha256 → Walrus blob → on-chain anchor via `core::update_strategy_hash`. The LLM is OFF the hot path. |

## DeFi & Payments (core · $30K + bonuses)

| Criterion | Evidence |
|---|---|
| **On-chain primitives** | Move contracts: `Agent`, `Treasury<T>`, `OrderRequest`, `PredictHedge` |
| **Risk-managed trading** | Per-tx caps, daily loss limits, leverage bps caps, automatic Predict hedge on vol, Sharpe-weighted Squad voting |
| **Non-custodial** | Owner holds Treasury; agent has capability, not the balance |
| **Spot + derivatives** | DeepBook V3 (spot CLOB) **and** DeepBook Predict (binary options hedge) in one flow |
| **Audit trail** | `walrus_adapter::AuditEntry` per decision, queryable on-chain |
| **Verifiable backtest** | `backtest::BacktestRun` + `backtest::BacktestResult` — strategy hash + fills hash + Sharpe + max DD + win rate, all attested on-chain |
| **Multi-agent squads (DAO)** | `squad::Squad` + `squad::Proposal` — multiple agents share Treasury, vote on every cycle with Sharpe-weighted voting |

## DeepBook (specialized · $70K)

| Criterion | Evidence |
|---|---|
| **Uses DeepBook CLOB** | `deepbook_adapter.move` defines `OrderRequest` and `TradeRecord` types that wrap DeepBook V3 calls; orchestrator composes real `tx.moveCall` to `deepbook::clob::place_limit_order` / `place_market_order` |
| **Uses DeepBook Predict** | `predict_adapter.move` defines `PredictHedge` for binary-option tail-risk hedge; orchestrator composes real `predict::open_hedge` PTB |
| **Real PTB execution** | `Orchestrator` has a `mode: 'synth' \| 'live'` toggle. In `live` mode it builds, signs, and submits a real PTB to Sui with `OpticClient.signAndExecute()` |
| **Novel use case** | Multi-agent quant agent with risk veto + Predict hedge — not a vanilla bot |
| **Tested on testnet** | Move tests pin Sui framework `9eaf47af2` (v1.69) for reproducible build; deploy script targets testnet by default |
| **Open source** | Apache-2.0, repo at `github.com/Zerxxz/OPTIC-PROJECT` |

## Walrus (specialized · $70K)

| Criterion | Evidence |
|---|---|
| **Walrus blob storage** | Strategy + audit log stored as Walrus blobs; `blob_id` referenced on-chain |
| **Walrus Site** | `frontend/site/` is a fully static site deployable to Walrus Sites; no backend, no AWS — 6 pages (home, how, tracks, decisions, **studio**, **leaderboard**) |
| **Censorship resistance** | The submission video, the decision log, and the agent's reasoning are all retrievable from Walrus blobs |
| **Kiosk integration** | **StrategyNFT** (`strategy_nft.move`) — strategy blobs wrapped as transferable Sui Kiosk items, with optional royalty_bps for the author. Tradeable IP. |
| **Live updates** | The site reads `decisions.json` from Walrus and renders in real time |

## Stacking

A single submission can win across multiple tracks. If OPTIC is strong on:
- **Agentic Web** (verifiable multi-agent + LLM strategy studio) → +$30K
- **DeFi & Payments** (risk-managed trading + leaderboard + backtest + squads) → +$30K
- **DeepBook** (real CLOB + Predict PTB execution) → +$70K
- **Walrus** (blob + Site + Kiosk + Strategy NFT) → +$70K

**Combined potential: $200K + university / bounty bonuses.**

The submission is one project; the awards can stack.
