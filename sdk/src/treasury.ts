/**
 * Treasury — convenience wrapper around the Treasury<CoinType> shared object.
 */

import { Transaction } from '@mysten/sui/transactions';
import type { OpticClient } from './client.js';
import type { ObjectId } from './types.js';

export class Treasury {
  constructor(
    private client: OpticClient,
    private treasuryId: ObjectId,
    public readonly coinType: string,
  ) {}

  /**
   * Build a `deposit` Move call. The Coin<T> must be passed as a tx input.
   */
  depositCall(tx: Transaction, agentId: ObjectId, coinInput: ReturnType<Transaction['object']>) {
    tx.moveCall({
      target: `${this.client.packageId}::treasury::deposit`,
      typeArguments: [this.coinType],
      arguments: [tx.object(this.treasuryId), tx.object(agentId), coinInput],
    });
  }

  /**
   * Build a `withdraw_by_owner` Move call.
   */
  withdrawByOwnerCall(tx: Transaction, agentId: ObjectId, amount: bigint) {
    tx.moveCall({
      target: `${this.client.packageId}::treasury::withdraw_by_owner`,
      typeArguments: [this.coinType],
      arguments: [
        tx.object(this.treasuryId),
        tx.object(agentId),
        tx.pure.u64(amount.toString()),
      ],
    });
  }

  /**
   * Build a `withdraw_by_cap` Move call.
   */
  withdrawByCapCall(
    tx: Transaction,
    agentId: ObjectId,
    capId: ObjectId,
    amount: bigint,
  ) {
    tx.moveCall({
      target: `${this.client.packageId}::treasury::withdraw_by_cap`,
      typeArguments: [this.coinType],
      arguments: [
        tx.object(this.treasuryId),
        tx.object(agentId),
        tx.object(capId),
        tx.pure.u64(amount.toString()),
      ],
    });
  }
}
