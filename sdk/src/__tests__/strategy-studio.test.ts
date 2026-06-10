/**
 * Tests for the Strategy Studio module.
 *
 * Run with:
 *   npx tsx --test src/__tests__/strategy-studio.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  StrategySpecSchema,
  canonicalJson,
  generateStrategySpec,
  commitStrategy,
  type LLMClient,
  type StrategySpec,
} from '../strategy-studio.js';

// -----------------------------------------------------------------------------
// A fake LLM that returns canned JSON for testing.
// -----------------------------------------------------------------------------

function fakeLlm(responses: string[]): LLMClient & { calls: { system: string; user: string }[] } {
  const calls: { system: string; user: string }[] = [];
  let i = 0;
  return {
    calls,
    async complete({ system, user }) {
      calls.push({ system, user });
      const text = responses[i++] ?? responses[responses.length - 1] ?? '';
      return text;
    },
  };
}

const VALID_SPEC: StrategySpec = {
  name: 'mean-rev-1pct',
  label: 'Conservative 1% mean reversion on SUI',
  kind: 'mean_reversion',
  market: { baseAsset: 'SUI', quoteAsset: 'USDC' },
  sizing: { sizeBps: 100, minConfidenceBps: 1500, maxOpenPositions: 1 },
  risk: {
    stopLossBps: 200,
    takeProfitBps: 400,
    maxDailyLossUsd: 50_000_000,
    maxLeverageBps: 10_000,
    hedgeVolThresholdBps: 800,
  },
  params: { lookbackBars: 20, entryZ: 2.0 },
  rationale: 'Fade deviations from the 20-bar mean with 1% sizing and a 2% stop.',
  tags: ['conservative', 'mean-reversion'],
};

const VALID_JSON = JSON.stringify(VALID_SPEC);

// -----------------------------------------------------------------------------
// Schema validation
// -----------------------------------------------------------------------------

test('StrategySpecSchema accepts a well-formed spec', () => {
  const r = StrategySpecSchema.safeParse(VALID_SPEC);
  assert.equal(r.success, true);
});

test('StrategySpecSchema rejects missing required fields', () => {
  const bad = { ...VALID_SPEC, name: 'X' }; // name too short
  const r = StrategySpecSchema.safeParse(bad);
  assert.equal(r.success, false);
});

test('StrategySpecSchema rejects invalid kind', () => {
  const bad = { ...VALID_SPEC, kind: 'nonsense' };
  const r = StrategySpecSchema.safeParse(bad);
  assert.equal(r.success, false);
});

test('StrategySpecSchema rejects sizeBps > 10_000', () => {
  const bad = { ...VALID_SPEC, sizing: { ...VALID_SPEC.sizing, sizeBps: 20_000 } };
  const r = StrategySpecSchema.safeParse(bad);
  assert.equal(r.success, false);
});

// -----------------------------------------------------------------------------
// canonicalJson determinism
// -----------------------------------------------------------------------------

test('canonicalJson produces stable output regardless of key order', () => {
  const a = { z: 1, a: 2, m: { y: 1, x: 2 } };
  const b = { a: 2, m: { x: 2, y: 1 }, z: 1 };
  assert.equal(canonicalJson(a as never), canonicalJson(b as never));
});

test('canonicalJson hashes are stable for equivalent specs', () => {
  const a = canonicalJson(VALID_SPEC);
  const reordered: StrategySpec = {
    ...VALID_SPEC,
    sizing: { ...VALID_SPEC.sizing, maxOpenPositions: 1, sizeBps: 100, minConfidenceBps: 1500 },
    market: { ...VALID_SPEC.market, quoteAsset: 'USDC', baseAsset: 'SUI' },
  };
  const b = canonicalJson(reordered);
  const ha = createHash('sha256').update(a).digest('hex');
  const hb = createHash('sha256').update(b).digest('hex');
  assert.equal(ha, hb);
});

test('canonicalJson differs for semantically different specs', () => {
  const ha = createHash('sha256').update(canonicalJson(VALID_SPEC)).digest('hex');
  const modified: StrategySpec = { ...VALID_SPEC, sizing: { ...VALID_SPEC.sizing, sizeBps: 200 } };
  const hb = createHash('sha256').update(canonicalJson(modified)).digest('hex');
  assert.notEqual(ha, hb);
});

// -----------------------------------------------------------------------------
// generateStrategySpec
// -----------------------------------------------------------------------------

test('generateStrategySpec: happy path', async () => {
  const llm = fakeLlm([VALID_JSON]);
  const r = await generateStrategySpec(llm, { prompt: 'make me a mean reversion' });
  assert.equal(r.spec.name, 'mean-rev-1pct');
  assert.equal(r.spec.kind, 'mean_reversion');
  assert.equal(llm.calls.length, 1);
});

test('generateStrategySpec: retries on invalid JSON', async () => {
  // First call returns garbage; we only have one response → it should fail.
  const llm = fakeLlm(['not json at all']);
  await assert.rejects(generateStrategySpec(llm, { prompt: 'whatever' }), /invalid JSON/);
});

test('generateStrategySpec: rejects spec that fails schema', async () => {
  const invalid = { ...VALID_SPEC, name: 'X' };
  const llm = fakeLlm([JSON.stringify(invalid)]);
  await assert.rejects(generateStrategySpec(llm, { prompt: 'whatever' }), /failed schema validation/);
});

test('generateStrategySpec: passes user prompt verbatim', async () => {
  const llm = fakeLlm([VALID_JSON]);
  await generateStrategySpec(llm, { prompt: 'aggressive break-out with 3% sizing' });
  // The user message must contain the natural-language prompt.
  const userCall = llm.calls[0]!;
  assert.match(userCall.user, /aggressive break-out/);
});

// -----------------------------------------------------------------------------
// commitStrategy (mocked Walrus)
// -----------------------------------------------------------------------------

test('commitStrategy: computes hash and returns blob info (no real upload)', async () => {
  // Minimal OpticClient mock — Transaction has object(), pure(), moveCall(), build().
  const fakeOptic = {
    packageId: '0xPKG',
    network: 'testnet' as const,
    sui: {} as never,
    forAgent: (_id: string) => ({
      upload: async (_payload: string, _epochs: number) => ({
        blobId: 'BLOB_123',
        blobHash: 'deadbeef'.repeat(8),
        endEpoch: 1000,
      }),
    }),
    tx: () => {
      const tx: Record<string, unknown> = {
        moveCall: () => {},
        build: async () => new Uint8Array([1, 2, 3, 4]),
      };
      tx.object = () => 'mock-arg';
      tx.pure = () => 'mock-arg';
      (tx.pure as Record<string, unknown>).vector = () => new Uint8Array(32);
      return tx;
    },
  };
  const r = await commitStrategy(fakeOptic as never, VALID_SPEC, { agentId: '0xAGENT' });
  assert.equal(r.spec.name, 'mean-rev-1pct');
  assert.equal(r.blobId, 'BLOB_123');
  assert.equal(r.endEpoch, 1000);
  assert.equal(r.hash.length, 64, 'sha256 hex must be 64 chars');
  // Hash must be deterministic.
  const expected = createHash('sha256').update(canonicalJson(VALID_SPEC)).digest('hex');
  assert.equal(r.hash, expected);
});
