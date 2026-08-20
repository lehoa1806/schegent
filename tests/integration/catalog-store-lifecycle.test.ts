// Feature 099 (FR-R3-015) T496c, T496e, T496i, T496k — the store on a real disk.
//
// Everything here is a claim about bytes that outlive the process: what is on
// disk after a save, what a *second* store reading the same directory cold gets
// back, and what is still there after ten of them. The unit suites assert the
// same algebra against an in-memory port and can say nothing about any of it —
// a fake filesystem has no directories to lazily not create, and "read it back"
// through a fake is a read of the object the test just wrote.
//
// The four claims:
//
//   - **T496e** — a workspace that never saves ends up with *nothing* on disk.
//     Not an empty store: no `.schegent/` directory at all (FR-001a, SC-018).
//   - **T496c** — a definition saved by one window is read back by another,
//     cold, with the layout and the permissions the store promises.
//   - **T496i** — the store validates nothing. A body every validator in the
//     host would reject round-trips byte-identically (FR-010, FR-011).
//   - **T496k** — ten saves make ten versions, monotonic, and every record
//     written along the way is byte-identical at the end (FR-004, FR-005, FR-016).
//
// Feature 100 (T514) — two things moved underneath all four. "A save" is now two
// writes (FR-016): a draft write produces the record, and a publication moves the
// active pointer, so `saveNext` below does both wherever a suite wants a *live*
// definition. And the claim that a save over a definition whose active record is
// missing is refused by name inverted — it is now the **repair** (FR-011a), so the
// last test in this file asserts the repair and the containment that survived it
// rather than a refusal that no longer exists.

import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CatalogStore } from '../../src/catalog';
import type { CatalogKind } from '../../src/contracts/catalog-store';
import {
  createWorkspace,
  draftTokenFor,
  fingerprintOf,
  openStore,
  openStoreWithoutWorkspace,
  readStoreFile,
  readStoreJson,
  removeWorkspace,
  storeRootOf,
  treeOf,
  type Fingerprint
} from '../fixtures/catalog-real-fs';

async function revisionOf(store: CatalogStore, kind: CatalogKind): Promise<string> {
  const result = await store.read();
  if (result.outcome !== 'read') throw new Error(`store unreadable: ${result.fault.fault}`);
  return result.snapshot.revisions[kind];
}

/**
 * A definition drafted and then published, returning the version the draft wrote.
 *
 * Two writes, because one no longer makes a definition live (FR-016). The draft
 * token is read out of the store each time rather than tracked here — the gate is
 * not what these suites are testing, and re-reading it is what a window does.
 */
async function saveNext(
  store: CatalogStore,
  kind: CatalogKind,
  id: string,
  body: unknown
): Promise<string> {
  const drafted = await store.applyLifecycleWrite({
    op: 'save-draft',
    kind,
    id,
    body,
    expectedDraftVersion: await draftTokenFor(store, kind, id)
  });
  if (drafted.outcome !== 'written') {
    throw new Error(`expected a draft write, got ${drafted.outcome}`);
  }
  const published = await store.applyLifecycleWrite({
    op: 'publish',
    kind,
    id,
    expectedDraftVersion: await draftTokenFor(store, kind, id)
  });
  if (published.outcome !== 'written') {
    throw new Error(`expected a publication, got ${published.outcome}`);
  }
  if (drafted.writtenVersionId === null) {
    throw new Error('a draft write reported no version');
  }
  return drafted.writtenVersionId;
}

/** The files `after` holds that `before` did not. */
function addedIn(before: Fingerprint, after: Fingerprint): readonly string[] {
  return [...after.keys()].filter((path) => !before.has(path)).sort();
}

