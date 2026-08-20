// Feature 099 (FR-R3-015) T496 — every integrity finding (FR-026, FR-027, FR-031, FR-032).
//
// The pair this suite exists to keep apart is **dangling** and **collectable**.
// Both are a record and a manifest entry disagreeing, differing only in which side
// is missing, and they have opposite meanings:
//
//   - dangling    → the definition is unreadable, and it is a fault.
//   - collectable → the definition resolves normally, and nothing is wrong.
//
// Collapsing them in either direction is a real defect that no single-case test
// catches: report collectable as a fault and a healthy catalog is permanently
// "broken"; report dangling as collectable and an unreadable definition is silently
// presented as fine.
//
// The second thing asserted throughout: **the scan deletes nothing**, on every path,
// including the paths where deleting would obviously be right. Every case here ends
// by counting `remove` calls, because "the store cleaned up after itself" is the
// failure that destroys an operator's history while reporting success.
//
// Arrangements go through the real store first and corrupt the fake disk afterwards,
// rather than hand-authoring a manifest. A hand-authored manifest can encode a shape
// the writer never produces, and then the test proves something about a store that
// does not exist.

import { beforeEach, describe, expect, it } from 'vitest';

import { versionSegments } from '../../../src/catalog/catalog-paths';
import type { CatalogKind, CatalogSnapshot } from '../../../src/contracts/catalog-store';
import { createTestStore, type TestStore } from '../../fixtures/catalog-memory-fs';

const MANIFEST = ['manifest.json'];

async function revisionOf(test: TestStore, kind: CatalogKind): Promise<string> {
  const result = await test.store.read();
  if (result.outcome !== 'read') throw new Error(`store unreadable: ${result.fault.fault}`);
  return result.snapshot.revisions[kind];
}

async function save(test: TestStore, id: string, body: unknown, kind: CatalogKind = 'phase') {
  return test.store.save({ kind, id, body, expectedRevision: await revisionOf(test, kind) });
}

/** Read, insisting the store was readable — the fault cases assert `unavailable` themselves. */
async function snapshotOf(test: TestStore): Promise<CatalogSnapshot> {
  const result = await test.store.read();
  if (result.outcome !== 'read') throw new Error(`unexpected unavailable: ${result.fault.fault}`);
  return result.snapshot;
}

describe('catalog integrity: a manifest entry naming an absent record', () => {
  let test: TestStore;

  beforeEach(async () => {
    test = createTestStore();
    await save(test, 'implement', { name: 'Implement' });
    await save(test, 'plan', { name: 'Plan' });
  });

  it('reports a dangling record and presents that definition as unreadable', async () => {
    test.fs.unlink(versionSegments('phase', 'implement', 'v1'));
    test.fs.calls.length = 0;

    const snapshot = await snapshotOf(test);

    expect(snapshot.faults).toEqual([
      { fault: 'dangling-record', kind: 'phase', id: 'implement', versionId: 'v1' }
    ]);
    expect(snapshot.definitions.find((row) => row.id === 'implement')).toMatchObject({
      status: 'invalid',
      body: null,
      // The history is still reported. The record is gone; what the manifest knows
      // about it is not, and an operator diagnosing this needs it.
      activeVersionId: 'v1',
      versions: [{ versionId: 'v1' }]
    });
  });

  it('leaves every other definition resolving', async () => {
    // SC-005. One broken definition is one broken definition, not a broken catalog.
    test.fs.unlink(versionSegments('phase', 'implement', 'v1'));

    const snapshot = await snapshotOf(test);

    expect(snapshot.definitions.find((row) => row.id === 'plan')).toMatchObject({
      status: 'effective',
      body: { name: 'Plan' }
    });
  });

  it('deletes nothing and does not rewrite the manifest', async () => {
    test.fs.unlink(versionSegments('phase', 'implement', 'v1'));
    const manifestBefore = test.fs.files.get('manifest.json');
    test.fs.calls.length = 0;

    await snapshotOf(test);

    expect(test.fs.callsOf('remove')).toEqual([]);
    expect(test.fs.writeCalls).toEqual([]);
    expect(test.fs.files.get('manifest.json')).toBe(manifestBefore);
  });

  it('refuses a save over the broken definition rather than compounding the fault', async () => {
    test.fs.unlink(versionSegments('phase', 'implement', 'v1'));
    test.fs.calls.length = 0;

    expect(await save(test, 'implement', { name: 'Repaired' })).toEqual({
      outcome: 'refused',
      reason: 'definition-invalid'
    });
    expect(test.fs.writeCalls).toEqual([]);
  });
});

