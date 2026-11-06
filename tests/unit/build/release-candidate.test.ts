import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * FR-R4-F09 (FR-002 to FR-006, FR-016, FR-032, SC-002; contracts RP1 to RP5, AC3; test T6, US1
 * half) -- the release driver builds, packages once, inspects those bytes, and writes a record
 * that names them.
 *
 * `releaseCandidate(deps)` is pure over its seams, as the gate recorder is: nothing here runs git,
 * npm, `vsce` or a build, and there is no network. A fake repository is a map of paths to bytes,
 * the fake build writes module graphs into it, and every effectful seam logs its call, so the
 * assertions are about ORDER (the steps of RP3), about WHICH BYTES (the record's digest is the
 * digest of the buffer the inspection received), and about what a refusal leaves behind (no
 * rename, no record, and the last line of the output).
 *
 * Loaded dynamically for the same TS1479 reason its siblings record.
 */
async function loadDriver() {
  return import('../../../scripts/release-candidate.mjs');
}
/** What the command-line shell exports. It has no declaration file: it is typed by use. */
interface Cli {
  parseArguments(argv: string[]): { ok: boolean; advisoryCaptures?: Record<string, string>; message?: string };
  runCli(argv: string[], io: Record<string, unknown>): number;
  writeExclusiveFile(path: string, text: string, mode: number): void;
}
async function loadCli(): Promise<Cli> {
  // A computed specifier, as `advisory-diff-is-report-only.test.ts` does for a module with no
  // declaration: a literal one from this CommonJS file is TS1479.
  const href = pathToFileURL(resolve(__dirname, '..', '..', '..', 'scripts', 'prepare-release.mjs')).href;
  return (await import(href)) as Cli;
}
async function loadDigest() {
  return import('../../../scripts/release-digest.mjs');
}
async function loadSbom() {
  return import('../../../scripts/generate-sbom.mjs');
}

const ROOT = '/work/repo';
const HEAD = 'a'.repeat(40);
const VERSION = '0.2.0';
const NOW = Date.parse('2026-11-02T10:00:00.000Z');
const STAGING = `.release/staging/schegent-${VERSION}.vsix`;
const CANDIDATE = `.release/schegent-${VERSION}.vsix`;
const RECORD = `.release/schegent-${VERSION}.release.json`;
const FINAL_LINE = 'Nothing was tagged, published or uploaded.';
const ESC = String.fromCharCode(27);
const BLOB = { root: 'b'.repeat(40), 'webview-ui': 'c'.repeat(40) } as const;
const VSIX_BYTES = Buffer.from('the packaged vsix bytes');

type Tree = 'root' | 'webview-ui';
type Files = Map<string, Buffer>;

const asBuffer = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));

function graph(half: 'host' | 'webview', over: Record<string, unknown> = {}) {
  return {
    moduleGraphVersion: 1,
    half,
    tree: half === 'host' ? 'root' : 'webview-ui',
    bundler: half === 'host' ? 'esbuild' : 'rollup',
    bundlerVersion: '1.0.0',
    build: { commit: HEAD, dirty: false, mode: 'development' },
    outputs: [
      half === 'host'
        ? { file: 'dist/extension.js', sha256: 'd'.repeat(64), bytes: 10 }
        : { file: 'dist/webview/index.js', sha256: 'e'.repeat(64), bytes: 20 }
    ],
    excludedOutputs: [],
    packages:
      half === 'webview'
        ? [{ installPath: 'node_modules/svelte', modules: 3, renderedBytes: 30 }]
        : [],
    unmapped: [],
    firstPartyModules: 5,
    ...over
  };
}

const LOCKS = {
  root: { packages: { '': {}, 'node_modules/esbuild': { version: '0.28.2', dev: true } } },
  'webview-ui': { packages: { '': {}, 'node_modules/svelte': { version: '5.56.10', dev: true } } }
};
const MANIFESTS = {
  root: { name: 'schegent', version: VERSION, license: 'MIT' },
  'webview-ui': { name: 'webview-ui', version: VERSION }
};

function capture(tree: Tree, over: Record<string, unknown> = {}) {
  return {
    captureVersion: 1,
    tree,
    ecosystem: 'npm',
    commit: 'f'.repeat(40),
    objectFormat: 'sha1',
    manifest: { path: tree === 'root' ? 'package.json' : 'webview-ui/package.json', blob: '1'.repeat(40) },
    lockfile: {
      path: tree === 'root' ? 'package-lock.json' : 'webview-ui/package-lock.json',
      blob: BLOB[tree]
    },
    tool: 'npm',
    toolVersion: '11.17.0',
    command: 'npm audit --json',
    registryHost: 'registry.npmjs.org',
    observedAt: new Date(NOW - 86_400_000).toISOString(),
    reportFormat: 'npm-audit-report-2',
    outcome: { status: 'succeeded' },
    limitations: ['Advisory data is the registry\'s at observedAt.'],
    findings: [],
    ...over
  };
}

function advisoryFinding(over: Record<string, unknown> = {}) {
  return {
    package: 'svelte',
    ids: { canonical: 'GHSA-aaaa-bbbb-cccc', aliases: [] },
    severity: 'moderate',
    range: '<6.0.0',
    title: 'A title',
    url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
    locations: [{ location: 'node_modules/svelte', version: '5.56.10', direct: true, production: false }],
    direct: true,
    production: false,
    dependents: [],
    notes: [],
    ...over
  };
}

const FRESH_BUNDLE = 'fresh host bundle';

/** What `npm run build` leaves behind when it succeeds on a clean checkout at HEAD. */
function freshBuild(files: Files, identity: Record<string, unknown> = {}) {
  const build = { commit: HEAD, dirty: false, mode: 'development', ...identity };
  files.set('dist/extension.js', Buffer.from(FRESH_BUNDLE));
  files.set('dist/module-graph/host.json', asBuffer(graph('host', { build })));
  files.set('dist/module-graph/webview.json', asBuffer(graph('webview', { build })));
}