describe('Feature 099 — a workspace that never saves has no store (T496e)', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await createWorkspace('never-saved');
  });

  afterEach(async () => {
    await removeWorkspace(workspaceRoot);
  });

  it('reads as the empty catalog and creates not one directory', async () => {
    const store = openStore(workspaceRoot);

    const result = await store.read();

    expect(result.outcome).toBe('read');
    if (result.outcome !== 'read') return;
    expect(result.snapshot.definitions).toEqual([]);
    expect(result.snapshot.faults).toEqual([]);
    expect(result.snapshot.collectable).toEqual([]);

    // FR-001a and SC-018, stated as strongly as they can be: activating in a
    // workspace nobody has saved in leaves the directory exactly as it was found.
    // The adapter creates parents lazily on the *write* path only, so this holds
    // structurally rather than because the read path remembers not to.
    expect(await treeOf(workspaceRoot)).toEqual({ files: [], directories: [] });
  });

  it('stays untouched through every read-side call the surfaces make', async () => {
    const store = openStore(workspaceRoot);

    await store.read();
    for (const kind of ['phase', 'pipeline', 'workflow'] as const) {
      expect(await store.listDefinitions(kind)).toEqual([]);
      expect(await store.listVersions(kind, 'implement')).toEqual([]);
      expect(await store.readVersion(kind, 'implement', 'v1')).toEqual({ outcome: 'absent' });
    }

    expect(await treeOf(workspaceRoot)).toEqual({ files: [], directories: [] });
  });

  it('refuses a save by name when no workspace folder is open, and writes nowhere', async () => {
    // FR-033a. The store still exists and still reads as the empty catalog — the
    // refusal is a write fault with a name, not a null the caller has to guess at.
    const store = openStoreWithoutWorkspace();

    const result = await store.read();
    expect(result.outcome).toBe('read');

    const outcome = await store.applyLifecycleWrite({
      op: 'save-draft',
      kind: 'phase',
      id: 'implement',
      body: { n: 1 },
      expectedDraftVersion: 'no-draft'
    });

    expect(outcome).toEqual({ outcome: 'refused', reason: 'no-workspace' });
    expect(await treeOf(workspaceRoot)).toEqual({ files: [], directories: [] });
  });
});

