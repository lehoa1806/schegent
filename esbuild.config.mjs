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


if (isWatch) {
  const extensionCtx = await context(extensionConfig);
  await extensionCtx.watch();
  console.log('esbuild: watching extension...');
} else {
  await build(extensionConfig);
}