/**
 * An incremental build: it writes what is missing and leaves what it finds, which is the build an
 * mtime freshness check trusts. If the driver did not remove `dist/` first, a stale output would
 * survive this build and reach the record, which is what the SC-003 cases below would catch.
 */
function lazyBuild(files: Files) {
  const fresh: Files = new Map();
  freshBuild(fresh);
  for (const [path, bytes] of fresh) if (!files.has(path)) files.set(path, bytes);
}

interface Options {
  head?: string;
  treeStates?: Array<{ head: string; treeClean: boolean }>;
  readTreeStateThrows?: boolean;
  status?: Partial<Record<'build' | 'sbom' | 'notices' | 'vsce', number>>;
  build?: (files: Files) => void;
  captures?: Partial<Record<Tree, Buffer | undefined>>;
  dispositions?: Buffer | undefined;
  inspectThrows?: string;
  agreementThrows?: string;
  archiveSbom?: (honest: unknown) => unknown;
  writeThrows?: boolean;
  version?: string;
  seedFiles?: Array<[string, Buffer]>;
  releaseDirectory?: string;
  removeThrows?: string;
  /** The gate record on disk: an object, `null` for none, or leave unset for a verified one. */
  gateRecord?: Record<string, unknown> | null;
  /** Raw text for the gate record file, for one that does not parse. */
  gateText?: string;
}

function world(options: Options = {}) {
  const files: Files = new Map();
  files.set('package.json', asBuffer({ ...MANIFESTS.root, version: options.version ?? VERSION }));
  files.set('package-lock.json', asBuffer(LOCKS.root));
  files.set('webview-ui/package.json', asBuffer(MANIFESTS['webview-ui']));
  files.set('webview-ui/package-lock.json', asBuffer(LOCKS['webview-ui']));
  files.set(
    'docs/release/advisory-dispositions.json',
    options.dispositions ?? asBuffer({ dispositionListVersion: 1, dispositions: [] })
  );
  files.set('/cap/root.json', options.captures?.root ?? asBuffer(capture('root')));
  files.set('/cap/webview-ui.json', options.captures?.['webview-ui'] ?? asBuffer(capture('webview-ui')));
  if (options.captures && 'root' in options.captures && options.captures.root === undefined) {
    files.delete('/cap/root.json');
  }
  if (options.captures && 'webview-ui' in options.captures && options.captures['webview-ui'] === undefined) {
    files.delete('/cap/webview-ui.json');
  }
  if (options.dispositions === undefined && 'dispositions' in options) {
    files.delete('docs/release/advisory-dispositions.json');
  }
  if (options.gateText !== undefined) files.set('.gate-attestation.json', Buffer.from(options.gateText));
  else if (options.gateRecord !== null) {
    files.set('.gate-attestation.json', asBuffer(options.gateRecord ?? verifiedGateRecord()));
  }
  for (const [path, bytes] of options.seedFiles ?? []) files.set(path, bytes);

  const events: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const written: Array<{ path: string; text: string; mode: number }> = [];
  const removed: string[] = [];
  const seen: { inspected?: Buffer; compared?: Buffer; runScripts: string[]; vsceOut: string[] } = {
    runScripts: [],
    vsceOut: []
  };
  const states = [...(options.treeStates ?? [])];
  const head = options.head ?? HEAD;

  const deps = {
    repoRoot: ROOT,
    releaseDirectory: options.releaseDirectory,
    advisoryCaptures: { root: '/cap/root.json', 'webview-ui': '/cap/webview-ui.json' },
    readTreeState: () => {
      events.push('readTreeState');
      if (options.readTreeStateThrows) throw new Error('not a git repository');
      return states.shift() ?? { head, treeClean: true };
    },
    gitBlob: (spec: string) => {
      events.push(`gitBlob:${spec}`);
      const match = /^HEAD:(.+)$/.exec(spec);
      const path = match?.[1];
      if (path === 'package-lock.json') return BLOB.root;
      if (path === 'webview-ui/package-lock.json') return BLOB['webview-ui'];
      throw new Error(`unexpected spec ${spec}`);
    },
    readFile: (path: string) => {
      const found = files.get(path);
      if (!found) throw new Error(`ENOENT: ${path}`);
      return found;
    },
    removePath: (path: string) => {
      events.push(`removePath:${path}`);
      if (options.removeThrows) throw new Error(options.removeThrows);
      removed.push(path);
      for (const key of [...files.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) files.delete(key);
      }
    },
    ensureDirectory: (path: string, mode: number) => {
      events.push(`ensureDirectory:${path}:${mode.toString(8)}`);
    },
    runScript: (name: string) => {
      events.push(`runScript:${name}`);
      seen.runScripts.push(name);
      const status = options.status?.[name as 'build' | 'sbom' | 'notices'] ?? 0;
      if (status === 0 && name === 'build') (options.build ?? freshBuild)(files);
      if (status === 0 && name === 'sbom') files.set('schegent-sbom.cdx.json', asBuffer('{"sbom":true}'));
      if (status === 0 && name === 'notices') files.set('THIRD-PARTY-NOTICES.md', Buffer.from('# Third-party notices'));
      return status;
    },
    runVsce: (outPath: string) => {
      events.push(`runVsce:${outPath}`);
      seen.vsceOut.push(outPath);
      const status = options.status?.vsce ?? 0;
      if (status === 0) files.set(outPath, VSIX_BYTES);
      return status;
    },
    rename: (from: string, to: string) => {
      events.push(`rename:${from}->${to}`);
      const bytes = files.get(from);
      if (!bytes) throw new Error(`ENOENT: ${from}`);
      files.delete(from);
      files.set(to, bytes);
    },
    writeExclusive: (path: string, text: string, mode: number) => {
      events.push(`writeExclusive:${path}:${mode.toString(8)}`);
      if (options.writeThrows) throw new Error('EEXIST: record already exists');
      written.push({ path, text, mode });
      files.set(path, Buffer.from(text));
    },
    now: () => NOW,
    log: (line: string) => logs.push(line),
    error: (line: string) => errors.push(line),
    inspectVsixBytes: (bytes: Buffer, label: string) => {
      events.push(`inspectVsixBytes:${label}`);
      seen.inspected = bytes;
      if (options.inspectThrows) throw new Error(options.inspectThrows);
    },
    assertSbomMatchesArchive: (bytes: Buffer, label: string) => {
      events.push(`assertSbomMatchesArchive:${label}`);
      seen.compared = bytes;
      if (options.agreementThrows) throw new Error(options.agreementThrows);
      return { sbom: archiveSbom(files, options.archiveSbom), sbomSha256: 'f'.repeat(64) };
    }
  };

  return { deps, files, events, logs, errors, written, removed, seen };
}

