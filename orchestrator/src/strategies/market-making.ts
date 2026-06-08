/**
 * Market making strategy: post tight limit orders on both sides.
 *
 * For a real implementation you'd want a real orderbook and inventory
 * tracking. This toy version emits alternating BUY/SELL signals at the
 * touch of the book, so the agent accumulates inventory on both sides
 * and lets the spread capture work in its favor.
 */

import type { Strategy, StrategySignal } from './types.js';
import type { AgentState, MarketState } from '../types.js';

export function marketMakingStrategy(): Strategy {
  let tick = 0;
  return {
    name: 'market-making-v1',
    evaluate(_state: AgentState, market: MarketState): StrategySignal {
      tick++;
      if (market.bestBid === 0n || market.bestAsk === 0n) {
        return { side: 0, confidenceBps: 0, limitPrice: null, reason: 'no book' };
      }
      const halfSpread = (market.bestAsk - market.bestBid) / 2n;
      if (halfSpread < 1n) {
        return { side: 0, confidenceBps: 0, limitPrice: null, reason: 'spread too tight' };
      }
      // alternate
      const side: 0 | 1 = tick % 2 === 0 ? 0 : 1;
      const price = side === 0
        ? market.bestBid + halfSpread / 4n   // buy at touch + small premium
        : market.bestAsk - halfSpread / 4n;  // sell at touch - small discount
      return {
        side,
        confidenceBps: 3_000, // medium confidence
        limitPrice: price,
        reason: `MM tick=${tick} side=${side === 0 ? 'BUY' : 'SELL'} @ ${price}`,
      };
    },
  };
}