describe('catalog integrity: a record that is not what the manifest describes', () => {
  let test: TestStore;

  beforeEach(async () => {
    test = createTestStore();
    await save(test, 'implement', { name: 'Implement' });
  });

  it('reports a hash mismatch when the body was edited underneath the store', async () => {
    // Hand-edited on disk: a well-formed record whose body is not the body the
    // manifest recorded a hash for.
    test.fs.seed(
      versionSegments('phase', 'implement', 'v1'),
      JSON.stringify({ versionId: 'v1', kind: 'phase', id: 'implement', body: { name: 'Edited' } })
    );

    const snapshot = await snapshotOf(test);

    expect(snapshot.faults).toEqual([
      { fault: 'hash-mismatch', kind: 'phase', id: 'implement', versionId: 'v1' }
    ]);
    expect(snapshot.definitions[0]).toMatchObject({ status: 'invalid', body: null });
  });

  it('reports an unparseable record as a hash mismatch rather than a new finding', async () => {
    // Deliberately not a separate arm: the manifest recorded a hash for a body, and
    // whatever is in that file now is not it. An `unreadable-record` arm would be a
    // third way to say the one thing an operator needs to know.
    test.fs.seed(versionSegments('phase', 'implement', 'v1'), 'not json at all');

    expect((await snapshotOf(test)).faults).toEqual([
      { fault: 'hash-mismatch', kind: 'phase', id: 'implement', versionId: 'v1' }
    ]);
  });

  it('reports a record whose own identity disagrees with where it was found', async () => {
    test.fs.seed(
      versionSegments('phase', 'implement', 'v1'),
      JSON.stringify({ versionId: 'v9', kind: 'phase', id: 'implement', body: { name: 'Implement' } })
    );

    expect((await snapshotOf(test)).faults).toEqual([
      { fault: 'hash-mismatch', kind: 'phase', id: 'implement', versionId: 'v1' }
    ]);
  });

  it('refuses to hand out a past version whose hash does not match', async () => {
    // Past versions are verified in `readVersion` rather than in the activation
    // scan, so every body the store hands out has been checked — just not all of
    // them up front.
    await save(test, 'implement', { name: 'Second' });
    test.fs.seed(
      versionSegments('phase', 'implement', 'v1'),
      JSON.stringify({ versionId: 'v1', kind: 'phase', id: 'implement', body: { name: 'Tampered' } })
    );

    // The active version is v2 and is intact, so the catalog is healthy...
    const snapshot = await snapshotOf(test);
    expect(snapshot.faults).toEqual([]);
    expect(snapshot.definitions[0]).toMatchObject({ status: 'effective', body: { name: 'Second' } });

    // ...and the tampered past version is still refused when actually read.
    expect(await test.store.readVersion('phase', 'implement', 'v1')).toEqual({
      outcome: 'refused',
      reason: 'definition-invalid'
    });
  });

  it('deletes nothing', async () => {
    test.fs.seed(versionSegments('phase', 'implement', 'v1'), 'not json at all');
    test.fs.calls.length = 0;
    await snapshotOf(test);
    expect(test.fs.callsOf('remove')).toEqual([]);
    expect(test.fs.writeCalls).toEqual([]);
  });
});