/**
 * A gate record a recorder writes on a green run at HEAD, built from the real module's constants so
 * a schema bump does not turn every case here into a refusal and hide what it asserts.
 */
let verifiedGateRecord: () => Record<string, unknown> = () => ({});

/** The SBOM the build beside the archive would carry, derived by the real generator. */
let honestSbom: (graphs: unknown) => unknown = () => ({});
function archiveSbom(files: Files, tamper: ((honest: unknown) => unknown) | undefined): unknown {
  const read = (path: string) => JSON.parse((files.get(path) ?? Buffer.from('{}')).toString('utf8'));
  const honest = honestSbom({
    graphs: { host: read('dist/module-graph/host.json'), webview: read('dist/module-graph/webview.json') },
    locks: LOCKS,
    manifests: MANIFESTS,
    now: new Date(NOW).toISOString()
  });
  return tamper ? tamper(honest) : honest;
}

/** Load the constants `verifiedGateRecord` is derived from, so a builder run before `run` can use it. */
async function loadGateRecordConstants(): Promise<void> {
  await run();
}

async function run(options: Options = {}) {
  const [{ releaseCandidate }, { buildSbom }, gate] = await Promise.all([
    loadDriver(),
    loadSbom(),
    import('../../../scripts/gate-attestation.mjs')
  ]);
  honestSbom = (input) => buildSbom(input as never);
  verifiedGateRecord = () => ({
    version: gate.ATTESTATION_VERSION,
    command: gate.GATE_COMMAND,
    commandExecutable: 'npm',
    commandArgv: [...gate.GATE_COMMAND_SPEC.args],
    head: HEAD,
    treeClean: true,
    exitCode: 0,
    platform: 'darwin',
    arch: 'arm64',
    nodeVersion: 'v24.19.0',
    nodeDeclared: '24.19.0',
    nodeMatchesDeclared: true,
    envelope: { present: true },
    trees: [
      { tree: 'root', lockfile: 'package-lock.json', lockfileSha256: '1'.repeat(64), install: 'matches' },
      { tree: 'webview-ui', lockfile: 'webview-ui/package-lock.json', lockfileSha256: '2'.repeat(64), install: 'matches' }
    ],
    startedAt: '2026-11-02T09:00:00.000Z',
    recordedAt: '2026-11-02T09:30:00.000Z'
  });
  const w = world(options);
  const result = releaseCandidate(w.deps as never);
  return { ...w, result };
}

const lastLine = (lines: string[]) => lines.at(-1);

describe('exports', () => {
  it('names exactly the three child scripts the controls page walks, in order, frozen', async () => {
    const { RELEASE_CHILD_SCRIPTS } = await loadDriver();
    expect([...RELEASE_CHILD_SCRIPTS]).toEqual(['build', 'sbom', 'notices']);
    expect(Object.isFrozen(RELEASE_CHILD_SCRIPTS)).toBe(true);
  });

  it('re-exports the advisory budget unchanged (TA4)', async () => {
    const driver = await loadDriver();
    const advisory = await import('../../../scripts/release-advisory.mjs');
    expect(driver.RELEASE_ADVISORY_BUDGET_DAYS).toBe(7);
    expect(driver.RELEASE_ADVISORY_BUDGET_DAYS).toBe(advisory.RELEASE_ADVISORY_BUDGET_DAYS);
  });
});

