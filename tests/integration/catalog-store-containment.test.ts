// Feature 099 (FR-R3-015) T496l — no workspace root escapes, and nothing escapes
// the store (FR-061, SC-012, and the containment oracle of FR-R3-005).
//
// Two halves, and they are opposite directions of the same boundary:
//
//   1. **Nothing about the root comes out.** No record on disk and no value the
//      store returns may carry a workspace root. The unit suites assert this
//      against a fake whose "paths" are `join('/')` of segments, where the claim is
//      close to a tautology. Here the store is rooted at a real absolute path that
//      the test knows the text of, so "that string appears nowhere" is a real
//      assertion with something to find.
//   2. **Nothing gets out through the adapter.** The core is segment-addressed and
//      provably never builds an escaping segment (`tests/unit/catalog/id-legality.test.ts`),
//      so the adapter's containment check guards against the case that test cannot
//      reach: a store directory that has been tampered with. A cloned repository can
//      contain a `.schegent/catalog/` with a symlink in it, and a symlink is a hop
//      no lexical join can see — which is why containment resolves rather than
//      compares, and why this half needs a real filesystem to mean anything.
//
// **Every** call proves containment, reads included. A read is non-destructive in
// the direction that matters least: `readFile` follows the leaf, so a record
// planted as a link to a file outside the workspace puts that file's contents into
// the Builder, and `listDirectory` through a linked directory reports names from
// outside the store as records to collect. Neither is reachable from the core,
// which cannot build an escaping segment — both are reachable from a cloned
// repository, which is the threat this file is about.

import { chmod, lstat, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CatalogStore } from '../../src/catalog';
import type { CatalogKind } from '../../src/contracts/catalog-store';
import { createCatalogFsAdapter } from '../../src/lib/catalog-fs-adapter';
import {
  createWorkspace,
  openStore,
  pathVariants,
  removeWorkspace,
  storeRootOf,
  treeOf
} from '../fixtures/catalog-real-fs';

/** The adapter's own errno for a refused resolution. Not exported: pinned by value. */
const CONTAINMENT_ERRNO = 'ESCHEGENTCONTAINMENT';

async function revisionOf(store: CatalogStore, kind: CatalogKind): Promise<string> {
  const result = await store.read();
  if (result.outcome !== 'read') throw new Error(`store unreadable: ${result.fault.fault}`);
  return result.snapshot.revisions[kind];
}

/** Every save, read, and listing the store offers, over a populated store. */
async function exerciseEverything(
  store: CatalogStore,
  workspaceRoot: string
): Promise<readonly unknown[]> {
  const seen: unknown[] = [];

  for (const kind of ['phase', 'pipeline', 'workflow'] as const) {
    seen.push(
      await store.save({
        kind,
        id: 'implement',
        body: { name: 'Implement', order: 1 },
        expectedRevision: await revisionOf(store, kind)
      })
    );
  }

  // A save that refuses, one that is unchanged, and one that prunes: the refusal
  // arms are the ones most likely to reach for a path when explaining themselves.
  seen.push(
    await store.save({
      kind: 'phase',
      id: 'Illegal Id',
      body: { n: 1 },
      expectedRevision: await revisionOf(store, 'phase')
    })
  );
  seen.push(
    await store.save({
      kind: 'phase',
      id: 'implement',
      body: { order: 1, name: 'Implement' },
      expectedRevision: await revisionOf(store, 'phase')
    })
  );
  seen.push(
    await store.save({
      kind: 'phase',
      id: 'implement',
      body: { n: 1 },
      expectedRevision: 'a revision nobody has'
    })
  );
  for (let n = 2; n <= 52; n += 1) {
    await store.save({
      kind: 'phase',
      id: 'implement',
      body: { n },
      expectedRevision: await revisionOf(store, 'phase')
    });
  }
  seen.push(
    await store.saveLayer({
      kind: 'workflow',
      definitions: [{ id: 'implement', body: { n: 2 } }, { id: 'review', body: { n: 1 } }],
      expectedRevision: await revisionOf(store, 'workflow')
    })
  );

  seen.push(await store.read());
  seen.push(await store.readVersion('phase', 'implement', 'v10'));
  seen.push(await store.readVersion('phase', 'implement', 'v1'));
  seen.push(await store.readVersion('phase', 'absent', 'v1'));
  seen.push(await store.listVersions('phase', 'implement'));
  for (const kind of ['phase', 'pipeline', 'workflow'] as const) {
    seen.push(await store.listDefinitions(kind));
  }

  // The exercise must have exercised something, or every assertion below is vacuous.
  const tree = await treeOf(storeRootOf(workspaceRoot));
  expect(tree.files.length).toBeGreaterThan(50);
  return seen;
}

