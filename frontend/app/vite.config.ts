import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * OPTIC Frontend — Vite multi-page config
 *
 * 6 entry points (one per Walrus Site page). All output to dist/
 * preserving relative paths so Walrus Sites deploys cleanly.
 *
 * Walrus Sites requires stable filenames in its config.yaml routes,
 * so we DISABLE content hashing in production builds. This trades
 * optimal cache-busting for deploy predictability.
 *
 * zklogin.mjs is a 12K LOC prebundled Mysten SDK — kept as a static
 * asset and dynamically imported only on first "Connect" click.
 */

const PAGES = [
  'index',
  'agents',
  'decisions',
  'how',
  'links',
  'tracks',
] as const;

export default defineConfig({
  // Use src/pages/ as root so HTML output is at dist/<page>.html
  root: 'src/pages',
  publicDir: resolve(__dirname, 'public'),

  // Relative base so Walrus Sites serve from /optic/* without breaking
  base: './',

  build: {
    outDir: resolve(__dirname, '../dist'),
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false, // single shared CSS chunk for Walrus config simplicity
    sourcemap: false,
    // Disable content hashing for stable filenames in walrus-sites-config.yaml
    rollupOptions: {
      input: Object.fromEntries(
        PAGES.map((p) => [p, resolve(__dirname, `src/pages/${p}.html`)]),
      ),
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: (info) => {
          // CSS keeps its name; other assets get an extension
          if (info.name?.endsWith('.css')) return 'assets/[name][extname]';
          return 'assets/[name][extname]';
        },
      },
    },
  },

  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },

  server: {
    port: 5173,
    strictPort: false,
    open: false,
  },

  preview: {
    port: 4173,
  },
});
