import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * FR-R4-F09 (FR-030, FR-031; contract GR2, data-model section 9; test T8) -- what a gate record
 * says it observed about the environment the gate ran in.
 *
 * Version 2 of the record said where and when the gate ran and nothing about WHAT it ran on: not
 * which Node the repository declares beside the one that ran, not whether the planning envelope
 * above the checkout was present (so whether the envelope-reading gates ran at all), and not
 * which lockfile and which installed tree each tree was gated on. `observeGateEnvironment` is that
 * observation, taken once before the gate is spawned. It describes and never decides: a Node
 * mismatch, a standalone clone and an install that differs are all recorded and none refuses.
 *
 * The filesystem and the envelope predicate are injected, so every case is a map of paths to
 * bytes. The hidden-lockfile rule is the heart of it and gets the most cases: npm's hidden
 * lockfile omits the platform packages that do not apply here, so a lock entry missing from it is
 * a difference only when it is not optional. Loaded dynamically for the same TS1479 reason its
 * siblings record.
 */
async function loadObservation() {
  return import('../../../scripts/gate-observation.mjs');
}
async function loadDigest() {
  return import('../../../scripts/release-digest.mjs');
}

const ROOT = '/work/repo';
const NODE = 'v24.19.0';

type Files = Map<string, Buffer>;
type LockPackages = Record<string, { version?: string; optional?: boolean }>;

const at = (relativePath: string) => join(ROOT, relativePath);
/** Built from parts: the path exists only where the webview tree is installed. */
const WEBVIEW_HIDDEN = ['webview-ui', 'node_modules', '.package-lock.json'].join('/');
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const lockOf = (packages: LockPackages) => json({ lockfileVersion: 3, packages: { '': {}, ...packages } });
const hiddenOf = (packages: LockPackages) => json({ lockfileVersion: 3, packages });

const SAME: LockPackages = {
  'node_modules/a': { version: '1.0.0' },
  'node_modules/b': { version: '2.0.0' }
};

/** A repository whose two trees install exactly what their lockfiles say. */
function agreeing(): Files {
  const files: Files = new Map();
  files.set(at('.nvmrc'), Buffer.from('24.19.0\n'));
  files.set(at('package-lock.json'), lockOf(SAME));
  files.set(at('node_modules/.package-lock.json'), hiddenOf(SAME));
  files.set(at('webview-ui/package-lock.json'), lockOf(SAME));
  files.set(at(WEBVIEW_HIDDEN), hiddenOf(SAME));
  return files;
}

async function observe(
  files: Files,
  over: { envelope?: boolean; nodeVersion?: string; reads?: string[] } = {}
) {
  const { observeGateEnvironment } = await loadObservation();
  return observeGateEnvironment({
    root: ROOT,
    readFile: (path: string) => {
      over.reads?.push(path);
      const found = files.get(path);
      if (!found) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return found;
    },
    envelopePresent: () => over.envelope ?? true,
    nodeVersion: over.nodeVersion ?? NODE
  });
}

type Tree = { tree: string; lockfile: string; lockfileSha256: string | null; install: string; installDifferences?: number };
const treeOf = (result: { readonly trees: readonly Tree[] }, name: string): Tree => {
  const found = result.trees.find((entry) => entry.tree === name);
  if (!found) throw new Error(`no tree ${name}`);
  return found;
};

describe('the declared Node (.nvmrc)', () => {
  it('reads the trimmed text and says the running version matches it', async () => {
    const result = await observe(agreeing());
    expect(result.nodeDeclared).toBe('24.19.0');
    expect(result.nodeMatchesDeclared).toBe(true);
  });

  it('says it does not match when the running version differs', async () => {
    const result = await observe(agreeing(), { nodeVersion: 'v24.21.0' });
    expect(result.nodeDeclared).toBe('24.19.0');
    expect(result.nodeMatchesDeclared).toBe(false);
  });

  it('gives null, and no match, when .nvmrc is absent', async () => {
    const files = agreeing();
    files.delete(at('.nvmrc'));
    const result = await observe(files);
    expect(result.nodeDeclared).toBeNull();
    expect(result.nodeMatchesDeclared).toBe(false);
  });

  it.each([
    ['empty', Buffer.alloc(0)],
    ['only whitespace', Buffer.from(' \n\t\n')],
    ['over 64 bytes', Buffer.from('2'.repeat(65))]
  ])('gives null, and no match, when .nvmrc is %s', async (_label, bytes) => {
    const files = agreeing();
    files.set(at('.nvmrc'), bytes);
    const result = await observe(files);
    expect(result.nodeDeclared).toBeNull();
    expect(result.nodeMatchesDeclared).toBe(false);
  });

  it('accepts a file of exactly 64 bytes', async () => {
    const files = agreeing();
    files.set(at('.nvmrc'), Buffer.from('2'.repeat(64)));
    expect((await observe(files)).nodeDeclared).toBe('2'.repeat(64));
  });
});

describe('the envelope', () => {
  it.each([true, false])('records the predicate\'s answer, %s, and nothing more', async (present) => {
    expect((await observe(agreeing(), { envelope: present })).envelope).toEqual({ present });
  });

  it('asks the predicate once', async () => {
    const { observeGateEnvironment } = await loadObservation();
    let asked = 0;
    observeGateEnvironment({
      root: ROOT,
      readFile: (path: string) => agreeing().get(path) as Buffer,
      envelopePresent: () => {
        asked += 1;
        return true;
      },
      nodeVersion: NODE
    });
    expect(asked).toBe(1);
  });
});

