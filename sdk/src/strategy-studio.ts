/**
 * Strategy Studio — LLM-powered strategy spec generator.
 *
 * The flow:
 *   1. User describes a strategy in natural language on the Walrus Site.
 *   2. `generateStrategySpec({ prompt })` calls an LLM (default: OpenRouter)
 *      and asks it to return a JSON StrategySpec matching the canonical shape.
 *   3. The caller validates the spec against the `StrategySpecSchema`.
 *   4. `commitStrategy(optic, spec)` serializes the spec, computes sha256,
 *      uploads the JSON to Walrus, and submits a `core::update_strategy_hash`
 *      PTB to anchor the blob on-chain.
 *
 * The LLM is OFF the hot path — it only translates intent into a deterministic
 * spec. Once committed, the spec is the source of truth; the strategy runs
 * without the LLM.
 *
 * No LLM provider keys are required at the SDK level. Pass your own client.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { OpticClient } from './client.js';
import type { ObjectId, Address, Hex } from './types.js';
import { WalrusAudit } from './walrus.js';

// -----------------------------------------------------------------------------
// Canonical StrategySpec schema
// -----------------------------------------------------------------------------

export const StrategyKind = z.enum([
  'mean_reversion',
  'momentum',
  'market_making',
  'volatility_breakout',
  'pairs_trading',
  'funding_arb',
  'custom',
]);
export type StrategyKind = z.infer<typeof StrategyKind>;

export const StrategySpecSchema = z.object({
  /// Machine-readable name (kebab-case, <= 64 chars).
  name: z.string().min(3).max(64).regex(/^[a-z0-9-]+$/),
  /// Human-readable label.
  label: z.string().min(3).max(128),
  /// What kind of strategy this is.
  kind: StrategyKind,
  /// Market to trade on.
  market: z.object({
    baseAsset: z.string(),
    quoteAsset: z.string(),
    pool: z.string().optional(), // DeepBook pool id, if known
  }),
  /// Sizing rules.
  sizing: z.object({
    /// Position size as fraction of treasury (bps, 100 = 1%).
    sizeBps: z.number().int().min(1).max(10_000),
    /// Confidence floor below which we sit out (bps, 100 = 1%).
    minConfidenceBps: z.number().int().min(0).max(10_000),
    /// Max number of open positions.
    maxOpenPositions: z.number().int().min(1).max(100).default(1),
  }),
  /// Risk parameters.
  risk: z.object({
    /// Per-trade stop loss in bps from entry.
    stopLossBps: z.number().int().min(0).max(10_000).default(0),
    /// Per-trade take profit in bps from entry.
    takeProfitBps: z.number().int().min(0).max(100_000).default(0),
    /// Max daily loss in micro-USDC; circuit breaker triggers pause.
    maxDailyLossUsd: z.number().int().min(0).default(100_000_000),
    /// Max leverage in bps (10_000 = 1x, 30_000 = 3x).
    maxLeverageBps: z.number().int().min(0).max(100_000).default(10_000),
    /// Realized vol (bps) above which risk agent opens a NO hedge.
    hedgeVolThresholdBps: z.number().int().min(0).max(10_000).default(800),
  }),
  /// Strategy-specific parameters (free-form, kind-specific).
  params: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  /// LLM-provided explanation (1-3 sentences).
  rationale: z.string().min(10).max(2_000),
  /// Tags for discoverability.
  tags: z.array(z.string()).max(16).default([]),
});
export type StrategySpec = z.infer<typeof StrategySpecSchema>;

// -----------------------------------------------------------------------------
// LLM client interface — anything that maps `prompt → text` works.
// -----------------------------------------------------------------------------

export interface LLMClient {
  complete(opts: { system: string; user: string; model?: string }): Promise<string>;
}

/**
 * OpenRouter-backed LLM client. Default endpoint: https://openrouter.ai/api/v1.
 * OpenRouter is provider-agnostic; you can route to GPT-4, Claude, Llama, etc.
 * using the `model` parameter.
 *
 * Set OPENROUTER_API_KEY in your environment.
 */
export class OpenRouterClient implements LLMClient {
  constructor(
    private opts: {
      apiKey: string;
      baseUrl?: string;
      defaultModel?: string;
    },
  ) {
    if (!opts.apiKey) throw new Error('OpenRouterClient: apiKey is required');
  }

