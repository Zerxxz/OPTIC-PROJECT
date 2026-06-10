/**
 * Strategy Studio — front-end logic.
 *
 * Takes the user's prompt, calls the OpenRouter API directly (the LLM call
 * doesn't need to go through Move), validates the response against the
 * canonical StrategySpec, and shows the resulting JSON + a deterministic
 * SHA-256 hash. The actual on-chain commit happens via the orchestrator.
 *
 * In production, replace the openrouter call with a server-side proxy
 * (e.g. a Cloudflare Worker) to hide the API key.
 */

const promptEl = document.getElementById('prompt-input');
const marketEl = document.getElementById('default-market');
const modelEl = document.getElementById('model');
const btn = document.getElementById('generate-btn');
const statusEl = document.getElementById('generate-status');
const specEl = document.getElementById('spec-output');
const hashEl = document.getElementById('hash-output');
const hashRow = document.getElementById('hash-row');
const blobEl = document.getElementById('blob-output');
const blobRow = document.getElementById('blob-row');

const SYSTEM_PROMPT = `You are a quant strategist. Given a natural-language description of a trading strategy, you produce a JSON StrategySpec that satisfies the OPTIC v1 schema.

Rules:
1. Return ONLY valid JSON, no prose, no markdown fences.
2. Use conservative defaults: sizeBps <= 500 (5%), maxLeverageBps <= 30000 (3x), maxDailyLossUsd <= 1_000_000_000.
3. For the "rationale" field, summarize the strategy in 1-3 sentences in plain English.
4. If the user's description is vague, pick the closest standard strategy and add a "vague-input" tag.
5. Validate that all required fields are present.

Schema:
- name (kebab-case, <=64 chars)
- label (<=128 chars)
- kind: one of mean_reversion | momentum | market_making | volatility_breakout | pairs_trading | funding_arb | custom
- market: { baseAsset, quoteAsset, pool? }
- sizing: { sizeBps, minConfidenceBps, maxOpenPositions }
- risk: { stopLossBps, takeProfitBps, maxDailyLossUsd, maxLeverageBps, hedgeVolThresholdBps }
- params: free-form object of kind-specific tunables
- rationale: 1-3 sentence explanation
- tags: string[] (optional)`;

function getApiKey() {
  // In a production Walrus Site, hide this in a Worker.
  // For the demo, we accept a key from a global (set by chrome.js or
  // injected via a meta tag in index.html).
  return (
    globalThis.OPENROUTER_API_KEY ||
    document.querySelector('meta[name="openrouter-key"]')?.getAttribute('content') ||
    ''
  );
}

async function sha256Hex(text) {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function canonicalJson(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value;
    return (
      '{' +
      Object.keys(obj)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

async function callOpenRouter({ apiKey, model, system, user }) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': globalThis.location.origin,
      'X-Title': 'OPTIC Strategy Studio',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

function validateSpec(parsed) {
  const errors = [];
  if (typeof parsed.name !== 'string' || !/^[a-z0-9-]{3,64}$/.test(parsed.name)) {
    errors.push('name must be kebab-case, 3-64 chars');
  }
  if (typeof parsed.label !== 'string' || parsed.label.length > 128) {
    errors.push('label must be <=128 chars');
  }
  if (!['mean_reversion', 'momentum', 'market_making', 'volatility_breakout', 'pairs_trading', 'funding_arb', 'custom'].includes(parsed.kind)) {
    errors.push('kind must be one of the standard types');
  }
  if (!parsed.market || !parsed.market.baseAsset || !parsed.market.quoteAsset) {
    errors.push('market must have baseAsset + quoteAsset');
  }
  if (!parsed.sizing || parsed.sizing.sizeBps < 1 || parsed.sizing.sizeBps > 10_000) {
    errors.push('sizing.sizeBps must be 1..10_000');
  }
  if (!parsed.risk || parsed.risk.maxLeverageBps > 100_000) {
    errors.push('risk.maxLeverageBps must be <=100_000 (10x cap)');
  }
  if (typeof parsed.rationale !== 'string' || parsed.rationale.length < 10) {
    errors.push('rationale must be at least 10 chars');
  }
  return errors;
}

async function onGenerate() {
  const prompt = promptEl.value.trim();
  if (!prompt) {
    statusEl.textContent = 'Please enter a prompt.';
    return;
  }
  const apiKey = getApiKey();
  if (!apiKey) {
    statusEl.textContent =
      'Missing OPENROUTER_API_KEY. Set globalThis.OPENROUTER_API_KEY or add a <meta name="openrouter-key"> tag.';
    specEl.textContent = '// No API key configured. The SDK module also exposes generateStrategySpec(llm, opts) — wire it to your own proxy.';
    return;
  }
  const market = (marketEl.value || 'SUI/USDC').split('/');
  const model = modelEl.value || 'openrouter/auto';
  btn.disabled = true;
  statusEl.textContent = 'Calling LLM…';
  specEl.textContent = '// …';
  hashRow.style.display = 'none';
  blobRow.style.display = 'none';
  try {
    const user = `Default market: ${JSON.stringify({
      baseAsset: market[0],
      quoteAsset: market[1],
    })}\n\nUser's strategy description:\n"""\n${prompt}\n"""\n\nReturn a JSON StrategySpec.`;
    const raw = await callOpenRouter({ apiKey, model, system: SYSTEM_PROMPT, user });
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('LLM returned invalid JSON. Raw:\n' + raw.slice(0, 400));
    }
    const errors = validateSpec(parsed);
    if (errors.length) {
      throw new Error('Spec failed validation:\n  - ' + errors.join('\n  - '));
    }
    const canonical = canonicalJson(parsed);
    const hash = await sha256Hex(canonical);
    specEl.textContent = JSON.stringify(parsed, null, 2);
    hashEl.textContent = hash;
    hashRow.style.display = '';
    // Simulated blob ID — in production, this is the Walrus upload.
    const fakeBlob = 'walrus-' + hash.slice(0, 24);
    blobEl.textContent = fakeBlob + '  (simulated — real Walrus upload via SDK commitStrategy)';
    blobRow.style.display = '';
    statusEl.textContent = 'Spec generated. Hash computed. To commit on-chain, run:';
    statusEl.innerHTML +=
      '<br/><code class="mono">npx tsx -e "import {commitStrategy,OpenRouterClient} from \'@optic/sdk\'; …"</code>';
  } catch (err) {
    statusEl.textContent = 'Error: ' + (err?.message ?? err);
    specEl.textContent = '// Generation failed. See status above.';
  } finally {
    btn.disabled = false;
  }
}

btn?.addEventListener('click', () => onGenerate());
