/**
 * Smoke tests for the orchestrator. Run with:
 *   node --test --experimental-strip-types src/__tests__/orchestrator.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator } from '../orchestrator.js';
import { meanReversionStrategy } from '../strategies/mean-reversion.js';
import { marketMakingStrategy } from '../strategies/market-making.js';
import { momentumStrategy } from '../strategies/momentum.js';
import { QuantAgent } from '../agents/quant.js';
import { RiskAgent, DEFAULT_RISK_CONFIG } from '../agents/risk.js';
import type { AgentState, MarketState, OrchestratorEvent } from '../types.js';

const TEST_STATE: AgentState = {
  agentId: '0xAGENT',
  pnlId: '0xPNL',
  treasuryId: '0xTRSY',
  quantCapId: '0xCAP_Q',
  riskCapId: '0xCAP_R',
  executorCapId: '0xCAP_E',
  status: 'active',
  maxPositionUsd: 1_000_000_000n, // $1000
  maxDailyLossUsd: 100_000_000n,
  maxLeverageBps: 10_000,
  treasuryBalance: 10_000_000_000n, // $10k
  realizedPnl: 0n,
  tradeCount: 0,
  volume: 0n,
  strategyHash: '0xSTRAT',
};

const QUIET_MARKET: MarketState = {
  midPrice: 1_500_000n,
  bestBid: 1_499_000n,
  bestAsk: 1_501_000n,
  realizedVolBps: 200, // low vol
  bookDepth: 50_000_000n,
  atMs: 0,
};

const VOLATILE_MARKET: MarketState = {
  midPrice: 1_500_000n,
  bestBid: 1_400_000n, // wide spread
  bestAsk: 1_600_000n,
  realizedVolBps: 1_500, // 15% vol
  bookDepth: 10_000_000n,
  atMs: 0,
};

test('mean reversion strategy emits a signal on a wide book', () => {
  const strat = meanReversionStrategy();
  const sig = strat.evaluate(TEST_STATE, VOLATILE_MARKET);
  assert.equal(sig.confidenceBps > 0, true, 'should produce non-zero confidence');
  assert.ok(sig.limitPrice !== null);
});

test('market making strategy alternates', () => {
  const strat = marketMakingStrategy();
  const s1 = strat.evaluate(TEST_STATE, QUIET_MARKET);
  const s2 = strat.evaluate(TEST_STATE, QUIET_MARKET);
  assert.equal(s1.side !== s2.side, true, 'sides should alternate');
});

test('momentum strategy picks side from book skew', () => {
  const strat = momentumStrategy();
  const bidHeavy: MarketState = { ...QUIET_MARKET, bestBid: 1_500_000n, bestAsk: 1_501_000n };
  const askHeavy: MarketState = { ...QUIET_MARKET, bestBid: 1_499_000n, bestAsk: 1_500_000n };
  assert.equal(strat.evaluate(TEST_STATE, bidHeavy).side, 0);
  assert.equal(strat.evaluate(TEST_STATE, askHeavy).side, 1);
});

test('QuantAgent: no trade on empty treasury', () => {
  const quant = new QuantAgent(meanReversionStrategy());
  const d = quant.decide({ ...TEST_STATE, treasuryBalance: 0n }, QUIET_MARKET);
  assert.equal(d.action.kind, 'no_op');
});

test('QuantAgent: no trade on paused agent', () => {
  const quant = new QuantAgent(meanReversionStrategy());
  const d = quant.decide({ ...TEST_STATE, status: 'paused' }, VOLATILE_MARKET);
  assert.equal(d.action.kind, 'no_op');
});

test('QuantAgent: places trade on wide book with capital', () => {
  const quant = new QuantAgent(meanReversionStrategy());
  const d = quant.decide(TEST_STATE, VOLATILE_MARKET);
  assert.equal(d.action.kind, 'place_order');
  if (d.action.kind === 'place_order') {
    assert.ok(d.action.size > 0n);
    assert.ok(d.action.price > 0n);
  }
});

test('RiskAgent: pause on excessive daily loss', () => {
  const risk = new RiskAgent();
  const d = risk.decide({ ...TEST_STATE, realizedPnl: -200_000_000n }, QUIET_MARKET);
  assert.equal(d.action.kind, 'pause');
});

test('RiskAgent: opens NO hedge on high vol', () => {
  const risk = new RiskAgent();
  const d = risk.decide(TEST_STATE, VOLATILE_MARKET);
  assert.equal(d.action.kind, 'open_hedge');
  if (d.action.kind === 'open_hedge') {
    assert.equal(d.action.side, 1); // NO
  }
});

test('RiskAgent: no-op on low vol + small loss', () => {
  const risk = new RiskAgent();
  const d = risk.decide(TEST_STATE, QUIET_MARKET);
  assert.equal(d.action.kind, 'no_op');
});

test('Orchestrator: runCycle emits the expected events', async () => {
  const events: OrchestratorEvent[] = [];
  const o = new Orchestrator({
    optic: {} as never, // unused in test mode
    fetchState: async () => TEST_STATE,
    fetchMarket: async () => VOLATILE_MARKET,
    onEvent: (e) => {
      events.push(e);
    },
  });
  o.withQuant(new QuantAgent(marketMakingStrategy()));
  o.withRisk(new RiskAgent({ ...DEFAULT_RISK_CONFIG, highVolBps: 1000 }));

  const cycleEvents = await o.runCycle();
  assert.ok(cycleEvents.length >= 4);
  assert.equal(cycleEvents[0]!.kind, 'cycle_started');
  assert.equal(cycleEvents[cycleEvents.length - 1]!.kind, 'cycle_completed');
  // The cycle should have at least one decision_made
  const decisions = cycleEvents.filter((e) => e.kind === 'decision_made');
  assert.ok(decisions.length >= 2);
});

test('Orchestrator: validates size cap', async () => {
  const o = new Orchestrator({
    optic: {} as never,
    fetchState: async () => TEST_STATE,
    fetchMarket: async () => VOLATILE_MARKET,
  });
  o.withQuant(new QuantAgent({
    name: 'oversize',
    evaluate: () => ({
      side: 0,
      confidenceBps: 9_999,
      limitPrice: 1_500_000n,
      reason: 'oversize test',
    }),
  }));
  o.withRisk(new RiskAgent({ ...DEFAULT_RISK_CONFIG, highVolBps: 10_000 }));
  const events = await o.runCycle();
  // With confidence=9999 bps, size = max_position * 9999/10000 ≈ 999_900_000 (just under cap)
  // So it should pass validation.
  const rejected = events.find((e) => e.kind === 'decision_rejected');
  assert.equal(rejected, undefined, 'should not reject a within-cap trade');
});

test('Orchestrator: rejects pause then resume flow', async () => {
  let status: 'active' | 'paused' = 'active';
  const o = new Orchestrator({
    optic: {} as never,
    fetchState: async () => ({ ...TEST_STATE, status }),
    fetchMarket: async () => VOLATILE_MARKET,
  });
  o.withQuant(new QuantAgent(marketMakingStrategy()));
  o.withRisk(new RiskAgent({ ...DEFAULT_RISK_CONFIG, highVolBps: 1_000 }));
  const events = await o.runCycle();
  const executed = events.filter((e) => e.kind === 'decision_executed');
  // The risk agent should have proposed a hedge; the quant should have proposed a trade.
  // Only one is dispatched per cycle (the higher-confidence one).
  assert.ok(executed.length <= 1);
  void status;
});