describe('Feature 099 — a definition round-trips through the disk (T496c)', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await createWorkspace('lifecycle');
  });

  afterEach(async () => {
    await removeWorkspace(workspaceRoot);
  });

  it('lands exactly the manifest and one record, and nothing else', async () => {
    const store = openStore(workspaceRoot);

    const versionId = await saveNext(store, 'phase', 'implement', { name: 'Implement' });
    expect(versionId).toBe('v1');

    // The whole workspace, not just the store: the store's own directories are
    // created and nothing outside them is.
    expect(await treeOf(workspaceRoot)).toEqual({
      files: ['.schegent/catalog/manifest.json', '.schegent/catalog/phases/implement/v1.json'],
      directories: [
        '.schegent',
        '.schegent/catalog',
        '.schegent/catalog/phases',
        '.schegent/catalog/phases/implement'
      ]
    });
  });

  it('leaves no temp file behind, under any name', async () => {
    // FR-024. The write is a sibling temp plus a rename, so a leftover `.tmp` is
    // the observable form of a rename that did not happen — and a reader that
    // scanned the directory would see it as a version record.
    const store = openStore(workspaceRoot);
    for (let n = 1; n <= 3; n += 1) {
      await saveNext(store, 'phase', 'implement', { n });
    }

    const tree = await treeOf(workspaceRoot);
    const debris = tree.files.filter(
      (file) => file.includes('.tmp') || file.split('/').pop()?.startsWith('.') === true
    );
    expect(debris).toEqual([]);
  });

  it('is read back cold by a second window that shares only the directory', async () => {
    const writer = openStore(workspaceRoot);
    await saveNext(writer, 'phase', 'implement', { name: 'Implement', order: 3 });
    await saveNext(writer, 'pipeline', 'standard', { phases: ['implement'] });

    // A different store object over the same root. Nothing is shared but the
    // bytes, which is what makes this a claim about the disk.
    const reader = openStore(workspaceRoot);
    const result = await reader.read();

    expect(result.outcome).toBe('read');
    if (result.outcome !== 'read') return;
    expect(result.snapshot.faults).toEqual([]);
    expect(result.snapshot.definitions).toEqual([
      expect.objectContaining({
        kind: 'phase',
        id: 'implement',
        status: 'effective',
        activeVersionId: 'v1',
        body: { name: 'Implement', order: 3 }
      }),
      expect.objectContaining({
        kind: 'pipeline',
        id: 'standard',
        status: 'effective',
        activeVersionId: 'v1',
        body: { phases: ['implement'] }
      })
    ]);
  });

  it('agrees with the other window about both gates, so either is usable across them', async () => {
    const writer = openStore(workspaceRoot);
    await saveNext(writer, 'phase', 'implement', { n: 1 });

    const reader = openStore(workspaceRoot);
    // Two gates now, at two granularities: the per-kind revision a layer write is
    // taken against (FR-036), and the per-definition draft pointer a single write
    // is taken against (FR-012). Both are facts about the manifest on disk, so
    // both must read the same from either window.
    expect(await revisionOf(reader, 'phase')).toBe(await revisionOf(writer, 'phase'));
    expect(await draftTokenFor(reader, 'phase', 'implement')).toBe(
      await draftTokenFor(writer, 'phase', 'implement')
    );

    // And the token the reader read is one the writer's store will accept: the
    // gate is over the same bytes on both sides (SC-019).
    const outcome = await writer.applyLifecycleWrite({
      op: 'save-draft',
      kind: 'phase',
      id: 'implement',
      body: { n: 2 },
      expectedDraftVersion: await draftTokenFor(reader, 'phase', 'implement')
    });
    expect(outcome).toMatchObject({ outcome: 'written', writtenVersionId: 'v2' });
  });

  it('recognises its own bytes, so reopening an editor manufactures no history', async () => {
    // FR-014 across process boundaries. The short-circuit compares a hash of the
    // canonical form, so a body that differs only in key order — which is what a
    // round trip through an editor produces — is still the same content.
    const writer = openStore(workspaceRoot);
    await saveNext(writer, 'phase', 'implement', { name: 'Implement', order: 3 });
    const before = await fingerprintOf(storeRootOf(workspaceRoot));

    const reopened = openStore(workspaceRoot);
    const outcome = await reopened.applyLifecycleWrite({
      op: 'save-draft',
      kind: 'phase',
      id: 'implement',
      body: { order: 3, name: 'Implement' },
      expectedDraftVersion: await draftTokenFor(reopened, 'phase', 'implement')
    });

    // Compared against the *head* — here the active version, since publishing left
    // no pending draft — so a reopened editor that saves what it loaded manufactures
    // no draft either (FR-014a).
    expect(outcome).toMatchObject({ outcome: 'unchanged', versionId: 'v1' });
    // Not one byte moved, and not one mtime either: an identical rewrite of the
    // manifest would move the revision and make the other window's next save stale.
    expect(await fingerprintOf(storeRootOf(workspaceRoot))).toEqual(before);
  });

  it('writes a record whose shape is the contract, not the manifest entry', async () => {
    const store = openStore(workspaceRoot);
    await saveNext(store, 'phase', 'implement', { name: 'Implement' });

    expect(await readStoreJson(workspaceRoot, 'phases', 'implement', 'v1.json')).toEqual({
      versionId: 'v1',
      kind: 'phase',
      id: 'implement',
      body: { name: 'Implement' }
    });

    // The record is self-describing: it names its own kind, id, and version, so a
    // record found on disk can be checked against where it was found rather than
    // trusted because of it.
    const manifest = (await readStoreJson(workspaceRoot, 'manifest.json')) as {
      storeFormatVersion: number;
      entries: readonly {
        kind: string;
        id: string;
        activeVersionId: string;
        draftVersionId: null;
        versions: readonly { versionId: string; createdAt: number; publishedAt: number | null }[];
      }[];
    };
    expect(manifest.storeFormatVersion).toBe(1);
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]).toMatchObject({
      kind: 'phase',
      id: 'implement',
      activeVersionId: 'v1',
      // Not "inert" any more, and not "the draft that was published" either: the
      // publication cleared it, so the pointers never name the same version (FR-009).
      draftVersionId: null
    });

    // The publication is on disk as a time, not merely as a pointer — which is what
    // lets a later read say when the active version went live (FR-020).
    const version = manifest.entries[0]!.versions[0]!;
    expect(version.versionId).toBe('v1');
    expect(typeof version.publishedAt).toBe('number');
    expect(version.publishedAt).toBeGreaterThanOrEqual(version.createdAt);
  });

  it('keeps the store out of reach of every other account', async () => {
    // The catalog holds definitions the extension will execute. `0o077` clearing
    // is the property; the exact mode is umask-dependent and the property is not.
    const store = openStore(workspaceRoot);
    await saveNext(store, 'phase', 'implement', { n: 1 });
    const storeRoot = storeRootOf(workspaceRoot);

    for (const relative of [[], ['phases'], ['phases', 'implement']]) {
      const info = await stat(join(storeRoot, ...relative));
      expect(info.isDirectory()).toBe(true);
      expect(info.mode & 0o077).toBe(0);
    }
    for (const relative of [['manifest.json'], ['phases', 'implement', 'v1.json']]) {
      const info = await stat(join(storeRoot, ...relative));
      expect(info.mode & 0o077).toBe(0);
    }
  });
});

