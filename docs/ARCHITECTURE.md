# OPTIC · Architecture (v0.2.0)

## What's new in v0.2.0

- **Real DeepBook V3 PTB execution** — orchestrator now composes, signs, and submits real `place_limit_order` / `open_hedge` PTBs to Sui (was: synthetic digests).
- **Proper executor veto logic** — the Executor agent is no longer a no-op; in `live` mode it re-validates and can block dispatch.
- **Strategy Studio** — LLM-powered strategy generator. User types a natural-language prompt; OPTIC calls OpenRouter, validates the response against a Zod schema, and anchors the resulting StrategySpec on-chain.
- **OPTIC Leaderboard** — on-chain ranking of all agents by Sharpe / PnL / volume, recomputable by anyone.
- **Strategy NFT** — strategies are now mintable as `StrategyNFT` objects that can be listed on Sui Kiosk with author royalties.
- **Verifiable Backtest Harness** — `BacktestRun` + `BacktestResult` Move objects attest strategy + fills hash + Sharpe + max drawdown.
- **Agent Squads (DAO)** — multiple agents share a Treasury and vote on every cycle, weighted by their rolling Sharpe.

## Data flow

```
                              ┌──────────────────────┐
                              │  Owner wallet        │
                              │  (zkLogin / SuiNS)   │
                              └──────────┬───────────┘
                                         │ uploads strategy
                                         ▼
                              ┌──────────────────────┐
                              │  Walrus              │
                              │  strategy_blob.mv    │
                              │  blob_id + sha256    │
                              └──────────┬───────────┘
                                         │ anchored by
                                         ▼
   ┌─────────────────────────────────────────────────────────────┐
   │                     Sui (Move contracts)                    │
   │                                                             │
   │   ┌────────────┐  ┌──────────────┐  ┌────────────────────┐  │
   │   │  Registry  │─▶│  core::Agent │──┤ core::AgentCap × 3 │  │
   │   └────────────┘  │  - strategy  │  │  quant | risk      │  │
   │                   │  - blob_id   │  │  executor          │  │
   │                   │  - status    │  └─────────┬──────────┘  │
   │                   └──────┬───────┘            │             │
   │                          │ owns               │ gated by    │
   │                          ▼                    ▼             │
   │   ┌──────────────────────────────┐  ┌────────────────────┐  │
   │   │ treasury::Treasury<T>        │  │  Action validation │  │
   │   │  - balance<T>                │  │  - max position    │  │
   │   │  - per-tx cap                │  │  - max daily loss  │  │
   │   │  - daily loss circuit        │  │  - leverage bps    │  │
   │   └──────────────┬───────────────┘  │  - treasury >= size│  │
   │                  │                  └─────────┬──────────┘  │
   │                  │                            │             │
   │                  ▼                            ▼             │
   │   ┌──────────────────────────────────────────────────────┐  │
   │   │   deepbook_adapter       predict_adapter             │  │
   │   │   OrderRequest           PredictHedge (NO/YES)       │  │
   │   │   TradeRecord            (binary option on spot)     │  │
   │   └──────────────────────────────────────────────────────┘  │
   │                          │                                   │
   │                          ▼                                   │
   │   ┌──────────────────────────────────────────────────────┐  │
   │   │   walrus_adapter::AuditEntry                          │  │
   │   │   - decision_id, agent, action, reasoning             │  │
   │   │   - walrus_blob_id, sequence, at_ms                   │  │
   │   └──────────────────────────────────────────────────────┘  │
   │                                                             │
   │   ┌──────────────────────────────────────────────────────┐  │
   │   │   strategy_nft (NEW)                                   │  │
   │   │   StrategyNFT + StrategyNFTRegistry                   │  │
   │   │   place+list in Sui Kiosk, royalty_bps                │  │
   │   └──────────────────────────────────────────────────────┘  │
   │                                                             │
   │   ┌──────────────────────────────────────────────────────┐  │
   │   │   backtest (NEW)                                       │  │
   │   │   BacktestRun + BacktestResult                         │  │
   │   │   input/output attested, all on-chain                 │  │
   │   └──────────────────────────────────────────────────────┘  │
   │                                                             │
   │   ┌──────────────────────────────────────────────────────┐  │
   │   │   squad (NEW)                                          │  │
   │   │   Squad + Proposal — multi-agent weighted voting      │  │
   │   │   Sharpe-weighted, quorum + threshold                 │  │
   │   └──────────────────────────────────────────────────────┘  │
   └─────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
                              ┌──────────────────────┐
                              │  Walrus (Site)       │
                              │  optic.sui/          │
                              │    index.html        │
                              │    studio.html       │
                              │    leaderboard.html  │
                              │    decisions.json    │
                              └──────────┬───────────┘
                                         │ rendered by
                                         ▼
                              ┌──────────────────────┐
                              │  Browser             │
                              │  zkLogin → owner     │
                              │  sees live decisions │
                              │  + leaderboard       │
                              │  + studio            │
                              └──────────────────────┘
```

