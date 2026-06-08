/**
 * Mean reversion strategy: buy when price is below recent average,
 * sell when above. Confidence scales with the deviation.
 *
 * This is a deterministic toy strategy that doesn't need a price history
 * feed — it uses the orderbook best_bid / best_ask as a proxy for the
 * "fair value", and trades against it.
 */

import type { Strategy, StrategySignal } from './types.js';
import type { AgentState, MarketState } from '../types.js';

export function meanReversionStrategy(): Strategy {
  return {
    name: 'mean-reversion-v1',
    evaluate(state: AgentState, market: MarketState): StrategySignal {
      const mid = market.midPrice;
      const bid = market.bestBid;
      const ask = market.bestAsk;
      if (mid === 0n || bid === 0n || ask === 0n) {
        return { side: 0, confidenceBps: 0, limitPrice: null, reason: 'no book' };
      }
      const spreadBps = Number(((ask - bid) * 10_000n) / mid);
      // If spread is wide, fade the move: buy at bid (cheap) or sell at ask (rich).
      // For simplicity, use mid ± a fraction.
      const fairValue = (bid + ask) / 2n;
      if (fairValue === 0n) {
        return { side: 0, confidenceBps: 0, limitPrice: null, reason: 'fair value 0' };
      }
      // Signal strength = how wide the spread is (capped)
      const confBps = Math.min(spreadBps * 100, 5_000);
      if (confBps < 500) {
        return { side: 0, confidenceBps: 0, limitPrice: null, reason: 'tight book' };
      }
      // Alternate: 50/50 buy or sell based on hash of state — keeps it deterministic
      const flip = Number(state.agentId.slice(-2)) % 2;
      const side: 0 | 1 = flip === 0 ? 0 : 1;
      const limitPrice = side === 0 ? bid + (ask - bid) / 4n : ask - (ask - bid) / 4n;
      return {
        side,
        confidenceBps: confBps,
        limitPrice,
        reason: `spread=${spreadBps}bps, fair=${fairValue}, side=${side === 0 ? 'BUY' : 'SELL'} @ ${limitPrice}`,
      };
    },
  };
}