describe('Feature 099 — the store validates nothing (T496i)', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await createWorkspace('verbatim');
  });

  afterEach(async () => {
    await removeWorkspace(workspaceRoot);
  });

  it('stores and returns a body every validator in the host would reject', async () => {
    // FR-010, FR-011. Validation belongs to the import path and to the Builder;
    // a store that also validated would refuse to hold a definition the operator
    // has already written and is halfway through fixing — and would have to be
    // kept in agreement with three validators forever.
    const hostile = {
      name: 42,
      phases: 'not an array',
      steps: [{ id: '' }, { id: '../escape' }],
      '': null,
      'a key with spaces': [1, {}, []],
      nested: { deeply: { empty: {} } }
    };

    const store = openStore(workspaceRoot);
    expect(await saveNext(store, 'pipeline', 'nonsense', hostile)).toBe('v1');

    const cold = openStore(workspaceRoot);
    const read = await cold.readVersion('pipeline', 'nonsense', 'v1');
    expect(read).toEqual({
      outcome: 'read',
      record: { versionId: 'v1', kind: 'pipeline', id: 'nonsense', body: hostile }
    });

    const snapshot = await cold.read();
    expect(snapshot.outcome).toBe('read');
    if (snapshot.outcome !== 'read') return;
    expect(snapshot.snapshot.faults).toEqual([]);
    expect(snapshot.snapshot.definitions[0]).toMatchObject({ status: 'effective', body: hostile });
  });

  it('stores a body that is not an object at all', async () => {
    // The port types the body as `unknown` and means it. A store that assumed an
    // object would fail here rather than at the boundary that cares.
    const store = openStore(workspaceRoot);
    await saveNext(store, 'workflow', 'scalar', 'just a string');
    await saveNext(store, 'workflow', 'listy', [1, 'two', null, { three: 3 }]);

    const cold = openStore(workspaceRoot);
    expect(await cold.readVersion('workflow', 'scalar', 'v1')).toMatchObject({
      record: { body: 'just a string' }
    });
    expect(await cold.readVersion('workflow', 'listy', 'v1')).toMatchObject({
      record: { body: [1, 'two', null, { three: 3 }] }
    });
  });

  it('preserves a body verbatim rather than in canonical form', async () => {
    // The canonical form is what the hash is taken over; it is not what is stored.
    // If the store normalised on the way in, the operator's file and the stored
    // record would differ and a diff between them would show edits nobody made.
    const store = openStore(workspaceRoot);
    await saveNext(store, 'phase', 'implement', { z: 1, a: 2, m: null });

    const record = await readStoreFile(workspaceRoot, 'phases', 'implement', 'v1.json');
    const body = JSON.parse(record).body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['z', 'a', 'm']);
    expect(body.m).toBeNull();
  });
});

