// OPTIC frontend — Walrus Site
// Decision log reader + zkLogin stub

import { renderDecisions, applyFilters, MOCK_DECISIONS, fetchLiveDecisions } from './decisions.js';

// ─── State ───────────────────────────────────────────────────────────────
const state = {
  agentFilter: 'all',
  actionFilter: 'all',
  connected: false,
  address: null,
};

// ─── DOM helpers ─────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── Filter wiring ───────────────────────────────────────────────────────
$('#agentFilter').addEventListener('change', (e) => {
  state.agentFilter = e.target.value;
  rerender();
});
$('#actionFilter').addEventListener('change', (e) => {
  state.actionFilter = e.target.value;
  rerender();
});
$('#refreshBtn').addEventListener('click', async () => {
  $('#decisionList').innerHTML =
    '<div class="decision placeholder">Refreshing from Walrus…</div>';
  await load();
});

// ─── zkLogin (stub) ──────────────────────────────────────────────────────
// Real flow: open popup → Google OAuth → get JWT → derive Sui address from
// JWT + ephemeral keypair via @mysten/zklogin. For the Walrus Site demo
// we keep this lightweight; the production flow is documented in /docs.
$('#connectBtn').addEventListener('click', async () => {
  if (state.connected) {
    state.connected = false;
    state.address = null;
    $('#connectBtn').textContent = 'Connect with zkLogin';
    $('#connectBtn').classList.remove('connected');
    return;
  }
  $('#connectBtn').textContent = 'Connecting…';
  $('#connectBtn').disabled = true;
  try {
    // In a real build this is a redirect to the OAuth provider.
    // We simulate a 1.5s handshake so the UI flow is visible.
    await new Promise((r) => setTimeout(r, 1500));
    const fakeAddr = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    state.connected = true;
    state.address = fakeAddr;
    $('#connectBtn').textContent = `Connected · ${fakeAddr.slice(0, 8)}…`;
    $('#connectBtn').classList.add('connected');
  } catch (err) {
    console.error('zkLogin failed', err);
    $('#connectBtn').textContent = 'Connect with zkLogin';
  } finally {
    $('#connectBtn').disabled = false;
  }
});

// ─── Load + render ───────────────────────────────────────────────────────
async function load() {
  let decisions;
  try {
    decisions = await fetchLiveDecisions();
    if (!decisions || decisions.length === 0) {
      console.info('No live decisions from Walrus — using demo dataset.');
      decisions = MOCK_DECISIONS;
    }
  } catch (err) {
    console.warn('Walrus fetch failed, falling back to mock:', err);
    decisions = MOCK_DECISIONS;
  }
  state.decisions = decisions;
  rerender();
}

function rerender() {
  const filtered = applyFilters(state.decisions ?? MOCK_DECISIONS, {
    agent: state.agentFilter,
    action: state.actionFilter,
  });
  renderDecisions($('#decisionList'), filtered);
}

// ─── Boot ────────────────────────────────────────────────────────────────
load();

// Expose for console debugging
window.OPTIC = { state, load, MOCK_DECISIONS };
