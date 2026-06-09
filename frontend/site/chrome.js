// Shared chrome — top bar, ripple layer, footer, theme toggle, REAL zkLogin.
//
// On any page that includes this script:
//   <script type="module" src="./chrome.js"></script>
//
// The Connect button drives the full real zkLogin flow:
//   1. Generate ephemeral Ed25519 keypair + nonce
//   2. Open Google OAuth popup (id_token flow)
//   3. POST the JWT to the salt service
//   4. Derive the Sui address from (jwt, salt)
//   5. Request a ZK proof from the Sui prover
//   6. Persist the session to localStorage
// The derived address is a real Sui address — verifiable on any explorer.

import {
  configureZkLogin,
  loadSession,
  clearSession,
  connectZkLogin,
} from './zklogin.mjs';

// ── Configuration ────────────────────────────────────────────────────────────
// Override these via window.OPTIC_CONFIG before this script runs, e.g.:
//   <script>window.OPTIC_CONFIG = { googleClientId: '...', saltUrl: '...' };</script>
//   <script type="module" src="./chrome.js"></script>
const DEFAULT_GOOGLE_CLIENT_ID =
  // Mysten's public zkLogin demo client. Testnet only.
  // For production, create your own in Google Cloud Console and override.
  '936519192202-tiptjpks49g6k0pll5pq7l50blc3djrq.apps.googleusercontent.com';

const DEFAULT_SALT_URL =
  'https://optic-salt.0xbojeng.workers.dev/salt';

configureZkLogin({
  network: 'testnet',
  googleClientId:
    (globalThis.OPTIC_CONFIG && globalThis.OPTIC_CONFIG.googleClientId) ||
    DEFAULT_GOOGLE_CLIENT_ID,
  saltUrl:
    (globalThis.OPTIC_CONFIG && globalThis.OPTIC_CONFIG.saltUrl) ||
    DEFAULT_SALT_URL,
});

// ── Page detection ───────────────────────────────────────────────────────────
const page = document.body.dataset.page || 'home';

// ── Theme (apply before paint) ───────────────────────────────────────────────
try {
  const t = localStorage.getItem('optic-theme');
  if (t === 'light') document.documentElement.classList.add('theme-light');
} catch {}

// ── Top bar ──────────────────────────────────────────────────────────────────
const topbar = document.createElement('header');
topbar.className = 'topbar';
topbar.innerHTML = `
  <a class="brand" href="./index.html" style="text-decoration:none;color:inherit;">
    <span class="logo" aria-hidden="true"></span>
    <span class="brand-text">OPTIC</span>
    <span class="suins-badge">optic.sui</span>
  </a>
  <nav class="nav" aria-label="Primary">
    <a href="./index.html"     data-page="home">Overview</a>
    <a href="./how.html"       data-page="how">How it works</a>
    <a href="./decisions.html" data-page="decisions">Decisions</a>
    <a href="./agents.html"    data-page="agents">Agents</a>
    <a href="./links.html"     data-page="links">Repo</a>
  </nav>
  <button id="themeToggle" class="theme-toggle" title="Toggle theme" aria-label="Toggle theme">☼</button>
  <button id="connectBtn" class="connect">Connect with zkLogin</button>
`;
document.body.prepend(topbar);

topbar.querySelectorAll('.nav a').forEach((a) => {
  if (a.dataset.page === page) a.classList.add('active');
});

// ── Water-ripple layer ───────────────────────────────────────────────────────
const ripple = document.createElement('div');
ripple.className = 'ripple-layer';
ripple.setAttribute('aria-hidden', 'true');
const ripples = [
  { x: '20%', y: '30%', delay: '0s',   cls: '' },
  { x: '70%', y: '25%', delay: '4s',   cls: 'r2' },
  { x: '50%', y: '75%', delay: '8s',   cls: 'r3' },
  { x: '85%', y: '60%', delay: '12s',  cls: 'r4' },
];
ripples.forEach((r) => {
  const d = document.createElement('div');
  d.className = `ripple ${r.cls}`;
  d.style.left = r.x;
  d.style.top = r.y;
  d.style.animationDelay = r.delay;
  ripple.appendChild(d);
});
document.body.appendChild(ripple);

