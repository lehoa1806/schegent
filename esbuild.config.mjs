import { readFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';
import ts from 'typescript';
import { readBuildIdentity } from './scripts/build-identity.mjs';
import { writeHostGraph } from './scripts/module-graph.mjs';

const isWatch = process.argv.includes('--watch');
const isProduction = process.env.NODE_ENV === 'production';
const root = dirname(fileURLToPath(import.meta.url));

/**
 * Strip first-party source comments while preserving exact line counts (newlines)
 * so unminified dev/CI bundles stay human-readable with 1:1 sourcemap line accuracy
 * without shipping ~480 KB of internal design-history comments in the VSIX.
 */
function stripFirstPartyComments(filePath, source) {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const ranges = [];
  const seen = new Set();
  const collect = (list) => {
    if (!list) return;
    for (const r of list) {
      const key = `${r.pos}:${r.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const text = source.slice(r.pos, r.end);
      if (text.startsWith('/*!') || text.startsWith('///') || text.includes('@__PURE__')) continue;
      ranges.push(r);
    }
  };
  const visit = (node) => {
    collect(ts.getLeadingCommentRanges(source, node.pos));
    collect(ts.getTrailingCommentRanges(source, node.end));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  collect(ts.getLeadingCommentRanges(source, sf.endOfFileToken.pos));
  if (ranges.length === 0) return source;
  ranges.sort((a, b) => a.pos - b.pos);
  let out = '';
  let cursor = 0;
  for (const r of ranges) {
    if (r.pos < cursor) continue;
    out += source.slice(cursor, r.pos);
    const body = source.slice(r.pos, r.end);
    // Preserve newline count so sourcemaps remain 1:1 line-aligned.
    out += body.replace(/[^\n]/g, '');
    cursor = r.end;
  }
  out += source.slice(cursor);
  return out;
}

const stripCommentsPlugin = {
  name: 'schegent-strip-first-party-comments',
  setup(buildContext) {
    buildContext.onLoad({ filter: /\.ts$/ }, (args) => {
      const rel = relative(root, args.path).replace(/\\/g, '/');
      if (!rel.startsWith('src/')) return null;
      const source = readFileSync(args.path, 'utf8');
      return { contents: stripFirstPartyComments(args.path, source), loader: 'ts' };
    });
  }
};

// FR-R4-F09 (FR-032; contracts BI2, MG1) -- read once per invocation, so a watch build keeps the
// identity it started with and the host graph records the same object the bundle was stamped
// with. A watch build is never a release input: the release path removes `dist/` and builds once.
const identity = readBuildIdentity();

// FR-R4-F09 (FR-007; contract MG1) -- write the host module graph once all host bundles are on
// disk, on every rebuild, and only for builds that had no errors. The webview half writes its own
// graph from `webview-ui/vite.config.ts`.
const hostBuildSpecs = [
  { key: 'extension', entryPoint: 'src/extension.ts', outfile: 'dist/extension.js' },
  {
    key: 'bridge',
    entryPoint: 'src/services/acp-runtime/bridges/acp-stdio-bridge-main.ts',
    outfile: 'dist/acp-stdio-bridge.js'
  },
  {
    key: 'run-snapshot-worker',
    entryPoint: 'src/services/reporting/run-snapshot-worker-entry.ts',
    outfile: 'dist/run-snapshot.worker.js'
  },
  {
    key: 'accounting-query-worker',
    entryPoint: 'src/services/usage-accounting/accounting-query-worker-entry.ts',
    outfile: 'dist/accounting-query.worker.js'
  },
  {
    key: 'result-operator-worker',
    entryPoint: 'src/services/result-operator-worker.ts',
    outfile: 'dist/result-operator.worker.js'
  }
];

const latestMetafiles = new Map();

function flushCombinedHostGraph() {
  if (latestMetafiles.size < hostBuildSpecs.length) return;
  const inputs = {};
  const outputs = {};
  for (const spec of hostBuildSpecs) {
    const metafile = latestMetafiles.get(spec.key);
    if (!metafile) return;
    Object.assign(inputs, metafile.inputs ?? {});
    Object.assign(outputs, metafile.outputs ?? {});
  }
  writeHostGraph({ inputs, outputs }, identity, root);
}

function createHostGraphPlugin(key) {
  return {
    name: `schegent-module-graph-${key}`,
    setup(buildContext) {
      buildContext.onEnd((result) => {
        if (result.errors.length === 0 && result.metafile) {
          latestMetafiles.set(key, result.metafile);
          flushCombinedHostGraph();
        }
      });
    }
  };
}

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

const hostBuildConfigs = hostBuildSpecs.map((spec) => ({
  ...sharedHostOptions,
  entryPoints: [spec.entryPoint],
  outfile: spec.outfile,
  plugins: [stripCommentsPlugin, createHostGraphPlugin(spec.key)]
}));

if (isWatch) {
  const contexts = await Promise.all(hostBuildConfigs.map((cfg) => context(cfg)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('esbuild: watching extension, ACP stdio bridge, and worker entries...');
} else {
  // Build auxiliary bundles before `dist/extension.js` so `dist/extension.js` is never newer
  // than its worker/bridge siblings on a partial failure.
  for (const cfg of [...hostBuildConfigs.slice(1), hostBuildConfigs[0]]) {
    await build(cfg);
  }
}
