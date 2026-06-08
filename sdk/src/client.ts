/**
 * OpticClient — main entry point for the SDK.
 *
 * Wraps a SuiClient + a signer, and exposes typed methods to interact
 * with the OPTIC Move package.
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import type { Keypair } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import type { Network, ObjectId, Address, Agent, AgentConfig, AgentCap, CapRole } from './types.js';
import { PACKAGE_ID, RPC_URLS } from './constants.js';

export interface OpticClientOptions {
  network: Network;
  packageId?: string;
  signer: Keypair;
}

export class OpticClient {
  readonly sui: SuiClient;
  readonly network: Network;
  readonly packageId: string;
  readonly signer: Keypair;

  constructor(opts: OpticClientOptions) {
    this.network = opts.network;
    this.packageId = opts.packageId ?? PACKAGE_ID;
    this.signer = opts.signer;
    this.sui = new SuiClient({ url: RPC_URLS[opts.network] });
  }

  /**
   * Static factory: connect to the default testnet RPC.
   */
  static testnet(signer: Keypair, packageId?: string): OpticClient {
    return new OpticClient({ network: 'testnet', signer, packageId });
  }

  /**
   * Build a new Programmable Transaction Block anchored to the OPTIC package.
   * Use the returned tx to add additional calls before signing + executing.
   */
  tx(): Transaction {
    return new Transaction();
  }

  /**
   * Build the `create_agent` Move call.
   */
  createAgentCall(
    tx: Transaction,
    registry: ObjectId,
    cfg: AgentConfig,
    treasuryId: ObjectId,
  ) {
    if (this.packageId === '0x0') {
      throw new Error('OpticClient.packageId is unset; publish the Move package first');
    }
    tx.moveCall({
      target: `${this.packageId}::core::create_agent`,
      arguments: [
        tx.object(registry),
        tx.pure.string(cfg.name),
        tx.pure.string(cfg.strategyHash),
        tx.pure(bcs.option(bcs.string()).serialize(cfg.suinsName ?? null).toBytes()),
        tx.pure.u64(cfg.maxPositionSizeUsd),
        tx.pure.u64(cfg.maxDailyLossUsd),
        tx.pure.u64(cfg.maxLeverageBps),
        tx.object(treasuryId),
      ],
    });
  }

  /**
   * Build the `create_treasury<T>` Move call.
   * The caller must ensure `T` matches the Coin<T> generic of the Treasury
   * they intend to create. The `coinType` is the fully qualified Move type,
   * e.g. `0x2::sui::SUI` or `0x...::usdc::USDC`.
   */
  createTreasuryCall(
    tx: Transaction,
    agent: ObjectId,
    coinType: string,
    perTxCap: bigint,
  ) {
    tx.moveCall({
      target: `${this.packageId}::treasury::create_treasury`,
      typeArguments: [coinType],
      arguments: [
        tx.object(agent),
        tx.pure.u64(perTxCap.toString()),
      ],
    });
  }

  /**
   * Build the `issue_cap` Move call. Returns the cap object ref.
   */
  issueCapCall(
    tx: Transaction,
    agent: ObjectId,
    role: CapRole,
    to: Address,
  ) {
    tx.moveCall({
      target: `${this.packageId}::core::issue_cap`,
      arguments: [
        tx.object(agent),
        tx.pure.u8(role),
        tx.pure.address(to),
      ],
    });
  }

  /**
   * Build the `pause` Move call.
   */
  pauseCall(tx: Transaction, agent: ObjectId) {
    tx.moveCall({
      target: `${this.packageId}::core::pause`,
      arguments: [tx.object(agent)],
    });
  }

  /**
   * Build the `resume` Move call.
   */
  resumeCall(tx: Transaction, agent: ObjectId) {
    tx.moveCall({
      target: `${this.packageId}::core::resume`,
      arguments: [tx.object(agent)],
    });
  }

  /**
   * Build the `liquidate` Move call.
   */
  liquidateCall(tx: Transaction, agent: ObjectId) {
    tx.moveCall({
      target: `${this.packageId}::core::liquidate`,
      arguments: [tx.object(agent)],
    });
  }

  /**
   * Sign + execute a transaction. Returns the digest.
   */
  async signAndExecute(tx: Transaction): Promise<string> {
    const result = await this.sui.signAndExecuteTransaction({
      signer: this.signer,
      transaction: tx,
      options: { showEffects: true, showEvents: true, showObjectChanges: true },
    });
    return result.digest;
  }

  /**
   * Read an Agent object by ID and decode to the typed `Agent` shape.
   */
  async getAgent(agentId: ObjectId): Promise<Agent> {
    const obj = await this.sui.getObject({
      id: agentId,
      options: { showContent: true, showType: true },
    });
    if (!obj.data) throw new Error(`Agent ${agentId} not found`);
    return decodeAgent(obj.data);
  }
}

// -----------------------------------------------------------------------------
// BCS helper (re-exported to avoid a top-level import in the consumer's bundle)
// -----------------------------------------------------------------------------
import { bcs } from '@mysten/sui/bcs';

function decodeAgent(data: NonNullable<Awaited<ReturnType<SuiClient['getObject']>>['data']>): Agent {
  const content = data.content;
  if (content?.dataType !== 'moveObject') {
    throw new Error(`Agent ${data.objectId} is not a Move object`);
  }
  const fields = content.fields as Record<string, unknown>;
  const statusNum = Number(fields.status);
  return {
    id: data.objectId,
    owner: String(fields.owner),
    name: String(fields.name),
    strategyHash: String(fields.strategy_hash),
    suinsName: (fields.suins_name as { vec: string[] } | undefined)?.vec?.[0],
    status: statusNum === 0 ? 'active' : statusNum === 1 ? 'paused' : 'liquidated',
    maxPositionSizeUsd: Number(fields.max_position_size_usd),
    maxDailyLossUsd: Number(fields.max_daily_loss_usd),
    maxLeverageBps: Number(fields.max_leverage_bps),
    treasuryId: String(fields.treasury_id),
    strategyBlobId: (fields.strategy_blob_id as { vec: string[] } | undefined)?.vec?.[0],
    createdAtMs: Number(fields.created_at_ms),
    lastActionMs: Number(fields.last_action_ms),
  };
}
