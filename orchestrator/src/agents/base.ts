/**
 * Agent — base interface for the three specialist agents.
 */

import type { AgentState, Decision, MarketState } from '../types.js';

export interface SpecialistAgent {
  readonly role: 'quant' | 'risk' | 'executor';

  /**
   * Propose a decision given the current agent state and market state.
   * Pure function — must be deterministic for the same inputs (modulo time).
   */
  decide(state: AgentState, market: MarketState): Decision;
}
