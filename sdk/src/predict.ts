/**
 * PredictClient — typed wrapper for the DeepBook Predict binary options
 * market. Records the hedge on OPTIC and emits the corresponding audit
 * entry on Walrus.
 */

import { Transaction } from '@mysten/sui/transactions';
import type { OpticClient } from './client.js';
import type { ObjectId } from './types.js';

export interface OpenHedgeArgs {
  agentId: ObjectId;
  capId: ObjectId;
  side: 0 | 1; // 0 = YES, 1 = NO
  underlying: string; // e.g. "SUI"
  strikePrice: bigint;
  size: bigint;
  expiresAtMs: number;
  hedgingTradeId?: ObjectId;
  predictTxDigest?: string;
}

export class PredictClient {
  constructor(private client: OpticClient) {}

  buildOpenHedgeTx(args: OpenHedgeArgs): Transaction {
    const tx = this.client.tx();
    const tradeIdOpt = args.hedgingTradeId
      ? new Uint8Array([1, ...new TextEncoder().encode(args.hedgingTradeId)])
      : new Uint8Array([0]);
    const digestOpt = args.predictTxDigest
      ? new Uint8Array([1, ...new TextEncoder().encode(args.predictTxDigest)])
      : new Uint8Array([0]);
    tx.moveCall({
      target: `${this.client.packageId}::predict_adapter::open_hedge`,
      arguments: [
        tx.object(args.agentId),
        tx.object(args.capId),
        tx.pure.u8(args.side),
        tx.pure.string(args.underlying),
        tx.pure.u64(args.strikePrice.toString()),
        tx.pure.u64(args.size.toString()),
        tx.pure.u64(args.expiresAtMs.toString()),
        tx.pure(tradeIdOpt),
        tx.pure(digestOpt),
      ],
    });
    return tx;
  }

  buildSettleHedgeTx(args: {
    agentId: ObjectId;
    capId: ObjectId;
    hedgeId: ObjectId;
    won: boolean;
    payout: bigint;
  }): Transaction {
    const tx = this.client.tx();
    tx.moveCall({
      target: `${this.client.packageId}::predict_adapter::settle_hedge`,
      arguments: [
        tx.object(args.agentId),
        tx.object(args.capId),
        tx.object(args.hedgeId),
        tx.pure.bool(args.won),
        tx.pure.u64(args.payout.toString()),
      ],
    });
    return tx;
  }
}
