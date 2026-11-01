import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * FR-R4-F09 (FR-007 to FR-011, SC-004; contracts SB1, SB2, data-model section 3; test T4) -- the
 * SBOM names what the bundlers shipped, not what the lockfiles' `dev` flags suggest.
 *
 * WHAT WAS WRONG. The SBOM marked a package `excluded` whenever its lock entry said `dev`, and
 * `svelte` is a `devDependency` of the webview tree that the webview build BUNDLES. So the one
 * document a recipient is handed listed shipping third-party code as tooling that does not ship
 * (FR-008). Membership now comes from each half's module graph and from nothing else: no package
 * name appears in the generator, and a package bundled tomorrow appears with no edit to it.
 *
 * `buildSbom` is pure and is driven here over synthetic graphs, locks and manifests. The merge is
 * driven with the trees in both orders, because a merge that keeps the first scope it saw passes
 * one order and fails the other. `readSbomInputs` is driven over a temporary repository for its
 * refusals, each of which must tell the operator to run the build, since the remedy is always the
 * same. Loaded dynamically for the same TS1479 reason its siblings record.
 */
async function loadSbom() {
  const module = await import('../../../scripts/generate-sbom.mjs');
  // The synthetic inputs below are deliberately looser than the declared types (a graph here is a
  // plain object), so the two functions that take them are wrapped once rather than cast at every
  // call. Both casts widen the input and narrow the result to this file's view of the document.
  return {
    ...module,
    buildSbom: (input: unknown) =>
      module.buildSbom(input as Parameters<typeof module.buildSbom>[0]) as unknown as Sbom,
    bundledComponents: (sbom: Sbom) =>
      module.bundledComponents(sbom as unknown as Parameters<typeof module.bundledComponents>[0])
  };
}
async function loadDigest() {
  return import('../../../scripts/release-digest.mjs');
}

const HEX = (character: string) => character.repeat(64);
const COMMIT = 'c'.repeat(40);
const NOW = '2026-11-02T10:00:00.000Z';

type Property = { name: string; value: string };
type Component = {
  type: string;
  name: string;
  version?: string;
  purl?: string;
  scope: string;
  licenses?: { license: { id: string } }[];
  hashes?: { alg: string; content: string }[];
  properties: Property[];
};
type Sbom = {
  metadata: { properties: Property[] };
  components: Component[];
};

const prop = (holder: { properties?: Property[] }, name: string): string | undefined =>
  holder.properties?.find((entry) => entry.name === name)?.value;

const headline = (sbom: Sbom, name: string): string | undefined => prop(sbom.metadata, name);

const component = (sbom: Sbom, name: string): Component => {
  const found = sbom.components.find((entry) => entry.name === name);
  if (!found) throw new Error(`no component named ${name}`);
  return found;
};

function graph(
  half: 'host' | 'webview',
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    moduleGraphVersion: 1,
    half,
    tree: half === 'host' ? 'root' : 'webview-ui',
    bundler: half === 'host' ? 'esbuild' : 'rollup',
    bundlerVersion: '1.0.0',
    build: { commit: COMMIT, dirty: false, mode: half === 'host' ? 'development' : 'production' },
    outputs: [
      half === 'host'
        ? { file: 'dist/extension.js', sha256: HEX('a'), bytes: 10 }
        : { file: 'dist/webview/index.js', sha256: HEX('b'), bytes: 20 }
    ],
    excludedOutputs: [],
    packages: [],
    unmapped: [],
    firstPartyModules: 3,
    ...over
  };
}

const lockOf = (packages: Record<string, unknown>) => ({
  lockfileVersion: 3,
  packages: { '': { name: 'tree' }, ...packages }
});

const manifestOf = (over: Record<string, unknown> = {}) => ({
  name: 'schegent',
  version: '0.2.0',
  license: 'MIT',
  ...over
});

/** The inputs of the real repository's shape: `svelte` bundled, `esbuild` build-only. */
function inputs(over: { graphs?: Record<string, unknown>; locks?: Record<string, unknown> } = {}) {
  return {
    graphs: {
      host: graph('host'),
      webview: graph('webview', {
        packages: [{ installPath: 'node_modules/svelte', modules: 53, renderedBytes: 209856 }],
        unmapped: [{ label: 'vite/preload-helper.js', reason: 'virtual' }]
      }),
      ...over.graphs
    },
    locks: {
      root: lockOf({ 'node_modules/esbuild': { version: '0.28.2', dev: true, license: 'MIT' } }),
      'webview-ui': lockOf({
        'node_modules/svelte': { version: '5.56.10', dev: true, license: 'MIT' }
      }),
      ...over.locks
    },
    manifests: { root: manifestOf(), 'webview-ui': manifestOf({ name: 'webview-ui' }) },
    now: NOW
  };
}

