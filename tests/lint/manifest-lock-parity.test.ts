import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * FR-R4-F09 (FR-023, FR-024, SC-006; research R18; contract DP1, test L1) -- each manifest and its
 * lockfile's root agree on what is declared.
 *
 * THE DEFECT. `FR-R3-109` declared two packages in `package.json` and did not regenerate the lock:
 * the manifest listed 22 devDependencies and the lockfile's root entry listed 20. Nothing noticed,
 * because `npm ci` and the gate install from the lockfile's resolved tree, where the packages were
 * already present as transitives, so everything built and ran. What it left was a lockfile that no
 * longer said what the manifest declares, and a declaration whose range no reviewer could trust the
 * lock to honour.
 *
 * WHAT IT PINS. For `root` and for `webview-ui`, the pure comparison returns no disagreement. It
 * compares the two root entries as exact strings, because npm writes the manifest's range into the
 * lock's root entry, so any difference is drift. Over fixture pairs it returns one disagreement of
 * each kind, naming the package and the tree, in a fixed order; that is the control which shows the
 * empty result for the real trees is a measurement and not a function that cannot say otherwise.
 *
 * Hermetic: `readFileSync` and a pure function, no network and no spawn.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');

async function loadParity() {
  return import('../../scripts/manifest-lock-parity.mjs');
}

const readJson = (relativePath: string): unknown =>
  JSON.parse(readFileSync(resolve(REPO_ROOT, relativePath), 'utf8'));

type Manifest = Record<string, unknown>;
type Lock = Record<string, unknown>;

describe('FR-R4-F09 — each manifest and its lockfile root declare the same dependencies: the real trees', () => {
  it('root: package.json and package-lock.json agree', async () => {
    const { manifestLockParity } = await loadParity();
    const disagreements = manifestLockParity({
      tree: 'root',
      manifest: readJson('package.json') as Manifest,
      lock: readJson('package-lock.json') as Lock
    });
    expect(disagreements).toEqual([]);
  });

  it('webview-ui: package.json and package-lock.json agree', async () => {
    const { manifestLockParity } = await loadParity();
    const disagreements = manifestLockParity({
      tree: 'webview-ui',
      manifest: readJson('webview-ui/package.json') as Manifest,
      lock: readJson('webview-ui/package-lock.json') as Lock
    });
    expect(disagreements).toEqual([]);
  });

  it('CONTROL: each real manifest declares something to compare, so an empty result is not vacuous', () => {
    const rootManifest = readJson('package.json') as { devDependencies?: Record<string, string> };
    const webviewManifest = readJson('webview-ui/package.json') as {
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(rootManifest.devDependencies ?? {}).length).toBeGreaterThan(10);
    expect(Object.keys(webviewManifest.devDependencies ?? {}).length).toBeGreaterThan(5);
  });
});

describe('fixture pairs', () => {
  const lockOf = (root: Record<string, unknown>): Lock => ({
    lockfileVersion: 3,
    packages: { '': root }
  });

  it('agrees when the two root entries list the same names and ranges', async () => {
    const { manifestLockParity } = await loadParity();
    const manifest = { dependencies: { a: '^1.0.0' }, devDependencies: { b: '~2.0.0', c: '3.0.0' } };
    const lock = lockOf({ dependencies: { a: '^1.0.0' }, devDependencies: { b: '~2.0.0', c: '3.0.0' } });
    expect(manifestLockParity({ tree: 'root', manifest, lock })).toEqual([]);
  });

  it('reports a declaration the lock root does not list, naming the package and the tree', async () => {
    const { manifestLockParity } = await loadParity();
    const result = manifestLockParity({
      tree: 'webview-ui',
      manifest: { devDependencies: { kept: '^1.0.0', secretlint: '^10.2.2' } },
      lock: lockOf({ devDependencies: { kept: '^1.0.0' } })
    });
    expect(result).toEqual([
      {
        tree: 'webview-ui',
        field: 'devDependencies',
        package: 'secretlint',
        kind: 'missing-from-lock',
        manifestRange: '^10.2.2'
      }
    ]);
  });

  it('reports an entry the lock root lists and the manifest does not', async () => {
    const { manifestLockParity } = await loadParity();
    const result = manifestLockParity({
      tree: 'root',
      manifest: { devDependencies: { kept: '^1.0.0' } },
      lock: lockOf({ devDependencies: { kept: '^1.0.0', leftover: '^4.0.0' } })
    });
    expect(result).toEqual([
      {
        tree: 'root',
        field: 'devDependencies',
        package: 'leftover',
        kind: 'extra-in-lock',
        lockRange: '^4.0.0'
      }
    ]);
  });

  it('reports a range that differs, with both ranges as written', async () => {
    const { manifestLockParity } = await loadParity();
    const result = manifestLockParity({
      tree: 'root',
      manifest: { devDependencies: { drifted: '^13.0.4' } },
      lock: lockOf({ devDependencies: { drifted: '^10.2.2' } })
    });
    expect(result).toEqual([
      {
        tree: 'root',
        field: 'devDependencies',
        package: 'drifted',
        kind: 'range-differs',
        manifestRange: '^13.0.4',
        lockRange: '^10.2.2'
      }
    ]);
  });

  it('treats ranges as exact strings: a range that means the same but is written differently differs', async () => {
    const { manifestLockParity } = await loadParity();
    const result = manifestLockParity({
      tree: 'root',
      manifest: { devDependencies: { same: '1.0.0' } },
      lock: lockOf({ devDependencies: { same: '=1.0.0' } })
    });
    expect(result.map((entry: { kind: string }) => entry.kind)).toEqual(['range-differs']);
  });

  it('reports one disagreement of each kind in one pass, sorted by tree, field, then package', async () => {
    const { manifestLockParity } = await loadParity();
    const result = manifestLockParity({
      tree: 'root',
      manifest: {
        dependencies: { zeta: '^1.0.0' },
        devDependencies: { beta: '^2.0.0', alpha: '^3.0.0', gamma: '^4.0.0' }
      },
      lock: lockOf({
        dependencies: {},
        devDependencies: { beta: '^2.1.0', gamma: '^4.0.0', delta: '^5.0.0' }
      })
    });
    expect(
      result.map(
        (entry: { tree: string; field: string; package: string; kind: string }) =>
          `${entry.tree}/${entry.field}/${entry.package}/${entry.kind}`
      )
    ).toEqual([
      'root/dependencies/zeta/missing-from-lock',
      'root/devDependencies/alpha/missing-from-lock',
      'root/devDependencies/beta/range-differs',
      'root/devDependencies/delta/extra-in-lock'
    ]);
  });

  it('reads a manifest or lock root with no dependency fields as listing none', async () => {
    const { manifestLockParity } = await loadParity();
    expect(manifestLockParity({ tree: 'root', manifest: {}, lock: lockOf({}) })).toEqual([]);
    expect(
      manifestLockParity({ tree: 'root', manifest: { devDependencies: { a: '1' } }, lock: { packages: {} } })
    ).toEqual([
      {
        tree: 'root',
        field: 'devDependencies',
        package: 'a',
        kind: 'missing-from-lock',
        manifestRange: '1'
      }
    ]);
  });
});