describe('an accepted candidate (RP3, RP5)', () => {
  it('runs the steps in order and builds, generates the SBOM and packages exactly once', async () => {
    const { events, seen, result } = await run();
    expect(result.exitCode).toBe(0);
    expect(seen.runScripts).toEqual(['build', 'sbom', 'notices']);
    expect(seen.vsceOut).toEqual([STAGING]);
    const at = (prefix: string, from = 0) => events.findIndex((e, i) => i >= from && e.startsWith(prefix));
    const order = [
      at('readTreeState'),
      at('gitBlob:'),
      at('runScript:build'),
      at('runScript:sbom'),
      at('ensureDirectory'),
      at('runVsce'),
      at('inspectVsixBytes'),
      at('assertSbomMatchesArchive'),
      at('readTreeState', at('assertSbomMatchesArchive')),
      at('rename'),
      at('writeExclusive')
    ];
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(new Set(order).size).toBe(order.length);
  });

  it('creates the staging directory owner-only before packaging into it', async () => {
    const { events } = await run();
    const made = events.indexOf('ensureDirectory:.release/staging:700');
    expect(made).toBeGreaterThanOrEqual(0);
    expect(made).toBeLessThan(events.findIndex((e) => e.startsWith('runVsce')));
  });

  it('renames the staging file to the candidate and writes the record exclusively, owner-only', async () => {
    const { events, files, written } = await run();
    expect(events).toContain(`rename:${STAGING}->${CANDIDATE}`);
    expect(events).toContain(`writeExclusive:${RECORD}:600`);
    expect(files.has(CANDIDATE)).toBe(true);
    expect(files.has(STAGING)).toBe(false);
    expect(written).toHaveLength(1);
    expect(written.at(0)?.path).toBe(RECORD);
    expect(written.at(0)?.mode).toBe(0o600);
  });

  it('records the digest of the very bytes the inspection received (SC-002)', async () => {
    const { sha256Hex } = await loadDigest();
    const { seen, written } = await run();
    expect(seen.inspected).toBe(VSIX_BYTES);
    expect(seen.compared).toBe(seen.inspected);
    const record = JSON.parse(written.at(0)?.text ?? '{}');
    expect(record.candidate.sha256).toBe(sha256Hex(seen.inspected as Buffer));
    expect(record.candidate.bytes).toBe(VSIX_BYTES.length);
    expect(record.candidate.path).toBe(CANDIDATE);
  });

  it('records the source commit, the build mode and the SBOM digest', async () => {
    const { written } = await run();
    const record = JSON.parse(written.at(0)?.text ?? '{}');
    expect(record.source).toEqual({ commit: HEAD, dirty: false });
    expect(record.build.mode).toBe('development');
    expect(record.build.webview).toBe('vite build (minified)');
    expect(record.sbom.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.sbom.entry).toBe('extension/schegent-sbom.cdx.json');
    expect(record.sbom).toMatchObject({
      declaredRuntimeDependencies: 0,
      bundledComponents: 1,
      unknownProvenance: 0
    });
  });

  it('states that nothing was tagged or published, in the record and as the last line', async () => {
    const { written, logs } = await run();
    const record = JSON.parse(written.at(0)?.text ?? '{}');
    expect(record.tagged).toBe(false);
    expect(record.published).toBe(false);
    expect(lastLine(logs)).toBe(FINAL_LINE);
  });

  it('writes the record with its fields in the documented order and a version', async () => {
    const { written } = await run();
    const record = JSON.parse(written.at(0)?.text ?? '{}');
    const keys = Object.keys(record);
    expect(keys.slice(0, 6)).toEqual([
      'releaseRecordVersion',
      'preparedAt',
      'candidate',
      'source',
      'build',
      'sbom'
    ]);
    expect(keys.at(-2)).toBe('tagged');
    expect(keys.at(-1)).toBe('published');
    expect(record.releaseRecordVersion).toBe(1);
    expect(record.preparedAt).toBe(new Date(NOW).toISOString());
  });

  it('names no absolute or home path in the record or in anything printed', async () => {
    const { written, logs, errors } = await run();
    const everything = [written.at(0)?.text ?? '', ...logs, ...errors].join('\n');
    expect(everything).not.toContain(ROOT);
    expect(everything).not.toContain('/Users/');
    expect(everything).not.toContain('/cap/');
  });

  it('prints the candidate, its digest and size, the commit, the mode, the SBOM counts and the record path', async () => {
    const { sha256Hex } = await loadDigest();
    const { logs } = await run();
    const printed = logs.join('\n');
    expect(printed).toContain(CANDIDATE);
    expect(printed).toContain(sha256Hex(VSIX_BYTES));
    expect(printed).toContain(`${VSIX_BYTES.length} bytes`);
    expect(printed).toContain(HEAD);
    expect(printed).toContain('development');
    expect(printed).toMatch(/0 declared runtime/);
    expect(printed).toMatch(/1 bundled/);
    expect(printed).toMatch(/0 unknown provenance/);
    expect(printed).toContain(RECORD);
    expect(printed).not.toContain(`${ESC}[`);
  });

  it('lists each finding by canonical id with its URL, severity, usage and verdict, ranking none', async () => {
    const { logs, written } = await run({
      captures: {
        'webview-ui': asBuffer(capture('webview-ui', { findings: [advisoryFinding()] }))
      }
    });
    const line = logs.find((entry) => entry.includes('GHSA-aaaa-bbbb-cccc'));
    expect(line).toBeDefined();
    for (const part of [
      'webview-ui',
      'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
      'moderate',
      'usage=shipped',
      'disposition=not-recorded'
    ]) {
      expect(line).toContain(part);
    }
    expect(logs.join('\n')).not.toMatch(/\btotal\b|\bmost\b|\bworst\b|\branked\b/i);
    const record = JSON.parse(written.at(0)?.text ?? '{}');
    expect(record.advisory.findings).toEqual([
      {
        tree: 'webview-ui',
        advisory: 'GHSA-aaaa-bbbb-cccc',
        url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
        package: 'svelte',
        severity: 'moderate',
        usage: 'shipped',
        disposition: 'not-recorded'
      }
    ]);
  });

  it('records the advisory evidence it relied on, with the budget and the lockfile digests', async () => {
    const { sha256Hex } = await loadDigest();
    const { written, files } = await run();
    const record = JSON.parse(written.at(0)?.text ?? '{}');
    expect(record.advisory.budgetDays).toBe(7);
    expect(record.advisory.evaluatedAt).toBe(new Date(NOW).toISOString());
    expect(record.advisory.captures).toHaveLength(2);
    const rootCapture = record.advisory.captures.at(0);
    expect(rootCapture).toMatchObject({
      tree: 'root',
      commit: 'f'.repeat(40),
      completeness: 'complete',
      findings: 0,
      lockfile: {
        path: 'package-lock.json',
        blob: BLOB.root,
        sha256: sha256Hex(files.get('package-lock.json') as Buffer)
      }
    });
    expect(record.advisory.dispositions).toMatchObject({
      path: 'docs/release/advisory-dispositions.json',
      entries: 0
    });
    expect(record.advisory.verdicts).toEqual({
      'not-recorded': 0,
      covers: 0,
      expired: 0,
      'does-not-cover': 0
    });
  });

  it('reads the version from the manifest and uses it for the file names', async () => {
    const { seen } = await run({ version: '1.4.0-rc.1' });
    expect(seen.vsceOut).toEqual(['.release/staging/schegent-1.4.0-rc.1.vsix']);
  });

  it('escapes anything a capture carries before printing it', async () => {
    const { logs } = await run({
      captures: {
        'webview-ui': asBuffer(
          capture('webview-ui', {
            findings: [advisoryFinding({ url: `https://example.test/${ESC}[31mred`, package: 'svelte' })]
          })
        )
      }
    });
    expect(logs.join('\n')).not.toContain(ESC);
    expect(logs.join('\n')).toContain('\\x1b');
  });
});

