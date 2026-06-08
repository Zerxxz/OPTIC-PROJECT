/**
 * Momentum strategy: trade in the direction of recent moves.
 *
 * Toy version: uses best_ask > best_bid to infer "buying pressure" and
 * emits a BUY. Symmetric for SELL.
 */

import type { Strategy, StrategySignal } from './types.js';
import type { AgentState, MarketState } from '../types.js';

export function momentumStrategy(): Strategy {
  return {
    name: 'momentum-v1',
    evaluate(_state: AgentState, market: MarketState): StrategySignal {
      if (market.bestBid === 0n || market.bestAsk === 0n) {
        return { side: 0, confidenceBps: 0, limitPrice: null, reason: 'no book' };
      }
      const mid = market.midPrice;
      if (mid === 0n) {
        return { side: 0, confidenceBps: 0, limitPrice: null, reason: 'no mid' };
      }
      // "bidHeavy" (bid at mid, ask far above mid) means bid pressure is pushing
      // price up → ride momentum with BUY. Symmetric for SELL on askHeavy.
      // bidDelta = |mid - best_bid| (small = bid is near mid = bid pressure up)
      // askDelta = |best_ask - mid| (small = ask is near mid = ask pressure down)
      const askDelta = market.bestAsk - mid;
      const bidDelta = mid - market.bestBid;
      if (askDelta === bidDelta) {
        return { side: 0, confidenceBps: 0, limitPrice: null, reason: 'balanced' };
      }
      if (bidDelta < askDelta) {
        return {
          side: 0, // BUY — bid near mid, ask far above
          confidenceBps: 4_000,
          limitPrice: market.bestAsk - 1n,
          reason: `bid near mid (delta=${bidDelta}) < ask delta=${askDelta} → BUY (momentum with buyers)`,
        };
      }
      return {
        side: 1, // SELL — ask near mid, bid far below
        confidenceBps: 4_000,
        limitPrice: market.bestBid + 1n,
        reason: `ask near mid (delta=${askDelta}) < bid delta=${bidDelta} → SELL (momentum with sellers)`,
      };
    },
  };
}
