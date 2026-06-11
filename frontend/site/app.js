// ============================================================================
// OPTIC — page bootstrap (ES module)
// Theme toggle, mobile nav, scroll-spy, wallet stub (zkLogin), and the
// self-initializing live-decisions panel with filter + refresh.
// ============================================================================

import {
  MOCK_DECISIONS,
  fetchLiveDecisions,
  applyFilters,
  renderDecisions,
} from './decisions.js';

/* ────────── Theme ────────── */
const THEME_KEY = 'optic-theme';
function applyTheme(theme) {
  const root = document.documentElement;
  root.classList.toggle('theme-light', theme === 'light');
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = theme === 'light' ? '☀️' : '🌙';
}
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  applyTheme(saved || (prefersLight ? 'light' : 'dark'));
  const btn = document.getElementById('theme-toggle');
  btn?.addEventListener('click', () => {
    const next = document.documentElement.classList.contains('theme-light') ? 'dark' : 'light';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
}

/* ────────── Mobile nav ────────── */
function initNav() {
  const menuBtn = document.getElementById('menu-btn');
  const nav = document.getElementById('nav');
  menuBtn?.addEventListener('click', () => nav?.classList.toggle('open'));
  nav?.querySelectorAll('a').forEach((a) =>
    a.addEventListener('click', () => nav.classList.remove('open')),
  );
}

/* ────────── Scroll-spy ────────── */
function initScrollSpy() {
  const links = [...document.querySelectorAll('.nav a[href^="#"]')];
  const map = new Map();
  links.forEach((l) => {
    const id = l.getAttribute('href').slice(1);
    const sec = document.getElementById(id);
    if (sec) map.set(sec, l);
  });
  if (!map.size) return;
  const obs = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          links.forEach((l) => l.classList.remove('active'));
          map.get(e.target)?.classList.add('active');
        }
      });
    },
    { rootMargin: '-45% 0px -50% 0px' },
  );
  map.forEach((_, sec) => obs.observe(sec));
}

/* ────────── Wallet (zkLogin stub) ────────── */
function initWallet() {
  const btn = document.getElementById('connect');
  if (!btn) return;
  let connected = false;
  btn.addEventListener('click', () => {
    connected = !connected;
    btn.classList.toggle('connected', connected);
    btn.querySelector('.txt').textContent = connected ? 'optic.sui' : 'Connect';
    // Real build: trigger @mysten/enoki zkLogin (Google) -> derive Sui address.
  });
}

/* ────────── Live decisions ────────── */
async function initDecisions() {
  const container = document.getElementById('decisions');
  if (!container) return;
  const agentSel = document.getElementById('f-agent');
  const actionSel = document.getElementById('f-action');
  const refreshBtn = document.getElementById('refresh');
  let all = [];

  function render() {
    const filters = {
      agent: agentSel?.value || 'all',
      action: actionSel?.value || 'all',
    };
    renderDecisions(container, applyFilters(all, filters));
  }

  async function load() {
    refreshBtn?.classList.add('loading');
    const live = await fetchLiveDecisions();
    all = (live && live.length ? live : MOCK_DECISIONS)
      .slice()
      .sort((a, b) => b.atMs - a.atMs);
    render();
    refreshBtn?.classList.remove('loading');
  }

  agentSel?.addEventListener('change', render);
  actionSel?.addEventListener('change', render);
  refreshBtn?.addEventListener('click', load);
  await load();
}

/* ────────── Reveal on scroll ────────── */
function initReveal() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const obs = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.style.transition = 'opacity 600ms var(--ease), transform 600ms var(--ease)';
          e.target.style.opacity = '1';
          e.target.style.transform = 'none';
          obs.unobserve(e.target);
        }
      });
    },
    { threshold: 0.12 },
  );
  document.querySelectorAll('[data-reveal]').forEach((el) => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(18px)';
    obs.observe(el);
  });
}

/* ────────── Footer year ────────── */
function initYear() {
  const y = document.getElementById('year');
  if (y) y.textContent = new Date().getFullYear();
}

/* ────────── Boot ────────── */
function boot() {
  initTheme();
  initNav();
  initScrollSpy();
  initWallet();
  initReveal();
  initYear();
  initDecisions();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