  async complete({
    system,
    user,
    model,
  }: {
    system: string;
    user: string;
    model?: string;
  }): Promise<string> {
    const url = (this.opts.baseUrl ?? 'https://openrouter.ai/api/v1') + '/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://optic.sui',
        'X-Title': 'OPTIC Strategy Studio',
      },
      body: JSON.stringify({
        model: model ?? this.opts.defaultModel ?? 'openrouter/auto',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        // Force JSON-mode if the model supports it.
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenRouter HTTP ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('OpenRouter returned no content');
    return text;
  }
}

// -----------------------------------------------------------------------------
// Prompt template
// -----------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a quant strategist. Given a natural-language description of a trading strategy, you produce a JSON StrategySpec that satisfies the OPTIC v1 schema.

Rules:
1. Return ONLY valid JSON, no prose, no markdown fences.
2. Use conservative defaults: sizeBps <= 500 (5%), maxLeverageBps <= 30000 (3x), maxDailyLossUsd <= 1_000_000_000.
3. For the "rationale" field, summarize the strategy in 1-3 sentences in plain English.
4. If the user's description is vague, pick the closest standard strategy and add a "vague-input" tag.
5. Validate that all required fields are present.

Schema reference (also enforced by the validator on the client side):
- name (kebab-case, <=64 chars)
- label (<=128 chars)
- kind: one of mean_reversion | momentum | market_making | volatility_breakout | pairs_trading | funding_arb | custom
- market: { baseAsset, quoteAsset, pool? }
- sizing: { sizeBps, minConfidenceBps, maxOpenPositions }
- risk: { stopLossBps, takeProfitBps, maxDailyLossUsd, maxLeverageBps, hedgeVolThresholdBps }
- params: free-form object of kind-specific tunables
- rationale: 1-3 sentence explanation
- tags: string[] (optional)`;

export interface GenerateOpts {
  /// Natural-language description of the strategy.
  prompt: string;
  /// Optional: market defaults. If omitted, uses SUI/USDC.
  defaultMarket?: { baseAsset: string; quoteAsset: string };
  /// Optional: model override.
  model?: string;
}

export interface GenerateResult {
  spec: StrategySpec;
  /// The raw LLM output, for debugging.
  raw: string;
}

/// Generate a StrategySpec from a natural-language prompt.
/// Throws if the LLM output does not validate against the schema.
export async function generateStrategySpec(
  llm: LLMClient,
  opts: GenerateOpts,
): Promise<GenerateResult> {
  const user = `Default market: ${JSON.stringify(
    opts.defaultMarket ?? { baseAsset: 'SUI', quoteAsset: 'USDC' },
  )}

User's strategy description:
"""
${opts.prompt}
"""

Return a JSON StrategySpec.`;

  const raw = await llm.complete({ system: SYSTEM_PROMPT, user: opts.prompt, model: opts.model });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`LLM returned invalid JSON: ${(err as Error).message}\nRaw: ${raw.slice(0, 500)}`);
  }
  const result = StrategySpecSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `LLM output failed schema validation: ${result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}\nRaw: ${raw.slice(0, 500)}`,
    );
  }
  return { spec: result.data, raw };
}

// -----------------------------------------------------------------------------
// Commit + execute: hash → Walrus blob → on-chain anchor
// -----------------------------------------------------------------------------

export interface CommitOpts {
  agentId: ObjectId;
  /// Number of epochs the blob should be stored on Walrus.
  epochs?: number;
}

export interface CommitResult {
  spec: StrategySpec;
  /// SHA-256 of the canonical JSON encoding of the spec.
  hash: Hex;
  /// Walrus blob ID for the uploaded spec.
  blobId: string;
  /// End epoch of the blob's storage.
  endEpoch: number;
  /// The Move call object ref for the update_strategy_hash PTB.
  updateHashTxBytes: Uint8Array;
}

/// Commit a StrategySpec to Walrus + return a PTB-ready Transaction for
/// on-chain anchoring. The caller is responsible for signing + submitting.
export async function commitStrategy(
  client: OpticClient,
  spec: StrategySpec,
  opts: CommitOpts,
): Promise<CommitResult> {
  // 1. Canonical JSON (sorted keys for determinism).
  const canonical = canonicalJson(spec);
  const bytes = new TextEncoder().encode(canonical);
  const hash = createHash('sha256').update(bytes).digest('hex') as Hex;

  // 2. Upload to Walrus.
  const audit = client.forAgent(opts.agentId);
  const uploaded = await audit.upload(canonical, opts.epochs ?? 5);

  // 3. Build a PTB that calls core::update_strategy_hash with the new hash.
  // The actual hash is a 32-byte vector; we encode hex → bytes here.
  const hashBytes = new Uint8Array(Buffer.from(hash, 'hex'));
  const tx = client.tx();
  tx.moveCall({
    target: `${client.packageId}::core::update_strategy_hash`,
    arguments: [
      tx.object(opts.agentId),
      tx.pure.vector('u8', Array.from(hashBytes)),
      // Optional<ID> for the new blob_id — wrap in some() tag
      tx.pure(
        new Uint8Array([
          0x01,
          ...new TextEncoder().encode(uploaded.blobId),
        ]),
      ),
    ],
  });
  // We don't sign+submit here; the caller composes the rest of the PTB.
  const txBytes = await tx.build({ client: client.sui });

  return {
    spec,
    hash,
    blobId: uploaded.blobId,
    endEpoch: uploaded.endEpoch,
    updateHashTxBytes: txBytes,
  };
}

/// Convert a StrategySpec to a deterministic JSON string with sorted keys.
/// This ensures sha256(spec1) === sha256(spec2) iff the specs are equivalent.
export function canonicalJson(spec: StrategySpec): string {
  return JSON.stringify(spec, sortedReplacer, 0);
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = obj[k];
        return acc;
      }, {});
  }
  return value;
}
