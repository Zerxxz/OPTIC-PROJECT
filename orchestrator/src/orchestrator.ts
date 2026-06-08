/**
 * Orchestrator — coordinates the 3 specialist agents and dispatches the
 * winning decision to the on-chain executor.
 *
 * The orchestrator loop:
 *   1. fetchState()       — read Agent + PnL + Treasury from chain
 *   2. fetchMarket()      — read DeepBook orderbook (mocked in test mode)
 *   3. quant.decide()     — propose a trade
 *   4. risk.decide()      — propose a hedge or pause
 *   5. mergeAndValidate() — run risk gate on quant's decision
 *   6. dispatch()         — execute the winning decision via OpticClient
 *   7. log()              — emit an AuditEntry on Walrus
 */

import type { SpecialistAgent } from './agents/base.js';
import type { AgentState, Decision, MarketState, OrchestratorEvent } from './types.js';
import { QuantAgent } from './agents/quant.js';
import { RiskAgent } from './agents/risk.js';
import { ExecutorAgent } from './agents/executor.js';
import { OpticClient } from '@optic/sdk';

export interface OrchestratorConfig {
  optic: OpticClient;
  /// Inject a custom market state fetcher (for testing).
  fetchMarket?: (state: AgentState) => Promise<MarketState>;
  /// Inject a custom state fetcher.
  fetchState?: () => Promise<AgentState>;
  /// Optional override for the audit log writer.
  onEvent?: (e: OrchestratorEvent) => void | Promise<void>;
}

const DEFAULT_MARKET: MarketState = {
  midPrice: 1_500_000n, // $1.50
  bestBid: 1_499_000n,
  bestAsk: 1_501_000n,
  realizedVolBps: 400,
  bookDepth: 100_000_000n,
  atMs: Date.now(),
};

export class Orchestrator {
  readonly quant: QuantAgent;
  readonly risk: RiskAgent;
  readonly executor: ExecutorAgent;
  private cycleCount = 0;
  private auditSequence = 0;

  constructor(private cfg: OrchestratorConfig) {
    this.quant = new QuantAgent({
      name: 'default',
      evaluate: () => ({
        side: 0,
        confidenceBps: 5_000,
        limitPrice: 1_500_000n,
        reason: 'default',
      }),
    });
    this.risk = new RiskAgent();
    this.executor = new ExecutorAgent();
  }

  withQuant(quant: QuantAgent): this {
    (this as { quant: QuantAgent }).quant = quant;
    return this;
  }

  withRisk(risk: RiskAgent): this {
    (this as { risk: RiskAgent }).risk = risk;
    return this;
  }

  async runCycle(): Promise<OrchestratorEvent[]> {
    this.cycleCount++;
    const events: OrchestratorEvent[] = [];
    const atMs = Date.now();
    const state = await this.fetchState();
    events.push({ kind: 'cycle_started', atMs, agentId: state.agentId });

    const market = await this.fetchMarket(state);

    // 1. Quant decision
    const quantDec = this.quant.decide(state, market);
    events.push({ kind: 'decision_made', decision: quantDec });

    // 2. Risk decision (may override quant)
    const riskDec = this.risk.decide(state, market);
    events.push({ kind: 'decision_made', decision: riskDec });

    // 3. Pick the winning decision
    const winning = this.mergeDecisions(quantDec, riskDec, state);
    if (winning.action.kind === 'no_op') {
      events.push({ kind: 'decision_rejected', reason: 'both no-op', decision: winning });
    }

    // 4. Validate (defence in depth)
    const validationError = this.validate(winning, state);
    if (validationError) {
      events.push({ kind: 'decision_rejected', reason: validationError, decision: winning });
    } else {
      // 5. Dispatch
      try {
        const digest = await this.dispatch(winning);
        events.push({ kind: 'decision_executed', decision: winning, txDigest: digest });
        this.auditSequence++;
      } catch (err) {
        events.push({
          kind: 'decision_rejected',
          reason: `dispatch failed: ${err}`,
          decision: winning,
        });
      }
    }

    events.push({
      kind: 'cycle_completed',
      atMs: Date.now(),
      actionsExecuted: events.filter((e) => e.kind === 'decision_executed').length,
    });

    // Emit to optional listener
    for (const e of events) {
      if (this.cfg.onEvent) await this.cfg.onEvent(e);
    }

    return events;
  }

  private mergeDecisions(quant: Decision, risk: Decision, state: AgentState): Decision {
    // Risk has veto power on trades. If risk says pause, we always pause.
    if (risk.action.kind === 'pause') {
      return { ...risk, agent: 'risk' };
    }
    // If risk opened a hedge, we run both: hedge first, then quant's trade.
    // For simplicity, prefer the highest-confidence non-no-op decision.
    const candidates = [quant, risk].filter((d) => d.action.kind !== 'no_op');
    if (candidates.length === 0) {
      return {
        agent: 'executor',
        action: { kind: 'no_op', reason: 'all specialists returned no-op' },
        reasoning: 'no action',
        confidenceBps: 0,
        atMs: Date.now(),
      };
    }
    candidates.sort((a, b) => b.confidenceBps - a.confidenceBps);
    return candidates[0]!;
  }

  private validate(d: Decision, state: AgentState): string | null {
    if (state.status !== 'active') return 'agent not active';
    switch (d.action.kind) {
      case 'place_order': {
        if (d.action.size > state.maxPositionUsd) return 'size > max position';
        if (d.action.price === 0n) return 'price = 0';
        if (d.action.size === 0n) return 'size = 0';
        return null;
      }
      case 'open_hedge': {
        if (d.action.size > state.treasuryBalance) return 'hedge > treasury';
        if (d.action.strikePrice === 0n) return 'strike = 0';
        return null;
      }
      case 'settle_hedge':
        return null;
      case 'cancel_order':
        return null;
      case 'pause':
        return null;
      case 'no_op':
        return null;
      default:
        return 'unknown action';
    }
  }

  private async dispatch(d: Decision): Promise<string> {
    // In real mode this composes a PTB and submits it.
    // For the orchestrator-only loop we return a synthetic digest.
    return `synth-${this.cycleCount}-${this.auditSequence}-${d.action.kind}`;
  }

  private async fetchState(): Promise<AgentState> {
    if (this.cfg.fetchState) return this.cfg.fetchState();
    // Default mock state for test mode
    return {
      agentId: '0xAGENT',
      pnlId: '0xPNL',
      treasuryId: '0xTRSY',
      quantCapId: '0xCAP_QUANT',
      riskCapId: '0xCAP_RISK',
      executorCapId: '0xCAP_EXEC',
      status: 'active',
      maxPositionUsd: 1_000_000_000n,
      maxDailyLossUsd: 100_000_000n,
      maxLeverageBps: 10_000,
      treasuryBalance: 10_000_000_000n,
      realizedPnl: 0n,
      tradeCount: 0,
      volume: 0n,
      strategyHash: '0xSTRAT',
    };
  }

  private async fetchMarket(state: AgentState): Promise<MarketState> {
    if (this.cfg.fetchMarket) return this.cfg.fetchMarket(state);
    return { ...DEFAULT_MARKET, atMs: Date.now() };
  }
}
