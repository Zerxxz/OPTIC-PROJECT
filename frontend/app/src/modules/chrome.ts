/**
 * Shared chrome — top bar, ripple layer, footer, theme toggle, REAL zkLogin.
 *
 * Usage: import { mountChrome } from '@/modules/chrome'; mountChrome();
 * Call once per page after DOMContentLoaded.
 *
 * Architecture:
 * - chrome.ts itself is tiny (topbar, theme, ripples, view transitions)
 * - zklogin.mjs (763KB) is loaded DYNAMICALLY only on first "Connect" click
 * - This means pages that never connect (most of them) skip the entire zkLogin
 *   SDK download + parse cost.
 */
import type { ZkLoginSession, ZkLoginConfig, ZkLoginModule } from '@/types/zklogin';
import { mountHead } from './head';

// ── Configuration ────────────────────────────────────────────────────────────
const DEFAULT_GOOGLE_CLIENT_ID =
  '936519192202-tiptjpks49g6k0pll5pq7l50blc3djrq.apps.googleusercontent.com';
const DEFAULT_SALT_URL = 'https://optic-salt.0xbojeng.workers.dev/salt';

interface OpticConfig {
  googleClientId?: string;
  saltUrl?: string;
}

declare global {
  interface Window {
    OPTIC_CONFIG?: OpticConfig;
    OPTIC?: {
      session?: ZkLoginSession;
      page?: string;
      supportsVT?: boolean;
      config?: {
        googleClientId: string;
        saltUrl: string;
        network: 'testnet' | 'mainnet' | 'devnet';
      };
      explorerLink?: () => string;
    };
  }
}

function readConfig(): Required<OpticConfig> {
  return {
    googleClientId: window.OPTIC_CONFIG?.googleClientId ?? DEFAULT_GOOGLE_CLIENT_ID,
    saltUrl: window.OPTIC_CONFIG?.saltUrl ?? DEFAULT_SALT_URL,
  };
}

// ── Theme (apply before paint) ───────────────────────────────────────────────
function applyStoredTheme(): void {
  try {
    const t = localStorage.getItem('optic-theme');
    if (t === 'light') document.documentElement.classList.add('theme-light');
  } catch {
    /* localStorage may be blocked */
  }
}

// ── Top bar ──────────────────────────────────────────────────────────────────
function buildTopbar(activePage: string): HTMLElement {
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
  topbar.querySelectorAll<HTMLAnchorElement>('.nav a').forEach((a) => {
    if (a.dataset.page === activePage) a.classList.add('active');
  });
  return topbar;
}

// ── Water-ripple layer ───────────────────────────────────────────────────────
function buildRipples(): HTMLElement {
  const layer = document.createElement('div');
  layer.className = 'ripple-layer';
  layer.setAttribute('aria-hidden', 'true');
  const ripples: Array<{ x: string; y: string; delay: string; cls: string }> = [
    { x: '20%', y: '30%', delay: '0s',  cls: '' },
    { x: '70%', y: '25%', delay: '4s',  cls: 'r2' },
    { x: '50%', y: '75%', delay: '8s',  cls: 'r3' },
    { x: '85%', y: '60%', delay: '12s', cls: 'r4' },
  ];
  ripples.forEach((r) => {
    const d = document.createElement('div');
    d.className = `ripple ${r.cls}`;
    d.style.left = r.x;
    d.style.top = r.y;
    d.style.animationDelay = r.delay;
    layer.appendChild(d);
  });
  return layer;
}

// ── Footer ───────────────────────────────────────────────────────────────────
function buildFooter(): void {
  if (document.querySelector('footer.footer')) return;
  const footer = document.createElement('footer');
  footer.className = 'footer';
  footer.innerHTML = `
    <div>OPTIC · Sui Overflow 2026 · Apache-2.0</div>
    <div>Built by <code>optic.sui</code></div>
  `;
  document.body.appendChild(footer);
}

// ── Theme toggle ─────────────────────────────────────────────────────────────
function wireThemeToggle(btn: HTMLElement): void {
  const updateIcon = (): void => {
    const isLight = document.documentElement.classList.contains('theme-light');
    btn.textContent = isLight ? '☾' : '☼';
  };
  updateIcon();
  btn.addEventListener('click', () => {
    const isLight = document.documentElement.classList.toggle('theme-light');
    try {
      localStorage.setItem('optic-theme', isLight ? 'light' : 'dark');
    } catch {
      /* ignore */
    }
    updateIcon();
  });
}

