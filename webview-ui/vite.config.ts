import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { moduleGraphPlugin } from '../scripts/module-graph.mjs';

// FR-R4-F09 (FR-007; contract MG2) -- the repository root, where `dist/` lives. The graph this
// build writes goes to `dist/module-graph/webview.json`, outside `emptyOutDir`'s `dist/webview`,
// so neither half's build erases the other's graph.
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  // VS Code rewrites the HTML entry assets to webview-safe URIs, but assets
  // discovered later by Vite's dynamic-import preloader must remain relative
  // to the loaded module. A root-relative base (Vite's default) makes lazy
  // route CSS resolve at the webview origin root instead of dist/webview.
  base: './',
  // `moduleGraphPlugin` applies to `vite build` only, so dev serving and the test runner never
  // run it. It records which modules reached the shipped chunks, for the SBOM.
  plugins: [
    svelte(),
    moduleGraphPlugin({ tree: 'webview-ui', half: 'webview', root: repositoryRoot })
  ],
  build: {
    outDir: '../dist/webview',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      input: {
        index: 'index.html',
        dashboard: 'dashboard.html'
      },
      output: {
        entryFileNames: (chunk) => `${chunk.name}.js`,
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith('.css')) {
            const sourceName = (assetInfo as { originalFileName?: string }).originalFileName ?? assetInfo.name;
            if (sourceName.includes('dashboard')) return 'dashboard.css';
            return 'index.css';
          }
          return 'assets/[name][extname]';
        }
      }
    }
  }
});
