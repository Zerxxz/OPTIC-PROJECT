# OPTIC · Demo

## 90-second submission video storyboard

1. **0:00–0:10** — Title card: "OPTIC · On-chain Predictable Transparent Intelligence for Commerce · Sui Overflow 2026".
2. **0:10–0:25** — Show the Walrus Site (`optic.sui`). Hero text + agent stats. Point out that
   the page itself is on Walrus, no AWS.
3. **0:25–0:45** — Open the README in GitHub. Walk through the 5 Move modules and the
   `core::Agent` Move object. Highlight the strategy hash commitment.
4. **0:45–1:05** — Run the orchestrator test suite live in terminal:
   ```
   cd orchestrator
   npx tsx --test src/__tests__/orchestrator.test.ts
   ```
   Show "12/12 pass" with the green checkmark.
5. **1:05–1:25** — Run the demo cycle:
   ```
   npx tsx scripts/demo-cycle.mts --n 14
   ```
   Show real decisions being emitted: mean-reversion picks up a SELL signal, risk
   opens a NO hedge when vol spikes.
6. **1:25–1:40** — Switch back to the Walrus Site. Show the **Live decisions** section
   with the same kind of decisions that just ran. Click filters. Show zkLogin button.
7. **1:40–1:50** — Final card: 4 tracks, $170K+ potential, repo link.

## Local walkthrough (5 minutes)

```bash
# 1. Run the Move unit tests (38/38)
cd contracts/optic
sui move test

# 2. Run the orchestrator integration tests (12/12)
cd ../../orchestrator
npx tsx --test src/__tests__/orchestrator.test.ts

# 3. Watch a live decision stream
cd ..
npx tsx scripts/demo-cycle.mts --n 30

# 4. Open the Walrus Site
cd frontend/site
python3 -m http.server 8089
# → open http://localhost:8089/
```

## What judges should look at first

1. `contracts/optic/sources/core.move` — the Agent object + capability model.
2. `orchestrator/src/orchestrator.ts` — `runCycle()` is the heart of the system.
3. `frontend/site/decisions.js` — the live audit log reader (mock fallback for the demo).
4. `docs/ARCHITECTURE.md` — end-to-end data flow.

## Why this is real, not a mock

- **38 Move unit tests** that exercise the Agent lifecycle, capability minting, treasury
  deposit/withdraw + risk caps, deepbook order types, walrus strategy anchoring, and
  predict hedge settlement — all passing on the real Sui framework (`9eaf47af2`).
- **12 orchestrator tests** that drive the off-chain coordinator through real decision
  paths: a paused agent, an empty treasury, a daily-loss circuit, a vol-spike hedge, a
  size-cap rejection.
- The demo cycle prints real `Decision` objects, not pre-cooked text. The Walrus Site
  reads the same shape and renders it.
- The deployment scripts (`publish.sh`, `init-agent.sh`) are real `sui` CLI wrappers
  that hit a public RPC and dump package + agent ids back to `.env`.

## Why this isn't a "DeFi chat bot"

A chat bot is `prompt → LLM → action`. OPTIC is:

- **Deterministic strategies** (mean-reversion / momentum / MM) — not LLM in the hot path.
- **On-chain state** — every decision is an object with a hash.
- **Multi-agent negotiation** — risk can veto quant.
- **Tail-hedge** — Predict NO on vol spike.
- **Public audit log** — Walrus blob + on-chain anchor, no private server.
- **Censorship-resistant hosting** — the demo page itself is a Walrus Site.

The LLM (if any) sits *outside* the decision loop and is used only to interpret
natural-language strategy descriptions into a strategy blob. The execution path is
pure Move + deterministic TypeScript.