// ── Address helpers ──────────────────────────────────────────────────────────
function shortAddr(a: string): string {
  if (!a) return '';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function explorerLink(addr: string): string {
  return `https://suiscan.xyz/testnet/account/${addr}`;
}

// ── zkLogin: LAZY-LOADED (the 763KB prebundled Mysten SDK) ──────────────────
//
// First click on "Connect with zkLogin" triggers a dynamic import() of the
// prebundled mjs file. Subsequent calls hit the in-memory cache. This keeps
// the chrome chunk tiny (just the wiring) and defers the heavy SDK until
// the user actually wants to connect.

// zklogin.mjs lives in public/ and is served at /zklogin.mjs (Vite convention).
// We import it by absolute path so it works the same in dev (Vite serves from
// publicDir) and in production build (Vite copies it to dist/ root).
const ZKLOGIN_URL = '/zklogin.mjs';

let zkLoginPromise: Promise<ZkLoginModule> | null = null;

async function loadZkLogin(): Promise<ZkLoginModule> {
  if (zkLoginPromise) return zkLoginPromise;
  zkLoginPromise = (async () => {
    // Dynamic import — Rollup will code-split this into its own chunk
    const mod = (await import(/* @vite-ignore */ ZKLOGIN_URL)) as unknown as ZkLoginModule;
    return mod;
  })();
  return zkLoginPromise;
}

function setBtn(btn: HTMLButtonElement, text: string, opts: { connected?: boolean; disabled?: boolean; title?: string } = {}): void {
  btn.textContent = text;
  btn.classList.toggle('connected', !!opts.connected);
  btn.disabled = !!opts.disabled;
  btn.title = opts.title || '';
}

function wireConnectButton(btn: HTMLButtonElement, cfg: Required<OpticConfig>): void {
  const restore = (session: ZkLoginSession | null): void => {
    if (!session) {
      setBtn(btn, 'Connect with zkLogin');
      delete btn.dataset.address;
      return;
    }
    setBtn(btn, `Connected · ${shortAddr(session.suiAddress)}`, {
      connected: true,
      title: `${session.suiAddress}\nView on SuiScan ↗`,
    });
    btn.dataset.address = session.suiAddress;
  };

  // Synchronous click — defer ALL zkLogin SDK work until first click
  let sdkLoaded: ZkLoginModule | null = null;
  let sessionLoaded = false;

  const ensureSdk = async (): Promise<ZkLoginModule> => {
    if (sdkLoaded) return sdkLoaded;
    setBtn(btn, 'Loading wallet SDK…', { disabled: true });
    const sdk = await loadZkLogin();
    // Configure on first load
    const zkCfg: ZkLoginConfig = {
      network: 'testnet',
      googleClientId: cfg.googleClientId,
      saltUrl: cfg.saltUrl,
    };
    sdk.configureZkLogin(zkCfg);
    sdkLoaded = sdk;
    // Restore existing session if any
    if (!sessionLoaded) {
      restore(sdk.loadSession());
      sessionLoaded = true;
    }
    return sdk;
  };

  btn.addEventListener('click', async (e: MouseEvent) => {
    // Disconnect path
    if (btn.classList.contains('connected')) {
      // If the click target was the second listener (copy), don't disconnect
      if ((e as MouseEvent).detail === 0) return; // programmatic, ignore
      e.stopImmediatePropagation();
      if (sdkLoaded) sdkLoaded.clearSession();
      restore(null);
      return;
    }

    try {
      setBtn(btn, 'Connecting…', { disabled: true });
      const sdk = await ensureSdk();
      const session = await sdk.connectZkLogin({
        onStage: (stage: string) => setBtn(btn, stage, { disabled: true }),
      });
      restore(session);
      window.OPTIC = {
        ...(window.OPTIC ?? {}),
        session,
        explorerLink: () => explorerLink(session.suiAddress),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBtn(btn, 'Connect with zkLogin', { title: msg });
      alert(`zkLogin failed:\n${msg}`);
    }
  });

  // Click-to-copy on connected state (separate listener)
  btn.addEventListener('click', () => {
    if (!btn.classList.contains('connected')) return;
    const addr = btn.dataset.address;
    if (!addr) return;
    void navigator.clipboard?.writeText(addr).catch(() => undefined);
  });
}

// ── View Transitions ─────────────────────────────────────────────────────────
function wireViewTransitions(topbar: HTMLElement): boolean {
  const supportsVT = typeof document.startViewTransition === 'function';
  topbar.querySelectorAll<HTMLAnchorElement>('.nav a, .brand').forEach((a) => {
    a.addEventListener('click', (e: MouseEvent) => {
      const href = a.getAttribute('href');
      if (!href || href.startsWith('http') || href.startsWith('#')) return;
      if (a.classList.contains('active')) {
        e.preventDefault();
        return;
      }
      if (!supportsVT) return;
      e.preventDefault();
      document.startViewTransition!(() => {
        window.location.href = href;
      });
    });
  });
  return supportsVT;
}

// ── Public API ───────────────────────────────────────────────────────────────
export function mountChrome(): void {
  const cfg = readConfig();

  mountHead();
  applyStoredTheme();

  const page = document.body.dataset.page || 'home';
  const topbar = buildTopbar(page);
  document.body.prepend(topbar);
  document.body.appendChild(buildRipples());
  buildFooter();

  const themeBtn = document.getElementById('themeToggle');
  if (themeBtn) wireThemeToggle(themeBtn);

  const connectBtn = document.getElementById('connectBtn') as HTMLButtonElement | null;
  if (connectBtn) wireConnectButton(connectBtn, cfg);

  const supportsVT = wireViewTransitions(topbar);

  window.OPTIC = {
    ...(window.OPTIC ?? {}),
    page,
    supportsVT,
    config: {
      googleClientId: cfg.googleClientId,
      saltUrl: cfg.saltUrl,
      network: 'testnet',
    },
  };
}
