import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  // VS Code rewrites the HTML entry assets to webview-safe URIs, but assets
  // discovered later by Vite's dynamic-import preloader must remain relative
  // to the loaded module. A root-relative base (Vite's default) makes lazy
  // route CSS resolve at the webview origin root instead of dist/webview.
  base: './',
  plugins: [svelte()],
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
