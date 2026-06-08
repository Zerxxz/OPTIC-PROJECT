/**
 * RiskAgent — proposes hedges via DeepBook Predict, and pauses the agent
 * if risk thresholds are breached.
 *
 * The risk agent is conservative: it never proposes a trade. It only
 * proposes hedges, pauses, or no-ops.
 */

import type { SpecialistAgent } from './base.js';
import type { AgentState, Decision, MarketState } from '../types.js';

export interface RiskConfig {
  /// Volatility threshold (bps) above which we open a NO hedge.
  highVolBps: number;
  /// Daily loss (in micro-USDC) above which we pause.
  dailyLossPauseUsd: bigint;
  /// Time horizon for the hedge in ms.
  hedgeHorizonMs: number;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  highVolBps: 800, // 8% realized vol
  dailyLossPauseUsd: 50_000_000n, // $50
  hedgeHorizonMs: 24 * 60 * 60 * 1000, // 24h
};

export class RiskAgent implements SpecialistAgent {
  readonly role = 'risk' as const;

  constructor(private cfg: RiskConfig = DEFAULT_RISK_CONFIG) {}

  decide(state: AgentState, market: MarketState): Decision {
    // Check daily loss circuit breaker
    if (state.realizedPnl < -this.cfg.dailyLossPauseUsd) {
      return {
        agent: 'risk',
        action: { kind: 'pause', reason: 'daily loss circuit breaker' },
        reasoning: `realized PnL = -${-state.realizedPnl} < -${this.cfg.dailyLossPauseUsd} → pause`,
        confidenceBps: 10_000,
        atMs: Date.now(),
      };
    }

    if (state.status !== 'active') {
      return {
        agent: 'risk',
        action: { kind: 'no_op', reason: `agent status = ${state.status}` },
        reasoning: 'risk agent idle: not active',
        confidenceBps: 0,
        atMs: Date.now(),
      };
    }

    // High vol → open a NO hedge to cap downside
    if (market.realizedVolBps > this.cfg.highVolBps) {
      const size = (state.treasuryBalance * 100n) / 10_000n; // 1% of treasury
      if (size < 1_000_000n) {
        return {
          agent: 'risk',
          action: { kind: 'no_op', reason: 'treasury too small to hedge' },
          reasoning: 'vol is high but treasury < $1 — skip hedge',
          confidenceBps: 0,
          atMs: Date.now(),
        };
      }
      return {
        agent: 'risk',
        action: {
          kind: 'open_hedge',
          side: 1, // NO
          underlying: 'SUI',
          strikePrice: (market.midPrice * 95n) / 100n, // 5% OTM put
          size,
          expiresAtMs: Date.now() + this.cfg.hedgeHorizonMs,
        },
        reasoning: `vol ${market.realizedVolBps}bps > ${this.cfg.highVolBps}bps → open NO hedge size=${size} strike=${(market.midPrice * 95n) / 100n}`,
        confidenceBps: 9_000,
        atMs: Date.now(),
      };
    }

    return {
      agent: 'risk',
      action: { kind: 'no_op', reason: 'risk within bounds' },
      reasoning: `vol ${market.realizedVolBps}bps within risk budget, no action`,
      confidenceBps: 0,
      atMs: Date.now(),
    };
  }
}