describe('buildSbom classification', () => {
  it('lists a bundled devDependency as bundled, required, at the lock version', async () => {
    const { buildSbom } = await loadSbom();
    const svelte = component(buildSbom(inputs()), 'svelte');
    expect(svelte.type).toBe('library');
    expect(svelte.scope).toBe('required');
    expect(svelte.version).toBe('5.56.10');
    expect(svelte.purl).toBe('pkg:npm/svelte@5.56.10');
    expect(prop(svelte, 'schegent:classification')).toBe('bundled');
    expect(prop(svelte, 'schegent:foundBy')).toBe('module-graph:webview');
    expect(svelte.licenses).toEqual([{ license: { id: 'MIT' } }]);
  });

  it('lists build-only tooling as excluded', async () => {
    const { buildSbom } = await loadSbom();
    const esbuild = component(buildSbom(inputs()), 'esbuild');
    expect(esbuild.scope).toBe('excluded');
    expect(prop(esbuild, 'schegent:classification')).toBe('build-only');
    expect(prop(esbuild, 'schegent:foundBy')).toBeUndefined();
  });

  it('lists a package that is newly bundled with no edit to the generator', async () => {
    const { buildSbom } = await loadSbom();
    const base = inputs();
    const next = inputs({
      graphs: {
        webview: graph('webview', {
          packages: [
            { installPath: 'node_modules/svelte', modules: 1, renderedBytes: 1 },
            { installPath: 'node_modules/brand-new', modules: 2, renderedBytes: 7 }
          ]
        })
      },
      locks: {
        'webview-ui': lockOf({
          'node_modules/svelte': { version: '5.56.10', dev: true },
          'node_modules/brand-new': { version: '9.9.9', dev: true }
        })
      }
    });
    expect(() => component(buildSbom(base), 'brand-new')).toThrow();
    const added = component(buildSbom(next), 'brand-new');
    expect(added.scope).toBe('required');
    expect(prop(added, 'schegent:classification')).toBe('bundled');
  });

  it('lists a declared runtime dependency as declared-runtime and counts it', async () => {
    const { buildSbom } = await loadSbom();
    const sbom = buildSbom({
      ...inputs({ locks: { root: lockOf({ 'node_modules/leftpad': { version: '1.0.0' } }) } }),
      manifests: {
        root: manifestOf({ dependencies: { leftpad: '^1.0.0' } }),
        'webview-ui': manifestOf({ name: 'webview-ui' })
      }
    });
    expect(prop(component(sbom, 'leftpad'), 'schegent:classification')).toBe('declared-runtime');
    expect(component(sbom, 'leftpad').scope).toBe('required');
    expect(headline(sbom, 'schegent:runtimeDependencyCount')).toBe('1');
    expect(headline(sbom, 'schegent:runtimeDependencies')).toBe('leftpad');
  });

  it('records a module the mapping could not place as unknown provenance, with no version or purl', async () => {
    const { buildSbom } = await loadSbom();
    const unknown = component(buildSbom(inputs()), 'vite/preload-helper.js');
    expect(unknown.type).toBe('library');
    expect(unknown.scope).toBe('required');
    expect(prop(unknown, 'schegent:classification')).toBe('unknown-provenance');
    expect(prop(unknown, 'schegent:unmappedReason')).toBe('virtual');
    expect(unknown.version).toBeUndefined();
    expect(unknown.purl).toBeUndefined();
  });
});

