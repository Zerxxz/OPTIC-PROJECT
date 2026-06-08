/**
 * Strategy interface.
 *
 * A strategy is a pure function (state, market) → signal.
 * It does NOT place orders — that's the orchestrator's job.
 */

import type { AgentState, MarketState } from '../types.js';

export interface StrategySignal {
  /// 0 = buy, 1 = sell
  side: 0 | 1;
  /// Confidence in 0-10000 bps. 0 means "no signal".
  confidenceBps: number;
  /// Optional limit price. If null, market price is used.
  limitPrice: bigint | null;
  /// Human-readable reason.
  reason: string;
}

export interface Strategy {
  readonly name: string;
  evaluate(state: AgentState, market: MarketState): StrategySignal;
}
