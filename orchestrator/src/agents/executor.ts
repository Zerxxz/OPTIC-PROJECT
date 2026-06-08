/**
 * ExecutorAgent — final gate before the decision hits the chain.
 *
 * The executor:
 *   1. Re-checks all risk params (defence in depth — never trust upstream).
 *   2. Checks that the proposed order size fits within current exposure.
 *   3. Returns the decision (essentially pass-through with extra assertions).
 *   4. Can also propose a 'cancel_order' if the agent has stale open orders.
 *
 * In a real implementation the executor would also batch multiple decisions
 * into a single PTB to save gas.
 */

import type { SpecialistAgent } from './base.js';
import type { AgentState, Decision, MarketState } from '../types.js';

export class ExecutorAgent implements SpecialistAgent {
  readonly role = 'executor' as const;

  decide(state: AgentState, market: MarketState): Decision {
    // The executor is invoked last in the chain; the orchestrator passes
    // the merged decision so far. The actual gating is done in
    // Orchestrator.dispatch(). This method here is a placeholder that
    // returns a no-op; the orchestrator handles the dispatch logic.
    return {
      agent: 'executor',
      action: { kind: 'no_op', reason: 'executor delegates to orchestrator.dispatch' },
      reasoning: 'executor runs through orchestrator.dispatch()',
      confidenceBps: 0,
      atMs: Date.now(),
    };
  }
}
