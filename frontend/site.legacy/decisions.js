// Decision log reader.
// In production this fetches from a Walrus Site endpoint or reads
// Sui events via the @mysten/sui JSON-RPC. For the demo, we ship
// a deterministic mock dataset that mirrors what the orchestrator
// emits in runCycle().

const WALRUS_BASE = 'https://walrus.site/optic'; // placeholder

export const MOCK_DECISIONS = [
  {
    id: '0xAUDIT_001',
    agent: 'quant',
    action: 'place_order',
    side: 0, // BUY
    confidenceBps: 6200,
    reason: 'mean-reversion-v1: spread=420bps, fair=1_500_000, side=BUY @ 1_500_500',
    atMs: Date.now() - 1000 * 60 * 2,
    txDigest: 'synth-12-0-place_order',
    pnlAfter: 12_500_000n, // +$12.50
    blobId: 'walrus_blob_a3f2',
  },
  {
    id: '0xAUDIT_002',
    agent: 'risk',
    action: 'no_op',
    side: null,
    confidenceBps: 0,
    reason: 'vol 320bps within risk budget (≤800bps), no action',
    atMs: Date.now() - 1000 * 60 * 3,
    txDigest: null,
    pnlAfter: 12_500_000n,
    blobId: 'walrus_blob_b7c1',
  },
  {
    id: '0xAUDIT_003',
    agent: 'executor',
    action: 'place_order',
    side: 1, // SELL
    confidenceBps: 4800,
    reason: 'market-making-v1 tick=14: SELL @ 1_500_750, size=4_000_000',
    atMs: Date.now() - 1000 * 60 * 7,
    txDigest: '0xSYNTH_TX_FAKE_A1',
    pnlAfter: 9_800_000n,
    blobId: 'walrus_blob_c4d9',
  },
  {
    id: '0xAUDIT_004',
    agent: 'risk',
    action: 'open_hedge',
    side: 1, // NO
    confidenceBps: 9000,
    reason: 'vol 1240bps > 800bps → open NO hedge size=100_000_000 strike=1_425_000',
    atMs: Date.now() - 1000 * 60 * 14,
    txDigest: '0xSYNTH_HEDGE_K3',
    pnlAfter: 9_800_000n,
    blobId: 'walrus_blob_e8f0',
  },
  {
    id: '0xAUDIT_005',
    agent: 'quant',
    action: 'no_op',
    side: null,
    confidenceBps: 0,
    reason: 'weak signal: confidence 4.20% < 10% threshold',
    atMs: Date.now() - 1000 * 60 * 19,
    txDigest: null,
    pnlAfter: 9_800_000n,
    blobId: 'walrus_blob_9120',
  },
  {
    id: '0xAUDIT_006',
    agent: 'executor',
    action: 'place_order',
    side: 0, // BUY
    confidenceBps: 5300,
    reason: 'momentum-v1: ask near mid (delta=800) < bid delta=1200 → BUY',
    atMs: Date.now() - 1000 * 60 * 25,
    txDigest: '0xSYNTH_TX_FAKE_B7',
    pnlAfter: 11_200_000n,
    blobId: 'walrus_blob_3456',
  },
  {
    id: '0xAUDIT_007',
    agent: 'risk',
    action: 'pause',
    side: null,
    confidenceBps: 10000,
    reason: 'daily loss circuit breaker: realized PnL = -52_000_000 < -50_000_000',
    atMs: Date.now() - 1000 * 60 * 32,
    txDigest: '0xSYNTH_PAUSE_X9',
    pnlAfter: -52_000_000n,
    blobId: 'walrus_blob_7890',
  },
  {
    id: '0xAUDIT_008',
    agent: 'risk',
    action: 'no_op',
    side: null,
    confidenceBps: 0,
    reason: 'agent status = paused',
    atMs: Date.now() - 1000 * 60 * 33,
    txDigest: null,
    pnlAfter: -52_000_000n,
    blobId: 'walrus_blob_aaaa',
  },
  {
    id: '0xAUDIT_009',
    agent: 'executor',
    action: 'no_op',
    side: null,
    confidenceBps: 0,
    reason: 'executor delegates to orchestrator.dispatch',
    atMs: Date.now() - 1000 * 60 * 40,
    txDigest: null,
    pnlAfter: -52_000_000n,
    blobId: 'walrus_blob_bbbb',
  },
  {
    id: '0xAUDIT_010',
    agent: 'risk',
    action: 'no_op',
    side: null,
    confidenceBps: 0,
    reason: 'vol 480bps within risk budget, treasury < $1, no hedge',
    atMs: Date.now() - 1000 * 60 * 47,
    txDigest: null,
    pnlAfter: -52_000_000n,
    blobId: 'walrus_blob_cccc',
  },
];

export async function fetchLiveDecisions() {
  // In production, hit the Walrus site endpoint that the audit writer
  // publishes to. We keep the URL parameterized so it can be swapped
  // at deploy time.
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${WALRUS_BASE}/decisions.json`, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('expected array');
    return data;
  } catch {
    return null; // fall back to mock
  }
}

export function applyFilters(decisions, filters) {
  return decisions.filter((d) => {
    if (filters.agent !== 'all' && d.agent !== filters.agent) return false;
    if (filters.action !== 'all' && d.action !== filters.action) return false;
    return true;
  });
}

export function renderDecisions(container, decisions) {
  if (decisions.length === 0) {
    container.innerHTML =
      '<div class="decision placeholder">No decisions match the current filters.</div>';
    return;
  }
  container.innerHTML = decisions
    .map((d) => {
      const sideLabel =
        d.side === 0 ? 'BUY' : d.side === 1 ? 'SELL' : '—';
      const pnl = d.pnlAfter != null ? formatUsd(d.pnlAfter) : '—';
      const conf = d.confidenceBps != null ? (d.confidenceBps / 100).toFixed(2) + '%' : '—';
      const ts = formatTimeAgo(d.atMs);
      return `
        <div class="decision">
          <span class="badge ${d.agent}">${d.agent}.sui</span>
          <div class="body">
            <div>
              <span class="badge ${d.action}">${d.action}</span>
              ${d.side != null ? `<span class="badge ${d.side === 0 ? 'quant' : 'risk'}">${sideLabel}</span>` : ''}
              <span class="reason">${escape(d.reason)}</span>
            </div>
          </div>
          <div class="meta">
            <div>conf: <span class="conf">${conf}</span></div>
            <div>pnl: ${pnl}</div>
            <div>${ts}</div>
          </div>
        </div>
      `;
    })
    .join('');
}

function formatUsd(microUsdc) {
  const dollars = Number(microUsdc) / 1_000_000;
  const sign = dollars < 0 ? '-' : '+';
  return `${sign}$${Math.abs(dollars).toFixed(2)}`;
}

function formatTimeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function escape(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
