import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * FR-R5-F21 (FR-023, FR-024; contract third-party-notices) -- the notices for the third-party code
 * the extension bundles. Membership is the SBOM's: a package is listed when a module graph shows
 * bytes of it in a shipped file, and a build-only package is not. `collectNotices` is pure and is
 * driven here over synthetic graphs, locks and a fake file reader; the SBOM it reads is built by the
 * real `buildSbom` from the same inputs, so the two cannot disagree about membership. Loaded
 * dynamically for the same TS1479 reason its siblings record.
 */
async function loadNotices() {
  const notices = await import('../../../scripts/third-party-notices.mjs');
  const sbom = await import('../../../scripts/generate-sbom.mjs');
  return { ...notices, buildSbom: sbom.buildSbom };
}

const HEX = (character: string) => character.repeat(64);
const COMMIT = 'c'.repeat(40);
const NOW = '2026-11-06T18:00:00.000Z';
const MIT_TEXT = 'MIT License\n\nCopyright (c) the authors\n';

type Half = 'host' | 'webview';
type Inputs = {
  graphs: Record<Half, Record<string, unknown>>;
  locks: Record<string, unknown>;
  manifests: Record<string, unknown>;
};

function graph(half: Half, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    moduleGraphVersion: 1,
    half,
    tree: half === 'host' ? 'root' : 'webview-ui',
    bundler: half === 'host' ? 'esbuild' : 'rollup',
    bundlerVersion: '1.0.0',
    build: { commit: COMMIT, dirty: false, mode: 'production' },
    outputs: [{ file: `dist/${half}.js`, sha256: HEX('a'), bytes: 10 }],
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

const bundled = (name: string) => ({ installPath: `node_modules/${name}`, modules: 1, renderedBytes: 9 });

/** One bundled MIT package in the webview, one build-only package in the root. */
function baseInputs(): Inputs {
  return {
    graphs: {
      host: graph('host'),
      webview: graph('webview', { packages: [bundled('alpha')] })
    },
    locks: {
      root: lockOf({ 'node_modules/tooling': { version: '3.0.0', dev: true, license: 'MIT' } }),
      'webview-ui': lockOf({ 'node_modules/alpha': { version: '1.2.3', dev: true, license: 'MIT' } })
    },
    manifests: {
      root: { name: 'schegent', version: '0.2.0', license: 'MIT' },
      'webview-ui': { name: 'webview-ui', version: '0.2.0' }
    }
  };
}

/** A reader over a fixed map of package directory to its top-level files. */
function fakeReader(files: Record<string, Record<string, string>>) {
  const read: string[] = [];
  const byDir = new Map(Object.entries(files));
  const reader = (dir: string) => {
    const entries = byDir.get(dir);
    if (entries === undefined) return null;
    const byName = new Map(Object.entries(entries));
    return {
      names: [...byName.keys()],
      read: (name: string) => {
        read.push(`${dir}/${name}`);
        const text = byName.get(name);
        if (text === undefined) throw new Error(`no file ${dir}/${name}`);
        return text;
      }
    };
  };
  return { reader, read };
}

/**
 * The fake reader's directory keys and an unmapped module's label. They are joined rather than
 * written as one quoted literal because `tests/lint/lint-anchor-grounding.test.ts` reads a quoted
 * `webview-ui/` or `src/` literal in this directory as a claim that the path exists, and these
 * name synthetic packages and modules that never do.
 */
const installed = (name: string) => posix.join('webview-ui', 'node_modules', name);
const GENERATED_LABEL = posix.join('src', 'generated.js');

const ALPHA_FILES = { [installed('alpha')]: { LICENSE: MIT_TEXT, 'package.json': '{}' } };

async function collect(inputs: Inputs, files: Record<string, Record<string, string>>) {
  const { collectNotices, buildSbom } = await loadNotices();
  const sbom = buildSbom({ ...inputs, now: NOW } as unknown as Parameters<typeof buildSbom>[0]);
  const { reader } = fakeReader(files);
  return collectNotices({
    sbom,
    graphs: inputs.graphs,
    locks: inputs.locks,
    readPackageFiles: reader
  } as unknown as Parameters<typeof collectNotices>[0]);
}

describe('collectNotices', () => {
  it('(a) lists a bundled MIT package once, with its id and its license text', async () => {
    const result = await collect(baseInputs(), ALPHA_FILES);
    expect(result.problems).toEqual([]);
    expect(result.notices).toHaveLength(1);
    const alpha = result.notices.find((notice) => notice.name === 'alpha');
    expect(alpha?.version).toBe('1.2.3');
    expect(alpha?.license).toBe('MIT');
    expect(alpha?.trees).toEqual(['webview']);
    expect(alpha?.text).toBe(MIT_TEXT);
  });

  it('(b) lists a package bundled in both graphs once, in both trees', async () => {
    const inputs = baseInputs();
    inputs.graphs.host = graph('host', { packages: [bundled('alpha')] });
    inputs.locks['root'] = lockOf({ 'node_modules/alpha': { version: '1.2.3', dev: true, license: 'MIT' } });
    const result = await collect(inputs, {
      ...ALPHA_FILES,
      'node_modules/alpha': { 'LICENSE.md': MIT_TEXT }
    });
    expect(result.problems).toEqual([]);
    expect(result.notices.map((notice) => notice.name)).toEqual(['alpha']);
    expect(result.notices.at(0)?.trees).toEqual(['host', 'webview']);
  });

  it('(c) does not list a build-only package', async () => {
    const result = await collect(baseInputs(), ALPHA_FILES);
    expect(result.notices.map((notice) => notice.name)).not.toContain('tooling');
  });

  it('(d) fails a bundled package with no license id, naming it', async () => {
    const inputs = baseInputs();
    inputs.locks['webview-ui'] = lockOf({ 'node_modules/alpha': { version: '1.2.3', dev: true } });
    const result = await collect(inputs, ALPHA_FILES);
    expect(result.problems).toEqual([{ subject: 'alpha@1.2.3', reason: 'no-license-id' }]);
  });

  it('(e) fails a bundled package with no license file', async () => {
    const result = await collect(baseInputs(), {
      [installed('alpha')]: { 'package.json': '{}', 'README.md': 'MIT' }
    });
    expect(result.problems).toEqual([{ subject: 'alpha@1.2.3', reason: 'no-license-text' }]);
  });

  it('(e) fails a bundled package whose license file is empty or whitespace (review S6)', async () => {
    const result = await collect(baseInputs(), {
      [installed('alpha')]: { LICENSE: ' \n\t\n', 'package.json': '{}' }
    });
    expect(result.problems).toEqual([{ subject: 'alpha@1.2.3', reason: 'no-license-text' }]);
  });

  it('(e) also fails a bundled package whose directory is not installed', async () => {
    const result = await collect(baseInputs(), {});
    expect(result.problems).toEqual([{ subject: 'alpha@1.2.3', reason: 'no-license-text' }]);
  });

  it('(f) attributes a virtual module to the locked package its label names', async () => {
    const inputs = baseInputs();
    inputs.graphs.webview = graph('webview', {
      packages: [bundled('alpha')],
      unmapped: [{ label: 'bundler/helper.js', reason: 'virtual' }]
    });
    inputs.locks['webview-ui'] = lockOf({
      'node_modules/alpha': { version: '1.2.3', dev: true, license: 'MIT' },
      'node_modules/bundler': { version: '7.1.0', dev: true, license: 'MIT' }
    });
    const result = await collect(inputs, {
      ...ALPHA_FILES,
      [installed('bundler')]: { 'LICENSE.md': 'bundler license\n' }
    });
    expect(result.problems).toEqual([]);
    const attributed = result.notices.find((notice) => notice.name === 'bundler');
    expect(attributed?.version).toBe('7.1.0');
    expect(attributed?.trees).toEqual(['webview']);
    expect(attributed?.includes).toEqual(['bundler/helper.js']);
    expect(attributed?.text).toBe('bundler license\n');
  });

  it('(f) attributes a scoped label by its first two segments', async () => {
    const inputs = baseInputs();
    inputs.graphs.webview = graph('webview', {
      packages: [bundled('alpha')],
      unmapped: [{ label: '@scope/kit/inject.js', reason: 'virtual' }]
    });
    inputs.locks['webview-ui'] = lockOf({
      'node_modules/alpha': { version: '1.2.3', dev: true, license: 'MIT' },
      'node_modules/@scope/kit': { version: '2.0.0', dev: true, license: 'Apache-2.0' }
    });
    const result = await collect(inputs, {
      ...ALPHA_FILES,
      [installed('@scope/kit')]: { LICENSE: 'apache\n', NOTICE: 'notice\n' }
    });
    expect(result.problems).toEqual([]);
    const kit = result.notices.find((notice) => notice.name === '@scope/kit');
    expect(kit?.license).toBe('Apache-2.0');
    expect(kit?.text).toBe('apache\n\nnotice\n');
  });

  it('(g) fails a virtual label that names no locked package, and any other unmapped module', async () => {
    const inputs = baseInputs();
    inputs.graphs.webview = graph('webview', {
      packages: [bundled('alpha')],
      unmapped: [
        { label: 'nowhere/x.js', reason: 'virtual' },
        { label: GENERATED_LABEL, reason: 'no-lock-entry' }
      ]
    });
    const result = await collect(inputs, ALPHA_FILES);
    expect(result.problems).toEqual([
      { subject: 'nowhere/x.js', reason: 'unattributed-module' },
      { subject: GENERATED_LABEL, reason: 'unattributed-module' }
    ]);
  });

  it('(h) reports every problem, not only the first', async () => {
    const inputs = baseInputs();
    inputs.graphs.webview = graph('webview', {
      packages: [bundled('alpha'), bundled('beta')],
      unmapped: [{ label: 'nowhere/x.js', reason: 'virtual' }]
    });
    inputs.locks['webview-ui'] = lockOf({
      'node_modules/alpha': { version: '1.2.3', dev: true },
      'node_modules/beta': { version: '0.1.0', dev: true, license: 'ISC' }
    });
    const result = await collect(inputs, ALPHA_FILES);
    expect(result.problems).toEqual([
      { subject: 'alpha@1.2.3', reason: 'no-license-id' },
      { subject: 'beta@0.1.0', reason: 'no-license-text' },
      { subject: 'nowhere/x.js', reason: 'unattributed-module' }
    ]);
  });

  it('(i) sorts the sections by package name', async () => {
    const inputs = baseInputs();
    inputs.graphs.webview = graph('webview', { packages: [bundled('zeta'), bundled('alpha')] });
    inputs.locks['webview-ui'] = lockOf({
      'node_modules/zeta': { version: '9.0.0', dev: true, license: 'MIT' },
      'node_modules/alpha': { version: '1.2.3', dev: true, license: 'MIT' }
    });
    const result = await collect(inputs, {
      ...ALPHA_FILES,
      [installed('zeta')]: { 'license.txt': 'zeta\n' }
    });
    expect(result.problems).toEqual([]);
    expect(result.notices.map((notice) => notice.name)).toEqual(['alpha', 'zeta']);
  });

  it('takes the license file by the name rule only: LICENSE, LICENCE or COPYING, then NOTICE', async () => {
    const result = await collect(baseInputs(), {
      [installed('alpha')]: {
        'LICENSE-NOT-A-MATCH': 'wrong\n',
        COPYING: 'copying\n',
        'NOTICE.md': 'notice\n'
      }
    });
    expect(result.problems).toEqual([]);
    expect(result.notices.at(0)?.text).toBe('copying\n\nnotice\n');
  });
});

describe('renderNotices', () => {
  it('writes the header, then one section per package, in the order given', async () => {
    const { renderNotices } = await loadNotices();
    const text = renderNotices({
      now: NOW,
      build: { commit: COMMIT, dirty: false },
      notices: [
        { name: 'alpha', version: '1.2.3', license: 'MIT', trees: ['webview'], includes: [], text: MIT_TEXT },
        {
          name: 'bundler',
          version: '7.1.0',
          license: 'MIT',
          trees: ['host', 'webview'],
          includes: ['bundler/helper.js'],
          text: 'x\n'
        }
      ]
    });
    expect(text.startsWith('# Third-party notices\n')).toBe(true);
    expect(text).toContain(`Generated ${NOW} from the module graphs at build ${COMMIT}.`);
    expect(text).toContain('Build-only packages are not listed.');
    expect(text.indexOf('## alpha 1.2.3')).toBeLessThan(text.indexOf('## bundler 7.1.0'));
    expect(text).toContain('- License: MIT\n- Bundled in: host, webview\n- Includes: bundler/helper.js\n');
    expect(text).not.toContain('- Includes: \n');
    expect(text).toContain('```text\nMIT License\n');
  });

  it('marks a dirty build, and fences a text that itself contains a fence', async () => {
    const { renderNotices } = await loadNotices();
    const text = renderNotices({
      now: NOW,
      build: { commit: COMMIT, dirty: true },
      notices: [
        { name: 'alpha', version: '1', license: 'MIT', trees: ['webview'], includes: [], text: 'a\n```\nb\n' }
      ]
    });
    expect(text).toContain(`at build ${COMMIT} (dirty)`);
    expect(text).toContain('````text\na\n```\nb\n````\n');
  });
});

describe('writeNotices', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('refuses with the SBOM reader message when the build has not run, and writes nothing', async () => {
    const { writeNotices, NOTICES_BASENAME } = await loadNotices();
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'notices-')));
    made.push(root);
    expect(() => writeNotices(root)).toThrow(/run `npm run build`/);
    expect(existsSync(join(root, NOTICES_BASENAME))).toBe(false);
  });

  it('names the notices file THIRD-PARTY-NOTICES.md', async () => {
    const { NOTICES_BASENAME } = await loadNotices();
    expect(NOTICES_BASENAME).toBe('THIRD-PARTY-NOTICES.md');
  });
});