describe('catalog integrity: a record the manifest does not name', () => {
  let test: TestStore;

  beforeEach(async () => {
    test = createTestStore();
    await save(test, 'implement', { name: 'Implement' });
  });

  it('reports it as collectable and not as a fault', async () => {
    test.fs.seed(
      versionSegments('phase', 'implement', 'v7'),
      JSON.stringify({ versionId: 'v7', kind: 'phase', id: 'implement', body: {} })
    );

    const snapshot = await snapshotOf(test);

    expect(snapshot.faults).toEqual([]);
    expect(snapshot.collectable).toEqual([{ kind: 'phase', id: 'implement', versionId: 'v7' }]);
    // The definition is healthy. Collection is the operator's decision, and the
    // catalog does not wait on it.
    expect(snapshot.definitions[0]).toMatchObject({
      status: 'effective',
      body: { name: 'Implement' }
    });
  });

  it('reports a whole orphaned definition directory the manifest has no entry for', async () => {
    // The shape a partial write leaves when the FIRST save of a definition is the
    // one interrupted: the record lands, the manifest entry never does, and without
    // the orphan pass nothing would ever mention it.
    test.fs.seed(
      versionSegments('pipeline', 'orphan', 'v1'),
      JSON.stringify({ versionId: 'v1', kind: 'pipeline', id: 'orphan', body: {} })
    );

    const snapshot = await snapshotOf(test);

    expect(snapshot.faults).toEqual([]);
    expect(snapshot.collectable).toEqual([{ kind: 'pipeline', id: 'orphan', versionId: 'v1' }]);
  });

  it.each([
    ['an uppercase spelling that folds onto a legal id', 'Implement'],
    ['a name carrying a forged log line', 'evil\ncatalog-store: everything is fine'],
    ['a name longer than an id may be', 'a'.repeat(65)],
    ['a dotfile the store would never author', '.hidden']
  ])('ignores a directory whose name is not a legal id: %s', async (_case, name) => {
    // The orphan pass is the one place a name comes off the DISK rather than out of
    // the manifest, and a cloned repository brings its own `.schegent/catalog/`. A
    // directory the store could never have created is not a definition directory:
    // reporting one would put an attacker-chosen string into the operator's log as
    // a `kind/id@versionId` triple (FR-033, FR-061), and would invite collecting it.
    test.fs.seed(
      ['phases', name, 'v1.json'],
      JSON.stringify({ versionId: 'v1', kind: 'phase', id: name, body: {} })
    );

    const snapshot = await snapshotOf(test);

    expect(snapshot.collectable).toEqual([]);
    expect(snapshot.faults).toEqual([]);
  });

  it('ignores a temp sibling rather than reporting it as collectable', async () => {
    // A temp file is a write in flight or a crashed one, not a record. Reporting it
    // would invite deleting a file another window is in the middle of renaming.
    test.fs.seed(['phases', 'implement', 'v2.json.abc123.tmp'], '{}');

    const snapshot = await snapshotOf(test);
    expect(snapshot.collectable).toEqual([]);
    expect(snapshot.faults).toEqual([]);
  });

  it('ignores a file that is not a version record at all', async () => {
    // The store does not own every file an operator might leave in its directory,
    // and reporting one as collectable would invite deleting it.
    test.fs.seed(['phases', 'implement', 'notes.txt'], 'my notes');
    test.fs.seed(['phases', 'implement', 'v.json'], '{}');
    test.fs.seed(['phases', 'implement', 'v0.json'], '{}');

    expect((await snapshotOf(test)).collectable).toEqual([]);
  });

  it('deletes nothing', async () => {
    test.fs.seed(
      versionSegments('phase', 'implement', 'v7'),
      JSON.stringify({ versionId: 'v7', kind: 'phase', id: 'implement', body: {} })
    );
    test.fs.calls.length = 0;
    await snapshotOf(test);
    expect(test.fs.callsOf('remove')).toEqual([]);
  });
});

