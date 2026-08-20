// Feature 099 (FR-R3-015) T495 — the record-writing path's version algebra.
// Feature 100 (T514, FR-R3-016): the entry point is `applyLifecycleWrite` with a
// `save-draft`, not `save`. Five of the six claims below are the same claims; one
// changed, and it changed on purpose.
//
//   - **The unchanged short-circuit is against the definition's HEAD** — the draft
//     where there is one, otherwise the active version (FR-011a). Two wrong
//     implementations sit either side of it: hashing against the *whole history*
//     makes a revert silently disappear, and hashing against the *active version
//     while a draft exists* appends a record on every re-save of the same draft,
//     which is the manufactured history FR-011a forbids. Both are asserted.
//   - **Readability is asked as part of the short-circuit, not before it** — and a
//     matching hash over an unreadable record is a **repair**, not a refusal
//     (FR-011a). This is the claim that changed. Feature 099 refused such a save by
//     name (`definition-invalid`), which was defensible while every save also moved
//     the active pointer; with a draft pointer it makes an unreadable draft a dead
//     end that no save can get out of. The new answer writes the next version and
//     leaves the broken record on disk for the integrity scan.
//   - **`versionId` is `max(N) + 1`, never `length + 1`** (099 FR-005). The two agree
//     exactly until retention prunes, and then `length + 1` reissues a version id
//     that already existed.
//   - **Records are write-once** (099 FR-030). A target that already exists is a
//     refusal, never an overwrite.
//   - **A partial write stays written** (099 FR-028, FR-029). There is no compensating
//     delete on any path, so the record left behind is collectable and the
//     definition still resolves at its previous version.
//   - **Retention runs on a draft write as well as on a publication** (FR-021), and
//     the pending draft is exempt from it.
//
// All of it runs against the real store on in-memory ports, so the code under test
// is the code that ships.

import { beforeEach, describe, expect, it } from 'vitest';

import type { CatalogStore } from '../../../src/catalog';
import { versionSegments } from '../../../src/catalog/catalog-paths';
import { draftTokenOf, type ExpectedDraftVersion } from '../../../src/contracts/catalog-lifecycle';
import type {
  CatalogKind,
  CatalogManifest,
  CatalogManifestEntry,
  LifecycleWriteOutcome
} from '../../../src/contracts/catalog-store';
import {
  createTestStore,
  keyOf,
  type MemoryCatalogFs,
  type TestStore
} from '../../fixtures/catalog-memory-fs';

const MANIFEST_KEY = 'manifest.json';

/** The revision, for the two claims that are about it not moving. */
async function revisionOf(store: CatalogStore, kind: CatalogKind): Promise<string> {
  const result = await store.read();
  if (result.outcome !== 'read') throw new Error(`store unreadable: ${result.fault.fault}`);
  return result.snapshot.revisions[kind];
}

/**
 * The draft token the store currently holds for one definition (FR-012).
 *
 * The gate is exercised on its own in the concurrency suite; here it would only add
 * a read to every arrangement. The read is charged to `fs.calls`, so tests that
 * count writes clear the log after arranging.
 */
async function tokenOf(
  store: CatalogStore,
  kind: CatalogKind,
  id: string
): Promise<ExpectedDraftVersion> {
  const result = await store.read();
  if (result.outcome !== 'read') throw new Error(`store unreadable: ${result.fault.fault}`);
  const found = result.snapshot.definitions.find(
    (definition) => definition.kind === kind && definition.id === id
  );
  return draftTokenOf(found?.draftVersionId ?? null);
}

/** Write a draft at whatever token the store is currently at. */
async function saveNext(
  test: TestStore,
  id: string,
  body: unknown,
  kind: CatalogKind = 'phase'
): Promise<LifecycleWriteOutcome> {
  return test.store.applyLifecycleWrite({
    op: 'save-draft',
    kind,
    id,
    body,
    expectedDraftVersion: await tokenOf(test.store, kind, id)
  });
}

/** Publish whatever draft is pending, so the definition has an active version. */
async function publishNext(
  test: TestStore,
  id: string,
  kind: CatalogKind = 'phase'
): Promise<LifecycleWriteOutcome> {
  return test.store.applyLifecycleWrite({
    op: 'publish',
    kind,
    id,
    expectedDraftVersion: await tokenOf(test.store, kind, id)
  });
}

