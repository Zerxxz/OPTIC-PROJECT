# OPTIC · Architecture

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
   └─────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
                              ┌──────────────────────┐
                              │  Walrus (Site)       │
                              │  optic.sui/          │
                              │    index.html        │
                              │    app.js            │
                              │    decisions.json    │
                              └──────────┬───────────┘
                                         │ rendered by
                                         ▼
                              ┌──────────────────────┐
                              │  Browser             │
                              │  zkLogin → owner     │
                              │  sees live decisions │
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
       │   7. dispatch()       — build PTB, sign, submit  │
       │   8. log()            — emit AuditEntry to Walrus│
       └──────────────────────────────────────────────────┘
              ▲                ▲                  ▲
              │                │                  │
        ┌─────┴──────┐  ┌──────┴──────┐  ┌────────┴────────┐
        │ QuantAgent │  │  RiskAgent  │  │ ExecutorAgent  │
        │            │  │             │  │                │
        │ strategy:  │  │ - vol gate  │  │ - re-validates │
        │ - mean-    │  │ - loss gate │  │ - composes PTB │
        │   reversion│  │ - exposure  │  │ - batch+sign   │
        │ - momentum │  │             │  │                │
        │ - market-  │  │ proposes:   │  │                │
        │   making   │  │ - pause     │  │                │
        │            │  │ - open_hedge│  │                │
        │ proposes:  │  │             │  │                │
        │ - place_   │  │             │  │                │
        │   order    │  │             │  │                │
        └────────────┘  └─────────────┘  └────────────────┘
```

## Decision lifecycle (1 cycle = ~3 s)

```
  ┌────────────┐
  │  tick      │  every N seconds (configurable; default 30)
  └─────┬──────┘
        ▼
  fetchState()         ← reads on-chain Agent + PnL + Treasury
        │
        ▼
  fetchMarket()        ← reads DeepBook orderbook (off-chain indexer)
        │
        ▼
  quant.decide()       ← evaluates strategy → Decision{place_order|no_op}
        │
        ▼
  risk.decide()        ← evaluates risk gates → Decision{pause|open_hedge|no_op}
        │
        ▼
  mergeDecisions()     ← risk veto, else pick highest-confidence
        │
        ▼
  validate()           ← defence in depth (sizes, prices, exposure)
        │
        ├── fail → emit decision_rejected, log to Walrus
        │
        ▼
  dispatch()           ← build PTB, sign, submit to Sui
        │
        ├── tx fail → emit decision_rejected, log to Walrus
        │
        ▼
  emit AuditEntry      ← on-chain object + Walrus blob with full reasoning
        │
        ▼
  update PnL object    ← realised_pnl += signed(pnl_of_this_trade)
```

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
predict_adapter    ←────┘
  PredictHedge
```

Zero external Move dependencies. The DeepBook V3 and Walrus SDKs are called from
TypeScript off-chain; the Move contracts just store the canonical types.
