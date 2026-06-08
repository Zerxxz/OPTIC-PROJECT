# OPTIC · Track alignment

## Agentic Web (core · $30K + bonuses)

| Criterion | Evidence |
|---|---|
| **Autonomous agent** | `core::Agent` Move object with `status: active|paused|liquidated` state machine |
| **Multi-step decision loop** | `Orchestrator.runCycle()` runs fetch → quant → risk → merge → validate → dispatch → log |
| **User intent delegation** | Owner uploads strategy to Walrus, commits hash on-chain; agent only operates on committed strategy |
| **Recovery / safety** | Capability-gated actions, daily-loss circuit breaker, vol-triggered hedge, defence-in-depth validation |
| **Web/SNS surface** | Walrus Site at `optic.sui` (zkLogin, SuiNS names) |

## DeFi & Payments (core · $30K + bonuses)

| Criterion | Evidence |
|---|---|
| **On-chain primitives** | Move contracts: `Agent`, `Treasury<T>`, `OrderRequest`, `PredictHedge` |
| **Risk-managed trading** | Per-tx caps, daily loss limits, leverage bps caps, automatic Predict hedge on vol |
| **Non-custodial** | Owner holds Treasury; agent has capability, not the balance |
| **Spot + derivatives** | DeepBook V3 (spot CLOB) **and** DeepBook Predict (binary options hedge) in one flow |
| **Audit trail** | `walrus_adapter::AuditEntry` per decision, queryable on-chain |

## DeepBook (specialized · $70K)

| Criterion | Evidence |
|---|---|
| **Uses DeepBook CLOB** | `deepbook_adapter.move` defines `OrderRequest` and `TradeRecord` types that wrap DeepBook V3 calls |
| **Uses DeepBook Predict** | `predict_adapter.move` defines `PredictHedge` for binary-option tail-risk hedge |
| **Novel use case** | Multi-agent quant agent with risk veto + Predict hedge — not a vanilla bot |
| **Tested on testnet** | Move tests pin Sui framework `9eaf47af2` (v1.69) for reproducible build; deploy script targets testnet by default |
| **Open source** | Apache-2.0, repo at `github.com/Zerxxz/OPTIC-PROJECT` |

## Walrus (specialized · $70K)

| Criterion | Evidence |
|---|---|
| **Walrus blob storage** | Strategy + audit log stored as Walrus blobs; `blob_id` referenced on-chain |
| **Walrus Site** | `frontend/site/` is a fully static site deployable to Walrus Sites; no backend, no AWS |
| **Censorship resistance** | The submission video, the decision log, and the agent's reasoning are all retrievable from Walrus blobs |
| **Kiosk integration** | Strategy blobs are published as Sui Kiosk items (transferrable NFT) |
| **Live updates** | The site reads `decisions.json` from Walrus and renders in real time |

## Stacking

A single submission can win across multiple tracks. If OPTIC is strong on:

- **Agentic Web** (verifiable multi-agent) → +$30K
- **DeFi & Payments** (risk-managed trading) → +$30K
- **DeepBook** (CLOB + Predict integration) → +$70K
- **Walrus** (blob + Site + Kiosk) → +$70K

**Combined potential: $200K + university / bounty bonuses.**

The submission is one project; the awards can stack.