/** The durable manifest, read back off the fake disk. */
function manifestOf(fs: MemoryCatalogFs): CatalogManifest {
  const text = fs.files.get(MANIFEST_KEY);
  if (text === undefined) throw new Error('no manifest on disk');
  return JSON.parse(text) as CatalogManifest;
}

function entryOf(fs: MemoryCatalogFs, kind: CatalogKind, id: string): CatalogManifestEntry {
  const entry = manifestOf(fs).entries.find((row) => row.kind === kind && row.id === id);
  if (entry === undefined) throw new Error(`no manifest entry for ${kind}/${id}`);
  return entry;
}

function versionIdsOf(fs: MemoryCatalogFs, kind: CatalogKind, id: string): readonly string[] {
  return entryOf(fs, kind, id).versions.map((version) => version.versionId);
}

describe('catalog store: a definition gains a history', () => {
  let test: TestStore;

  beforeEach(() => {
    test = createTestStore();
  });

  it('writes the record before the manifest, so a crash between them is collectable', async () => {
    test.fs.calls.length = 0;
    const outcome = await saveNext(test, 'implement', { name: 'Implement' });

    expect(outcome).toMatchObject({
      outcome: 'written',
      writtenVersionId: 'v1',
      draftVersionId: 'v1',
      // A draft write moves no active pointer, which is the whole of FR-013: nothing
      // has become triggerable.
      activeVersionId: null,
      publishedAt: null,
      pruned: []
    });
    // Record first, manifest second (099 FR-024). The reverse order leaves a manifest
    // entry pointing at nothing, which is a dangling record and presents the
    // definition as unreadable; this order leaves a collectable record and a
    // catalog that is still healthy.
    expect(test.fs.writeCalls.map((call) => call.key)).toEqual([
      'phases/implement/v1.json',
      MANIFEST_KEY
    ]);
  });

  it('numbers each effective draft write one higher than the last', async () => {
    expect(await saveNext(test, 'implement', { n: 1 })).toMatchObject({ writtenVersionId: 'v1' });
    expect(await saveNext(test, 'implement', { n: 2 })).toMatchObject({ writtenVersionId: 'v2' });
    expect(await saveNext(test, 'implement', { n: 3 })).toMatchObject({ writtenVersionId: 'v3' });
    expect(versionIdsOf(test.fs, 'phase', 'implement')).toEqual(['v1', 'v2', 'v3']);
  });

  it('keeps each kind in its own directory and its own id space', async () => {
    await saveNext(test, 'shared', { n: 1 }, 'phase');
    await saveNext(test, 'shared', { n: 1 }, 'pipeline');
    await saveNext(test, 'shared', { n: 1 }, 'workflow');

    expect([...test.fs.files.keys()].sort()).toEqual([
      MANIFEST_KEY,
      'phases/shared/v1.json',
      'pipelines/shared/v1.json',
      'workflows/shared/v1.json'
    ]);
    // Same id, three kinds, all at v1: the version counter is per definition, not
    // per store and not per id.
    for (const kind of ['phase', 'pipeline', 'workflow'] as const) {
      expect(versionIdsOf(test.fs, kind, 'shared')).toEqual(['v1']);
    }
  });

  it('stores the body verbatim and validates nothing about it', async () => {
    // The store stores and returns bodies (099 FR-010, FR-011). This one would be
    // rejected by every Phase validator in the codebase.
    const body = { not: 'a phase', phaseId: 42, extra: [null, {}] };
    await saveNext(test, 'anything', body);

    const read = await test.store.readVersion('phase', 'anything', 'v1');
    expect(read).toMatchObject({ outcome: 'read', record: { body } });
  });

  it('stamps publishedAt on the publication and on nothing else', async () => {
    // FR-020. `createdAt` answers "when was this written"; `publishedAt` answers
    // "when did this become live", and a version that never became live has none.
    await saveNext(test, 'implement', { n: 1 });
    expect(entryOf(test.fs, 'phase', 'implement').versions[0]?.publishedAt).toBeNull();

    test.clock.advance(5_000);
    const published = await publishNext(test, 'implement');

    expect(published).toMatchObject({
      outcome: 'written',
      activeVersionId: 'v1',
      // Publishing clears the draft pointer in the same write (FR-005, FR-020).
      draftVersionId: null,
      writtenVersionId: null
    });
    expect(entryOf(test.fs, 'phase', 'implement').versions[0]?.publishedAt).not.toBeNull();
  });
});

