/**
 * Strategy registry. Re-exports the built-in strategies and the
 * Strategy/StrategySignal types.
 */

export { meanReversionStrategy } from './mean-reversion.js';
export { marketMakingStrategy } from './market-making.js';
export { momentumStrategy } from './momentum.js';
export type { Strategy, StrategySignal } from './types.js';
