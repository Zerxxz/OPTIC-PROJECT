/**
 * Leaderboard front-end.
 *
 * Calls the Sui RPC directly to read AgentRegistry + Agent + PnL objects.
 * In production this would be served by an indexer; for the demo we hit
 * the public fullnode.
 *
 * To wire this to a real testnet deployment, set the meta tags in
 * index.html / leaderboard.html:
 *   <meta name="optic-package" content="0x...">
 *   <meta name="optic-registry" content="0x...">
 *   <meta name="optic-network" content="testnet">
 */

const tbody = document.getElementById('lb-tbody');
const sortBy = document.getElementById('sort-by');
const activeOnly = document.getElementById('active-only');
const refresh = document.getElementById('refresh-btn');
const status = document.getElementById('status');

const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') || '';
const PKG = meta('optic-package');
const REG = meta('optic-registry');
const NET = meta('optic-network') || 'testnet';

const RPC = {
  mainnet: 'https://fullnode.mainnet.sui.io:443',
  testnet: 'https://fullnode.testnet.sui.io:443',
  devnet: 'https://fullnode.devnet.sui.io:443',
}[NET] || 'https://fullnode.testnet.sui.io:443';

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

async function getObject(id) {
  const r = await rpc('sui_getObject', [
    id,
    { showType: true, showContent: true },
  ]);
  return r;
}

async function getDynamicFields(parent) {
  const r = await rpc('suix_getDynamicFields', [parent, null, 50]);
  return r.data;
}

function fmtUsd(n) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function statusBadge(s) {
  if (s === 'active') return '<span class="badge ok">active</span>';
  if (s === 'paused') return '<span class="badge warn">paused</span>';
  return '<span class="badge bad">liquidated</span>';
}

async function loadLeaderboard() {
  if (!PKG || !REG) {
    status.textContent = 'Missing <meta name="optic-package"> or <meta name="optic-registry">. Configure to load live data.';
    return;
  }
  refresh.disabled = true;
  status.textContent = 'Reading AgentRegistry…';
  tbody.innerHTML = '<tr><td colspan="8" class="muted">Loading…</td></tr>';
  try {
    const reg = await getObject(REG);
    const agents = reg?.content?.fields?.agents?.vec || [];
    if (!agents.length) {
      status.textContent = `Registry has 0 agents.`;
      tbody.innerHTML = '<tr><td colspan="8" class="muted">No agents yet.</td></tr>';
      return;
    }
    status.textContent = `Reading ${agents.length} agents…`;
    const rows = [];
    for (const id of agents) {
      const a = await getObject(id);
      if (!a?.content?.fields) continue;
      const f = a.content.fields;
      const statusNum = Number(f.status);
      const s = statusNum === 0 ? 'active' : statusNum === 1 ? 'paused' : 'liquidated';
      if (activeOnly.checked && s !== 'active') continue;
      // PnL via dynamic fields
      let realized = 0, trades = 0, volume = 0;
      try {
        const dyn = await getDynamicFields(id);
        for (const field of dyn) {
          if (String(field.objectType).includes('core::PnL')) {
            const p = await getObject(field.objectId);
            const pf = p?.content?.fields || {};
            realized = Number(pf.realized_pnl || 0);
            trades = Number(pf.trade_count || 0);
            volume = Number(pf.volume || 0);
            break;
          }
        }
      } catch (_) { /* ignore */ }
      const realizedUsd = realized / 1_000_000;
      const volumeUsd = volume / 1_000_000;
      const sharpe = trades >= 2 ? realizedUsd / Math.max(1, volumeUsd) * Math.sqrt(365) : 0;
      rows.push({
        agentId: id,
        name: String(f.name || '?'),
        owner: String(f.owner || '?'),
        status: s,
        sharpe,
        realizedPnlUsd: realizedUsd,
        volumeUsd,
        trades,
      });
    }
    const sb = sortBy.value;
    rows.sort((x, y) => y[sb] - x[sb]);
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="muted">No agents match the filter.</td></tr>';
      status.textContent = `Done. 0 agents match.`;
      return;
    }
    tbody.innerHTML = rows
      .map(
        (r, i) => `
        <tr>
          <td>${i + 1}</td>
          <td><a href="https://suiscan.xyz/${NET}/object/${r.agentId}" target="_blank" rel="noreferrer">${r.name}</a></td>
          <td><code class="mono small">${r.owner.slice(0, 6)}…${r.owner.slice(-4)}</code></td>
          <td>${statusBadge(r.status)}</td>
          <td>${r.sharpe.toFixed(3)}</td>
          <td>${fmtUsd(r.realizedPnlUsd)}</td>
          <td>${fmtUsd(r.volumeUsd)}</td>
          <td>${r.trades}</td>
        </tr>`,
      )
      .join('');
    status.textContent = `Done. ${rows.length} agents ranked by ${sb}.`;
  } catch (err) {
    status.textContent = 'Error: ' + (err?.message ?? err);
    tbody.innerHTML = '<tr><td colspan="8" class="muted">Failed to load.</td></tr>';
  } finally {
    refresh.disabled = false;
  }
}

refresh?.addEventListener('click', loadLeaderboard);
sortBy?.addEventListener('change', loadLeaderboard);
activeOnly?.addEventListener('change', loadLeaderboard);