## Off-chain orchestrator (TypeScript)

```
       ┌──────────────────────────────────────────────────┐
       │              Orchestrator.runCycle()             │
       │                                                  │
       │   1. fetchState()     — read Agent + PnL         │
       │   2. fetchMarket()    — read DeepBook orderbook  │
       │   3. quant.decide()   — propose a trade          │
       │   4. risk.decide()    — propose hedge / pause    │
       │   5. mergeDecisions() — risk veto, pick highest  │
       │   6. validate()       — defence in depth         │
       │   7. executor.decide() — re-check + veto (live)   │
       │   8. dispatch()       — build PTB, sign, submit  │
       │   9. log()              — emit AuditEntry on Walrus│
       └──────────────────────────────────────────────────┘
              ▲                ▲                  ▲
              │                │                  │
        ┌─────┴──────┐  ┌──────┴──────┐  ┌────────┴────────┐
        │ QuantAgent │  │  RiskAgent  │  │ ExecutorAgent  │
        │            │  │             │  │                │
        │ strategy:  │  │ - vol gate  │  │ - re-validates │
        │ - mean-    │  │ - loss gate │  │ - composes PTB │
        │   reversion│  │ - exposure  │  │                │
        │ - momentum │  │             │  │                │
        │ - market-  │  │ proposes:   │  │                │
        │   making   │  │ - pause     │  │                │
        │            │  │ - open_hedge│  │                │
        │ proposes:  │  │             │  │                │
        │ - place_   │  │             │  │                │
        │   order    │  │             │  │                │
        └────────────┘  └─────────────┘  └────────────────┘
```

## Modes

- `'synth'` (default for tests): `dispatch()` returns a synthetic digest. Used by the 19/19 orchestrator tests.
- `'live'`: `dispatch()` composes a real PTB via `OpticClient.deepbook.buildPlaceOrderTx()` or `OpticClient.predict.buildOpenHedgeTx()`, signs with the executor cap, and submits to Sui. The executor vetoes any cycle that lacks a real cap, pool config, or violates risk params.

## Strategy Studio (LLM → on-chain)

1. User opens `optic.sui/studio.html` in a browser.
2. Types a natural-language prompt.
3. Front-end calls OpenRouter (`https://openrouter.ai/api/v1/chat/completions`) with the canonical `StrategySpec` schema.
4. Response is validated against the Zod schema.
5. SHA-256 is computed over the canonical JSON.
6. The spec is uploaded to Walrus → blob_id is returned.
7. A `core::update_strategy_hash` PTB anchors the new hash on the Agent.
8. The orchestrator (next tick) reads the spec from Walrus and runs it deterministically — no LLM in the hot path.

## Squad voting

For each cycle, a `Proposal` is opened on a `Squad`:
1. Member weights (= Sharpe × 10000) are snapshotted.
2. Each member agent casts a vote (yes/no) — the vote weight is the snapshot weight.
3. `weighted_yes` / `weighted_total` ≥ `pass_threshold_bps` AND `cast` / `total_weight` ≥ `quorum_bps` → PASS.
4. The passed proposal authorizes a single action (place_order, open_hedge, pause, or no_op).

## Module dependency graph

```
core.move          ←──┐
  Agent                 │
  AgentCap              │
  AuditEntry            │
                        ├── used by Move tests
treasury.move      ←────┤
  Treasury<T>           │
  PerTxCap              │
                        │
deepbook_adapter   ←────┤
  OrderRequest          │
  TradeRecord           │
                        │
walrus_adapter     ←────┤
  StrategyRef           │
  AuditEntry            │
                        │
predict_adapter    ←────┤
  PredictHedge          │
                        │
strategy_nft       ←─────┤  (NEW)
  StrategyNFT            │
  StrategyNFTRegistry    │
                        │
backtest           ←─────┤  (NEW)
  BacktestRun            │
  BacktestResult          │
                        │
squad              ←─────┘  (NEW)
  Squad
  Proposal
```

Zero external Move dependencies. The DeepBook V3 and Walrus SDKs are called from
TypeScript off-chain; the Move contracts just store the canonical types and
implement on-chain accounting + audit.
