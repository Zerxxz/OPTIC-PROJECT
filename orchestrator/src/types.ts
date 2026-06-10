/**
 * Shared types for the orchestrator.
 */

import type { ObjectId, Address } from '@optic/sdk';

export interface AgentState {
  agentId: ObjectId;
  pnlId: ObjectId;
  treasuryId: ObjectId;
  quantCapId: ObjectId;
  riskCapId: ObjectId;
  executorCapId: ObjectId;
  status: 'active' | 'paused' | 'liquidated';
  maxPositionUsd: bigint;
  maxDailyLossUsd: bigint;
  maxLeverageBps: number;
  treasuryBalance: bigint;
  realizedPnl: bigint;
  tradeCount: number;
  volume: bigint;
  strategyHash: string;
}

export interface MarketState {
  /// Mid price in quote units (1e6 USDC).
  midPrice: bigint;
  /// Best bid in quote units.
  bestBid: bigint;
  /// Best ask in quote units.
  bestAsk: bigint;
  /// 24h realized volatility in bps (10_000 = 100%).
  realizedVolBps: number;
  /// Orderbook depth at top of book in quote units.
  bookDepth: bigint;
  /// Timestamp of the snapshot.
  atMs: number;
}

export type DecisionAction =
  | {
      kind: 'place_order';
      side: 0 | 1;
      orderType: 0 | 1;
      baseAsset: string;
      quoteAsset: string;
      price: bigint;
      size: bigint;
    }
  | {
      kind: 'cancel_order';
      orderId: ObjectId;
    }
  | {
      kind: 'open_hedge';
      side: 0 | 1;
      underlying: string;
      strikePrice: bigint;
      size: bigint;
      expiresAtMs: number;
    }
  | {
      kind: 'settle_hedge';
      hedgeId: ObjectId;
      won: boolean;
      payout: bigint;
    }
  | {
      kind: 'pause';
      reason: string;
    }
  | {
      kind: 'no_op';
      reason: string;
    };

export interface Decision {
  agent: 'quant' | 'risk' | 'executor';
  action: DecisionAction;
  /// Free-form reasoning to be logged on Walrus.
  reasoning: string;
  /// Confidence in 0-10000 bps. 0 = abstain.
  confidenceBps: number;
  atMs: number;
}

export type OrchestratorEvent =
  | { kind: 'cycle_started'; atMs: number; agentId: ObjectId }
  | { kind: 'decision_made'; decision: Decision }
  | { kind: 'decision_rejected'; reason: string; decision: Decision }
  | { kind: 'decision_executed'; decision: Decision; txDigest: string }
  | { kind: 'cycle_completed'; atMs: number; actionsExecuted: number };

/// ExecutorContext — passed to ExecutorAgent.decide() in 'live' mode
/// so the executor can build a real PTB using the cap it holds and the
/// on-chain pool it routes through.
export interface ExecutorContext {
  state: AgentState;
  market: MarketState;
  capId: ObjectId;
  executorAddress?: Address;
  deepbookPool?: { poolId: ObjectId; baseCoinType: string; quoteCoinType: string };
  treasuryCoinType?: string;
}

/// Re-export Agent (sdk) for convenience
export type Agent = import('@optic/sdk').Agent;
export type { Address, ObjectId };