describe('Feature 099 — ten saves make ten versions (T496k)', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await createWorkspace('history');
  });

  afterEach(async () => {
    await removeWorkspace(workspaceRoot);
  });

  it('numbers monotonically, renumbers nothing, and leaves every record immutable', async () => {
    const store = openStore(workspaceRoot);
    const written = new Map<string, string>();

    for (let n = 1; n <= 10; n += 1) {
      const versionId = await saveNext(store, 'phase', 'implement', { n, note: `save ${n}` });
      expect(versionId).toBe(`v${n}`);
      // Captured immediately after its own save, compared at the end: a record is
      // write-once, so nothing any later save does may change these bytes (FR-016).
      written.set(
        versionId,
        await readStoreFile(workspaceRoot, 'phases', 'implement', `${versionId}.json`)
      );
    }

    const cold = openStore(workspaceRoot);
    const versions = await cold.listVersions('phase', 'implement');
    expect(versions.map((version) => version.versionId)).toEqual([
      'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9', 'v10'
    ]);
    // `createdAt` is non-decreasing across the history, which is what makes the
    // order in the manifest an order and not just an array (FR-021a).
    for (let index = 1; index < versions.length; index += 1) {
      expect(versions[index]!.createdAt).toBeGreaterThanOrEqual(versions[index - 1]!.createdAt);
    }

    for (const [versionId, contents] of written) {
      expect(await readStoreFile(workspaceRoot, 'phases', 'implement', `${versionId}.json`)).toBe(
        contents
      );
      expect(await cold.readVersion('phase', 'implement', versionId)).toMatchObject({
        outcome: 'read',
        record: { versionId, body: { n: Number(versionId.slice(1)) } }
      });
    }

    // Ten records and one manifest, and the tenth is active.
    const tree = await treeOf(storeRootOf(workspaceRoot));
    expect(tree.files).toHaveLength(11);
    expect(await cold.listDefinitions('phase')).toEqual([
      expect.objectContaining({ activeVersionId: 'v10', body: { n: 10, note: 'save 10' } })
    ]);
  });

  it('reads a past version without writing anything or moving a timestamp', async () => {
    // FR-017, SC-003. Reading history is not an event in the history.
    const store = openStore(workspaceRoot);
    for (let n = 1; n <= 10; n += 1) {
      await saveNext(store, 'phase', 'implement', { n });
    }
    const before = await fingerprintOf(storeRootOf(workspaceRoot));

    const cold = openStore(workspaceRoot);
    for (let n = 1; n <= 10; n += 1) {
      expect(await cold.readVersion('phase', 'implement', `v${n}`)).toMatchObject({
        outcome: 'read',
        record: { body: { n } }
      });
    }
    await cold.listVersions('phase', 'implement');
    await cold.listDefinitions('phase');
    await cold.read();

    expect(await fingerprintOf(storeRootOf(workspaceRoot))).toEqual(before);
  });

  it('keeps three kinds apart on disk under one shared id', async () => {
    const store = openStore(workspaceRoot);
    for (const kind of ['phase', 'pipeline', 'workflow'] as const) {
      await saveNext(store, kind, 'shared', { kind });
      await saveNext(store, kind, 'shared', { kind, second: true });
    }

    expect((await treeOf(storeRootOf(workspaceRoot))).files).toEqual([
      'manifest.json',
      'phases/shared/v1.json',
      'phases/shared/v2.json',
      'pipelines/shared/v1.json',
      'pipelines/shared/v2.json',
      'workflows/shared/v1.json',
      'workflows/shared/v2.json'
    ]);

    const cold = openStore(workspaceRoot);
    for (const kind of ['phase', 'pipeline', 'workflow'] as const) {
      expect(await cold.readVersion(kind, 'shared', 'v1')).toMatchObject({
        record: { kind, body: { kind } }
      });
    }
  });
});

