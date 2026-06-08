/**
 * WalrusAudit — uploads a blob to Walrus and registers it as a StrategyRef
 * + emits an audit entry on-chain. This is the cornerstone of the OPTIC
 * white-box guarantee.
 *
 * NOTE: The actual upload to Walrus is done via the publisher.walrus.site
 * HTTP API. We use fetch() so this works in Node 20+ without any extra
 * dependency.
 */

import { Transaction } from '@mysten/sui/transactions';
import type { OpticClient } from './client.js';
import type { ObjectId } from './types.js';
import { WALRUS_ENDPOINTS } from './constants.js';
import { createHash } from 'node:crypto';

export interface WalrusUploadResult {
  blobId: string;
  blobHash: string;
  suiObjectId?: string;
  endEpoch: number;
}

export class WalrusAudit {
  constructor(
    private client: OpticClient,
    private agentId: ObjectId,
  ) {}

  /**
   * Upload a JSON or text payload to Walrus. Returns the blob ID + a
   * SHA-3 (we use SHA-256 here for portability — the on-chain field is
   * generic bytes, the consumer can verify via any hash they prefer).
   */
  async upload(payload: string | Uint8Array, epochs = 1): Promise<WalrusUploadResult> {
    const bytes = typeof payload === 'string'
      ? new TextEncoder().encode(payload)
      : payload;
    const hash = createHash('sha256').update(bytes).digest('hex');
    const url = `${WALRUS_ENDPOINTS[this.client.network]}/v1/store?epochs=${epochs}`;
    const res = await fetch(url, {
      method: 'PUT',
      body: bytes,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    if (!res.ok) {
      throw new Error(`Walrus upload failed: ${res.status} ${await res.text()}`);
    }
    const json = await res.json() as {
      newlyCreated?: { blobObject: { id: string }; endEpoch: number };
      alreadyCertified?: { blobObject: { id: string }; endEpoch: number };
    };
    const created = json.newlyCreated ?? json.alreadyCertified;
    if (!created) {
      throw new Error('Walrus upload: unexpected response shape');
    }
    return {
      blobId: created.blobObject.id,
      blobHash: hash,
      suiObjectId: created.blobObject.id,
      endEpoch: created.endEpoch,
    };
  }

  /**
   * Build the `anchor_strategy` Move call. Must be invoked by the agent owner.
   */
  anchorStrategyCall(
    tx: Transaction,
    blobId: string,
    blobHash: string,
    label: string,
  ) {
    tx.moveCall({
      target: `${this.client.packageId}::walrus_adapter::anchor_strategy`,
      arguments: [
        tx.object(this.agentId),
        tx.pure.string(blobId),
        tx.pure.string(blobHash),
        tx.pure.string(label),
      ],
    });
  }

  /**
   * Build the `record_audit` Move call.
   */
  recordAuditCall(
    tx: Transaction,
    action: number,
    sequence: number,
    blobId: string | null,
    summary: string,
  ) {
    tx.moveCall({
      target: `${this.client.packageId}::walrus_adapter::record_audit`,
      arguments: [
        tx.object(this.agentId),
        tx.pure.u8(action),
        tx.pure.u64(sequence),
        tx.pure(bcsOptionString(blobId)),
        tx.pure.string(summary),
      ],
    });
  }
}

function bcsOptionString(value: string | null): Uint8Array {
  // For Option<vector<u8>> we use bcs encoding directly.
  // 0 = None, 1 followed by length-prefixed bytes = Some(bytes).
  if (value === null) {
    return new Uint8Array([0]);
  }
  const bytes = new TextEncoder().encode(value);
  const out = new Uint8Array(1 + 4 + bytes.length);
  out[0] = 1; // Some
  const view = new DataView(out.buffer);
  view.setUint32(1, bytes.length, true);
  out.set(bytes, 5);
  return out;
}
