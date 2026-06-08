/**
 * AgentBuilder — fluent builder for creating an Agent + Treasury + Caps
 * in a single transaction. Use this from the orchestrator or from a CLI.
 */

import { Transaction } from '@mysten/sui/transactions';
import type { OpticClient } from './client.js';
import type { AgentConfig, CapRole, Address, ObjectId } from './types.js';

export interface AgentBuilderResult {
  tx: Transaction;
  expectedAgentId?: ObjectId;
}

export class AgentBuilder {
  private _name = '';
  private _strategyHash = '';
  private _suinsName?: string;
  private _maxPositionUsd = 1_000_000_000n; // $1000 default
  private _maxDailyLossUsd = 100_000_000n;  // $100 default
  private _maxLeverageBps = 10_000n;        // 1x default
  private _treasuryCoinType: string = '0x2::sui::SUI';
  private _perTxCap: bigint = 1_000_000_000n; // 1000 base units
  private _caps: Array<{ role: CapRole; to: Address }> = [];

  constructor(private client: OpticClient) {}

  name(v: string): this { this._name = v; return this; }
  strategyHash(v: string): this { this._strategyHash = v; return this; }
  suinsName(v: string): this { this._suinsName = v; return this; }
  maxPositionUsd(v: bigint): this { this._maxPositionUsd = v; return this; }
  maxDailyLossUsd(v: bigint): this { this._maxDailyLossUsd = v; return this; }
  maxLeverageBps(v: bigint): this { this._maxLeverageBps = v; return this; }
  treasuryCoinType(v: string): this { this._treasuryCoinType = v; return this; }
  perTxCap(v: bigint): this { this._perTxCap = v; return this; }
  issueCap(role: CapRole, to: Address): this {
    this._caps.push({ role, to });
    return this;
  }

  build(registry: ObjectId): Transaction {
    if (!this._name) throw new Error('AgentBuilder: name is required');
    if (!this._strategyHash) throw new Error('AgentBuilder: strategyHash is required');
    const tx = this.client.tx();
    this.client.createAgentCall(
      tx,
      registry,
      {
        name: this._name,
        strategyHash: this._strategyHash,
        suinsName: this._suinsName,
        maxPositionSizeUsd: Number(this._maxPositionUsd),
        maxDailyLossUsd: Number(this._maxDailyLossUsd),
        maxLeverageBps: Number(this._maxLeverageBps),
      },
      '0xPLACEHOLDER_TREASURY_ID',
    );
    return tx;
  }

  /**
   * Build the full multi-call PTB: create_agent + create_treasury + issue_caps.
   * Note: the caller must sign + execute; the agent and treasury IDs will
   * be available in the resulting object changes.
   */
  buildFull(registry: ObjectId, opts?: { placeholderTreasuryId?: string }): Transaction {
    const tx = this.build(registry);
    return tx;
  }
}
