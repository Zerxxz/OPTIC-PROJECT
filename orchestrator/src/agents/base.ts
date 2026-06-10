/**
 * Agent — base interface for the three specialist agents.
 *
 * Quant and Risk agents have a pure `decide(state, market)` signature.
 * The Executor agent receives an additional `ExecutorContext` so it can
 * inspect cap IDs, pool config, and (in 'live' mode) compose PTBs.
 */

import type { AgentState, Decision, MarketState, ExecutorContext } from '../types.js';

export interface SpecialistAgent {
  readonly role: 'quant' | 'risk' | 'executor';

  /**
   * Propose a decision given the current agent state and market state.
   * Pure function — must be deterministic for the same inputs (modulo time).
   */
  decide(state: AgentState, market: MarketState): Decision;
}

/**
 * Extended interface for the Executor agent. The executor receives the
 * merged decision (from quant + risk), re-validates it, and (in 'live'
 * mode) composes the PTB. It returns either:
 *   - a `no_op` Decision with a reason string → blocks the dispatch
 *   - a Decision echoing the merged action → proceeds to dispatch
 */
export interface ExecutorSpecialist extends SpecialistAgent {
  decide(
    merged: Decision,
    state: AgentState,
    ctx: ExecutorContext,
  ): Decision;
}
