import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';
import { readBuildIdentity } from './scripts/build-identity.mjs';
import { writeHostGraph } from './scripts/module-graph.mjs';

const isWatch = process.argv.includes('--watch');
const isProduction = process.env.NODE_ENV === 'production';
const root = dirname(fileURLToPath(import.meta.url));

// FR-R4-F09 (FR-032; contracts BI2, MG1) -- read once per invocation, so a watch build keeps the
// identity it started with and the host graph records the same object the bundle was stamped
// with. A watch build is never a release input: the release path removes `dist/` and builds once.
const identity = readBuildIdentity();

// FR-R4-F09 (FR-007; contract MG1) -- write the host module graph once the bundle is on disk, on
// every rebuild, and only for a build that had no errors. The webview half writes its own graph
// from `webview-ui/vite.config.ts`.
let latestExtensionMetafile = null;
let latestBridgeMetafile = null;

function flushCombinedHostGraph() {
  if (!latestExtensionMetafile || !latestBridgeMetafile) return;
  writeHostGraph(
    {
      inputs: {
        ...(latestExtensionMetafile.inputs ?? {}),
        ...(latestBridgeMetafile.inputs ?? {})
      },
      outputs: {
        ...(latestExtensionMetafile.outputs ?? {}),
        ...(latestBridgeMetafile.outputs ?? {})
      }
    },
    identity,
    root
  );
}

const extensionGraphPlugin = {
  name: 'schegent-module-graph-extension',
  setup(buildContext) {
    buildContext.onEnd((result) => {
      if (result.errors.length === 0 && result.metafile) {
        latestExtensionMetafile = result.metafile;
        flushCombinedHostGraph();
      }
    });
  }
};

const bridgeGraphPlugin = {
  name: 'schegent-module-graph-bridge',
  setup(buildContext) {
    buildContext.onEnd((result) => {
      if (result.errors.length === 0 && result.metafile) {
        latestBridgeMetafile = result.metafile;
        flushCombinedHostGraph();
      }
    });
  }
};

const sharedHostOptions = {
  bundle: true,
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
  // The host reads this through `src/lib/build-identity.ts`, behind a `typeof` guard: under vitest
  // and the tsc-compiled integration suite the constant is absent and the read says `unknown`.
  define: { __SCHEGENT_BUILD_IDENTITY__: JSON.stringify(identity) },
  metafile: true,
  logLevel: 'info'
};

const extensionConfig = {
  ...sharedHostOptions,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  plugins: [extensionGraphPlugin]
};

const bridgeConfig = {
  ...sharedHostOptions,
  entryPoints: ['src/services/acp-runtime/bridges/acp-stdio-bridge-main.ts'],
  outfile: 'dist/acp-stdio-bridge.js',
  plugins: [bridgeGraphPlugin]
};

if (isWatch) {
  const [extensionCtx, bridgeCtx] = await Promise.all([
    context(extensionConfig),
    context(bridgeConfig)
  ]);
  await Promise.all([extensionCtx.watch(), bridgeCtx.watch()]);
  console.log('esbuild: watching extension and ACP stdio bridge...');
} else {
  await build(bridgeConfig);
  await build(extensionConfig);
}
