# OPTIC · Sui Overflow 2026 · Submission Form Packet

> Copy/paste-ready text for the overflow.sui.io submission form.
> Repo: https://github.com/Zerxxz/OPTIC-PROJECT
> License: Apache-2.0
> Submission date: 2026-06-10
> Version: v0.2.0

---

## Project name

```
OPTIC
```

## One-line tagline (<= 80 chars)

```
On-chain Predictable Transparent Intelligence for Commerce — a verifiable AI quant agent for DeepBook.
```

## Description (<= 500 words)

OPTIC is a **verifiable, auditable AI quant agent** that trades on DeepBook with
strict, on-chain risk management. Where most "AI agent" demos are black boxes,
OPTIC makes every decision reproducible: the strategy is committed to Walrus and
its `sha256` lives inside the `core::Agent` Move object, the multi-agent
decision (Quant → Risk → Executor) is logged as a `walrus_adapter::AuditEntry`
on-chain, and the demo site itself is hosted on Walrus Sites — no AWS, no
private server.

**v0.2.0 highlights.** The orchestrator now executes **real DeepBook V3 PTBs**
(`place_limit_order` / `open_hedge`) via the executor cap, not synthetic digests.
The **Strategy Studio** (a new Walrus Site page) lets a user describe a
strategy in natural language — the LLM produces a canonical JSON spec, which
is validated, hashed, and anchored on-chain. The **OPTIC Leaderboard** ranks
every agent on-chain by Sharpe / PnL / volume and is recomputable by anyone.
Strategies can be minted as **StrategyNFT** objects and traded on Sui Kiosk
with author royalties. A **Verifiable Backtest Harness** (`BacktestRun` +
`BacktestResult` Move objects) lets anyone reproduce a strategy's historical
PnL on-chain. **Agent Squads** let N agents share a Treasury and vote on every
cycle, weighted by their rolling Sharpe.

**What it does.** The owner uploads a strategy blob to Walrus, the orchestrator
runs a 3-agent decision loop every tick, and the resulting trades are gated by
three independent `core::AgentCap` objects (`quant`, `risk`, `executor`). The
`Treasury<T>` enforces per-tx caps, daily-loss circuits, and leverage bps. When
realized vol crosses a threshold, the `RiskAgent` opens a **DeepBook Predict**
`NO` hedge at 5% OTM with 24h expiry, sized at 1% of treasury — turning a
single-agent quant into a spot + derivatives flow.

**What's on-chain.** Eight Move modules in `contracts/optic/`: `core`,
`treasury`, `deepbook_adapter`, `walrus_adapter`, `predict_adapter`,
`strategy_nft`, `backtest`, `squad`. 60/60 Move unit tests pass on Sui framework
`9eaf47af2`. The off-chain TypeScript orchestrator in `orchestrator/` has
19/19 integration tests covering synth + live modes, paused agents, empty
treasuries, daily-loss circuits, vol-spike hedges, and executor veto logic.

**Why it's not a chat bot.** A chat bot is `prompt → LLM → action`. OPTIC is
deterministic strategies (mean-reversion, momentum, market-making) running
through a multi-agent state machine with risk veto, on-chain commitment, and
public audit. The LLM is used only at strategy-intent time; once the spec is
committed, the agent runs without it.

**Stack.** Move · Sui object model · DeepBook V3 (CLOB + Predict) · Walrus
(blob + Site + Kiosk) · zkLogin · SuiNS · Sui Kiosk · OpenRouter (LLM).

**Track alignment.** One project, four tracks: Agentic Web (core, $30K), DeFi
& Payments (core, $30K), DeepBook (specialized, $70K), Walrus (specialized,
$70K). Combined potential: $200K+.

## Track selection

```
[x] Agentic Web ($30K 1st)
[x] DeFi & Payments ($30K 1st)
[x] DeepBook ($70K specialized)
[x] Walrus ($70K specialized)
```

## Repository URL

```
https://github.com/Zerxxz/OPTIC-PROJECT
```

## Commit hash (verifiable state)

```
3c4aff4  ui: cyan-dominant Sui palette + animated water ripple effect
d193b06  ui: split into 6 pages + cyan-dominant palette + water ripples
722bc0a  ui: redesign with Sui brand palette (deep ocean + cyan)
796aeb7  OPTIC v0.1.0 — Sui Overflow 2026 submission
```

## Live demo (Walrus Site — to be deployed)

```
TBD: optic.sui
Fallback:  http://localhost:8089/  (after `cd frontend/site && python3 -m http.server 8089`)
```

## Submission video (90s, storyboard in docs/DEMO.md)

```
TBD: link to be recorded
Storyboard: 0:00 title → 0:10 Walrus site → 0:25 Move modules → 0:45 tests → 1:05 demo cycle → 1:25 live decisions → 1:40 final card
```

## Identity (SuiNS)

```
optic.sui      Main project identity
quant.sui      Quant agent identity
risk.sui       Risk agent identity
executor.sui   Executor agent identity
```

## Tech keywords

```
Move, Sui, DeepBook V3, Walrus, Walrus Sites, Sui Kiosk, SuiNS, zkLogin,
multi-agent, on-chain audit, risk management, binary options, CLOB,
TypeScript, pnpm workspaces, Playwright
```

## How to verify (3 commands)

```bash
# 1. Move unit tests
cd contracts/optic && sui move test              # 38/38 ✅

# 2. Orchestrator integration tests
cd ../../orchestrator && npx tsx --test src/__tests__/orchestrator.test.ts  # 12/12 ✅

# 3. Live decision stream
npx tsx scripts/demo-cycle.mts --n 30            # prints real Decision objects
```

## Team

```
Solo: Lort (0xBojeng) — @Zerxxz
```

## License

```
Apache-2.0
```
