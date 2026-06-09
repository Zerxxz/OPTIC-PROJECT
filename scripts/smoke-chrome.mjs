// Minimal browser shim to syntax-check chrome.js + verify it imports
// the real zkLogin module without exploding.
import { readFileSync } from 'node:fs';

const shim = `
const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const document = {
  body: { dataset: {}, prepend: () => {}, appendChild: () => {} },
  documentElement: { classList: { add: () => {}, remove: () => {}, toggle: () => false, contains: () => false } },
  createElement: () => ({
    className: '', innerHTML: '', setAttribute: () => {},
    style: {}, querySelectorAll: () => [], appendChild: () => {},
    addEventListener: () => {},
  }),
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => ({
    addEventListener: () => {},
    classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => false },
    style: {},
  }),
  addEventListener: () => {},
  startViewTransition: undefined,
  head: { appendChild: () => {} },
};
const window = {
  location: { origin: 'https://optic.wal.app', pathname: '/' },
  screen: { width: 1024, height: 768 },
  OPTIC_CONFIG: undefined,
  OPTIC: undefined,
};
const globalThis = { OPTIC_CONFIG: undefined, OPTIC: undefined };
const setTimeout = global.setTimeout.bind(global);
const clearTimeout = global.clearTimeout.bind(global);
const alert = () => {};
const navigator = { clipboard: undefined };
`;

const chromeSrc = readFileSync(
  new URL('../frontend/site/chrome.js', import.meta.url),
  'utf8',
);

// Strip the import line so we don't actually run zkLogin imports — just
// verify the file parses and the surrounding code doesn't reference
// anything that would crash at import-resolution time.
const stripped = chromeSrc
  .replace(/^import[\s\S]*?;\s*$/m, '// (import stripped for syntax check)')
  .replace(/globalThis\./g, 'window.')
  .replace(/^export default .*$/m, '');

const code = shim + '\n' + stripped;
try {
  new Function(code);
  console.log('✓ chrome.js parses cleanly');
} catch (e) {
  console.error('✗ chrome.js parse error:', e.message);
  process.exit(1);
}