describe('catalog store: the unchanged short-circuit', () => {
  let test: TestStore;

  beforeEach(() => {
    test = createTestStore();
  });

  it('reports unchanged and writes nothing when the body hashes equal to the pending draft', async () => {
    await saveNext(test, 'implement', { name: 'Implement', order: ['a', 'b'] });
    test.fs.calls.length = 0;

    const outcome = await saveNext(test, 'implement', { name: 'Implement', order: ['a', 'b'] });

    expect(outcome).toMatchObject({ outcome: 'unchanged', versionId: 'v1' });
    // Opening an editor and closing it must not manufacture history (FR-011a). Not
    // "wrote a version and then removed it" — never wrote at all. This is also the
    // case that rules out comparing against the active version: there is no active
    // version here, so an active-only comparison would append v2.
    expect(test.fs.writeCalls).toEqual([]);
    expect(test.fs.callsOf('remove')).toEqual([]);
  });

  it('reports unchanged against the active version once there is no draft', async () => {
    // The other half of "head": with the draft pointer cleared by a publication, the
    // head is the active version, and re-saving the live body still appends nothing.
    await saveNext(test, 'implement', { n: 1 });
    await publishNext(test, 'implement');
    test.fs.calls.length = 0;

    expect(await saveNext(test, 'implement', { n: 1 })).toMatchObject({
      outcome: 'unchanged',
      versionId: 'v1'
    });
    expect(test.fs.writeCalls).toEqual([]);
  });

  it('treats a key reordered and an optional dropped-as-undefined as the same body', async () => {
    await saveNext(test, 'implement', { name: 'Implement', timeout: 30 });
    test.fs.calls.length = 0;

    // What a round trip through the webview boundary produces: the same body with
    // its keys in insertion order and an absent optional present as `undefined`.
    const outcome = await saveNext(test, 'implement', {
      timeout: 30,
      name: 'Implement',
      note: undefined
    });

    expect(outcome).toMatchObject({ outcome: 'unchanged' });
    expect(test.fs.writeCalls).toEqual([]);
  });

  it('does not move updatedAt on an unchanged save', async () => {
    await saveNext(test, 'implement', { n: 1 });
    const before = entryOf(test.fs, 'phase', 'implement').updatedAt;

    test.clock.advance(60_000);
    expect(await saveNext(test, 'implement', { n: 1 })).toMatchObject({ outcome: 'unchanged' });

    // 099 FR-020. `updatedAt` is the last *effective* write; the short-circuit returns
    // before the manifest is touched, so this holds by construction rather than by
    // a rule someone has to remember.
    expect(entryOf(test.fs, 'phase', 'implement').updatedAt).toBe(before);
  });

  it('treats a revert to an older body as a change and gives it a new version', async () => {
    // 099 FR-015, and the reason the comparison is against one pointer rather than the
    // history. An implementation that hashed against the whole history would report
    // `unchanged` here and silently lose the operator's revert.
    await saveNext(test, 'implement', { n: 'first' });
    await saveNext(test, 'implement', { n: 'second' });

    const outcome = await saveNext(test, 'implement', { n: 'first' });

    expect(outcome).toMatchObject({ outcome: 'written', writtenVersionId: 'v3' });
    const versions = entryOf(test.fs, 'phase', 'implement').versions;
    expect(versions.map((version) => version.versionId)).toEqual(['v1', 'v2', 'v3']);
    // v3 is a distinct version whose content happens to equal v1's. Equal hashes,
    // separate history entries: the store records what happened, not a set of
    // distinct states.
    expect(versions[2]?.contentHash).toBe(versions[0]?.contentHash);
    expect(versions[2]?.contentHash).not.toBe(versions[1]?.contentHash);
    expect(test.fs.files.has('phases/implement/v3.json')).toBe(true);
  });

  it('writes the repair rather than reporting unchanged when the head record is missing', async () => {
    // Two things must hold to conclude nothing changed: the manifest says this body
    // is already there, AND the record it describes is readable. Here the first holds
    // and the second does not, so the write proceeds and the new version IS the
    // repair — a pointer with a record that can be read.
    //
    // Feature 099 refused this by name. That answer made an unreadable draft a dead
    // end: no save could replace it, because every save hashing equal to it was
    // refused and every save differing from it left the broken pointer in place.
    await saveNext(test, 'implement', { n: 1 });
    test.fs.unlink(versionSegments('phase', 'implement', 'v1'));
    test.fs.calls.length = 0;

    const outcome = await saveNext(test, 'implement', { n: 1 });

    expect(outcome).toMatchObject({
      outcome: 'written',
      writtenVersionId: 'v2',
      draftVersionId: 'v2'
    });
    // Records are write-once, so the repair overwrites nothing and compounds no
    // fault (099 FR-030): the broken v1 is still named by the history and the
    // integrity scan keeps reporting it. Nothing is deleted here either.
    expect(versionIdsOf(test.fs, 'phase', 'implement')).toEqual(['v1', 'v2']);
    expect(test.fs.callsOf('remove')).toEqual([]);
  });
});

