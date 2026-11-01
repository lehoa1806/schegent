import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * FR-R4-F09 (FR-007, FR-010; contracts MG1 to MG3, test T3) — the module graphs the SBOM reads.
 *
 * WHAT IT PINS. The SBOM's "bundled" set comes from what each bundler says it put in the shipped
 * file, never from a list of names. That only holds if three things do: a module is mapped to its
 * lockfile entry by its install path alone (plain, scoped and nested `node_modules`); a module the
 * mapping cannot place is recorded as unmapped under a label that names no path, rather than being
 * dropped; and a module the bundler removed (zero bytes in the output) is not counted, so
 * "bundled" means bytes in the file.
 *
 * Everything runs over synthetic metafiles, synthetic bundles and a temporary repository. No
 * bundler runs, and the temporary root and the home directory are searched for, as text, in every
 * file written: a graph that carried an absolute path would travel into the SBOM and the record.
 * Loaded dynamically for the same TS1479 reason its siblings record.
 */
async function loadGraph() {
  return import('../../../scripts/module-graph.mjs');
}
async function loadDigest() {
  return import('../../../scripts/release-digest.mjs');
}

const REPO = resolve('/work/repo');
const WEBVIEW_TREE = join(REPO, 'webview-ui');
const IDENTITY = { commit: 'b'.repeat(40), dirty: false, mode: 'development' } as const;

const LOCK_PACKAGES = {
  '': { name: 'schegent' },
  'node_modules/leftpad': { version: '1.0.0', license: 'MIT' },
  'node_modules/@scope/pkg': { version: '2.1.0', license: 'ISC' },
  'node_modules/a': { version: '1.0.0' },
  'node_modules/a/node_modules/b': { version: '3.0.0' },
  'node_modules/a/node_modules/@s/c': { version: '4.0.0' }
};

describe('classifyModule', () => {
  it('maps a plain, a scoped and a nested package to its install path', async () => {
    const { classifyModule } = await loadGraph();
    const classify = (id: string) => classifyModule(id, REPO, REPO, LOCK_PACKAGES);
    expect(classify(join(REPO, 'node_modules/leftpad/index.js'))).toEqual({
      kind: 'third-party',
      installPath: 'node_modules/leftpad'
    });
    expect(classify(join(REPO, 'node_modules/@scope/pkg/dist/a.js'))).toEqual({
      kind: 'third-party',
      installPath: 'node_modules/@scope/pkg'
    });
    expect(classify(join(REPO, 'node_modules/a/node_modules/b/lib/x.js'))).toEqual({
      kind: 'third-party',
      installPath: 'node_modules/a/node_modules/b'
    });
    expect(classify(join(REPO, 'node_modules/a/node_modules/@s/c/lib/x.js'))).toEqual({
      kind: 'third-party',
      installPath: 'node_modules/a/node_modules/@s/c'
    });
  });

  it('records a package with no lock entry as unmapped, labelled by its install path', async () => {
    const { classifyModule } = await loadGraph();
    expect(
      classifyModule(join(REPO, 'node_modules/ghost/index.js'), REPO, REPO, LOCK_PACKAGES)
    ).toEqual({ kind: 'unmapped', reason: 'no-lock-entry', label: 'node_modules/ghost' });
  });

  it('records a virtual id with the NUL prefix dropped, and not as a package', async () => {
    const { classifyModule } = await loadGraph();
    expect(
      classifyModule('\0vite/preload-helper.js', WEBVIEW_TREE, REPO, LOCK_PACKAGES)
    ).toEqual({ kind: 'unmapped', reason: 'virtual', label: 'vite/preload-helper.js' });
  });

  it('records an id outside the repository under the literal label, naming no path', async () => {
    const { classifyModule } = await loadGraph();
    const outside = classifyModule('/elsewhere/lib/x.js', REPO, REPO, LOCK_PACKAGES);
    expect(outside).toEqual({
      kind: 'unmapped',
      reason: 'outside-repository',
      label: 'outside-repository'
    });
    const outsideNodeModules = classifyModule(
      '/elsewhere/node_modules/foo/x.js',
      REPO,
      REPO,
      LOCK_PACKAGES
    );
    expect(outsideNodeModules).toEqual(outside);
    expect(JSON.stringify([outside, outsideNodeModules])).not.toContain('elsewhere');
  });

  it('counts a first-party module without naming it', async () => {
    const { classifyModule } = await loadGraph();
    expect(classifyModule(join(REPO, 'src/extension.ts'), REPO, REPO, LOCK_PACKAGES)).toEqual({
      kind: 'first-party'
    });
    expect(
      classifyModule(join(WEBVIEW_TREE, 'src/extension.ts'), WEBVIEW_TREE, REPO, LOCK_PACKAGES)
    ).toEqual({ kind: 'first-party' });
  });

  it('ignores a query suffix on the id', async () => {
    const { classifyModule } = await loadGraph();
    expect(
      classifyModule(
        join(WEBVIEW_TREE, 'src/App.svelte?svelte&type=style&lang.css'),
        WEBVIEW_TREE,
        REPO,
        LOCK_PACKAGES
      )
    ).toEqual({ kind: 'first-party' });
  });

  it('reads an id relative to the repository root, as esbuild writes its metafile', async () => {
    const { classifyModule } = await loadGraph();
    const classify = (id: string) => classifyModule(id, REPO, REPO, LOCK_PACKAGES);
    expect(classify('node_modules/leftpad/index.js')).toEqual({
      kind: 'third-party',
      installPath: 'node_modules/leftpad'
    });
    expect(classify('src/extension.ts')).toEqual({ kind: 'first-party' });
    expect(classify('../outside/x.js')).toEqual({
      kind: 'unmapped',
      reason: 'outside-repository',
      label: 'outside-repository'
    });
  });
});

