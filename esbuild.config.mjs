import { build, context } from 'esbuild';

const isWatch = process.argv.includes('--watch');
const isProduction = process.env.NODE_ENV === 'production';

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  sourcemap: !isProduction,
  minify: isProduction,
  logLevel: 'info'
};

// Feature 014 — Standalone Node runner for the Wake up daemon. Lives in
// `src/headless/` and MUST be self-contained — no `vscode` import (the
// no-vscode-import-in-headless lint regression guards this). Output is
// copied atomically into `<globalStorageUri>/wakeup/runner.js` on Save.
const wakeupRunnerConfig = {
  entryPoints: ['src/headless/wakeup-runner.ts'],
  bundle: true,
  outfile: 'dist/wakeup-runner.js',
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: [],
  sourcemap: !isProduction,
  minify: false,
  logLevel: 'info'
};

if (isWatch) {
  const extensionCtx = await context(extensionConfig);
  const wakeupCtx = await context(wakeupRunnerConfig);
  await Promise.all([extensionCtx.watch(), wakeupCtx.watch()]);
  console.log('esbuild: watching extension + wakeup-runner...');
} else {
  await Promise.all([build(extensionConfig), build(wakeupRunnerConfig)]);
}