// ── Footer ───────────────────────────────────────────────────────────────────
if (!document.querySelector('footer.footer')) {
  const footer = document.createElement('footer');
  footer.className = 'footer';
  footer.innerHTML = `
    <div>OPTIC · Sui Overflow 2026 · Apache-2.0</div>
    <div>Built by <code>optic.sui</code></div>
  `;
  document.body.appendChild(footer);
}

// ── Theme toggle ─────────────────────────────────────────────────────────────
const themeBtn = document.getElementById('themeToggle');
const updateIcon = () => {
  const isLight = document.documentElement.classList.contains('theme-light');
  themeBtn.textContent = isLight ? '☾' : '☼';
};
updateIcon();
themeBtn.addEventListener('click', () => {
  const isLight = document.documentElement.classList.toggle('theme-light');
  try { localStorage.setItem('optic-theme', isLight ? 'light' : 'dark'); } catch {}
  updateIcon();
});

// ── zkLogin: REAL FLOW ───────────────────────────────────────────────────────
const btn = document.getElementById('connectBtn');

function setBtn(text, opts = {}) {
  btn.textContent = text;
  btn.classList.toggle('connected', !!opts.connected);
  btn.disabled = !!opts.disabled;
  btn.title = opts.title || '';
}

function shortAddr(a) {
  if (!a) return '';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function explorerLink(addr) {
  return `https://suiscan.xyz/testnet/account/${addr}`;
}

// Restore previous session on page load.
const existing = loadSession();
if (existing) {
  setBtn(`Connected · ${shortAddr(existing.suiAddress)}`, {
    connected: true,
    title: `${existing.suiAddress}\nView on SuiScan ↗`,
  });
  btn.dataset.address = existing.suiAddress;
}

btn.addEventListener('click', async () => {
  // Already connected? Disconnect.
  if (btn.classList.contains('connected')) {
    clearSession();
    setBtn('Connect with zkLogin');
    delete btn.dataset.address;
    return;
  }

  try {
    setBtn('Connecting…', { disabled: true });
    const session = await connectZkLogin({
      onStage: (stage) => setBtn(stage, { disabled: true }),
    });
    setBtn(`Connected · ${shortAddr(session.suiAddress)}`, {
      connected: true,
      title: `${session.suiAddress}\nView on SuiScan ↗`,
    });
    btn.dataset.address = session.suiAddress;
    // Persist a global for the rest of the page.
    globalThis.OPTIC = {
      ...(globalThis.OPTIC || {}),
      session,
      explorerLink: () => explorerLink(session.suiAddress),
    };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    setBtn('Connect with zkLogin', { title: msg });
    // eslint-disable-next-line no-alert
    alert(`zkLogin failed:\n${msg}`);
  }
});

// Click-to-copy on connected button.
btn.addEventListener('click', () => {
  if (!btn.classList.contains('connected')) return;
  const addr = btn.dataset.address;
  if (!addr) return;
  navigator.clipboard?.writeText(addr).catch(() => {});
});

// ── View Transitions ─────────────────────────────────────────────────────────
const supportsVT = typeof document.startViewTransition === 'function';
topbar.querySelectorAll('.nav a, .brand').forEach((a) => {
  a.addEventListener('click', (e) => {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('http') || href.startsWith('#')) return;
    if (a.classList.contains('active')) { e.preventDefault(); return; }
    if (!supportsVT) return;
    e.preventDefault();
    document.startViewTransition(() => { window.location.href = href; });
  });
});

// Expose state for debugging.
globalThis.OPTIC = {
  ...(globalThis.OPTIC || {}),
  page,
  supportsVT,
  config: {
    googleClientId: (globalThis.OPTIC_CONFIG && globalThis.OPTIC_CONFIG.googleClientId) || DEFAULT_GOOGLE_CLIENT_ID,
    saltUrl: (globalThis.OPTIC_CONFIG && globalThis.OPTIC_CONFIG.saltUrl) || DEFAULT_SALT_URL,
    network: 'testnet',
  },
};