/** Every refusal prints its reason, exits 1, writes no record and ends with the final line. */
function expectRefused(
  outcome: Awaited<ReturnType<typeof run>>,
  reason: string
): void {
  expect(outcome.result.exitCode).toBe(1);
  expect(outcome.result.reason).toBe(reason);
  expect(outcome.errors.at(0)).toBe(`prepare-release: REFUSED (${reason})`);
  expect(lastLine(outcome.errors)).toBe(FINAL_LINE);
  expect(outcome.errors.length).toBeGreaterThanOrEqual(3);
  expect(outcome.written).toHaveLength(0);
  expect(outcome.logs).not.toContain(FINAL_LINE);
}

describe('refusals (RP4)', () => {
  it('dirty-tree: the tree has uncommitted changes, and nothing is built', async () => {
    const outcome = await run({ treeStates: [{ head: HEAD, treeClean: false }] });
    expectRefused(outcome, 'dirty-tree');
    expect(outcome.seen.runScripts).toEqual([]);
    expect(outcome.errors.join('\n')).toMatch(/commit|stash/i);
  });

  it('unknown-identity: git cannot name HEAD', async () => {
    const outcome = await run({ readTreeStateThrows: true });
    expectRefused(outcome, 'unknown-identity');
    expect(outcome.seen.runScripts).toEqual([]);
  });

  it('unknown-identity: HEAD is not a full lowercase hex id', async () => {
    const outcome = await run({ head: 'ABCDEF0' });
    expectRefused(outcome, 'unknown-identity');
    expect(outcome.seen.runScripts).toEqual([]);
  });

  it('unknown-identity: the manifest version is not a release version', async () => {
    const outcome = await run({ version: '../../outside' });
    expectRefused(outcome, 'unknown-identity');
    expect(outcome.seen.runScripts).toEqual([]);
    expect(outcome.seen.vsceOut).toEqual([]);
  });

  it('unknown-identity: the graph the build wrote carries commit unknown', async () => {
    const outcome = await run({
      build: (files) => freshBuild(files, { commit: 'unknown', dirty: 'unknown' })
    });
    expectRefused(outcome, 'unknown-identity');
    expect(outcome.seen.runScripts).toEqual(['build']);
    expect(outcome.seen.vsceOut).toEqual([]);
  });

  it('dirty-identity: the graph says the build ran on a dirty tree', async () => {
    const outcome = await run({ build: (files) => freshBuild(files, { dirty: true }) });
    expectRefused(outcome, 'dirty-identity');
    expect(outcome.seen.vsceOut).toEqual([]);
  });

  it('identity-mismatch: the graph names a commit other than HEAD', async () => {
    const outcome = await run({ build: (files) => freshBuild(files, { commit: '9'.repeat(40) }) });
    expectRefused(outcome, 'identity-mismatch');
    expect(outcome.seen.vsceOut).toEqual([]);
  });

  it('identity-mismatch: the two halves were built from different commits', async () => {
    const outcome = await run({
      build: (files) => {
        freshBuild(files);
        files.set(
          'dist/module-graph/webview.json',
          asBuffer(graph('webview', { build: { commit: '8'.repeat(40), dirty: false, mode: 'production' } }))
        );
      }
    });
    expectRefused(outcome, 'identity-mismatch');
  });

  it('accepts halves whose modes differ, because each mode describes its own half', async () => {
    const outcome = await run({
      build: (files) => {
        freshBuild(files);
        files.set(
          'dist/module-graph/webview.json',
          asBuffer(graph('webview', { build: { commit: HEAD, dirty: false, mode: 'production' } }))
        );
      }
    });
    expect(outcome.result.exitCode).toBe(0);
  });

  it('build-failed: the build exits non-zero, and nothing later runs', async () => {
    const outcome = await run({ status: { build: 1 } });
    expectRefused(outcome, 'build-failed');
    expect(outcome.seen.runScripts).toEqual(['build']);
  });

  it('build-failed: the build exits zero but writes no module graph', async () => {
    const outcome = await run({ build: () => undefined });
    expectRefused(outcome, 'build-failed');
    expect(outcome.seen.runScripts).toEqual(['build']);
  });

  it('sbom-failed: the SBOM step exits non-zero, and nothing is packaged', async () => {
    const outcome = await run({ status: { sbom: 1 } });
    expectRefused(outcome, 'sbom-failed');
    expect(outcome.seen.runScripts).toEqual(['build', 'sbom']);
    expect(outcome.seen.vsceOut).toEqual([]);
  });

  it('notices-failed: the notices step exits non-zero, and nothing is packaged (FR-R5-F21)', async () => {
    const outcome = await run({ status: { notices: 1 } });
    expectRefused(outcome, 'notices-failed');
    expect(outcome.errors.join('\n')).toContain('`npm run notices` exited non-zero.');
    expect(outcome.seen.runScripts).toEqual(['build', 'sbom', 'notices']);
    expect(outcome.seen.vsceOut).toEqual([]);
  });

  it('package-failed: vsce exits non-zero, and no candidate or record exists', async () => {
    const outcome = await run({ status: { vsce: 1 } });
    expectRefused(outcome, 'package-failed');
    expect(outcome.files.has(CANDIDATE)).toBe(false);
  });

  it('inspection-failed: carries the check\'s own [policy] text, renames nothing and writes no record', async () => {
    const outcome = await run({ inspectThrows: `${STAGING}: [policy] unexpected packaged file extension/x` });
    expectRefused(outcome, 'inspection-failed');
    expect(outcome.errors.join('\n')).toContain('[policy] unexpected packaged file extension/x');
    expect(outcome.events.some((event) => event.startsWith('rename'))).toBe(false);
    expect(outcome.files.has(CANDIDATE)).toBe(false);
    expect(outcome.files.has(STAGING)).toBe(true);
  });

  it('inspection-failed: the SBOM does not agree with the archive', async () => {
    const outcome = await run({ agreementThrows: `${STAGING}: [policy] the SBOM and the archive list different dist files` });
    expectRefused(outcome, 'inspection-failed');
    expect(outcome.errors.join('\n')).toContain('different dist files');
    expect(outcome.events.some((event) => event.startsWith('rename'))).toBe(false);
  });

  it('inspection-failed: the bundled set re-derived from the graphs differs from the archive\'s SBOM (AC3)', async () => {
    const outcome = await run({
      archiveSbom: (honest) => {
        const sbom = JSON.parse(JSON.stringify(honest));
        sbom.components = sbom.components.filter((c: { name: string }) => c.name !== 'svelte');
        return sbom;
      }
    });
    expectRefused(outcome, 'inspection-failed');
    expect(outcome.errors.join('\n')).toContain('svelte@5.56.10');
    expect(outcome.events.some((event) => event.startsWith('rename'))).toBe(false);
  });

  it('tree-moved: HEAD moved while the release was being prepared', async () => {
    const outcome = await run({
      treeStates: [
        { head: HEAD, treeClean: true },
        { head: '7'.repeat(40), treeClean: true }
      ]
    });
    expectRefused(outcome, 'tree-moved');
    expect(outcome.events.some((event) => event.startsWith('rename'))).toBe(false);
  });

  it('tree-moved: the tree is dirty again after the build', async () => {
    const outcome = await run({
      treeStates: [
        { head: HEAD, treeClean: true },
        { head: HEAD, treeClean: false }
      ]
    });
    expectRefused(outcome, 'tree-moved');
  });

  it('record-failed: the record cannot be written, so the candidate goes back to staging', async () => {
    const outcome = await run({ writeThrows: true });
    expectRefused(outcome, 'record-failed');
    const renames = outcome.events.filter((event) => event.startsWith('rename:'));
    expect(renames).toEqual([`rename:${STAGING}->${CANDIDATE}`, `rename:${CANDIDATE}->${STAGING}`]);
    expect(outcome.files.has(CANDIDATE)).toBe(false);
    expect(outcome.files.has(STAGING)).toBe(true);
  });

  it('passes the advisory reasons through, before any build work', async () => {
    const outcome = await run({ captures: { 'webview-ui': undefined } });
    expectRefused(outcome, 'advisory-capture-missing');
    expect(outcome.seen.runScripts).toEqual([]);
    expect(outcome.errors.join('\n')).toContain('webview-ui');
  });

  it('passes a stale capture through with the age and the budget', async () => {
    const outcome = await run({
      captures: {
        root: asBuffer(capture('root', { observedAt: new Date(NOW - 8 * 86_400_000).toISOString() }))
      }
    });
    expectRefused(outcome, 'advisory-stale');
    expect(outcome.errors.join('\n')).toContain('7 days');
    expect(outcome.seen.runScripts).toEqual([]);
  });

  it('passes an unusable disposition list through', async () => {
    const outcome = await run({ dispositions: Buffer.from('not json') });
    expectRefused(outcome, 'dispositions-unusable');
    expect(outcome.seen.runScripts).toEqual([]);
  });

  it('escapes anything a failed check carried before printing it', async () => {
    const outcome = await run({ inspectThrows: `${STAGING}: [policy] bad ${ESC}[2Jname` });
    expect(outcome.errors.join('\n')).not.toContain(ESC);
    expect(outcome.errors.join('\n')).toContain('\\x1b');
  });

  it('names the remedy on every refusal, not only the reason', async () => {
    const outcomes = await Promise.all([
      run({ treeStates: [{ head: HEAD, treeClean: false }] }),
      run({ status: { build: 1 } }),
      run({ status: { sbom: 1 } }),
      run({ status: { vsce: 1 } }),
      run({ writeThrows: true })
    ]);
    for (const outcome of outcomes) {
      expect(outcome.errors.at(1)).toMatch(/^ {2}\S/);
      expect(outcome.errors.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('prepare-release (RP1, RP2, RP4)', () => {
  const ARGS = ['--advisory-capture', 'root=a.json', '--advisory-capture', 'webview-ui=b.json'];

  it('parses one capture per tree, in either order', async () => {
    const { parseArguments } = await loadCli();
    expect(parseArguments(ARGS)).toEqual({
      ok: true,
      advisoryCaptures: { root: 'a.json', 'webview-ui': 'b.json' }
    });
    expect(
      parseArguments(['--advisory-capture', 'webview-ui=b.json', '--advisory-capture', 'root=a.json'])
    ).toEqual({ ok: true, advisoryCaptures: { root: 'a.json', 'webview-ui': 'b.json' } });
  });

  it.each([
    ['no arguments', []],
    ['one tree only', ['--advisory-capture', 'root=a.json']],
    ['a repeated tree', [...ARGS, '--advisory-capture', 'root=c.json']],
    ['an unknown tree', ['--advisory-capture', 'root=a.json', '--advisory-capture', 'other=b.json']],
    ['an unknown flag', [...ARGS, '--force']],
    ['a bare word', [...ARGS, 'now']],
    ['a flag with no value', ['--advisory-capture']],
    ['a value with no path', ['--advisory-capture', 'root=', '--advisory-capture', 'webview-ui=b.json']],
    ['a value with no tree', ['--advisory-capture', '=a.json', '--advisory-capture', 'webview-ui=b.json']],
    ['the equals form', ['--advisory-capture=root=a.json', '--advisory-capture=webview-ui=b.json']]
  ])('refuses %s as a usage error', async (_label, argv) => {
    const { parseArguments } = await loadCli();
    const parsed = parseArguments(argv as string[]);
    expect(parsed.ok).toBe(false);
  });

  it('exits 2 on a usage error, touches nothing, and still ends with the final line', async () => {
    const { runCli } = await loadCli();
    const errors: string[] = [];
    const logs: string[] = [];
    let built = 0;
    const code = runCli(['--bogus'], {
      makeDeps: () => {
        built += 1;
        throw new Error('must not be called');
      },
      releaseCandidate: () => {
        throw new Error('must not be called');
      },
      log: (line: string) => logs.push(line),
      error: (line: string) => errors.push(line)
    } as never);
    expect(code).toBe(2);
    expect(built).toBe(0);
    expect(lastLine(errors)).toBe(FINAL_LINE);
    expect(errors.join('\n')).toContain('--advisory-capture');
  });

  it('maps the driver\'s exit code through, 0 for accepted and 1 for refused', async () => {
    const { runCli } = await loadCli();
    for (const exitCode of [0, 1]) {
      const code = runCli(ARGS, {
        makeDeps: (captures: unknown) => ({ captures }),
        releaseCandidate: () => ({ exitCode }),
        log: () => undefined,
        error: () => undefined
      } as never);
      expect(code).toBe(exitCode);
    }
  });

  it('resolves capture paths against the working directory before the driver sees them', async () => {
    const { runCli } = await loadCli();
    let seen: unknown;
    runCli(['--advisory-capture', 'root=rel/a.json', '--advisory-capture', 'webview-ui=/abs/b.json'], {
      makeDeps: (captures: unknown) => {
        seen = captures;
        return {};
      },
      releaseCandidate: () => ({ exitCode: 0 }),
      log: () => undefined,
      error: () => undefined
    } as never);
    const resolved = seen as { root: string; 'webview-ui': string };
    expect(resolved.root.startsWith('/')).toBe(true);
    expect(resolved.root.endsWith('rel/a.json')).toBe(true);
    expect(resolved['webview-ui']).toBe('/abs/b.json');
  });
});

describe('the real bindings (RP2)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });
  const temp = () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'release-bindings-'));
    dirs.push(dir);
    return dir;
  };

  it('writes the record exclusively, owner-only, and refuses to overwrite one', async () => {
    const { writeExclusiveFile } = await loadCli();
    const path = join(temp(), 'record.json');
    writeExclusiveFile(path, '{"first":true}\n', 0o600);
    expect(readFileSync(path, 'utf8')).toBe('{"first":true}\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => writeExclusiveFile(path, '{"second":true}\n', 0o600)).toThrow(/EEXIST/);
    expect(readFileSync(path, 'utf8')).toBe('{"first":true}\n');
  });

  it('resolves a path inside the root and refuses one that leaves it', async () => {
    const { resolveInsideRoot } = await loadDriver();
    expect(resolveInsideRoot('/work/repo', 'dist')).toBe('/work/repo/dist');
    expect(resolveInsideRoot('/work/repo', '.release/staging')).toBe('/work/repo/.release/staging');
    for (const escaping of ['..', '../x', 'dist/../../x', '/etc/passwd']) {
      expect(() => resolveInsideRoot('/work/repo', escaping), escaping).toThrow(/outside/);
    }
  });
});

describe('output is never reused (RP3 step 3, research R2, SC-003)', () => {
  const FOREIGN = '9'.repeat(40);
  const STALE_DIGEST = '5'.repeat(64);
  const foreignGraphs = (identity: Record<string, unknown>, digest: string): Array<[string, Buffer]> => [
    [
      'dist/module-graph/host.json',
      asBuffer(
        graph('host', {
          build: identity,
          outputs: [{ file: 'dist/extension.js', sha256: digest, bytes: 1 }]
        })
      )
    ],
    [
      'dist/module-graph/webview.json',
      asBuffer(
        graph('webview', {
          build: { ...identity, mode: 'production' },
          outputs: [{ file: 'dist/webview/index.js', sha256: digest, bytes: 1 }]
        })
      )
    ]
  ];
  const headIdentity = { commit: HEAD, dirty: false, mode: 'development' };

  const cases: Array<[string, Array<[string, Buffer]>]> = [
    [
      'a dist/ from another tree carrying a foreign graph identity',
      [
        ...foreignGraphs({ commit: FOREIGN, dirty: false, mode: 'development' }, STALE_DIGEST),
        ['dist/extension.js', Buffer.from('built from another tree')]
      ]
    ],
    [
      'output touched newer than its source',
      [...foreignGraphs(headIdentity, STALE_DIGEST), ['dist/extension.js', Buffer.from('hand-touched bytes')]]
    ],
    [
      'output built before a configuration change',
      [...foreignGraphs(headIdentity, STALE_DIGEST), ['dist/extension.js', Buffer.from('built with the old configuration')]]
    ]
  ];

  it.each(cases)('rebuilds from nothing when it finds %s', async (_label, seedFiles) => {
    const outcome = await run({ seedFiles, build: lazyBuild });
    expect(outcome.result.exitCode).toBe(0);
    const removedAt = outcome.events.indexOf('removePath:dist');
    expect(removedAt).toBeGreaterThanOrEqual(0);
    expect(removedAt).toBeLessThan(outcome.events.indexOf('runScript:build'));
    expect(outcome.files.get('dist/extension.js')?.toString()).toBe(FRESH_BUNDLE);
    const record = outcome.written.at(0)?.text ?? '';
    expect(record).not.toContain(FOREIGN);
    expect(record).not.toContain(STALE_DIGEST);
    expect(record).toContain(HEAD);
  });

  it('removes only the closed set, each path once, before the build', async () => {
    const outcome = await run({
      seedFiles: [
        ['schegent-sbom.cdx.json', Buffer.from('an SBOM from an earlier run')],
        ['THIRD-PARTY-NOTICES.md', Buffer.from('notices from an earlier run')],
        [STAGING, Buffer.from('an earlier staging file')],
        [CANDIDATE, Buffer.from('an earlier candidate')],
        [RECORD, Buffer.from('an earlier record')]
      ],
      build: lazyBuild
    });
    expect(outcome.removed).toEqual([
      'dist',
      'schegent-sbom.cdx.json',
      'THIRD-PARTY-NOTICES.md',
      '.release/staging',
      CANDIDATE,
      RECORD
    ]);
    const lastRemoval = Math.max(...outcome.events.map((event, i) => (event.startsWith('removePath:') ? i : -1)));
    expect(lastRemoval).toBeLessThan(outcome.events.indexOf('runScript:build'));
    // What stands afterwards was made by this run: the earlier candidate, record and SBOM are gone.
    expect(outcome.files.get(CANDIDATE)).toBe(VSIX_BYTES);
    expect(outcome.files.get(RECORD)?.toString()).not.toBe('an earlier record');
    expect(outcome.files.get('schegent-sbom.cdx.json')?.toString()).toBe('{"sbom":true}');
    expect(outcome.files.get('THIRD-PARTY-NOTICES.md')?.toString()).toBe('# Third-party notices');
  });

  it('never passes node_modules, the root or a source path to removePath', async () => {
    const outcome = await run();
    for (const path of outcome.removed) {
      expect(path).not.toMatch(/node_modules|^src|^webview-ui|^\.git|^\.?$/);
    }
  });

  it('removes nothing when the tree is dirty or git cannot name HEAD', async () => {
    for (const options of [
      { treeStates: [{ head: HEAD, treeClean: false }] },
      { readTreeStateThrows: true },
      { head: 'abc' }
    ]) {
      const outcome = await run(options);
      expect(outcome.events.some((event) => event.startsWith('removePath:'))).toBe(false);
    }
  });

  it('removes nothing when the advisory evidence is refused, which is checked first', async () => {
    const outcome = await run({ captures: { 'webview-ui': undefined } });
    expect(outcome.events.some((event) => event.startsWith('removePath:'))).toBe(false);
  });

  it('refuses clean-failed when a removal fails, and builds nothing', async () => {
    const outcome = await run({ removeThrows: 'EBUSY: resource busy' });
    expectRefused(outcome, 'clean-failed');
    expect(outcome.errors.join('\n')).toContain('EBUSY');
    expect(outcome.seen.runScripts).toEqual([]);
  });

  it('refuses a path that resolves outside the repository, and removes nothing at all', async () => {
    const outcome = await run({ releaseDirectory: '../elsewhere' });
    expectRefused(outcome, 'clean-failed');
    expect(outcome.removed).toEqual([]);
    expect(outcome.events.some((event) => event.startsWith('removePath:'))).toBe(false);
    expect(outcome.seen.runScripts).toEqual([]);
    expect(outcome.errors.join('\n')).toContain('outside');
  });
});

describe('the gate record the release relies on (TA6, data-model section 5, GR4)', () => {
  it('refuses gate-unverified before anything is removed or built, carrying the decision\'s reason', async () => {
    const outcome = await run({ gateRecord: { ...verifiedGateRecord(), exitCode: 1 } });
    expectRefused(outcome, 'gate-unverified');
    expect(outcome.errors.join('\n')).toContain('gate-failed');
    expect(outcome.errors.join('\n')).toContain('npm run gate:record');
    expect(outcome.events.some((event) => event.startsWith('removePath:'))).toBe(false);
    expect(outcome.seen.runScripts).toEqual([]);
  });

  // Built inside the case, because the record is derived from the real module's constants and
  // that module is loaded when a case runs, not when the table is written.
  it.each<[string, () => Options, string]>([
    ['there is no record', () => ({ gateRecord: null }), 'no-attestation'],
    ['the record does not parse', () => ({ gateText: '{ truncated' }), 'unreadable'],
    ['the record is version 2', () => ({ gateRecord: { ...verifiedGateRecord(), version: 2 } }), 'stale-version'],
    [
      'the record names another commit',
      () => ({ gateRecord: { ...verifiedGateRecord(), head: '7'.repeat(40) } }),
      'wrong-commit'
    ],
    [
      'the record lacks the observation',
      () => ({ gateRecord: { ...verifiedGateRecord(), trees: undefined } }),
      'observation-missing'
    ]
  ])('refuses when %s, naming %s', async (_label, options, reason) => {
    await loadGateRecordConstants();
    const outcome = await run(options());
    expectRefused(outcome, 'gate-unverified');
    expect(outcome.errors.join('\n')).toContain(reason);
    expect(outcome.seen.runScripts).toEqual([]);
  });

  it('copies the version-3 fields into the record\'s gate section, after the advisory evidence', async () => {
    const { written } = await run();
    const record = JSON.parse(written.at(0)?.text ?? '{}');
    expect(Object.keys(record).slice(-4)).toEqual(['advisory', 'gate', 'tagged', 'published']);
    expect(record.gate).toEqual({
      recordVersion: 3,
      head: HEAD,
      recordedAt: '2026-11-02T09:30:00.000Z',
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: 'v24.19.0',
      nodeDeclared: '24.19.0',
      nodeMatchesDeclared: true,
      envelope: { present: true },
      trees: verifiedGateRecord().trees
    });
    expect(record.source.commit).toBe(record.gate.head);
  });

  it('carries a Node difference, a standalone clone and an install that differs, and refuses on none of them', async () => {
    const outcome = await run({
      gateRecord: {
        ...verifiedGateRecord(),
        nodeVersion: 'v24.21.0',
        nodeMatchesDeclared: false,
        envelope: { present: false },
        trees: [
          { tree: 'root', lockfile: 'package-lock.json', lockfileSha256: '1'.repeat(64), install: 'differs', installDifferences: 2 },
          { tree: 'webview-ui', lockfile: 'webview-ui/package-lock.json', lockfileSha256: null, install: 'unreadable' }
        ]
      }
    });
    expect(outcome.result.exitCode).toBe(0);
    const record = JSON.parse(outcome.written.at(0)?.text ?? '{}');
    expect(record.gate.nodeMatchesDeclared).toBe(false);
    expect(record.gate.envelope).toEqual({ present: false });
    expect(record.gate.trees.at(0).install).toBe('differs');
    const printed = outcome.logs.join('\n');
    expect(printed).toContain('v24.21.0');
    expect(printed).toContain('(differs)');
    expect(printed).toContain('absent (standalone clone)');
    expect(printed).toContain('root install: differs');
    expect(printed).toContain('webview-ui install: unreadable');
  });

  it('prints the observation of a matching run too', async () => {
    const printed = (await run()).logs.join('\n');
    expect(printed).toContain('24.19.0');
    expect(printed).not.toContain('(differs)');
    expect(printed).toContain('workspace envelope: present');
    expect(printed).toContain('root install: matches');
    expect(printed).toContain('webview-ui install: matches');
  });

  it('reads the record through the same file seam as everything else, from the repository root', async () => {
    const reads: string[] = [];
    const { releaseCandidate } = await loadDriver();
    await run();
    const w = world();
    const original = w.deps.readFile;
    w.deps.readFile = (path: string) => {
      reads.push(path);
      return original(path);
    };
    releaseCandidate(w.deps as never);
    expect(reads).toContain('.gate-attestation.json');
  });
});
