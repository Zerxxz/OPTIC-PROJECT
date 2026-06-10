# OPTIC

> **O**n-chain **P**redictable **T**ransparent **I**ntelligence for **C**ommerce

A verifiable, auditable AI quant agent for DeepBook. Strategy hash, decision log, and
PnL are all **on-chain objects**. Anyone can replay every decision, audit the risk
gates, and see exactly why an order was placed — without trusting the operator.

Built for **Sui Overflow 2026**.

---

## Tracks

| Track | Prize | Status |
|---|---|---|
| Agentic Web (core) | $30K 1st | Submitted |
| DeFi & Payments (core) | $30K 1st | Submitted |
| DeepBook (specialized) | $70K | Submitted |
| Walrus (specialized) | $70K | Submitted |

Stack used: **Move** · **Sui object model** · **DeepBook V3 (CLOB + Predict)** · **Walrus (blob + Site)** · **zkLogin** · **SuiNS** · **Sui Kiosk**.

---

## Why OPTIC

Most "AI agent" demos are **black boxes**: a single key, a single prompt, an opaque
trade history. OPTIC is different:

1. **Strategy commitment** — The owner uploads a strategy to Walrus and the
   `core::Agent` Move object stores the `blob_id` + `sha256(strategy_code)` on-chain.
   The Move contract refuses to act on any strategy that doesn't match the
   committed hash.
2. **Capability-gated actions** — Three roles (`quant`, `risk`, `executor`) each
   get a `core::AgentCap`. Orders can only be placed when the right combination
   of caps sign the PTB.
3. **Multi-agent decision log** — A `QuantAgent` proposes trades, a `RiskAgent`
   has veto + can open a Predict hedge, an `ExecutorAgent` does defence-in-depth
   re-checks. The winning decision — with full `reasoning` text — is logged to
   Walrus and anchored to an on-chain `walrus_adapter::AuditEntry`.
4. **Predict tail-hedge** — When realized vol crosses the threshold, the risk
   agent opens a `NO` position on DeepBook Predict with strike = 5% OTM and
   expiry = 24h. Sized at 1% of treasury.
5. **Strategy NFT via Kiosk** — Strategies are first-class objects that can be
   transferred, licensed, or forked through the standard Sui Kiosk marketplace.

---

## Repository layout

```
optic/
├── contracts/optic/        # Move package (5 modules, 38 unit tests)
│   ├── sources/
│   │   ├── core.move              Agent, AgentCap, AuditEntry, Registry
│   │   ├── treasury.move          Treasury<T> with per-tx caps + risk circuit
│   │   ├── deepbook_adapter.move  OrderRequest + TradeRecord types
│   │   ├── walrus_adapter.move    StrategyRef + on-chain audit anchor
│   │   └── predict_adapter.move   PredictHedge (binary options) types
│   └── tests/                     38/38 ✅
├── sdk/                     # TypeScript SDK (OpticClient, AgentBuilder, …)
│   └── src/                       9 files, ~880 LOC
├── orchestrator/            # Multi-agent coordinator
│   ├── src/
│   │   ├── orchestrator.ts        runCycle() with merge + validate + dispatch
│   │   ├── agents/                base, quant, risk, executor
│   │   └── strategies/            mean-reversion, momentum, market-making
│   └── src/__tests__/             12/12 ✅
├── frontend/site/           # Walrus Site (static, no build step)
│   ├── index.html
│   ├── app.js
│   ├── decisions.js
│   ├── style.css
│   └── walrus-sites-config.yaml
├── scripts/                 # Deployment & demo
│   ├── publish.sh
│   ├── init-agent.sh
│   └── demo-cycle.mts
└── docs/
    ├── ARCHITECTURE.md
    ├── DEMO.md
    └── TRACKS.md
```

---

## Quickstart

```bash
# 1. Run the orchestrator tests (no Sui required)
cd orchestrator
npx tsx --test src/__tests__/orchestrator.test.ts
# → 12/12 pass

# 2. Watch a 14-cycle demo
cd ..
npx tsx scripts/demo-cycle.mts --n 14

# 3. Serve the Walrus Site locally
cd frontend/site
python3 -m http.server 8089
# → open http://localhost:8089/
```

### Deploy to Sui testnet

```bash
# Publish the Move package
./scripts/publish.sh --network testnet

# Initialize the agent
./scripts/init-agent.sh --name agent-alpha --strategy mean-reversion

# Inspect the new package + agent ids
cat orchestrator/.env
```

---

## Test status

| Suite | Status |
|---|---|
| Move unit tests (`sui move test`) | **60 / 60** ✅ (5 original + 3 new modules) |
| Orchestrator integration tests | **19 / 19** ✅ (12 original + 7 new) |
| SDK strategy-studio tests | **12 / 12** ✅ |
| SDK leaderboard tests | **8 / 8** ✅ |
| Walrus Site (browser) | renders + filters + zkLogin + Studio + Leaderboard ✅ |

---

## Identity

| Handle | Use |
|---|---|
| `optic.sui` | Main project identity (Walrus Site, SuiNS) |
| `quant.sui` | Quant agent identity |
| `risk.sui` | Risk agent identity |
| `executor.sui` | Executor agent identity |

---

## License

Apache-2.0