describe('the two trees', () => {
  it('lists exactly root then webview-ui, with repository-relative lockfile paths', async () => {
    const result = await observe(agreeing());
    expect(result.trees.map((entry: Tree) => entry.tree)).toEqual(['root', 'webview-ui']);
    expect(result.trees.map((entry: Tree) => entry.lockfile)).toEqual([
      'package-lock.json',
      'webview-ui/package-lock.json'
    ]);
  });

  it('records the SHA-256 of the lockfile bytes', async () => {
    const { sha256Hex } = await loadDigest();
    const files = agreeing();
    const result = await observe(files);
    expect(treeOf(result, 'root').lockfileSha256).toBe(sha256Hex(files.get(at('package-lock.json')) as Buffer));
    expect(treeOf(result, 'webview-ui').lockfileSha256).toBe(
      sha256Hex(files.get(at('webview-ui/package-lock.json')) as Buffer)
    );
  });

  it('names no absolute path anywhere in what it returns', async () => {
    expect(JSON.stringify(await observe(agreeing()))).not.toContain(ROOT);
  });

  it('keeps its fields in the order the record is written', async () => {
    const result = await observe(agreeing());
    expect(Object.keys(result)).toEqual(['nodeDeclared', 'nodeMatchesDeclared', 'envelope', 'trees']);
    expect(Object.keys(treeOf(result, 'root'))).toEqual(['tree', 'lockfile', 'lockfileSha256', 'install']);
  });
});

describe('the hidden-lockfile rule (research R16)', () => {
  it('matches when the hidden lockfile omits only entries the lock marks optional', async () => {
    const files = agreeing();
    files.set(
      at('package-lock.json'),
      lockOf({ ...SAME, 'node_modules/@esbuild/linux-x64': { version: '0.28.2', optional: true } })
    );
    const root = treeOf(await observe(files), 'root');
    expect(root.install).toBe('matches');
    expect(root).not.toHaveProperty('installDifferences');
  });

  it('differs, with a count, when the hidden lockfile has a key the lock does not', async () => {
    const files = agreeing();
    files.set(at('node_modules/.package-lock.json'), hiddenOf({ ...SAME, 'node_modules/stray': { version: '1.0.0' } }));
    const root = treeOf(await observe(files), 'root');
    expect(root.install).toBe('differs');
    expect(root.installDifferences).toBe(1);
  });

  it('differs when a shared key has another version', async () => {
    const files = agreeing();
    files.set(
      at(WEBVIEW_HIDDEN),
      hiddenOf({ ...SAME, 'node_modules/a': { version: '1.0.1' } })
    );
    const webview = treeOf(await observe(files), 'webview-ui');
    expect(webview.install).toBe('differs');
    expect(webview.installDifferences).toBe(1);
  });

  it('differs when the hidden lockfile lacks an entry the lock does not mark optional', async () => {
    const files = agreeing();
    files.set(at('node_modules/.package-lock.json'), hiddenOf({ 'node_modules/a': { version: '1.0.0' } }));
    const root = treeOf(await observe(files), 'root');
    expect(root.install).toBe('differs');
    expect(root.installDifferences).toBe(1);
  });

  it('counts every kind of difference once', async () => {
    const files = agreeing();
    files.set(
      at('package-lock.json'),
      lockOf({ ...SAME, 'node_modules/c': { version: '3.0.0' }, 'node_modules/d': { version: '4.0.0', optional: true } })
    );
    files.set(
      at('node_modules/.package-lock.json'),
      hiddenOf({ 'node_modules/a': { version: '9.9.9' }, 'node_modules/b': { version: '2.0.0' }, 'node_modules/extra': { version: '1.0.0' } })
    );
    // a: version; c: missing and not optional; extra: only in the hidden lockfile. d is optional.
    expect(treeOf(await observe(files), 'root').installDifferences).toBe(3);
  });

  it('is absent when there is no hidden lockfile', async () => {
    const files = agreeing();
    files.delete(at('node_modules/.package-lock.json'));
    const root = treeOf(await observe(files), 'root');
    expect(root.install).toBe('absent');
    expect(root.lockfileSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is unreadable when the hidden lockfile is not JSON', async () => {
    const files = agreeing();
    files.set(at('node_modules/.package-lock.json'), Buffer.from('{ not json'));
    const root = treeOf(await observe(files), 'root');
    expect(root.install).toBe('unreadable');
    expect(root.lockfileSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is unreadable, with no digest, when the lockfile itself cannot be read', async () => {
    const files = agreeing();
    files.delete(at('package-lock.json'));
    const root = treeOf(await observe(files), 'root');
    expect(root.install).toBe('unreadable');
    expect(root.lockfileSha256).toBeNull();
  });

  it('judges each tree on its own files', async () => {
    const files = agreeing();
    files.delete(at(WEBVIEW_HIDDEN));
    const result = await observe(files);
    expect(treeOf(result, 'root').install).toBe('matches');
    expect(treeOf(result, 'webview-ui').install).toBe('absent');
  });
});

describe('what it reads', () => {
  it('reads only .nvmrc, the two lockfiles and the two hidden lockfiles, under the root', async () => {
    const reads: string[] = [];
    await observe(agreeing(), { reads });
    expect([...reads].sort()).toEqual(
      [
        '.nvmrc',
        'package-lock.json',
        'node_modules/.package-lock.json',
        'webview-ui/package-lock.json',
        WEBVIEW_HIDDEN
      ]
        .map(at)
        .sort()
    );
  });
});