describe('buildSbom merge across trees', () => {
  /** `shared@1.0.0` is build-only in the root tree and bundled in the webview tree. */
  const shared = { version: '1.0.0', dev: true };
  const sharedInputs = (order: 'root-first' | 'webview-first') => {
    const base = inputs({
      graphs: {
        webview: graph('webview', {
          packages: [{ installPath: 'node_modules/shared', modules: 1, renderedBytes: 5 }]
        })
      }
    });
    const locks =
      order === 'root-first'
        ? {
            root: lockOf({ 'node_modules/shared': shared }),
            'webview-ui': lockOf({ 'node_modules/shared': shared })
          }
        : {
            'webview-ui': lockOf({ 'node_modules/shared': shared }),
            root: lockOf({ 'node_modules/shared': shared })
          };
    const manifests =
      order === 'root-first'
        ? base.manifests
        : { 'webview-ui': base.manifests['webview-ui'], root: base.manifests.root };
    return { ...base, locks, manifests };
  };

  it.each(['root-first', 'webview-first'] as const)(
    'makes a package that ships in one tree and is build-only in the other bundled (%s)',
    async (order) => {
      const { buildSbom } = await loadSbom();
      const sbom = buildSbom(sharedInputs(order));
      const merged = sbom.components.filter((entry) => entry.name === 'shared');
      expect(merged).toHaveLength(1);
      const entry = component(sbom, 'shared');
      expect(entry.scope).toBe('required');
      expect(prop(entry, 'schegent:classification')).toBe('bundled');
      expect(prop(entry, 'schegent:foundBy')).toBe('module-graph:webview');
    }
  );

  it('lists every tree that has the package, in the order the trees were read', async () => {
    const { buildSbom } = await loadSbom();
    const sbom = buildSbom(sharedInputs('root-first'));
    const trees = component(sbom, 'shared')
      .properties.filter((entry) => entry.name === 'schegent:tree')
      .map((entry) => entry.value);
    expect(trees).toEqual(['host', 'webview']);
  });

  it('produces the same document whichever order the trees are read in', async () => {
    const { buildSbom } = await loadSbom();
    const forward = buildSbom(sharedInputs('root-first'));
    const reverse = buildSbom(sharedInputs('webview-first'));
    const names = (sbom: Sbom) =>
      sbom.components.map(
        (entry) =>
          `${entry.name}@${entry.version ?? ''} ${entry.scope} ${prop(entry, 'schegent:classification')}`
      );
    expect(names(reverse)).toEqual(names(forward));
  });
});