describe('packageFileReader (review S4, S5)', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A root with one package directory holding a real LICENSE, a link to a file outside it, and a broken link. */
  function fixtureRoot(): { root: string; pkg: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'notices-reader-')));
    made.push(root);
    const pkg = posix.join('node_modules', 'alpha');
    mkdirSync(join(root, pkg), { recursive: true });
    writeFileSync(join(root, pkg, 'LICENSE'), MIT_TEXT);
    writeFileSync(join(root, 'outside.txt'), 'not a license');
    symlinkSync(join(root, 'outside.txt'), join(root, pkg, 'NOTICE'));
    symlinkSync(join(root, 'missing.txt'), join(root, pkg, 'NOTICE.md'));
    return { root, pkg };
  }

  it('lists only regular files: a symbolic link is skipped, and a broken one does not throw', async () => {
    const { packageFileReader } = await loadNotices();
    const { root, pkg } = fixtureRoot();
    const files = packageFileReader(root)(pkg);
    expect(files?.names).toEqual(['LICENSE']);
    expect(files?.read('LICENSE')).toBe(MIT_TEXT);
  });

  it('refuses a package directory outside node_modules or with a parent segment', async () => {
    const { packageFileReader } = await loadNotices();
    const { root } = fixtureRoot();
    const read = packageFileReader(root);
    expect(read(posix.join('node_modules', '..', '..'))).toBeNull();
    expect(read('.')).toBeNull();
  });
});

describe('NoticesError', () => {
  it('lists every problem in its message, one per line', async () => {
    const { NoticesError } = await loadNotices();
    const error = new NoticesError([
      { subject: 'alpha@1.2.3', reason: 'no-license-id' },
      { subject: 'nowhere/x.js', reason: 'unattributed-module' }
    ]);
    expect(error.problems).toHaveLength(2);
    expect(error.message).toContain('notices: alpha@1.2.3: no-license-id');
    expect(error.message).toContain('notices: nowhere/x.js: unattributed-module');
  });
});