describe('catalog store: records are write-once', () => {
  it('refuses when a record already sits at the target version id', async () => {
    const test = createTestStore();
    await saveNext(test, 'implement', { n: 1 });

    // A leftover from an interrupted save, or a file an operator dropped in. Either
    // way the next version id is claimed, and a record is never overwritten
    // (099 FR-030).
    const claimed = versionSegments('phase', 'implement', 'v2');
    test.fs.seed(claimed, '{"hand":"written"}');
    test.fs.calls.length = 0;

    const outcome = await saveNext(test, 'implement', { n: 2 });

    expect(outcome).toEqual({ outcome: 'refused', reason: 'version-exists' });
    // Untouched, and the manifest never learned about v2 — the id is not reissued
    // and nothing is repaired here.
    expect(test.fs.files.get(keyOf(claimed))).toBe('{"hand":"written"}');
    expect(versionIdsOf(test.fs, 'phase', 'implement')).toEqual(['v1']);
    expect(test.fs.callsOf('remove')).toEqual([]);
  });
});

describe('catalog store: an interrupted write stays written', () => {
  it('reports partial when the manifest write fails and leaves the record on disk', async () => {
    const test = createTestStore();
    await saveNext(test, 'implement', { n: 1 });

    test.fs.failWrite(['manifest.json'], 'EIO');
    test.fs.calls.length = 0;
    const outcome = await saveNext(test, 'implement', { n: 2 });

    expect(outcome).toEqual({ outcome: 'partial', wrote: ['v2'], errno: 'EIO' });
    // 099 FR-029: no compensating delete on any path. The record that landed stays
    // landed, and the store does not try to tidy up after itself.
    expect(test.fs.files.has('phases/implement/v2.json')).toBe(true);
    expect(test.fs.callsOf('remove')).toEqual([]);
  });

  it('leaves the definition resolving at its previous version, with the orphan collectable', async () => {
    const test = createTestStore();
    await saveNext(test, 'implement', { n: 1 });
    await publishNext(test, 'implement');
    test.fs.failWrite(['manifest.json'], 'EIO');
    await saveNext(test, 'implement', { n: 2 });

    const result = await test.store.read();
    expect(result.outcome).toBe('read');
    if (result.outcome !== 'read') return;

    // The catalog is healthy: v2 is a record the manifest does not name, which is
    // collectable and NOT a fault (099 FR-026). Collection is the operator's decision.
    expect(result.snapshot.faults).toEqual([]);
    expect(result.snapshot.collectable).toEqual([
      { kind: 'phase', id: 'implement', versionId: 'v2' }
    ]);
    expect(result.snapshot.definitions).toMatchObject([
      {
        kind: 'phase',
        id: 'implement',
        status: 'effective',
        activeVersionId: 'v1',
        body: { n: 1 },
        // The failed draft write did not move the draft pointer either, so the
        // definition is back to plain Active and the operator's edit is unrecorded.
        draftVersionId: null
      }
    ]);
  });

  it('reports partial with nothing written when the record write itself fails', async () => {
    const test = createTestStore();
    await saveNext(test, 'implement', { n: 1 });
    const revisionBefore = await revisionOf(test.store, 'phase');

    test.fs.failWrite(['phases', 'implement', 'v2.json'], 'ENOSPC');
    const outcome = await saveNext(test, 'implement', { n: 2 });

    // `wrote` is empty when nothing landed at all. Same instruction to the caller
    // either way: report it, do not tidy up.
    expect(outcome).toEqual({ outcome: 'partial', wrote: [], errno: 'ENOSPC' });
    expect(test.fs.files.has('phases/implement/v2.json')).toBe(false);
    // The manifest was never reached, so the revision did not move and the other
    // window's in-flight package publish is not spuriously stale.
    expect(await revisionOf(test.store, 'phase')).toBe(revisionBefore);
  });
});

