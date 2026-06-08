// Shared chrome — top bar, ripple layer, footer, theme toggle.
// Active link is determined from the data-page attribute on <body>.

(function () {
  const page = document.body.dataset.page || 'home';

  // ── Apply theme from localStorage (before paint) ──
  try {
    const t = localStorage.getItem('optic-theme');
    if (t === 'light') document.documentElement.classList.add('theme-light');
  } catch {}

  // ── Top bar ──
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

  // ── Water-ripple layer (calm, slow, no flash) ──
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

  // ── Footer ──
  if (!document.querySelector('footer.footer')) {
    const footer = document.createElement('footer');
    footer.className = 'footer';
    footer.innerHTML = `
      <div>OPTIC · Sui Overflow 2026 · Apache-2.0</div>
      <div>Built by <code>optic.sui</code></div>
    `;
    document.body.appendChild(footer);
  }

  // ── Theme toggle ──
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

  // ── zkLogin stub ──
  const btn = document.getElementById('connectBtn');
  const state = { connected: false, address: null };
  btn.addEventListener('click', async () => {
    if (state.connected) {
      state.connected = false; state.address = null;
      btn.textContent = 'Connect with zkLogin';
      btn.classList.remove('connected');
      return;
    }
    btn.textContent = 'Connecting…';
    btn.disabled = true;
    await new Promise((r) => setTimeout(r, 1200));
    const a = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    state.connected = true; state.address = a;
    btn.textContent = `Connected · ${a.slice(0, 8)}…`;
    btn.classList.add('connected');
    btn.disabled = false;
  });

  // ── View Transitions: wrap nav clicks in document.startViewTransition ──
  // Falls back to plain navigation if the API isn't supported.
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

  // Expose for debugging
  window.OPTIC = { page, state, supportsVT, ...(window.OPTIC || {}) };
})();