describe('Feature 099 — no workspace root leaves the store (T496l)', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await createWorkspace('containment');
  });

  afterEach(async () => {
    await removeWorkspace(workspaceRoot);
  });

  it('writes no path into any file, and returns none from any call', async () => {
    const store = openStore(workspaceRoot);
    const outcomes = await exerciseEverything(store, workspaceRoot);
    const forbidden = [
      ...pathVariants(workspaceRoot),
      ...pathVariants(storeRootOf(workspaceRoot)),
      ...pathVariants(dirname(workspaceRoot)),
      '.schegent'
    ];

    const storeRoot = storeRootOf(workspaceRoot);
    for (const relative of (await treeOf(storeRoot)).files) {
      const contents = await readFile(join(storeRoot, ...relative.split('/')), 'utf8');
      for (const needle of forbidden) {
        expect(contents, `${relative} carries ${needle}`).not.toContain(needle);
      }
    }

    for (const outcome of outcomes) {
      const rendered = JSON.stringify(outcome) ?? '';
      for (const needle of forbidden) {
        expect(rendered, `an outcome carries ${needle}`).not.toContain(needle);
      }
      // Stronger than "no root": no separator at all. A returned value that holds
      // no separator cannot hold a path, whatever the root happens to be — which
      // is the property FR-061 is really after, and it survives being run from a
      // different directory.
      expect(rendered).not.toMatch(/[/\\]/);
    }
  });

  it('names no path when it refuses a store it cannot write', async () => {
    // FR-033b, and the refusal most likely to want to explain *which* path. Skipped
    // for root, for whom a mode of 0o500 is not a restriction.
    if (process.getuid?.() === 0) return;

    const store = openStore(workspaceRoot);
    await store.save({
      kind: 'phase',
      id: 'implement',
      body: { n: 1 },
      expectedRevision: await revisionOf(store, 'phase')
    });

    const storeRoot = storeRootOf(workspaceRoot);
    await chmod(storeRoot, 0o500);
    try {
      const outcome = await store.save({
        kind: 'phase',
        id: 'implement',
        body: { n: 2 },
        expectedRevision: await revisionOf(store, 'phase')
      });
      expect(outcome).toEqual({ outcome: 'refused', reason: 'not-writable' });
      expect(JSON.stringify(outcome)).not.toMatch(/[/\\]/);
    } finally {
      await chmod(storeRoot, 0o700);
    }
  });
});

