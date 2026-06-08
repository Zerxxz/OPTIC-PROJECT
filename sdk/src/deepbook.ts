/**
 * DeepBookClient — typed wrapper for placing orders and recording fills
 * on DeepBookV3 (canonical CLOB on Sui).
 *
 * The actual order submission uses a Programmable Transaction Block that
 * composes the DeepBook SDK calls. We use the deepbook SDK address from
 * the constants module and pass pool / manager object IDs as parameters.
 *
 * The Move-side `record_fill` is invoked atomically inside the same PTB
 * after a successful fill event is observed.
 */

import { Transaction } from '@mysten/sui/transactions';
import type { OpticClient } from './client.js';
import type { ObjectId, Address } from './types.js';
import { DEEPBOOK_PACKAGE_IDS } from './constants.js';

export interface DeepBookPoolInfo {
  poolId: ObjectId;
  baseCoinType: string;
  quoteCoinType: string;
}

export interface PlaceOrderArgs {
  pool: DeepBookPoolInfo;
  /** 0 = buy, 1 = sell */
  side: 0 | 1;
  /** 0 = limit, 1 = market */
  orderType: 0 | 1;
  price: bigint;
  size: bigint;
  /** Cap that authorizes the trade */
  capId: ObjectId;
  /** Agent being traded for */
  agentId: ObjectId;
  /** Shared PnL object to update on fill */
  pnlId: ObjectId;
  /** DEEP coin type (for fee discount) */
  deepCoinType: string;
}

export class DeepBookClient {
  constructor(private client: OpticClient) {}

  /**
   * Build a PTB that:
   *   1. Calls deepbook::clob::place_limit_order / place_market_order
   *   2. (On a separate tx) records the fill via optic::deepbook_adapter::record_fill
   *
   * For a real production implementation the orchestrator would listen
   * to the DeepBook event stream and emit the record_fill when a fill
   * actually lands. This method returns the place-order PTB; the orchestrator
   * composes the record_fill as a follow-up.
   */
  buildPlaceOrderTx(args: PlaceOrderArgs): Transaction {
    const tx = this.client.tx();
    const deepbookPkg = DEEPBOOK_PACKAGE_IDS[this.client.network];

    if (args.orderType === 0) {
      tx.moveCall({
        target: `${deepbookPkg}::clob::place_limit_order`,
        typeArguments: [args.pool.baseCoinType, args.pool.quoteCoinType],
        arguments: [
          tx.object(args.pool.poolId),
          tx.pure.u8(args.side),
          tx.pure.u64(args.price.toString()),
          tx.pure.u64(args.size.toString()),
          tx.pure.u8(0), // self-matching option: 0 = allowed
          tx.pure.u64(0), // client order id (unused)
          tx.pure.u64(2_000_000_000), // max gas (or compute budget)
        ],
      });
    } else {
      tx.moveCall({
        target: `${deepbookPkg}::clob::place_market_order`,
        typeArguments: [args.pool.baseCoinType, args.pool.quoteCoinType],
        arguments: [
          tx.object(args.pool.poolId),
          tx.pure.u8(args.side),
          tx.pure.u64(args.size.toString()),
          tx.pure.u64(0),
        ],
      });
    }

    // submit a matching OrderRequest on OPTIC (the audit record)
    tx.moveCall({
      target: `${this.client.packageId}::deepbook_adapter::submit_order`,
      arguments: [
        tx.object(args.agentId),
        tx.object(args.capId),
        tx.pure.u8(args.side),
        tx.pure.u8(args.orderType),
        tx.pure.string(extractCoinName(args.pool.baseCoinType)),
        tx.pure.string(extractCoinName(args.pool.quoteCoinType)),
        tx.pure.u64(args.price.toString()),
        tx.pure.u64(args.size.toString()),
        tx.pure.u64(120_000), // 2min TTL
      ],
    });

    return tx;
  }

  /**
   * Build a `record_fill` PTB. Call this when the DeepBook indexer reports
   * a matching fill for the agent.
   */
  buildRecordFillTx(args: {
    agentId: ObjectId;
    pnlId: ObjectId;
    capId: ObjectId;
    side: 0 | 1;
    baseAsset: string;
    quoteAsset: string;
    fillPrice: bigint;
    fillSize: bigint;
    fee: bigint;
    realizedPnlMag: bigint;
    realizedPnlSign: 0 | 1;
    deepbookTxDigest?: string;
  }): Transaction {
    const tx = this.client.tx();
    const digestOpt = args.deepbookTxDigest
      ? new Uint8Array([1, ...new TextEncoder().encode(args.deepbookTxDigest)])
      : new Uint8Array([0]);
    tx.moveCall({
      target: `${this.client.packageId}::deepbook_adapter::record_fill`,
      arguments: [
        tx.object(args.agentId),
        tx.object(args.pnlId),
        tx.object(args.capId),
        tx.pure.u8(args.side),
        tx.pure.string(args.baseAsset),
        tx.pure.string(args.quoteAsset),
        tx.pure.u64(args.fillPrice.toString()),
        tx.pure.u64(args.fillSize.toString()),
        tx.pure.u64(args.fee.toString()),
        tx.pure.u64(args.realizedPnlMag.toString()),
        tx.pure.u8(args.realizedPnlSign),
        tx.pure(digestOpt),
      ],
    });
    return tx;
  }
}

function extractCoinName(fullyQualifiedType: string): string {
  const parts = fullyQualifiedType.split('::');
  return parts[parts.length - 1] ?? fullyQualifiedType;
}
