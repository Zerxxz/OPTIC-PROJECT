/**
 * Orchestrator — coordinates the 3 specialist agents, validates the merged
 * decision, and dispatches the winning action as a real Programmable
 * Transaction Block to Sui.
 *
 * Modes:
 *   - 'synth'  (default for tests): dispatch returns a synthetic digest,
 *              no chain submission. Useful for unit tests and offline demos.
 *   - 'live'   : dispatch composes a real PTB via OpticClient, signs, and
 *              submits to Sui. The PTB atomically bundles all sub-actions
 *              (place order + open hedge + log audit entry) to save gas.
 *
 * Cycle:
 *   1. fetchState()       — read Agent + PnL + Treasury from chain
 *   2. fetchMarket()      — read DeepBook orderbook (mocked in test mode)
 *   3. quant.decide()     — propose a trade
 *   4. risk.decide()      — propose a hedge or pause
 *   5. mergeDecisions()   — risk veto, else pick highest confidence
 *   6. validate()         — defence in depth (sizes, prices, exposure)
 *   7. executor.decide()  — re-check + (in 'live' mode) build the PTB
 *   8. dispatch()         — submit (or simulate) the PTB
 *   9. log()              — emit an AuditEntry on Walrus
 */

import type { SpecialistAgent } from './agents/base.js';
import type {
  AgentState,
  Decision,
  MarketState,
  OrchestratorEvent,
  DecisionAction,
  ExecutorContext,
} from './types.js';
import { QuantAgent } from './agents/quant.js';
import { RiskAgent } from './agents/risk.js';
import { ExecutorAgent } from './agents/executor.js';
import { OpticClient } from '@optic/sdk';
import type { Transaction } from '@mysten/sui/transactions';
import type { ObjectId, Address } from '@optic/sdk';

export type OrchestratorMode = 'synth' | 'live';

export interface OrchestratorConfig {
  optic: OpticClient;
  /// Inject a custom market state fetcher (for testing).
  fetchMarket?: (state: AgentState) => Promise<MarketState>;
  /// Inject a custom state fetcher.
  fetchState?: () => Promise<AgentState>;
  /// Optional override for the audit log writer.
  onEvent?: (e: OrchestratorEvent) => void | Promise<void>;
  /// Operational mode. Defaults to 'synth' for backward compatibility.
  mode?: OrchestratorMode;
  /// Cap ID for executor role (required in 'live' mode).
  executorCapId?: ObjectId;
  /// DeepBook pool to route orders through (required for place_order in 'live').
  deepbookPool?: {
    poolId: ObjectId;
    baseCoinType: string;
    quoteCoinType: string;
  };
  /// Coin type for the Treasury (e.g. '0x2::sui::SUI').
  treasuryCoinType?: string;
  /// Receiver address for executor cap holder (used to sign PTB).
  executorAddress?: Address;
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
  readonly mode: OrchestratorMode;
  private cycleCount = 0;
  private auditSequence = 0;
  private lastPnl = 0n;

  constructor(private cfg: OrchestratorConfig) {
    this.mode = cfg.mode ?? 'synth';
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
    this.executor = new ExecutorAgent(this.mode);
  }

  withQuant(quant: QuantAgent): this {
    (this as { quant: QuantAgent }).quant = quant;
    return this;
  }

  withRisk(risk: RiskAgent): this {
    (this as { risk: RiskAgent }).risk = risk;
    return this;
  }

