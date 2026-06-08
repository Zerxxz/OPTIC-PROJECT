#!/usr/bin/env node
/**
 * demo-cycle.ts — Run a small batch of orchestrator cycles against the
 * MOVING market (random walk) and print the resulting decision stream.
 *
 * This is the entry point for the submission video. It uses the
 * orchestrator in test mode (no on-chain dispatch) so reviewers can
 * see the full audit trail without spending gas.
 *
 * Usage:
 *   tsx scripts/demo-cycle.ts           # 10 cycles
 *   tsx scripts/demo-cycle.ts --n 50    # 50 cycles
 *   tsx scripts/demo-cycle.ts --seed 42 # deterministic
 */

import { Orchestrator } from '../orchestrator/src/orchestrator.js';
import { QuantAgent } from '../orchestrator/src/agents/quant.js';
import { RiskAgent, DEFAULT_RISK_CONFIG } from '../orchestrator/src/agents/risk.js';
import {
  meanReversionStrategy,
  marketMakingStrategy,
  momentumStrategy,
} from '../orchestrator/src/strategies/index.js';
import type { AgentState, MarketState } from '../orchestrator/src/types.js';

const args = process.argv.slice(2);
function arg(name: string, def: number): number {
  const i = args.indexOf(name);
  if (i === -1) return def;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : def;
}

const N = arg('--n', 10);
const SEED = arg('--seed', 7);

// Deterministic PRNG
let rngState = SEED >>> 0;
function rng(): number {
  rngState = (rngState * 1664525 + 1013904223) >>> 0;
  return rngState / 0x100000000;
}

const INITIAL_STATE: AgentState = {
  agentId: '0xAGENT_DEMO',
  pnlId: '0xPNL_DEMO',
  treasuryId: '0xTRSY_DEMO',
  quantCapId: '0xCAP_Q',
  riskCapId: '0xCAP_R',
  executorCapId: '0xCAP_E',
  status: 'active',
  maxPositionUsd: 1_000_000_000n, // $1000
  maxDailyLossUsd: 50_000_000n,
  maxLeverageBps: 3_000,
  treasuryBalance: 100_000_000_000n, // $100k
  realizedPnl: 0n,
  tradeCount: 0,
  volume: 0n,
  strategyHash: '0xDEMO_STRAT',
};

// Random-walk market
function makeMarket(t: number): MarketState {
  // Walk mid price in 1e6 units around $1.50
  const drift = Math.sin(t / 4) * 50_000;
  const noise = (rng() - 0.5) * 30_000;
  const mid = 1_500_000 + Math.floor(drift + noise);
  const halfSpread = 500 + Math.floor(rng() * 2000);
  // Volatility: baseline ~300bps, occasional calm (~100) and storms (~1500)
  const phase = t % 11;
  const volBase = phase < 6 ? 100 + Math.floor(rng() * 200)        // calm
                : phase < 9 ? 400 + Math.floor(rng() * 400)        // normal
                :              1200 + Math.floor(rng() * 600);    // storm
  return {
    midPrice: BigInt(mid),
    bestBid: BigInt(mid - halfSpread),
    bestAsk: BigInt(mid + halfSpread),
    realizedVolBps: volBase,
    bookDepth: 50_000_000n + BigInt(Math.floor(rng() * 100_000_000)),
    atMs: Date.now(),
  };
}

const orch = new Orchestrator({
  optic: {} as never,
  fetchState: async () => INITIAL_STATE,
  fetchMarket: async (s) => makeMarket(s.tradeCount),
});

// Pick strategies based on a deterministic rotation
const strategies = [meanReversionStrategy(), marketMakingStrategy(), momentumStrategy()];
orch.withQuant(new QuantAgent(strategies[0]));
orch.withRisk(new RiskAgent({ ...DEFAULT_RISK_CONFIG, highVolBps: 700 }));

console.log(`▶ OPTIC demo · ${N} cycles · seed=${SEED}\n`);

let cycle = 0;
let executed = 0;
let rejected = 0;
for (let i = 0; i < N; i++) {
  cycle++;
  const events = await orch.runCycle();
  const dec = events.find((e) => e.kind === 'decision_executed');
  const rej = events.find((e) => e.kind === 'decision_rejected');
  if (dec) {
    executed++;
    const a = (dec.decision.action as { kind: string; side?: number; price?: bigint; size?: bigint });
    const side = a.side === 0 ? 'BUY ' : a.side === 1 ? 'SELL' : '    ';
    const price = a.price ? a.price.toString().padStart(10) : '   --   ';
    const size = a.size ? a.size.toString().padStart(12) : '      --   ';
    console.log(
      `  [${String(cycle).padStart(2, '0')}] ${side} ${price} size=${size}  ${(dec.decision.reasoning ?? '').slice(0, 60)}`,
    );
  } else if (rej) {
    rejected++;
    console.log(`  [${String(cycle).padStart(2, '0')}] —           no-op / rejected: ${rej.reason.slice(0, 60)}`);
  } else {
    console.log(`  [${String(cycle).padStart(2, '0')}] —           (no events emitted)`);
  }
}

console.log(`\n✓ ${N} cycles · executed=${executed} · rejected=${rejected}`);