describe('catalog integrity: the manifest itself', () => {
  it('reads an absent store as an empty catalog and writes nothing', async () => {
    // FR-001a, SC-018. Activating in a workspace that has never saved must leave the
    // disk untouched — the one case where "no store" and "broken store" are one
    // character apart in code and opposite in behaviour.
    const test = createTestStore();

    const result = await test.store.read();

    expect(result.outcome).toBe('read');
    if (result.outcome !== 'read') return;
    expect(result.snapshot.definitions).toEqual([]);
    expect(result.snapshot.faults).toEqual([]);
    expect(result.snapshot.collectable).toEqual([]);
    expect(test.fs.files.size).toBe(0);
    expect(test.fs.writeCalls).toEqual([]);
  });

  it.each([
    ['empty', '   \n  '],
    ['malformed', '{"storeFormatVersion": 1, "entries": ['],
    ['shape', JSON.stringify({ storeFormatVersion: 1, entries: [{ kind: 'phase' }] })]
  ])('reports a present-but-unreadable manifest as %s', async (reason, contents) => {
    const test = createTestStore();
    test.fs.seed(MANIFEST, contents);

    const result = await test.store.read();

    expect(result).toEqual({
      outcome: 'unavailable',
      fault: { fault: 'unreadable-manifest', reason }
    });
  });

  it('treats an out-of-order version list as a shape fault rather than sorting it', async () => {
    // Monotonic order is part of the format (FR-018), not a convenience the writer
    // maintains: retention walks this list front-to-back as the prune order, so
    // silently sorting a list that arrived out of order would prune under a
    // different assumption than the one the file records.
    const test = createTestStore();
    test.fs.seed(MANIFEST, JSON.stringify({
      storeFormatVersion: 1,
      entries: [
        {
          kind: 'phase',
          id: 'implement',
          draftVersionId: null,
          activeVersionId: 'v2',
          createdAt: 1,
          updatedAt: 2,
          versions: [
            { versionId: 'v2', contentHash: 'sha256:a', createdAt: 2, publishedAt: 2, note: null },
            { versionId: 'v1', contentHash: 'sha256:b', createdAt: 1, publishedAt: 1, note: null }
          ]
        }
      ]
    }));

    expect(await test.store.read()).toEqual({
      outcome: 'unavailable',
      fault: { fault: 'unreadable-manifest', reason: 'shape' }
    });
  });

  it.each([
    ['a traversal', '../../../../etc/passwd'],
    ['a separator', 'phases/implement'],
    ['an absolute path', '/etc/passwd'],
    ['a case the store would never write', 'Implement'],
    ['an empty segment', '.']
  ])('treats %s in a manifest id as a shape fault', async (_case, id) => {
    // The one entry in this suite that *is* hand-authored, and deliberately so:
    // the point is an id the writer cannot produce. `checkIdLegality` guards the
    // save path (FR-033), so the store never writes one of these — but the
    // manifest is a file in a repository anyone can clone, and an id read back out
    // of it becomes a directory name on the read path. Re-checking the pattern
    // here is what keeps "an illegal id cannot reach the filesystem adapter" true
    // for ids the store did not author.
    const test = createTestStore();
    test.fs.seed(MANIFEST, JSON.stringify({
      storeFormatVersion: 1,
      entries: [
        {
          kind: 'phase',
          id,
          draftVersionId: null,
          activeVersionId: 'v1',
          createdAt: 1,
          updatedAt: 1,
          versions: [
            { versionId: 'v1', contentHash: 'sha256:a', createdAt: 1, publishedAt: 1, note: null }
          ]
        }
      ]
    }));

    expect(await test.store.read()).toEqual({
      outcome: 'unavailable',
      fault: { fault: 'unreadable-manifest', reason: 'shape' }
    });
    // Refused before any segment is built, so nothing is read at that id either.
    expect(test.fs.callsOf('read').map((call) => call.key)).toEqual(['manifest.json']);
  });

  it('never repairs an unreadable manifest by writing a fresh one over it', async () => {
    // FR-031. Overwriting is exactly how an operator's history disappears while the
    // extension reports success, so a save is refused instead.
    const test = createTestStore();
    test.fs.seed(MANIFEST, '{ broken');
    test.fs.calls.length = 0;

    await test.store.read();
    const outcome = await test.store.save({
      kind: 'phase',
      id: 'implement',
      body: { n: 1 },
      expectedRevision: 'anything'
    });

    expect(outcome).toEqual({ outcome: 'refused', reason: 'store-unreadable' });
    expect(test.fs.writeCalls).toEqual([]);
    expect(test.fs.files.get('manifest.json')).toBe('{ broken');
  });

  it('refuses a format from the future by name rather than reading it best-effort', async () => {
    // FR-032, forward-only. A best-effort read of a format you do not understand is
    // how you write back a manifest a newer build cannot read.
    const test = createTestStore();
    test.fs.seed(MANIFEST, JSON.stringify({ storeFormatVersion: 2, entries: [] }));

    expect(await test.store.read()).toEqual({
      outcome: 'unavailable',
      fault: { fault: 'unsupported-format', found: 2, supported: 1 }
    });
    expect(
      await test.store.save({
        kind: 'phase',
        id: 'implement',
        body: { n: 1 },
        expectedRevision: 'anything'
      })
    ).toEqual({ outcome: 'refused', reason: 'unsupported-format' });
    expect(test.fs.writeCalls).toEqual([]);
  });

  it('reports the corruption it can prove when a future format is also corrupt', async () => {
    // The format check runs AFTER the shape check on purpose: a manifest that is
    // both is reported as the thing that is demonstrably true rather than as a guess
    // about which came first.
    const test = createTestStore();
    test.fs.seed(MANIFEST, JSON.stringify({ storeFormatVersion: 9, entries: 'not an array' }));

    expect(await test.store.read()).toMatchObject({
      outcome: 'unavailable',
      fault: { fault: 'unreadable-manifest', reason: 'shape' }
    });
  });

  it('distinguishes an I/O failure from a content problem', async () => {
    // Nothing is known about the content, so no content-shaped fault would be honest.
    const test = createTestStore();
    test.fs.seed(MANIFEST, JSON.stringify({ storeFormatVersion: 1, entries: [] }));
    test.fs.failRead(MANIFEST, 'EACCES');

    expect(await test.store.read()).toEqual({
      outcome: 'unavailable',
      fault: { fault: 'unreadable-store', errno: 'EACCES' }
    });
  });

  it('carries no path in any fault it reports', async () => {
    // FR-061. The faults have no path-shaped field to begin with, which is what the
    // segment-addressed core buys; this checks the values too, including `errno`,
    // which is where a path most easily rides along from a Node error message.
    const test = createTestStore();
    test.fs.seed(MANIFEST, JSON.stringify({ storeFormatVersion: 1, entries: [] }));
    test.fs.failRead(MANIFEST, 'EACCES');

    const result = await test.store.read();
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('/');
    expect(serialised).not.toContain('\\');
  });
});
