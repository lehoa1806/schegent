import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
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
