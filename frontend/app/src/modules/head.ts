/**
 * Shared <head> content for all OPTIC pages.
 * Mounts favicon, theme-color, OG meta.
 *
 * Used by chrome.ts via mountHead(). Idempotent — safe to call repeatedly.
 */

/**
 * Mount shared head elements.
 * - favicon (replaces inline data: URIs with the real /favicon.svg asset)
 * - theme-color
 * - og:title / og:description (defaults to OPTIC; pages can override)
 */
export function mountHead(opts: { title?: string; description?: string } = {}): void {
  const head = document.head;

  // Real SVG favicon (replaces any inline data: URI favicon links)
  if (!head.querySelector('link[rel="icon"][data-vite-favicon]')) {
    head.querySelectorAll('link[rel*="icon"]').forEach((el) => el.remove());
    const favicon = document.createElement('link');
    favicon.rel = 'icon';
    favicon.type = 'image/svg+xml';
    favicon.href = '/favicon.svg';
    favicon.setAttribute('data-vite-favicon', 'true');
    head.appendChild(favicon);
  }

  // Theme color (Sui-blue accent, matches optic.css :root)
  if (!head.querySelector('meta[name="theme-color"]')) {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#001a2c';
    head.appendChild(meta);
  }

  // OG meta — only set if not already present
  setOgMeta('og:title', opts.title ?? 'OPTIC — On-chain Predictable Transparent Intelligence');
  setOgMeta('og:description',
    opts.description ??
    'Verifiable AI on a CLOB. Strategy, decisions, and PnL — all on-chain objects.');
  setOgMeta('og:type', 'website');
  setOgMeta('og:image', '/favicon.svg');
}

function setOgMeta(property: string, content: string): void {
  if (document.head.querySelector(`meta[property="${property}"]`)) return;
  const meta = document.createElement('meta');
  meta.setAttribute('property', property);
  meta.content = content;
  document.head.appendChild(meta);
}
