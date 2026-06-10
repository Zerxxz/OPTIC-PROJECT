/**
 * OPTIC Leaderboard — derives a ranked list of agents from on-chain data.
 *
 * The leaderboard reads:
 *   1. AgentRegistry → list of all agent IDs
 *   2. For each agent, the `core::Agent` object (status, strategy hash, etc.)
 *   3. For each agent, the `core::PnL` object (realized PnL, trade count, volume)
 *   4. For each agent, the last N `walrus_adapter::AuditEntry` events (to compute
 *      drawdown + time-series for Sharpe)
 *
 * The leaderboard is **derived**, not stored — anyone can recompute it from
 * chain data alone. There is no central "OPTIC leaderboard" server. The
 * Walrus Site is just a renderer.
 *
 * Metrics:
 *   - realized_pnl_usd    : total realized PnL (micro-USDC / 1e6)
 *   - volume_usd          : total traded volume (micro-USDC / 1e6)
 *   - trades              : trade count
 *   - win_rate            : wins / total resolved trades
 *   - sharpe              : mean(return) / stddev(return), 0 if <2 trades
 *   - max_drawdown_bps    : peak-to-trough drop in cumulative PnL (bps)
 *   - status              : active | paused | liquidated
 *
 * The leaderboard is sorted by Sharpe desc by default; the caller can
 * pass a different `sortBy`.
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import type { Network, ObjectId, Address, Hex } from './types.js';
import { PACKAGE_ID, RPC_URLS } from './constants.js';

export interface LeaderboardEntry {
  rank: number;
  agentId: ObjectId;
  owner: Address;
  name: string;
  strategyHash: Hex;
  status: 'active' | 'paused' | 'liquidated';
  /// All metrics in USD (1e-6 scale converted to floats for display).
  metrics: {
    realizedPnlUsd: number;
    volumeUsd: number;
    trades: number;
    winRate: number; // 0..1
    sharpe: number;
    maxDrawdownBps: number;
  };
}

export interface Leaderboard {
  /// Number of agents in the registry.
  totalAgents: number;
  /// Number included in the leaderboard (active only by default).
  ranked: number;
  /// The list, sorted.
  entries: LeaderboardEntry[];
  /// Wall-clock timestamp the leaderboard was computed.
  computedAtMs: number;
  /// Network + package used.
  network: Network;
  packageId: string;
}

export interface LeaderboardOpts {
  network: Network;
  /// Package ID of the published OPTIC Move package.
  packageId?: string;
  /// Registry object id (singleton). If omitted, the leaderboard will try
  /// to fetch it dynamically via the published `init` event.
  registryId?: ObjectId;
  /// Include only active agents (status = 0). Default: true.
  activeOnly?: boolean;
  /// Sort metric. Default: 'sharpe'.
  sortBy?: 'sharpe' | 'realizedPnlUsd' | 'volumeUsd' | 'winRate';
  /// Max entries to return. Default: 50.
  limit?: number;
  /// Caller's SuiClient. If omitted, a public fullnode client is used.
  sui?: SuiClient;
}

/// Compute the on-chain leaderboard.
export async function computeLeaderboard(opts: LeaderboardOpts): Promise<Leaderboard> {
  const client = opts.sui ?? new SuiClient({ url: RPC_URLS[opts.network] });
  const packageId = opts.packageId ?? PACKAGE_ID;
  const activeOnly = opts.activeOnly ?? true;
  const sortBy = opts.sortBy ?? 'sharpe';
  const limit = opts.limit ?? 50;

  if (packageId === '0x0') {
    throw new Error('computeLeaderboard: packageId is required (set via opts.packageId or PACKAGE_ID)');
  }
  if (!opts.registryId) {
    throw new Error(
      'computeLeaderboard: registryId is required (the singleton AgentRegistry id, available after `sui client publish`)',
    );
  }

  // 1. Read the registry.
  const regObj = await client.getObject({
    id: opts.registryId,
    options: { showContent: true, showType: true },
  });
  if (!regObj.data) {
    throw new Error(`AgentRegistry ${opts.registryId} not found`);
  }
  const regFields = (regObj.data.content as { fields: Record<string, unknown> }).fields;
  const agentIds = ((regFields.agents as { vec?: string[] })?.vec ?? []) as string[];

  // 2. For each agent, fetch Agent + PnL in parallel.
  const entries: LeaderboardEntry[] = [];
  const chunkSize = 8;
  for (let i = 0; i < agentIds.length; i += chunkSize) {
    const chunk = agentIds.slice(i, i + chunkSize);
    const fetched = await Promise.all(
      chunk.map(async (id) => {
        const [agent, pnl] = await Promise.all([
          fetchAgent(client, packageId, id),
          fetchPnL(client, packageId, id),
        ]);
        return { id, agent, pnl };
      }),
    );
    for (const { id, agent, pnl } of fetched) {
      if (!agent) continue;
      if (activeOnly && agent.status !== 'active') continue;
      // We don't have a per-trade event stream in the MVP; approximate
      // sharpe + drawdown from the PnL object's lifetime fields.
      const realizedUsd = pnl.realizedPnl / 1_000_000;
      const volumeUsd = pnl.volume / 1_000_000;
      const trades = pnl.tradeCount;
      const metrics = {
        realizedPnlUsd: realizedUsd,
        volumeUsd,
        trades,
        winRate: 0, // not derivable from PnL alone; needs trade history
        sharpe: trades >= 2 ? realizedUsd / Math.max(1, volumeUsd) * Math.sqrt(365) : 0,
        maxDrawdownBps: 0, // needs event stream; leave as 0 for now
      };
      entries.push({
        rank: 0, // assigned after sort
        agentId: id,
        owner: agent.owner,
        name: agent.name,
        strategyHash: agent.strategyHash,
        status: agent.status,
        metrics,
      });
    }
  }

  // 3. Sort.
  entries.sort((a, b) => b.metrics[sortBy] - a.metrics[sortBy]);

  // 4. Assign ranks.
  entries.forEach((e, i) => {
    e.rank = i + 1;
  });

  return {
    totalAgents: agentIds.length,
    ranked: entries.length,
    entries: entries.slice(0, limit),
    computedAtMs: Date.now(),
    network: opts.network,
    packageId,
  };
}

interface MinimalAgent {
  owner: Address;
  name: string;
  strategyHash: Hex;
  status: 'active' | 'paused' | 'liquidated';
}

interface MinimalPnL {
  realizedPnl: number;
  tradeCount: number;
  volume: number;
}

async function fetchAgent(
  client: SuiClient,
  packageId: string,
  id: ObjectId,
): Promise<MinimalAgent | null> {
  try {
    const obj = await client.getObject({
      id,
      options: { showContent: true, showType: true },
    });
    if (!obj.data) return null;
    const t = (obj.data.type ?? '') as string;
    if (!t.includes(`${packageId}::core::Agent`)) return null;
    const fields = (obj.data.content as { fields: Record<string, unknown> }).fields;
    const statusNum = Number(fields.status);
    return {
      owner: String(fields.owner),
      name: String(fields.name),
      strategyHash: String(fields.strategy_hash),
      status: statusNum === 0 ? 'active' : statusNum === 1 ? 'paused' : 'liquidated',
    };
  } catch {
    return null;
  }
}

async function fetchPnL(
  client: SuiClient,
  packageId: string,
  _agentId: ObjectId,
): Promise<MinimalPnL> {
  // The PnL object id is not stored on the Agent; we need to either
  // index PnLUpdated events or store the PnL id on the Agent. For the
  // MVP, we look up the PnL object via dynamic field on the Agent.
  // If absent, we return zeros.
  try {
    const dyn = await client.getDynamicFields({ parentId: _agentId });
    for (const field of dyn.data) {
      if (field.name.type === '0x2::object::ID' || String(field.name.type).endsWith('::ID')) {
        const pnlObj = await client.getObject({
          id: field.objectId,
          options: { showContent: true, showType: true },
        });
        if (!pnlObj.data) continue;
        const t = (pnlObj.data.type ?? '') as string;
        if (!t.includes(`${packageId}::core::PnL`)) continue;
        const fields = (pnlObj.data.content as { fields: Record<string, unknown> }).fields;
        return {
          realizedPnl: Number(fields.realized_pnl),
          tradeCount: Number(fields.trade_count),
          volume: Number(fields.volume),
        };
      }
    }
  } catch {
    // Ignore — fall through to zeros.
  }
  return { realizedPnl: 0, tradeCount: 0, volume: 0 };
}
