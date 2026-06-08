/**
 * QuantAgent — proposes trades based on a pluggable strategy.
 *
 * In production, the strategy is loaded from a Walrus blob (anchored on-chain
 * via `walrus_adapter::anchor_strategy`). The orchestrator periodically
 * fetches the latest strategy and the agent's parameters. For test mode,
 * the strategy is a pure function injected at construction.
 */

import type { SpecialistAgent } from './base.js';
import type { AgentState, Decision, MarketState } from '../types.js';
import type { Strategy } from '../strategies/types.js';

export class QuantAgent implements SpecialistAgent {
  readonly role = 'quant' as const;

  constructor(private strategy: Strategy) {}

  decide(state: AgentState, market: MarketState): Decision {
    if (state.status !== 'active') {
      return {
        agent: 'quant',
        action: { kind: 'no_op', reason: `agent status = ${state.status}` },
        reasoning: 'skipping trade decision: agent not active',
        confidenceBps: 0,
        atMs: Date.now(),
      };
    }

    if (state.treasuryBalance === 0n) {
      return {
        agent: 'quant',
        action: { kind: 'no_op', reason: 'empty treasury' },
        reasoning: 'no capital to deploy',
        confidenceBps: 0,
        atMs: Date.now(),
      };
    }

    const signal = this.strategy.evaluate(state, market);
    if (signal.confidenceBps < 1_000) {
      return {
        agent: 'quant',
        action: { kind: 'no_op', reason: 'weak signal' },
        reasoning: `strategy ${this.strategy.name}: confidence ${(signal.confidenceBps / 100).toFixed(2)}% < 10%`,
        confidenceBps: signal.confidenceBps,
        atMs: Date.now(),
      };
    }

    const size = computeSize(state, signal.confidenceBps);
    const price = signal.limitPrice ?? market.midPrice;
    if (size === 0n) {
      return {
        agent: 'quant',
        action: { kind: 'no_op', reason: 'position too small' },
        reasoning: `size = 0 after risk cap, signal confidence=${(signal.confidenceBps / 100).toFixed(2)}%`,
        confidenceBps: signal.confidenceBps,
        atMs: Date.now(),
      };
    }

    return {
      agent: 'quant',
      action: {
        kind: 'place_order',
        side: signal.side,
        orderType: 0, // limit
        baseAsset: 'SUI',
        quoteAsset: 'USDC',
        price,
        size,
      },
      reasoning: `${this.strategy.name}: ${signal.reason} | side=${signal.side === 0 ? 'BUY' : 'SELL'} size=${size} @ ${price}`,
      confidenceBps: signal.confidenceBps,
      atMs: Date.now(),
    };
  }
}

function computeSize(state: AgentState, confidenceBps: number): bigint {
  // confidence-weighted position: max_position_usd * (confidence / 100%)
  const bps = BigInt(confidenceBps);
  const size = (state.maxPositionUsd * bps) / 10_000n;
  if (size > state.maxPositionUsd) return state.maxPositionUsd;
  if (size < 1_000_000n) return 0n; // < $1 skip
  return size;
}