describe('buildSbom headline and shipped files', () => {
  it('states the declared runtime count and the bundled count as separate properties', async () => {
    const { buildSbom } = await loadSbom();
    const sbom = buildSbom(inputs());
    expect(headline(sbom, 'schegent:runtimeDependencyCount')).toBe('0');
    expect(headline(sbom, 'schegent:runtimeDependencies')).toBe('(none declared)');
    expect(headline(sbom, 'schegent:bundledComponentCount')).toBe('1');
    expect(headline(sbom, 'schegent:unknownProvenanceCount')).toBe('1');
  });

  it('carries the build identity of the host graph', async () => {
    const { buildSbom } = await loadSbom();
    const sbom = buildSbom(inputs());
    expect(headline(sbom, 'schegent:build.commit')).toBe(COMMIT);
    expect(headline(sbom, 'schegent:build.dirty')).toBe('false');
    expect(headline(sbom, 'schegent:build.mode')).toBe('development');
  });

  it('carries the digest of each graph under the renamed property', async () => {
    const { buildSbom } = await loadSbom();
    const sbom = buildSbom(inputs());
    expect(headline(sbom, 'schegent:moduleGraphSha256.host')).toMatch(/^[0-9a-f]{64}$/);
    expect(headline(sbom, 'schegent:moduleGraphSha256.webview')).toMatch(/^[0-9a-f]{64}$/);
    const names = sbom.metadata.properties.map((entry) => entry.name);
    expect(names.some((name) => /\.sha256$/.test(name))).toBe(false);
  });

  it('uses a digest handed in for a graph over one computed from its parsed form', async () => {
    const { buildSbom } = await loadSbom();
    const sbom = buildSbom({
      ...inputs(),
      graphDigests: { host: HEX('1'), webview: HEX('2') }
    });
    expect(headline(sbom, 'schegent:moduleGraphSha256.host')).toBe(HEX('1'));
    expect(headline(sbom, 'schegent:moduleGraphSha256.webview')).toBe(HEX('2'));
  });

  it('lists each shipped file with its SHA-256', async () => {
    const { buildSbom } = await loadSbom();
    const sbom = buildSbom(inputs());
    const files = sbom.components.filter((entry) => entry.type === 'file');
    expect(files.map((entry) => entry.name)).toEqual(['dist/extension.js', 'dist/webview/index.js']);
    for (const file of files) {
      expect(file.scope).toBe('required');
      expect(prop(file, 'schegent:classification')).toBe('shipped-file');
      expect(file.hashes).toHaveLength(1);
      expect(file.hashes?.at(0)?.alg).toBe('SHA-256');
    }
    expect(files.at(0)?.hashes?.at(0)?.content).toBe(HEX('a'));
    expect(files.at(1)?.hashes?.at(0)?.content).toBe(HEX('b'));
  });

  it('says what it observed and what it does not claim', async () => {
    const { buildSbom } = await loadSbom();
    const sbom = buildSbom(inputs());
    const asserts = headline(sbom, 'schegent:asserts') ?? '';
    const doesNot = headline(sbom, 'schegent:doesNotAssert') ?? '';
    expect(asserts).toMatch(/module graph/i);
    expect(asserts).toMatch(/lockfile/i);
    expect(asserts).toMatch(/not in the shipped code/);
    expect(asserts).toMatch(/SHA-256/);
    expect(doesNot).toMatch(/exploitab/i);
    expect(doesNot).toMatch(/licen[cs]e/i);
    expect(doesNot).toMatch(/archive/i);
    expect(doesNot).toMatch(/signature/i);
  });

  it('is deterministic for the same inputs', async () => {
    const { buildSbom } = await loadSbom();
    expect(JSON.stringify(buildSbom(inputs()))).toBe(JSON.stringify(buildSbom(inputs())));
  });

  it('names the bundled and unknown-provenance components for the release driver to compare', async () => {
    const { buildSbom, bundledComponents } = await loadSbom();
    expect(bundledComponents(buildSbom(inputs()))).toEqual([
      'svelte@5.56.10 bundled',
      'vite/preload-helper.js@ unknown-provenance'
    ]);
  });
});

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function put(root: string, relativePath: string, text: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** A repository whose graphs, `dist/` and lockfiles agree. */
async function repository(): Promise<string> {
  const { sha256Hex } = await loadDigest();
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'sbom-inputs-'));
  roots.push(root);
  const hostBundle = 'host bundle';
  const webviewBundle = 'webview bundle';
  put(root, 'dist/extension.js', hostBundle);
  put(root, 'dist/webview/index.js', webviewBundle);
  const set = inputs();
  const host = graph('host', {
    outputs: [
      { file: 'dist/extension.js', sha256: sha256Hex(hostBundle), bytes: hostBundle.length }
    ],
    excludedOutputs: ['dist/extension.js.map']
  });
  const webview = graph('webview', {
    outputs: [
      { file: 'dist/webview/index.js', sha256: sha256Hex(webviewBundle), bytes: webviewBundle.length }
    ],
    packages: [{ installPath: 'node_modules/svelte', modules: 1, renderedBytes: 1 }]
  });
  put(root, 'dist/module-graph/host.json', `${JSON.stringify(host, null, 2)}\n`);
  put(root, 'dist/module-graph/webview.json', `${JSON.stringify(webview, null, 2)}\n`);
  put(root, 'package.json', JSON.stringify(set.manifests.root));
  put(root, 'package-lock.json', JSON.stringify(set.locks.root));
  put(root, 'webview-ui/package.json', JSON.stringify(set.manifests['webview-ui']));
  put(root, 'webview-ui/package-lock.json', JSON.stringify(set.locks['webview-ui']));
  return root;
}

/** Rewrite one graph file with `change` applied to its parsed form. */
async function amendGraph(
  root: string,
  half: 'host' | 'webview',
  change: (parsed: Record<string, unknown>) => Record<string, unknown>
): Promise<void> {
  const { readFileSync } = await import('node:fs');
  const path = join(root, 'dist/module-graph', `${half}.json`);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, `${JSON.stringify(change(parsed), null, 2)}\n`);
}

const RUN_THE_BUILD = /run `npm run build`$/;