const roots: string[] = [];

/** A repository with a lockfile for the host tree and one for the webview tree. */
function sandbox(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'module-graph-'));
  roots.push(root);
  mkdirSync(join(root, 'dist/webview'), { recursive: true });
  mkdirSync(join(root, 'webview-ui'), { recursive: true });
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({ lockfileVersion: 3, packages: LOCK_PACKAGES })
  );
  writeFileSync(
    join(root, 'webview-ui/package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'webview-ui' },
        'node_modules/svelte': { version: '5.56.10', license: 'MIT' }
      }
    })
  );
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

/** The graph files carry no absolute path: neither the sandbox root nor the home directory. */
function expectNoAbsolutePath(text: string, root: string): void {
  expect(text).not.toContain(root);
  expect(text).not.toContain(homedir());
}

describe('writeHostGraph', () => {
  const EXTENSION_JS = 'console.log("bundled");\n';

  const metafile = {
    inputs: {},
    outputs: {
      'dist/extension.js': {
        bytes: EXTENSION_JS.length,
        inputs: {
          'src/extension.ts': { bytesInOutput: 400 },
          'src/lib/logger.ts': { bytesInOutput: 100 },
          'node_modules/leftpad/index.js': { bytesInOutput: 20 },
          'node_modules/leftpad/extra.js': { bytesInOutput: 5 },
          'node_modules/dead/index.js': { bytesInOutput: 0 },
          'node_modules/ghost/index.js': { bytesInOutput: 7 }
        }
      },
      'dist/extension.js.map': { bytes: 10, inputs: {} }
    }
  };

  it('counts only inputs with bytes in the output and digests the file after the write', async () => {
    const { writeHostGraph } = await loadGraph();
    const { sha256Hex } = await loadDigest();
    const root = sandbox();
    writeFileSync(join(root, 'dist/extension.js'), EXTENSION_JS);

    const graph = writeHostGraph(metafile, IDENTITY, root);

    expect(graph.moduleGraphVersion).toBe(1);
    expect(graph.half).toBe('host');
    expect(graph.tree).toBe('root');
    expect(graph.bundler).toBe('esbuild');
    expect(graph.build).toEqual(IDENTITY);
    expect(graph.outputs).toEqual([
      {
        file: 'dist/extension.js',
        sha256: sha256Hex(Buffer.from(EXTENSION_JS)),
        bytes: Buffer.byteLength(EXTENSION_JS)
      }
    ]);
    expect(graph.packages).toEqual([
      { installPath: 'node_modules/leftpad', modules: 2, renderedBytes: 25 }
    ]);
    expect(graph.unmapped).toEqual([{ label: 'node_modules/ghost', reason: 'no-lock-entry' }]);
    expect(graph.firstPartyModules).toBe(2);
    // The dead input has no bytes in the output, so it is in no list and no count.
    expect(JSON.stringify(graph)).not.toContain('dead');
  });

  it('lists the source map under excludedOutputs, not outputs', async () => {
    const { writeHostGraph } = await loadGraph();
    const root = sandbox();
    writeFileSync(join(root, 'dist/extension.js'), EXTENSION_JS);
    const graph = writeHostGraph(metafile, IDENTITY, root);
    expect(graph.excludedOutputs).toEqual(['dist/extension.js.map']);
    expect(graph.outputs.map((entry: { file: string }) => entry.file)).not.toContain(
      'dist/extension.js.map'
    );
  });

  it('writes dist/module-graph/host.json with its fields in the documented order', async () => {
    const { writeHostGraph } = await loadGraph();
    const root = sandbox();
    writeFileSync(join(root, 'dist/extension.js'), EXTENSION_JS);
    writeHostGraph(metafile, IDENTITY, root);
    const text = readFileSync(join(root, 'dist/module-graph/host.json'), 'utf8');
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed)).toEqual([
      'moduleGraphVersion',
      'half',
      'tree',
      'bundler',
      'bundlerVersion',
      'build',
      'outputs',
      'excludedOutputs',
      'packages',
      'unmapped',
      'firstPartyModules'
    ]);
    expect(parsed.bundlerVersion).toMatch(/^\d+\.\d+\.\d+/);
    expectNoAbsolutePath(text, root);
  });

  it('sorts packages by install path', async () => {
    const { writeHostGraph } = await loadGraph();
    const root = sandbox();
    writeFileSync(join(root, 'dist/extension.js'), EXTENSION_JS);
    const graph = writeHostGraph(
      {
        inputs: {},
        outputs: {
          'dist/extension.js': {
            bytes: 1,
            inputs: {
              'node_modules/leftpad/index.js': { bytesInOutput: 1 },
              'node_modules/a/index.js': { bytesInOutput: 1 },
              'node_modules/@scope/pkg/index.js': { bytesInOutput: 1 }
            }
          }
        }
      },
      IDENTITY,
      root
    );
    expect(graph.packages.map((entry: { installPath: string }) => entry.installPath)).toEqual([
      'node_modules/@scope/pkg',
      'node_modules/a',
      'node_modules/leftpad'
    ]);
  });

  it('refuses a missing bundle instead of digesting nothing', async () => {
    const { writeHostGraph } = await loadGraph();
    const root = sandbox();
    expect(() => writeHostGraph(metafile, IDENTITY, root)).toThrow(/dist\/extension\.js/);
  });
});

