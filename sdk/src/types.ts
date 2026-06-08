/**
 * Public types shared across the SDK.
 */

export type Address = string;
export type ObjectId = string;
export type Digest = string;
export type Hex = string;

export interface AgentConfig {
  name: string;
  strategyHash: string;       // hex
  suinsName?: string;
  maxPositionSizeUsd: number;  // 6-decimal scaled (1_000_000 = $1)
  maxDailyLossUsd: number;
  maxLeverageBps: number;      // 10_000 = 1x
}

export type AgentStatus = 'active' | 'paused' | 'liquidated';

export interface Agent {
  id: ObjectId;
  owner: Address;
  name: string;
  strategyHash: Hex;
  suinsName?: string;
  status: AgentStatus;
  maxPositionSizeUsd: number;
  maxDailyLossUsd: number;
  maxLeverageBps: number;
  treasuryId: ObjectId;
  strategyBlobId?: ObjectId;
  createdAtMs: number;
  lastActionMs: number;
}

export interface PnL {
  id: ObjectId;
  agentId: ObjectId;
  realizedPnl: number;
  unrealizedPnlMag: number;
  unrealizedPnlSign: 0 | 1;
  tradeCount: number;
  volume: number;
  updatedAtMs: number;
}

export type CapRole = 0 | 1 | 2 | 3; // full, quant, risk, executor

export interface AgentCap {
  id: ObjectId;
  agentId: ObjectId;
  role: CapRole;
  issuedAtMs: number;
  nonce: number;
}

export interface Treasury<T = unknown> {
  id: ObjectId;
  agentId: ObjectId;
  balance: bigint;
  perTxCap: bigint;
  dailyWithdrawn: bigint;
  lastResetMs: number;
  lifetimeDeposited: bigint;
  lifetimeWithdrawn: bigint;
  createdAtMs: number;
}

export interface OrderRequest {
  id: ObjectId;
  agentId: ObjectId;
  side: 0 | 1; // buy, sell
  orderType: 0 | 1; // limit, market
  baseAsset: string;
  quoteAsset: string;
  price: bigint;
  size: bigint;
  requestedBy: Address;
  ttlMs: number;
  createdAtMs: number;
  status: 0 | 1 | 2 | 3 | 4;
}

export interface TradeRecord {
  id: ObjectId;
  agentId: ObjectId;
  side: 0 | 1;
  baseAsset: string;
  quoteAsset: string;
  fillPrice: bigint;
  fillSize: bigint;
  fee: bigint;
  realizedPnlMag: bigint;
  realizedPnlSign: 0 | 1;
  strategyHash: Hex;
  filledAtMs: number;
}

export interface PredictHedge {
  id: ObjectId;
  agentId: ObjectId;
  side: 0 | 1; // yes, no
  underlying: string;
  strikePrice: bigint;
  size: bigint;
  openedAtMs: number;
  expiresAtMs: number;
  status: 0 | 1 | 2 | 3; // open, won, lost, cancelled
  openedBy: Address;
  payout: bigint;
  realizedPnlMag: bigint;
  realizedPnlSign: 0 | 1;
}

export interface StrategyRef {
  id: ObjectId;
  agentId: ObjectId;
  blobHash: Hex;
  blobId: string;
  version: number;
  anchoredAtMs: number;
  anchoredBy: Address;
  label: string;
}

export interface AuditEntry {
  id: ObjectId;
  agentId: ObjectId;
  action: number; // see walrus_adapter constants
  sequence: number;
  blobId?: string;
  summary: string;
  atMs: number;
  actor: Address;
}
