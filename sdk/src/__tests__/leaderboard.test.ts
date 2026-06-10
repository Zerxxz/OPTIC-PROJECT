/**
 * Tests for the Leaderboard module.
 * Run with: npx tsx --test src/__tests__/leaderboard.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLeaderboard, type Leaderboard } from '../leaderboard.js';

// -----------------------------------------------------------------------------
// Mocks
// -----------------------------------------------------------------------------

function mockSuiClient(registry: { agents: string[] }, agents: Record<string, any> = {}, pnl: Record<string, any> = {}) {
  // pnl is keyed by PnL object id (e.g. 'PNL_OF_A1'), which the leaderboard
  // resolves via getDynamicFields on the parent agent.
  return {
    async getObject({ id }: { id: string; options: any }) {
      if (id === 'REGISTRY') {
        return {
          data: {
            objectId: 'REGISTRY',
            type: '0xPKG::core::AgentRegistry',
            content: {
              dataType: 'moveObject',
              fields: { agents: { vec: registry.agents } },
            },
          },
        };
      }
      if (id in pnl) {
        return { data: pnl[id] };
      }
      if (id in agents) {
        return { data: agents[id] };
      }
      return { data: null };
    },
    async getDynamicFields({ parentId }: { parentId: string }) {
      // Look for `PNL_OF_<parentId>` in pnl map.
      const pnlId = `PNL_OF_${parentId}`;
      if (pnlId in pnl) {
        return {
          data: [
            { name: { type: '0x2::object::ID' }, objectType: '0xPKG::core::PnL', objectId: pnlId },
          ],
          hasNextPage: false,
          nextCursor: null,
        };
      }
      return { data: [], hasNextPage: false, nextCursor: null };
    },
  } as never;
}

function agentObj(id: string, name: string, status: number) {
  return {
    objectId: id,
    type: '0xPKG::core::Agent',
    content: {
      dataType: 'moveObject',
      fields: {
        owner: '0xOWNER',
        name,
        strategy_hash: '0xSTRAT',
        status,
      },
    },
  };
}

function pnlObj(id: string, realizedPnl: number, trades: number, volume: number) {
  return {
    objectId: id,
    type: '0xPKG::core::PnL',
    content: {
      dataType: 'moveObject',
      fields: { realized_pnl: realizedPnl, trade_count: trades, volume },
    },
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

test('computeLeaderboard: rejects when packageId is the default sentinel', async () => {
  await assert.rejects(
    computeLeaderboard({ network: 'testnet', registryId: 'REGISTRY' } as never),
    /packageId is required/,
  );
});

test('computeLeaderboard: rejects when registryId is missing', async () => {
  await assert.rejects(
    computeLeaderboard({ network: 'testnet', packageId: '0xPKG' } as never),
    /registryId is required/,
  );
});

test('computeLeaderboard: ranks agents by Sharpe desc', async () => {
  const registry = { agents: ['A1', 'A2', 'A3'] };
  const agents = {
    A1: agentObj('A1', 'alpha', 0),    // active
    A2: agentObj('A2', 'beta', 0),     // active
    A3: agentObj('A3', 'gamma', 0),    // active
  };
  // pnl keyed by PnL object id (PNL_OF_<agentId>).
  const pnl = {
    PNL_OF_A1: pnlObj('PNL_OF_A1', 1_000_000, 50, 100_000_000),    // $1, 50 trades, $100
    PNL_OF_A2: pnlObj('PNL_OF_A2', 5_000_000, 80, 200_000_000),    // $5, 80 trades, $200
    PNL_OF_A3: pnlObj('PNL_OF_A3', 0, 0, 0),                         // no trades
  };
  const sui = mockSuiClient(registry, agents, pnl);
  const lb: Leaderboard = await computeLeaderboard({
    network: 'testnet',
    packageId: '0xPKG',
    registryId: 'REGISTRY',
    sui,
    activeOnly: true,
    sortBy: 'sharpe',
  });
  assert.equal(lb.totalAgents, 3);
  assert.equal(lb.ranked, 3);
  // Beta has highest realized PnL & trades → highest Sharpe
  assert.equal(lb.entries[0]!.agentId, 'A2');
  assert.equal(lb.entries[0]!.name, 'beta');
  assert.equal(lb.entries[1]!.agentId, 'A1');
  assert.equal(lb.entries[2]!.agentId, 'A3');
  // No-trade agent has Sharpe = 0
  assert.equal(lb.entries[2]!.metrics.sharpe, 0);
});

test('computeLeaderboard: filters paused/liquidated when activeOnly=true', async () => {
  const registry = { agents: ['A1', 'A2', 'A3'] };
  const agents = {
    A1: agentObj('A1', 'active', 0),
    A2: agentObj('A2', 'paused', 1),
    A3: agentObj('A3', 'liquidated', 2),
  };
  const sui = mockSuiClient(registry, agents, {});
  const lb = await computeLeaderboard({
    network: 'testnet',
    packageId: '0xPKG',
    registryId: 'REGISTRY',
    sui,
    activeOnly: true,
  });
  assert.equal(lb.ranked, 1);
  assert.equal(lb.entries[0]!.name, 'active');
});

test('computeLeaderboard: includes all statuses when activeOnly=false', async () => {
  const registry = { agents: ['A1', 'A2', 'A3'] };
  const agents = {
    A1: agentObj('A1', 'a', 0),
    A2: agentObj('A2', 'p', 1),
    A3: agentObj('A3', 'l', 2),
  };
  const sui = mockSuiClient(registry, agents, {});
  const lb = await computeLeaderboard({
    network: 'testnet',
    packageId: '0xPKG',
    registryId: 'REGISTRY',
    sui,
    activeOnly: false,
  });
  assert.equal(lb.ranked, 3);
});

test('computeLeaderboard: respects limit', async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `A${i}`);
  const registry = { agents: ids };
  const agents = Object.fromEntries(ids.map((id) => [id, agentObj(id, id, 0)]));
  const sui = mockSuiClient(registry, agents, {});
  const lb = await computeLeaderboard({
    network: 'testnet',
    packageId: '0xPKG',
    registryId: 'REGISTRY',
    sui,
    limit: 3,
  });
  assert.equal(lb.entries.length, 3);
  assert.equal(lb.entries[0]!.rank, 1);
  assert.equal(lb.entries[2]!.rank, 3);
});

test('computeLeaderboard: handles empty registry', async () => {
  const sui = mockSuiClient({ agents: [] });
  const lb = await computeLeaderboard({
    network: 'testnet',
    packageId: '0xPKG',
    registryId: 'REGISTRY',
    sui,
  });
  assert.equal(lb.totalAgents, 0);
  assert.equal(lb.ranked, 0);
  assert.equal(lb.entries.length, 0);
});

test('computeLeaderboard: returns realized PnL in USD (1e-6 conversion)', async () => {
  const registry = { agents: ['A1'] };
  const agents = { A1: agentObj('A1', 'one', 0) };
  const pnl = { PNL_OF_A1: pnlObj('PNL_OF_A1', 12_345_678, 5, 0) };
  const sui = mockSuiClient(registry, agents, pnl);
  const lb = await computeLeaderboard({
    network: 'testnet',
    packageId: '0xPKG',
    registryId: 'REGISTRY',
    sui,
  });
  assert.equal(lb.entries[0]!.metrics.realizedPnlUsd, 12.345678);
  assert.equal(lb.entries[0]!.metrics.trades, 5);
});
