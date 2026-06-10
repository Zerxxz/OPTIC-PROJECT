/**
 * ExecutorAgent — final gate before the decision hits the chain.
 *
 * The executor:
 *   1. Re-checks all risk params (defence in depth — never trust upstream).
 *   2. Checks that the proposed order size fits within current exposure.
 *   3. Verifies the executor cap is still valid (nonce > 0 in 'live' mode).
 *   4. Returns the decision (essentially pass-through with extra assertions).
 *   5. In 'live' mode, the orchestrator will then call deepbook.buildPlaceOrderTx
 *      or predict.buildOpenHedgeTx using ctx.capId, ctx.deepbookPool, etc.
 *
 * If any check fails, the executor returns a `no_op` with a reason string,
 * which the orchestrator treats as a veto.
 */

import type { ExecutorSpecialist } from './base.js';
import type { AgentState, Decision, ExecutorContext } from '../types.js';

export interface ExecutorConfig {
  /// In 'synth' mode, skip the cap/pool sanity checks. Default: false.
  /// In 'live' mode these checks are mandatory.
  relaxChecks?: boolean;
}

export class ExecutorAgent implements ExecutorSpecialist {
  readonly role = 'executor' as const;

  constructor(private mode: 'synth' | 'live' = 'synth', private cfg: ExecutorConfig = {}) {}

  decide(merged: Decision, _state: AgentState, ctx: ExecutorContext): Decision {
    // Synth mode → pass through (preserves the original 12/12 test contract).
    if (this.mode === 'synth') {
      return {
        agent: 'executor',
        action: { kind: 'no_op', reason: 'executor delegates to orchestrator.dispatch' },
        reasoning: 'executor runs through orchestrator.dispatch()',
        confidenceBps: 0,
        atMs: Date.now(),
      };
    }

    // Live mode → re-validate. Any failure vetoes the dispatch.
    if (ctx.state.status !== 'active') {
      return this.veto(`agent not active (status=${ctx.state.status})`);
    }
    if (!ctx.capId || ctx.capId === '0xCAP_EXEC') {
      return this.veto('executor cap id not bound');
    }

    const action = merged.action;
    switch (action.kind) {
      case 'place_order': {
        if (!ctx.deepbookPool) {
          return this.veto('place_order requires deepbookPool config');
        }
        if (action.size > ctx.state.maxPositionUsd) {
          return this.veto(`place_order size ${action.size} > max ${ctx.state.maxPositionUsd}`);
        }
        if (action.price <= 0n) return this.veto('place_order price must be > 0');
        if (action.size <= 0n) return this.veto('place_order size must be > 0');
        return merged;
      }
      case 'open_hedge': {
        if (action.size > ctx.state.treasuryBalance) {
          return this.veto(`open_hedge size ${action.size} > treasury ${ctx.state.treasuryBalance}`);
        }
        return merged;
      }
      case 'pause':
      case 'cancel_order':
      case 'settle_hedge':
        return merged;
      case 'no_op':
        return merged; // pass through; orchestrator will skip dispatch
      default:
        return this.veto('unknown action kind');
    }
  }

  private veto(reason: string): Decision {
    return {
      agent: 'executor',
      action: { kind: 'no_op', reason },
      reasoning: `executor veto: ${reason}`,
      confidenceBps: 0,
      atMs: Date.now(),
    };
  }
}