describe('moduleGraphPlugin', () => {
  const CHUNK_CODE = 'export const x = 1;\n';
  const ASSET_SOURCE = 'body{color:red}\n';

  /** The bundle a webview build hands `writeBundle`, with module ids under the sandbox root. */
  const bundleFor = (root: string) => {
    const tree = join(root, 'webview-ui');
    return {
      'index.js': {
        type: 'chunk',
        fileName: 'index.js',
        code: CHUNK_CODE,
        modules: {
          [join(tree, 'src/extension.ts')]: { renderedLength: 100 },
          [join(tree, 'node_modules/svelte/src/runtime.js')]: { renderedLength: 300 },
          [join(tree, 'node_modules/svelte/src/other.js')]: { renderedLength: 50 },
          [join(tree, 'node_modules/svelte/src/shaken.js')]: { renderedLength: 0 },
          '\0vite/preload-helper.js': { renderedLength: 12 }
        }
      },
      'assets/index.css': { type: 'asset', fileName: 'assets/index.css', source: ASSET_SOURCE }
    } as const;
  };

  const options = (root: string) => ({ dir: join(root, 'dist/webview') });
  const rollupContext = { meta: { rollupVersion: '4.60.4' } };

  it('applies to build only, so tests and dev serving never run it', async () => {
    const { moduleGraphPlugin } = await loadGraph();
    const plugin = moduleGraphPlugin({ tree: 'webview-ui', half: 'webview', root: REPO });
    expect(plugin.apply).toBe('build');
    expect(typeof plugin.writeBundle).toBe('function');
  });

  it('excludes zero-rendered modules and digests the final code and source', async () => {
    const { moduleGraphPlugin } = await loadGraph();
    const { sha256Hex } = await loadDigest();
    const root = sandbox();
    const plugin = moduleGraphPlugin({
      tree: 'webview-ui',
      half: 'webview',
      root,
      readIdentity: () => IDENTITY
    });

    plugin.writeBundle.call(rollupContext, options(root), bundleFor(root));

    const text = readFileSync(join(root, 'dist/module-graph/webview.json'), 'utf8');
    const graph = JSON.parse(text);
    expect(graph.half).toBe('webview');
    expect(graph.tree).toBe('webview-ui');
    expect(graph.bundler).toBe('rollup');
    expect(graph.bundlerVersion).toBe('4.60.4');
    expect(graph.build).toEqual(IDENTITY);
    expect(graph.outputs).toEqual([
      {
        file: 'dist/webview/assets/index.css',
        sha256: sha256Hex(Buffer.from(ASSET_SOURCE)),
        bytes: Buffer.byteLength(ASSET_SOURCE)
      },
      {
        file: 'dist/webview/index.js',
        sha256: sha256Hex(Buffer.from(CHUNK_CODE)),
        bytes: Buffer.byteLength(CHUNK_CODE)
      }
    ]);
    expect(graph.packages).toEqual([
      { installPath: 'node_modules/svelte', modules: 2, renderedBytes: 350 }
    ]);
    expect(graph.unmapped).toEqual([{ label: 'vite/preload-helper.js', reason: 'virtual' }]);
    expect(graph.firstPartyModules).toBe(1);
    expect(text).not.toContain('shaken');
    expectNoAbsolutePath(text, root);
  });

  it('sorts outputs by file and records versions and the module-graph version', async () => {
    const { moduleGraphPlugin } = await loadGraph();
    const root = sandbox();
    const plugin = moduleGraphPlugin({
      tree: 'webview-ui',
      half: 'webview',
      root,
      readIdentity: () => IDENTITY
    });
    plugin.writeBundle.call(rollupContext, options(root), bundleFor(root));
    const graph = JSON.parse(readFileSync(join(root, 'dist/module-graph/webview.json'), 'utf8'));
    const files = graph.outputs.map((entry: { file: string }) => entry.file);
    expect(files).toEqual([...files].sort());
    expect(graph.moduleGraphVersion).toBe(1);
  });

  it('digests a binary asset by its bytes', async () => {
    const { moduleGraphPlugin } = await loadGraph();
    const { sha256Hex } = await loadDigest();
    const root = sandbox();
    const plugin = moduleGraphPlugin({
      tree: 'webview-ui',
      half: 'webview',
      root,
      readIdentity: () => IDENTITY
    });
    const bytes = new Uint8Array([0, 255, 1, 254]);
    plugin.writeBundle.call(rollupContext, options(root), {
      'assets/font.woff2': { type: 'asset', fileName: 'assets/font.woff2', source: bytes }
    });
    const graph = JSON.parse(readFileSync(join(root, 'dist/module-graph/webview.json'), 'utf8'));
    expect(graph.outputs).toEqual([
      { file: 'dist/webview/assets/font.woff2', sha256: sha256Hex(bytes), bytes: 4 }
    ]);
  });
});