describe('readSbomInputs', () => {
  it('accepts graphs that agree with dist/ and with each other', async () => {
    const { readSbomInputs } = await loadSbom();
    const read = readSbomInputs(await repository());
    expect(Object.keys(read.graphs).sort()).toEqual(['host', 'webview']);
    expect(read.graphDigests.host).toMatch(/^[0-9a-f]{64}$/);
    expect(read.locks.root).toBeDefined();
  });

  it('refuses a graph that is absent, telling the operator to build', async () => {
    const { readSbomInputs } = await loadSbom();
    const root = await repository();
    rmSync(join(root, 'dist/module-graph/host.json'));
    expect(() => readSbomInputs(root)).toThrow(/host\.json/);
    expect(() => readSbomInputs(root)).toThrow(RUN_THE_BUILD);
  });

  it('refuses a graph whose moduleGraphVersion is not 1', async () => {
    const { readSbomInputs } = await loadSbom();
    const root = await repository();
    await amendGraph(root, 'webview', (parsed) => ({ ...parsed, moduleGraphVersion: 2 }));
    expect(() => readSbomInputs(root)).toThrow(/moduleGraphVersion/);
    expect(() => readSbomInputs(root)).toThrow(RUN_THE_BUILD);
  });

  it('refuses a graph file whose half or tree is not the one its name says', async () => {
    const { readSbomInputs } = await loadSbom();
    const root = await repository();
    await amendGraph(root, 'host', (parsed) => ({ ...parsed, half: 'webview' }));
    expect(() => readSbomInputs(root)).toThrow(/half/);
    expect(() => readSbomInputs(root)).toThrow(RUN_THE_BUILD);
  });

  it('refuses an output whose digest differs from the file now in dist/', async () => {
    const { readSbomInputs } = await loadSbom();
    const root = await repository();
    put(root, 'dist/extension.js', 'host bundle, rebuilt by something else');
    expect(() => readSbomInputs(root)).toThrow(/dist\/extension\.js/);
    expect(() => readSbomInputs(root)).toThrow(RUN_THE_BUILD);
  });

  it('refuses an output the graph lists but dist/ no longer holds', async () => {
    const { readSbomInputs } = await loadSbom();
    const root = await repository();
    rmSync(join(root, 'dist/webview/index.js'));
    expect(() => readSbomInputs(root)).toThrow(/dist\/webview\/index\.js/);
    expect(() => readSbomInputs(root)).toThrow(RUN_THE_BUILD);
  });

  it('refuses a file under the webview output path that is in neither list', async () => {
    const { readSbomInputs } = await loadSbom();
    const root = await repository();
    put(root, 'dist/webview/stray.js', 'not from this build');
    expect(() => readSbomInputs(root)).toThrow(/dist\/webview\/stray\.js/);
    expect(() => readSbomInputs(root)).toThrow(RUN_THE_BUILD);
  });

  it('refuses a stray file beside the host bundle', async () => {
    const { readSbomInputs } = await loadSbom();
    const root = await repository();
    put(root, 'dist/stray.js', 'not from this build');
    expect(() => readSbomInputs(root)).toThrow(/dist\/stray\.js/);
    expect(() => readSbomInputs(root)).toThrow(RUN_THE_BUILD);
  });

  it('does not count the graph files, the source map or an operating-system file as strays', async () => {
    const { readSbomInputs } = await loadSbom();
    const root = await repository();
    put(root, 'dist/extension.js.map', '{}');
    put(root, 'dist/.DS_Store', 'noise');
    expect(() => readSbomInputs(root)).not.toThrow();
  });

  it('refuses halves that were built from different commits', async () => {
    const { readSbomInputs } = await loadSbom();
    const root = await repository();
    await amendGraph(root, 'webview', (parsed) => ({
      ...parsed,
      build: { commit: 'd'.repeat(40), dirty: false, mode: 'production' }
    }));
    expect(() => readSbomInputs(root)).toThrow(/halves were built from different trees/);
    expect(() => readSbomInputs(root)).toThrow(RUN_THE_BUILD);
  });

  it('refuses halves that disagree on the dirty flag', async () => {
    const { readSbomInputs } = await loadSbom();
    const root = await repository();
    await amendGraph(root, 'webview', (parsed) => ({
      ...parsed,
      build: { commit: COMMIT, dirty: true, mode: 'production' }
    }));
    expect(() => readSbomInputs(root)).toThrow(/halves were built from different trees/);
  });

  it('accepts halves whose modes differ, because each mode describes its own half', async () => {
    const { readSbomInputs } = await loadSbom();
    const root = await repository();
    await amendGraph(root, 'host', (parsed) => ({
      ...parsed,
      build: { commit: COMMIT, dirty: false, mode: 'production' }
    }));
    expect(() => readSbomInputs(root)).not.toThrow();
  });
});