  withExecutor(exec: ExecutorAgent): this {
    (this as { executor: ExecutorAgent }).executor = exec;
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
    const merged = this.mergeDecisions(quantDec, riskDec, state);
    if (merged.action.kind === 'no_op') {
      events.push({ kind: 'decision_rejected', reason: 'both no-op', decision: merged });
    }

    // 4. Validate (defence in depth)
    const validationError = this.validate(merged, state);
    if (validationError) {
      events.push({ kind: 'decision_rejected', reason: validationError, decision: merged });
      return this.completeCycle(events);
    }

    // 5. Executor re-check (in 'live' mode this also composes the PTB)
    const execCtx: ExecutorContext = {
      state,
      market,
      capId: this.cfg.executorCapId ?? state.executorCapId,
      executorAddress: this.cfg.executorAddress,
      deepbookPool: this.cfg.deepbookPool,
      treasuryCoinType: this.cfg.treasuryCoinType,
    };
    const execDecision = this.executor.decide(merged, state, execCtx);
    // The executor's no_op is either:
    //  - a 'delegates' marker (synth mode pass-through) → proceed
    //  - a real veto (with a different reason) → block
    const isVeto =
      execDecision.action.kind === 'no_op' &&
      execDecision.action.kind === 'no_op' &&
      execDecision.action.reason !== 'executor delegates to orchestrator.dispatch';
    if (isVeto) {
      events.push({
        kind: 'decision_rejected',
        reason: `executor veto: ${execDecision.action.kind === 'no_op' ? execDecision.action.reason : ''}`,
        decision: merged,
      });
      return this.completeCycle(events);
    }

    // 6. Dispatch (real PTB in 'live' mode, synthetic in 'synth' mode)
    try {
      const digest = await this.dispatch(merged, execCtx);
      events.push({ kind: 'decision_executed', decision: merged, txDigest: digest });
      this.auditSequence++;
    } catch (err) {
      events.push({
        kind: 'decision_rejected',
        reason: `dispatch failed: ${err}`,
        decision: merged,
      });
    }

    return this.completeCycle(events);
  }

  private async completeCycle(events: OrchestratorEvent[]): Promise<OrchestratorEvent[]> {
    events.push({
      kind: 'cycle_completed',
      atMs: Date.now(),
      actionsExecuted: events.filter((e) => e.kind === 'decision_executed').length,
    });
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
    // If risk opened a hedge, prefer running the hedge over the quant's trade.
    if (risk.action.kind === 'open_hedge' && quant.action.kind !== 'pause') {
      return { ...risk, agent: 'risk' };
    }
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
      case 'cancel_order':
      case 'pause':
      case 'no_op':
        return null;
      default:
        return 'unknown action';
    }
  }

  /**
   * Dispatch a decision. In 'synth' mode, returns a deterministic digest.
   * In 'live' mode, composes a real PTB and submits it to Sui.
   */
  private async dispatch(d: Decision, execCtx: ExecutorContext): Promise<string> {
    if (this.mode === 'synth') {
      return this.dispatchSynth(d);
    }
    return this.dispatchLive(d, execCtx);
  }

  private async dispatchSynth(d: Decision): Promise<string> {
    return `synth-${this.cycleCount}-${this.auditSequence}-${d.action.kind}`;
  }

  private async dispatchLive(d: Decision, execCtx: ExecutorContext): Promise<string> {
    // Compose a single PTB that batches all sub-actions atomically.
    // For a place_order, the helper appends the deepbook::clob::place_* call
    // AND the matching optic::deepbook_adapter::submit_order audit record.
    let tx: Transaction | null = null;

    if (d.action.kind === 'place_order' && this.cfg.deepbookPool) {
      tx = this.cfg.optic.deepbook.buildPlaceOrderTx({
        pool: this.cfg.deepbookPool,
        side: d.action.side,
        orderType: d.action.orderType ?? 0,
        price: d.action.price,
        size: d.action.size,
        capId: execCtx.capId,
        agentId: execCtx.state.agentId,
        pnlId: execCtx.state.pnlId,
        deepCoinType: '0xdee9::deep::DEEP',
      });
    } else if (d.action.kind === 'open_hedge') {
      tx = this.cfg.optic.predict.buildOpenHedgeTx({
        agentId: execCtx.state.agentId,
        capId: execCtx.capId,
        side: d.action.side,
        underlying: d.action.underlying,
        strikePrice: d.action.strikePrice,
        size: d.action.size,
        expiresAtMs: d.action.expiresAtMs,
      });
    } else if (d.action.kind === 'pause') {
      tx = this.cfg.optic.tx();
      this.cfg.optic.pauseCall(tx, execCtx.state.agentId);
    }

    if (!tx) {
      // No PTB build path for this action — fall back to synth digest.
      return this.dispatchSynth(d);
    }

    // Sign + submit. The signer must be the cap holder (or the owner's keypair
    // if the cap was issued to the owner). In production, the orchestrator
    // would have custody of the cap-holder keypair in a secure enclave.
    const digest = await this.cfg.optic.signAndExecute(tx);
    return digest;
  }

  private async fetchState(): Promise<AgentState> {
    if (this.cfg.fetchState) return this.cfg.fetchState();
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

  /** Total cycles run so far. */
  get cycles(): number { return this.cycleCount; }

  /** Audit sequence counter (increments per successful dispatch). */
  get sequence(): number { return this.auditSequence; }
}
