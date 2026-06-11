// OPTIC — Live decision-log reader (self-initializing ES module).
// In production this fetches the audit log the orchestrator publishes
// to a Walrus Site endpoint, or reads Sui events via @mysten/sui JSON-RPC.
// For the demo it falls back to a deterministic mock dataset that mirrors
// what runCycle() emits.

const WALRUS_BASE = 'https://walrus.site/optic'; // placeholder

const MOCK_DECISIONS = [
  { id: '0xAUDIT_001', agent: 'quant',    action: 'place_order', side: 0,    confidenceBps: 6200, reason: 'mean-reversion-v1: spread=420bps, fair=1_500_000, side=BUY @ 1_500_500', atMs: Date.now() - 1000 * 60 * 2,  pnlAfter: 12_500_000n },
  { id: '0xAUDIT_002', agent: 'risk',     action: 'no_op',       side: null, confidenceBps: 0,    reason: 'vol 320bps within risk budget (<=800bps), no action',                 atMs: Date.now() - 1000 * 60 * 3,  pnlAfter: 12_500_000n },
  { id: '0xAUDIT_003', agent: 'executor', action: 'place_order', side: 1,    confidenceBps: 4800, reason: 'market-making-v1 tick=14: SELL @ 1_500_750, size=4_000_000',           atMs: Date.now() - 1000 * 60 * 7,  pnlAfter: 9_800_000n  },
  { id: '0xAUDIT_004', agent: 'risk',     action: 'open_hedge',  side: 1,    confidenceBps: 9000, reason: 'vol 1240bps > 800bps -> open NO hedge size=100_000_000 strike=1_425_000', atMs: Date.now() - 1000 * 60 * 14, pnlAfter: 9_800_000n  },
  { id: '0xAUDIT_005', agent: 'quant',    action: 'no_op',       side: null, confidenceBps: 0,    reason: 'weak signal: confidence 4.20% < 10% threshold',                       atMs: Date.now() - 1000 * 60 * 19, pnlAfter: 9_800_000n  },
  { id: '0xAUDIT_006', agent: 'executor', action: 'place_order', side: 0,    confidenceBps: 5300, reason: 'momentum-v1: ask near mid (delta=800) < bid delta=1200 -> BUY',        atMs: Date.now() - 1000 * 60 * 25, pnlAfter: 11_200_000n },
  { id: '0xAUDIT_007', agent: 'risk',     action: 'pause',       side: null, confidenceBps: 10000,reason: 'daily loss circuit breaker: realized PnL = -52_000_000 < -50_000_000', atMs: Date.now() - 1000 * 60 * 32, pnlAfter: -52_000_000n },
  { id: '0xAUDIT_008', agent: 'risk',     action: 'no_op',       side: null, confidenceBps: 0,    reason: 'agent status = paused',                                               atMs: Date.now() - 1000 * 60 * 33, pnlAfter: -52_000_000n },
  { id: '0xAUDIT_009', agent: 'executor', action: 'no_op',       side: null, confidenceBps: 0,    reason: 'executor delegates to orchestrator.dispatch',                         atMs: Date.now() - 1000 * 60 * 40, pnlAfter: -52_000_000n },
  { id: '0xAUDIT_010', agent: 'risk',     action: 'no_op',       side: null, confidenceBps: 0,    reason: 'vol 480bps within risk budget, treasury < $1, no hedge',              atMs: Date.now() - 1000 * 60 * 47, pnlAfter: -52_000_000n },
];

async function fetchLiveDecisions() {
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

function applyFilters(decisions, filters) {
  return decisions.filter((d) => {
    if (filters.agent !== 'all' && d.agent !== filters.agent) return false;
    if (filters.action !== 'all' && d.action !== filters.action) return false;
    return true;
  });
}

function renderDecisions(container, decisions) {
  if (!decisions.length) {
    container.innerHTML = '<div class="decision placeholder">No decisions match the current filters.</div>';
    return;
  }
  container.innerHTML = decisions.map((d) => {
    const sideLabel = d.side === 0 ? 'BUY' : d.side === 1 ? 'SELL' : null;
    const sideClass = d.side === 0 ? 'buy' : d.side === 1 ? 'sell' : '';
    const conf = d.confidenceBps != null ? (d.confidenceBps / 100).toFixed(2) + '%' : '—';
    const pnlText = d.pnlAfter != null ? formatUsd(d.pnlAfter) : '—';
    const pnlClass = d.pnlAfter != null && Number(d.pnlAfter) < 0 ? 'neg' : 'pos';
    return `
      <div class="decision">
        <span class="badge ${d.agent}">${esc(d.agent)}.sui</span>
        <div class="body">
          <div class="body-top">
            <span class="badge ${d.action}">${esc(d.action)}</span>
            ${sideLabel ? `<span class="badge ${sideClass}">${sideLabel}</span>` : ''}
            <span class="reason">${esc(d.reason)}</span>
          </div>
        </div>
        <div class="meta">
          <span class="conf">conf: ${conf}</span>
          <span class="${pnlClass}">pnl: ${pnlText}</span>
          <span class="ts">${formatTimeAgo(d.atMs)}</span>
        </div>
      </div>`;
  }).join('');
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

function esc(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// ── Wire up the UI ──
async function init() {
  const container = document.getElementById('decisions');
  if (!container) return;
  const agentSel = document.getElementById('filter-agent');
  const actionSel = document.getElementById('filter-action');
  const refreshBtn = document.getElementById('refresh');
  const sourceTag = document.getElementById('feed-source');

  let all = [];

  async function load() {
    container.innerHTML = '<div class="decision placeholder">Loading decision log…</div>';
    const live = await fetchLiveDecisions();
    all = live ?? MOCK_DECISIONS;
    if (sourceTag) sourceTag.textContent = live ? 'live (Walrus)' : 'mock data';
    draw();
  }

  function draw() {
    const filters = {
      agent: agentSel ? agentSel.value : 'all',
      action: actionSel ? actionSel.value : 'all',
    };
    renderDecisions(container, applyFilters(all, filters));
  }

  agentSel && agentSel.addEventListener('change', draw);
  actionSel && actionSel.addEventListener('change', draw);
  refreshBtn && refreshBtn.addEventListener('click', load);

  await load();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

export { MOCK_DECISIONS, fetchLiveDecisions, applyFilters, renderDecisions };
