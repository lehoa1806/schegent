import { build, context } from 'esbuild';

const isWatch = process.argv.includes('--watch');
const isProduction = process.env.NODE_ENV === 'production';

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  format: 'cjs',
  platform: 'node',
  // FR-R3-059 (V-06 residual). Was `node20` while `engines.node` declares
  // `^22 || ^24`. A LOWER downlevel target is conservative, not risky -- the
  // 2026-08-23 review corrected an earlier draft that offered this as evidence
  // of an unqualified floor, and it is not. It is simply a mismatch: the bundle
  // was downlevelled for a runtime the package refuses to run on. Aligned to the
  // declared floor so the two numbers say the same thing.
  target: 'node22',
  external: ['vscode'],
  sourcemap: !isProduction,
  minify: isProduction,
  logLevel: 'info'
};


if (isWatch) {
  const extensionCtx = await context(extensionConfig);
  await extensionCtx.watch();
  console.log('esbuild: watching extension...');
} else {
  await build(extensionConfig);
}