describe('Feature 099 — nothing escapes the store directory (T496l)', () => {
  let workspaceRoot: string;
  /** A file outside the store, next to it, that no store operation may touch. */
  let outsidePath: string;

  beforeEach(async () => {
    workspaceRoot = await createWorkspace('escape');
    outsidePath = join(workspaceRoot, 'outside.json');
    await writeFile(outsidePath, '{"untouched":true}');
  });

  afterEach(async () => {
    await removeWorkspace(workspaceRoot);
  });

  it('refuses a write whose segments climb out, and creates nothing outside', async () => {
    // These segments cannot come from the core — that is what `id-legality.test.ts`
    // proves. The adapter refuses them anyway, because the core is not the only
    // thing that could ever call it and a lexical join would happily produce this
    // path.
    const adapter = createCatalogFsAdapter(storeRootOf(workspaceRoot));

    expect(await adapter.writeFileAtomic(['..', '..', 'escape.json'], '{}')).toEqual({
      outcome: 'failed',
      errno: CONTAINMENT_ERRNO
    });
    expect(await adapter.writeFileIfAbsent(['..', '..', 'escape.json'], '{}')).toEqual({
      outcome: 'failed',
      errno: CONTAINMENT_ERRNO
    });

    // The store's own directory is created — `ensureParent` creates the anchor it
    // measures containment against, as every save's writability check already does
    // — but the directory the write was aimed at is not, because that one is
    // proven first. Both halves are pinned: a refused write may leave the store
    // root and nothing else.
    expect(await treeOf(workspaceRoot)).toEqual({
      files: ['outside.json'],
      directories: ['.schegent', '.schegent/catalog']
    });
    expect(await readFile(outsidePath, 'utf8')).toBe('{"untouched":true}');
  });

  it('refuses an unlink that climbs out, and leaves the file it aimed at', async () => {
    // The only destructive call the store makes is retention's prune. An escaping
    // unlink is the one that costs something that cannot be undone, so it is
    // refused before the syscall rather than reported after it.
    const adapter = createCatalogFsAdapter(storeRootOf(workspaceRoot));

    expect(await adapter.removeFile(['..', '..', 'outside.json'])).toEqual({
      outcome: 'failed',
      errno: CONTAINMENT_ERRNO
    });

    expect(await readFile(outsidePath, 'utf8')).toBe('{"untouched":true}');
  });

  it('refuses to write through a symlinked directory planted in the store', async () => {
    // The case a lexical containment check cannot see, and the reason the oracle
    // resolves instead: every segment here is legal, the joined path is inside the
    // store, and the write would still land outside it. A cloned repository is
    // enough to arrange this, which is why it is a security boundary and not a
    // tidiness one.
    const storeRoot = storeRootOf(workspaceRoot);
    const escapeTarget = join(workspaceRoot, 'elsewhere');
    await mkdir(join(storeRoot, 'phases'), { recursive: true });
    await mkdir(escapeTarget, { recursive: true });
    await symlink(escapeTarget, join(storeRoot, 'phases', 'evil'));

    const adapter = createCatalogFsAdapter(storeRoot);
    expect(await adapter.writeFileIfAbsent(['phases', 'evil', 'v1.json'], '{}')).toEqual({
      outcome: 'failed',
      errno: CONTAINMENT_ERRNO
    });
    expect(await adapter.writeFileAtomic(['phases', 'evil', 'v1.json'], '{}')).toEqual({
      outcome: 'failed',
      errno: CONTAINMENT_ERRNO
    });
    expect(await adapter.removeFile(['phases', 'evil', 'v1.json'])).toEqual({
      outcome: 'failed',
      errno: CONTAINMENT_ERRNO
    });

    expect((await treeOf(escapeTarget)).files).toEqual([]);
  });

  it('creates no directory through a symlinked kind directory planted in the store', async () => {
    // The same plant one level up, and the case the test above cannot see. There
    // the link is the *definition* directory and it already exists, so the
    // `mkdir -p` that precedes the containment check has nothing to create and the
    // only observable effect is the refused write. Here the link is the *kind*
    // directory and the definition below it is new — which is the ordinary shape of
    // the very first save into a freshly cloned repository — so `mkdir -p` has a
    // component to create, and `mkdir` follows symlinks.
    //
    // The write is refused either way. What this asserts is that nothing is
    // *created* either: a directory appearing at an attacker-chosen path is a real
    // effect, it is the effect an operator would never look for after being told
    // the save failed, and this module's own header claims to be "the single place
    // the containment oracle has to be consulted" — so no syscall in it may run
    // ahead of the oracle.
    const storeRoot = storeRootOf(workspaceRoot);
    const escapeTarget = join(workspaceRoot, 'elsewhere');
    await mkdir(storeRoot, { recursive: true });
    await mkdir(escapeTarget, { recursive: true });
    await symlink(escapeTarget, join(storeRoot, 'phases'));

    const adapter = createCatalogFsAdapter(storeRoot);
    expect(await adapter.writeFileAtomic(['phases', 'fresh', 'v1.json'], '{}')).toEqual({
      outcome: 'failed',
      errno: CONTAINMENT_ERRNO
    });
    expect(await adapter.writeFileIfAbsent(['phases', 'fresh', 'v1.json'], '{}')).toEqual({
      outcome: 'failed',
      errno: CONTAINMENT_ERRNO
    });

    const outside = await treeOf(escapeTarget);
    expect(outside.directories).toEqual([]);
    expect(outside.files).toEqual([]);
  });

  it('refuses to read a record through a link that leaves the store', async () => {
    // The read path's own escape. What the link names here is a byte-for-byte copy
    // of the record it replaced, so it parses, and its hash matches: nothing about
    // the *content* can tell this apart from a healthy store, and only containment
    // can. That is the point — the guard has to be structural, because the
    // interesting version of this attack points the link at a file that happens to
    // be valid JSON and reads it into the Builder.
    const storeRoot = storeRootOf(workspaceRoot);
    const store = openStore(workspaceRoot);
    await store.save({
      kind: 'phase',
      id: 'implement',
      body: { n: 1 },
      expectedRevision: await revisionOf(store, 'phase')
    });

    const recordPath = join(storeRoot, 'phases', 'implement', 'v1.json');
    const elsewhere = join(workspaceRoot, 'elsewhere.json');
    await rename(recordPath, elsewhere);
    await symlink(elsewhere, recordPath);

    const result = await store.read();
    expect(result.outcome).toBe('read');
    if (result.outcome !== 'read') return;
    expect(result.snapshot.faults).toEqual([
      { fault: 'unreadable-store', errno: CONTAINMENT_ERRNO }
    ]);
    // Reported as unreadable, and reported without the body: a refused read must
    // not degrade to "read it anyway and mark it suspect".
    expect(result.snapshot.definitions).toMatchObject([{ id: 'implement', status: 'invalid', body: null }]);
  });

  it('lists nothing through a symlinked definition directory', async () => {
    // `listDirectory` is the integrity scan's eye, and what it reports is what a
    // later feature's clean-up would act on. A linked directory would have it
    // reporting files outside the store as collectable records.
    const storeRoot = storeRootOf(workspaceRoot);
    const store = openStore(workspaceRoot);
    await store.save({
      kind: 'phase',
      id: 'implement',
      body: { n: 1 },
      expectedRevision: await revisionOf(store, 'phase')
    });

    const outsideDirectory = join(workspaceRoot, 'elsewhere');
    await mkdir(outsideDirectory, { recursive: true });
    await writeFile(join(outsideDirectory, 'v1.json'), '{}');
    await symlink(outsideDirectory, join(storeRoot, 'phases', 'evil'));

    const result = await store.read();
    expect(result.outcome).toBe('read');
    if (result.outcome !== 'read') return;
    expect(result.snapshot.collectable).toEqual([]);
    expect(result.snapshot.definitions).toMatchObject([{ id: 'implement', status: 'effective' }]);
  });

  it('refuses to read a manifest planted as a link out of the store', async () => {
    // Both forms of the check meet on this one file. The **target** form refuses to
    // *read* through the link, so nothing outside the store is ever parsed as a
    // manifest — even when what is there is a perfectly good one, tested below,
    // because the alternative is a manifest an operator cannot see governing a
    // catalog they can. The **link** form is what would have governed the write,
    // and it never gets a turn: a store that cannot be read is not written (FR-031).
    const storeRoot = storeRootOf(workspaceRoot);
    await mkdir(storeRoot, { recursive: true });
    await symlink(outsidePath, join(storeRoot, 'manifest.json'));

    const store = openStore(workspaceRoot);
    expect(await store.read()).toEqual({
      outcome: 'unavailable',
      fault: { fault: 'unreadable-store', errno: CONTAINMENT_ERRNO }
    });

    const outcome = await store.save({
      kind: 'phase',
      id: 'implement',
      body: { n: 1 },
      expectedRevision: 'whatever the store says'
    });
    expect(outcome).toEqual({ outcome: 'refused', reason: 'store-unreadable' });
    expect(await readFile(outsidePath, 'utf8')).toBe('{"untouched":true}');

    // A *readable* manifest at the link target changes nothing: the refusal is
    // about where the file is, not about what is in it. The link stays a link —
    // nothing was written over it — and the outside file is untouched.
    await writeFile(outsidePath, JSON.stringify({ storeFormatVersion: 1, entries: [] }));
    const stillRefused = await store.save({
      kind: 'phase',
      id: 'implement',
      body: { n: 1 },
      expectedRevision: 'whatever the store says'
    });
    expect(stillRefused).toEqual({ outcome: 'refused', reason: 'store-unreadable' });
    expect(await readFile(outsidePath, 'utf8')).toBe(
      JSON.stringify({ storeFormatVersion: 1, entries: [] })
    );
    expect((await lstat(join(storeRoot, 'manifest.json'))).isSymbolicLink()).toBe(true);
  });
});