describe('catalog store: version ids survive a prune', () => {
  it('derives the next version from the highest id, not from how many are retained', async () => {
    // 52 effective writes against a bound of 50. Retention prunes v1 on the 51st and
    // v2 on the 52nd, so the retained window is v3-v52: fifty versions whose ids run
    // to 52. `length + 1` would then reissue v51, which already exists — and because
    // records are write-once, the store would refuse its own next save forever.
    const test = createTestStore();
    for (let n = 1; n <= 52; n += 1) {
      const outcome = await saveNext(test, 'implement', { n });
      expect(outcome).toMatchObject({ outcome: 'written', writtenVersionId: `v${n}` });
    }

    const retained = versionIdsOf(test.fs, 'phase', 'implement');
    expect(retained).toHaveLength(50);
    expect(retained[0]).toBe('v3');
    expect(retained.at(-1)).toBe('v52');

    expect(await saveNext(test, 'implement', { n: 53 })).toMatchObject({
      outcome: 'written',
      writtenVersionId: 'v53',
      pruned: ['v3']
    });
  });

  it('removes the pruned records from disk and reports what left the history', async () => {
    const test = createTestStore();
    for (let n = 1; n <= 51; n += 1) await saveNext(test, 'implement', { n });

    // Reported oldest first, which is the prune order (099 FR-035).
    expect(test.fs.files.has('phases/implement/v1.json')).toBe(false);
    expect(test.fs.files.has('phases/implement/v2.json')).toBe(true);
    // Pruning happens after the manifest write, so the manifest has already stopped
    // naming v1 by the time the file goes — a crash in between leaves a collectable
    // record rather than a dangling reference.
    const removes = test.fs.callsOf('remove').map((call) => call.key);
    expect(removes).toEqual(['phases/implement/v1.json']);
  });

  it('leaves history alone while it is at the bound', async () => {
    const test = createTestStore();
    for (let n = 1; n <= 50; n += 1) {
      expect(await saveNext(test, 'implement', { n })).toMatchObject({ pruned: [] });
    }
    expect(versionIdsOf(test.fs, 'phase', 'implement')).toHaveLength(50);
    expect(test.fs.callsOf('remove')).toEqual([]);
  });

  it('never prunes the pending draft, even when it is the oldest retained version', async () => {
    // FR-021. The draft is work in progress that nothing else holds a copy of, so
    // pruning it would discard an edit the operator has not published and cannot
    // recover. Reached by publishing v1 and then filling the history past the bound:
    // the draft is exempt by pointer, not by age.
    const test = createTestStore();
    await saveNext(test, 'implement', { n: 1 });
    await publishNext(test, 'implement');
    for (let n = 2; n <= 52; n += 1) await saveNext(test, 'implement', { n });

    const retained = versionIdsOf(test.fs, 'phase', 'implement');
    expect(retained).toHaveLength(50);
    // v1 is the active version and v52 is the pending draft; both survive, and what
    // retention took came from between them.
    expect(retained).toContain('v1');
    expect(retained).toContain('v52');
  });
});
