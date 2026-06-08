/**
 * @optic/sdk — Type-only stub for orchestrator tests.
 *
 * The real SDK is in /sdk and depends on @mysten/sui. To keep the
 * orchestrator testable without pulling in the full Sui client stack,
 * we ship a stub with just the type signatures that orchestrator code
 * uses. In production, this path is replaced with the real SDK via
 * the workspace `paths` mapping in tsconfig.
 */

export type ObjectId = string;
export type Address = string;

export interface AgentConfig {
  name: string;
  strategyHash: string;
  suinsName?: string | null;
  maxPositionSizeUsd: number;
  maxDailyLossUsd: number;
  maxLeverageBps: number;
}

export type CapRole = 0 | 1 | 2; // quant | risk | executor

export interface AgentCap {
  id: ObjectId;
  role: CapRole;
  holder: Address;
  agentId: ObjectId;
}

export interface Agent {
  id: ObjectId;
  owner: Address;
  name: string;
  strategyHash: string;
  suinsName?: string;
  status: 'active' | 'paused' | 'liquidated';
  maxPositionSizeUsd: number;
  maxDailyLossUsd: number;
  maxLeverageBps: number;
  treasuryId: ObjectId;
  strategyBlobId?: string;
  createdAtMs: number;
  lastActionMs: number;
}

export class OpticClient {
  readonly network: 'testnet' | 'mainnet' | 'devnet';
  readonly packageId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(_opts: any) {
    this.network = 'testnet';
    this.packageId = '0xSTUB';
  }
}

export class AgentBuilder {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(_client: any) {}
}

export class Treasury {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(_client: any, _id: ObjectId) {}
}

export class WalrusAudit {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(_client: any) {}
}

export class DeepBookClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(_client: any) {}
}

export class PredictClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(_client: any) {}
}

export type Network = 'testnet' | 'mainnet' | 'devnet';

export const PACKAGE_ID = '0xSTUB';
export const MODULES = {
  core: 'core',
  treasury: 'treasury',
  deepbookAdapter: 'deepbook_adapter',
  walrusAdapter: 'walrus_adapter',
  predictAdapter: 'predict_adapter',
} as const;
export const RPC_URLS: Record<Network, string> = {
  testnet: 'https://fullnode.testnet.sui.io:443',
  mainnet: 'https://fullnode.mainnet.sui.io:443',
  devnet: 'https://fullnode.devnet.sui.io:443',
};