describe('Feature 099 — a missing record costs exactly one definition (T496c)', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await createWorkspace('dangling');
  });

  afterEach(async () => {
    await removeWorkspace(workspaceRoot);
  });

  it('reports one invalid definition, resolves every other, and deletes nothing', async () => {
    // FR-027, SC-005. The unit suite asserts this against a fake whose "missing
    // file" is a Map with a key removed. Here the file is really gone — deleted
    // out from under a live store by anything from a partial checkout to a
    // half-finished sync — which is the only version of this scenario that also
    // proves the store does not try to repair it.
    const store = openStore(workspaceRoot);
    await saveNext(store, 'phase', 'alpha', { n: 1 });
    await saveNext(store, 'phase', 'beta', { n: 1 });
    await saveNext(store, 'phase', 'beta', { n: 2 });
    await saveNext(store, 'pipeline', 'gamma', { n: 1 });

    // Remove the record `beta`'s manifest entry points at, leaving v1 behind: the
    // definition is unreadable even though it still has history on disk.
    await rm(join(storeRootOf(workspaceRoot), 'phases', 'beta', 'v2.json'));
    const before = await fingerprintOf(storeRootOf(workspaceRoot));

    const cold = openStore(workspaceRoot);
    const result = await cold.read();
    expect(result.outcome).toBe('read');
    if (result.outcome !== 'read') return;

    // Exactly one fault, and it names the definition without naming a path.
    expect(result.snapshot.faults).toEqual([
      { fault: 'dangling-record', kind: 'phase', id: 'beta', versionId: 'v2' }
    ]);

    const byId = new Map(result.snapshot.definitions.map((d) => [`${d.kind}/${d.id}`, d]));
    expect(byId.get('phase/beta')).toMatchObject({
      status: 'invalid',
      activeVersionId: 'v2',
      body: null
    });
    // `invalid` is about the active version, not about the history: the versions
    // the entry lists are still listed, v1 included.
    expect(byId.get('phase/beta')?.versions.map((v) => v.versionId)).toEqual(['v1', 'v2']);

    // The other two are untouched by their neighbour's damage.
    expect(byId.get('phase/alpha')).toMatchObject({ status: 'effective', body: { n: 1 } });
    expect(byId.get('pipeline/gamma')).toMatchObject({ status: 'effective', body: { n: 1 } });
    expect(result.snapshot.definitions).toHaveLength(3);

    // The version that survived is still readable by name, and the one that did
    // not reports its absence rather than throwing.
    expect(await cold.readVersion('phase', 'beta', 'v1')).toMatchObject({
      outcome: 'read',
      record: { body: { n: 1 } }
    });
    expect(await cold.readVersion('phase', 'beta', 'v2')).toEqual({ outcome: 'absent' });

    // Zero deletions, zero repairs, zero rewrites: reading a damaged store leaves
    // it byte-for-byte and mtime-for-mtime as it was found (FR-016, FR-031).
    expect(await fingerprintOf(storeRootOf(workspaceRoot))).toEqual(before);
  });

  it('repairs the damaged definition by adding a version, and still saves its neighbours', async () => {
    // 099 refused this save by name (`definition-invalid`) on the grounds that a
    // version whose predecessor cannot be read compounds the fault. FR-011a
    // reverses the judgement: refusing leaves the operator with a definition they
    // cannot fix from the surface that broke it, so the write is allowed and is the
    // repair. What survives from the old claim is the part that mattered — the
    // damage is contained in both directions. Nothing is deleted, no existing
    // record is rewritten, the fault is still reported until the repair is
    // published, and a save aimed at anything else proceeds untouched by it.
    const store = openStore(workspaceRoot);
    await saveNext(store, 'phase', 'alpha', { n: 1 });
    await saveNext(store, 'phase', 'beta', { n: 1 });
    await saveNext(store, 'phase', 'beta', { n: 2 });
    await rm(join(storeRootOf(workspaceRoot), 'phases', 'beta', 'v2.json'));

    const cold = openStore(workspaceRoot);
    const before = await fingerprintOf(storeRootOf(workspaceRoot));

    expect(
      await cold.applyLifecycleWrite({
        op: 'save-draft',
        kind: 'phase',
        id: 'beta',
        body: { n: 3 },
        expectedDraftVersion: await draftTokenFor(cold, 'phase', 'beta')
      })
    ).toMatchObject({
      outcome: 'written',
      writtenVersionId: 'v3',
      draftVersionId: 'v3',
      // The *active* pointer does not move: a draft write never promotes itself,
      // so the definition is still broken until somebody publishes the repair.
      activeVersionId: 'v2',
      pruned: []
    });

    // An addition, not an edit. The one new file is v3, the manifest is the only
    // file rewritten, and v1 — the record that is still readable — is untouched
    // down to its mtime. A "repair" that rewrote history would be the compounding
    // the old refusal was there to prevent.
    const afterRepair = await fingerprintOf(storeRootOf(workspaceRoot));
    expect(addedIn(before, afterRepair)).toEqual(['phases/beta/v3.json']);
    for (const [path, print] of before) {
      if (path === 'manifest.json') continue;
      expect(afterRepair.get(path)).toBe(print);
    }

    // Still invalid, and still exactly one fault: the active version is still the
    // missing one.
    const drafted = await cold.read();
    expect(drafted.outcome).toBe('read');
    if (drafted.outcome !== 'read') return;
    expect(drafted.snapshot.faults).toEqual([
      { fault: 'dangling-record', kind: 'phase', id: 'beta', versionId: 'v2' }
    ]);
    expect(
      drafted.snapshot.definitions.find((definition) => definition.id === 'beta')
    ).toMatchObject({ status: 'invalid', body: null, activeVersionId: 'v2', draftVersionId: 'v3' });

    // Publishing the repair is what clears the fault — and nothing was deleted to
    // get there, so v2's manifest row survives its record.
    expect(
      await cold.applyLifecycleWrite({
        op: 'publish',
        kind: 'phase',
        id: 'beta',
        expectedDraftVersion: await draftTokenFor(cold, 'phase', 'beta')
      })
    ).toMatchObject({ outcome: 'written', activeVersionId: 'v3', draftVersionId: null });

    // The neighbour saves normally throughout, and the store is clean.
    expect(await saveNext(cold, 'phase', 'alpha', { n: 2 })).toBe('v2');
    const after = await cold.read();
    expect(after.outcome).toBe('read');
    if (after.outcome !== 'read') return;
    expect(after.snapshot.faults).toEqual([]);
    expect(after.snapshot.collectable).toEqual([]);
    expect(after.snapshot.definitions.find((definition) => definition.id === 'beta')).toMatchObject({
      status: 'effective',
      body: { n: 3 }
    });
  });
});
