// Feature 100 (FR-R3-016) T514 — two windows on one workspace (FR-012, FR-030, SC-019).
//
// The store adds no lock. The expected-**draft-version** gate is the whole of its
// concurrency control for a single definition, and beneath it `flag: 'wx'` on the
// version record is the backstop the kernel arbitrates. Both claims are about a real
// filesystem: a fake enforces write-once by consulting a Map, which is a
// check-then-act — the very race the real primitive exists to close.
//
// What feature 100 changed here, and why it is a rewrite rather than a rename:
// feature 099 gated every write on the **per-kind revision**, so saving any Phase
// invalidated every other Phase editor's read. The gate is now the one definition's
// **draft pointer** (FR-012), which is both narrower and differently shaped:
//
//   - Two windows editing *different* definitions no longer collide at all, where
//     before one of them was told it was stale.
//   - A publication or a deactivation — even of the same definition — does not
//     invalidate an in-flight edit, because the gate reads the draft pointer only.
//   - The refusal carries the pointer pair the write actually loaded rather than a
//     revision string, so the loser learns which pointer moved.
//
// The per-kind revision survives, but only for the two **layer** writes (FR-036),
// where one manifest write covers many definitions. That gate is asserted here too,
// because "per kind" is now a claim about a different pair of methods than the one
// the 099 suite made it about.
//
// The cross-definition case is the documented boundary rather than a defect, and
// feature 100 WIDENED it: with a per-definition gate, any two definitions can now be
// written concurrently past their own gates into one shared manifest file, where the
// spec's assumptions record last-writer-wins. So the invariant in the last test —
// every record on disk is either history or debris, never unaccounted for — carries
// more weight than it did, not less.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CatalogStore } from '../../src/catalog';
import type { CatalogKind } from '../../src/contracts/catalog-store';
import { createCatalogFsAdapter } from '../../src/lib/catalog-fs-adapter';
import {
  activate,
  createWorkspace,
  draftTokenFor,
  openStore,
  removeWorkspace,
  storeRootOf,
  treeOf
} from '../fixtures/catalog-real-fs';

async function revisionOf(store: CatalogStore, kind: CatalogKind): Promise<string> {
  const result = await store.read();
  if (result.outcome !== 'read') throw new Error(`store unreadable: ${result.fault.fault}`);
  return result.snapshot.revisions[kind];
}

async function versionIdsOf(store: CatalogStore, kind: CatalogKind, id: string): Promise<string[]> {
  return (await store.listVersions(kind, id)).map((version) => version.versionId);
}

/** One draft save at whatever token the window can currently see. */
async function saveDraft(store: CatalogStore, kind: CatalogKind, id: string, body: unknown) {
  return await store.applyLifecycleWrite({
    op: 'save-draft',
    kind,
    id,
    body,
    expectedDraftVersion: await draftTokenFor(store, kind, id)
  });
}

describe('Feature 100 — two windows drafting one definition (T514)', () => {
  let workspaceRoot: string;
  /** Two independent stores over one directory. They share nothing but the bytes. */
  let windowA: CatalogStore;
  let windowB: CatalogStore;

  beforeEach(async () => {
    workspaceRoot = await createWorkspace('concurrency');
    windowA = openStore(workspaceRoot);
    windowB = openStore(workspaceRoot);
    // A live definition, which is the state two editors would actually open onto:
    // active at v1, no pending draft, so both windows read the token `no-draft`.
    await activate(windowA, 'phase', 'implement', { n: 1 });
  });

  afterEach(async () => {
    await removeWorkspace(workspaceRoot);
  });

  it('writes the first draft and refuses the second as stale', async () => {
    // Deterministic form: both windows read, then both save. The second holds a
    // draft token the first has already superseded.
    const shared = await draftTokenFor(windowA, 'phase', 'implement');
    expect(await draftTokenFor(windowB, 'phase', 'implement')).toBe(shared);
    expect(shared).toBe('no-draft');

    const first = await windowA.applyLifecycleWrite({
      op: 'save-draft',
      kind: 'phase',
      id: 'implement',
      body: { n: 2, from: 'A' },
      expectedDraftVersion: shared
    });
    const second = await windowB.applyLifecycleWrite({
      op: 'save-draft',
      kind: 'phase',
      id: 'implement',
      body: { n: 2, from: 'B' },
      expectedDraftVersion: shared
    });

    expect(first).toMatchObject({ outcome: 'written', writtenVersionId: 'v2', draftVersionId: 'v2' });
    expect(second).toMatchObject({ outcome: 'stale' });
    if (second.outcome !== 'stale') return;
    // The refusal carries the pointer pair the write loaded, so the loser can say
    // which pointer moved without a second read that would be a different manifest
    // and a different answer (FR-012).
    expect(second.pointers).toEqual({
      draftVersionId: 'v2',
      activeVersionId: 'v1',
      present: true
    });

    // Exactly one new version, and it is the winner's content. B's body is nowhere.
    expect(await versionIdsOf(windowA, 'phase', 'implement')).toEqual(['v1', 'v2']);
    expect(await windowA.readVersion('phase', 'implement', 'v2')).toMatchObject({
      record: { body: { n: 2, from: 'A' } }
    });
    for (const file of (await treeOf(storeRootOf(workspaceRoot))).files) {
      expect(await readFile(join(storeRootOf(workspaceRoot), file), 'utf8')).not.toContain('"B"');
    }
  });

  it('lets the refused window retry successfully once it re-reads', async () => {
    // A refusal that cannot be recovered from is a lock with extra steps. The
    // second window re-reads, sees the draft the first one left, and writes over it
    // — over the POINTER, that is: v2 stays in history and the new draft is v3,
    // because records are write-once (FR-030).
    const shared = await draftTokenFor(windowA, 'phase', 'implement');
    await windowA.applyLifecycleWrite({
      op: 'save-draft',
      kind: 'phase',
      id: 'implement',
      body: { n: 2, from: 'A' },
      expectedDraftVersion: shared
    });
    const refused = await windowB.applyLifecycleWrite({
      op: 'save-draft',
      kind: 'phase',
      id: 'implement',
      body: { n: 3, from: 'B' },
      expectedDraftVersion: shared
    });
    expect(refused.outcome).toBe('stale');

    const retried = await saveDraft(windowB, 'phase', 'implement', { n: 3, from: 'B' });

    expect(retried).toMatchObject({
      outcome: 'written',
      writtenVersionId: 'v3',
      draftVersionId: 'v3',
      activeVersionId: 'v1'
    });
    expect(await versionIdsOf(windowA, 'phase', 'implement')).toEqual(['v1', 'v2', 'v3']);
  });

  it('refuses a publication whose draft another window has already moved', async () => {
    // The gate is not only about the save path. B reads a draft, A saves over it, and
    // B's publish would otherwise make a version live that its operator never saw —
    // silently publishing someone else's edit (FR-012, US6 AS3).
    await saveDraft(windowA, 'phase', 'implement', { n: 2, from: 'A' });
    const seenByB = await draftTokenFor(windowB, 'phase', 'implement');
    await saveDraft(windowA, 'phase', 'implement', { n: 3, from: 'A' });

    const outcome = await windowB.applyLifecycleWrite({
      op: 'publish',
      kind: 'phase',
      id: 'implement',
      expectedDraftVersion: seenByB
    });

    expect(outcome).toMatchObject({ outcome: 'stale' });
    // Nothing became live: the active pointer is still v1.
    const result = await windowB.read();
    expect(result.outcome).toBe('read');
    if (result.outcome !== 'read') return;
    expect(result.snapshot.definitions[0]).toMatchObject({
      activeVersionId: 'v1',
      draftVersionId: 'v3'
    });
  });

  it('does not invalidate an in-flight edit of a different definition', async () => {
    // The gate feature 100 narrowed. Under 099 both of these held the same per-kind
    // revision and the second was refused; the draft pointer of `plan` says nothing
    // about `implement`, so both windows now proceed. Stated as a test because
    // widening a gate back out would break nothing else.
    await activate(windowA, 'phase', 'plan', { n: 1 });
    const tokenForImplement = await draftTokenFor(windowB, 'phase', 'implement');

    await saveDraft(windowA, 'phase', 'plan', { n: 2 });

    expect(
      await windowB.applyLifecycleWrite({
        op: 'save-draft',
        kind: 'phase',
        id: 'implement',
        body: { n: 2 },
        expectedDraftVersion: tokenForImplement
      })
    ).toMatchObject({ outcome: 'written' });
  });

  it('does not invalidate an in-flight edit when the active pointer moves under it', async () => {
    // The gate reads the DRAFT pointer only (FR-012). A deactivation moves the active
    // pointer, which is not what the editor's read was about — and refusing here
    // would throw away an operator's pending work to report a state change they did
    // not make.
    //
    // Arranged with a draft already pending, because FR-024a makes a deactivation of
    // an UNdrafted definition move the draft pointer too: it parks the formerly
    // active version there, so `no-draft` would be genuinely stale and the test would
    // be asserting the opposite of what it says. With a draft pending there is nothing
    // to park, and the draft pointer is left exactly where it was.
    await saveDraft(windowA, 'phase', 'implement', { n: 2, from: 'A' });
    const draftToken = await draftTokenFor(windowB, 'phase', 'implement');
    expect(draftToken).toBe('v2');

    expect(
      await windowA.applyLifecycleWrite({
        op: 'deactivate',
        kind: 'phase',
        id: 'implement',
        expectedDraftVersion: draftToken
      })
    ).toMatchObject({ outcome: 'written', activeVersionId: null, draftVersionId: 'v2' });

    expect(
      await windowB.applyLifecycleWrite({
        op: 'save-draft',
        kind: 'phase',
        id: 'implement',
        body: { n: 3, from: 'B' },
        expectedDraftVersion: draftToken
      })
    ).toMatchObject({ outcome: 'written', writtenVersionId: 'v3' });
  });

  it('produces exactly one new version when the two saves genuinely overlap', async () => {
    // The interleaving here is real and not controlled: whichever window loses may
    // lose at the draft gate or at the record write, and which arm it lands on
    // depends on scheduling. The invariant is the same either way and is what
    // SC-019 actually asserts — so it is stated that way rather than pinned to one
    // arm that a faster disk would flip.
    const shared = await draftTokenFor(windowA, 'phase', 'implement');

    const [first, second] = await Promise.all([
      windowA.applyLifecycleWrite({
        op: 'save-draft',
        kind: 'phase',
        id: 'implement',
        body: { n: 2, from: 'A' },
        expectedDraftVersion: shared
      }),
      windowB.applyLifecycleWrite({
        op: 'save-draft',
        kind: 'phase',
        id: 'implement',
        body: { n: 2, from: 'B' },
        expectedDraftVersion: shared
      })
    ]);

    const written = [first, second].filter((outcome) => outcome.outcome === 'written');
    const rejected = [first, second].filter((outcome) => outcome.outcome !== 'written');
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ writtenVersionId: 'v2' });
    // Both refusals are refusals: the loser is never told it wrote, and never
    // reports a partial write, which would mean a record landed without a manifest.
    expect(['stale', 'refused']).toContain(rejected[0]!.outcome);

    expect(await versionIdsOf(windowA, 'phase', 'implement')).toEqual(['v1', 'v2']);
    const cold = openStore(workspaceRoot);
    const result = await cold.read();
    expect(result.outcome).toBe('read');
    if (result.outcome !== 'read') return;
    expect(result.snapshot.faults).toEqual([]);
  });

  it('introduces no lock file, of any shape, anywhere in the store', async () => {
    // FR-030a and SC-019's third clause. A lock would also be the first thing in
    // the store that is neither the manifest nor a record, so the assertion is over
    // the whole directory rather than over a list of names a lock might take.
    const shared = await draftTokenFor(windowA, 'phase', 'implement');
    await Promise.all([
      windowA.applyLifecycleWrite({
        op: 'save-draft',
        kind: 'phase',
        id: 'implement',
        body: { from: 'A' },
        expectedDraftVersion: shared
      }),
      windowB.applyLifecycleWrite({
        op: 'save-draft',
        kind: 'phase',
        id: 'implement',
        body: { from: 'B' },
        expectedDraftVersion: shared
      }),
      windowA.applyLifecycleWrite({
        op: 'save-draft',
        kind: 'pipeline',
        id: 'standard',
        body: { from: 'A' },
        expectedDraftVersion: 'no-draft'
      })
    ]);

    const tree = await treeOf(storeRootOf(workspaceRoot));
    for (const file of tree.files) {
      expect(file === 'manifest.json' || /^(phases|pipelines|workflows)\/[^/]+\/v\d+\.json$/.test(file)).toBe(
        true
      );
    }
  });
});

describe('Feature 100 — write-once is the kernel, not a check (T514, FR-030)', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await createWorkspace('write-once');
  });

  afterEach(async () => {
    await removeWorkspace(workspaceRoot);
  });

  it('gives exactly one winner when many writers race for one path', async () => {
    // `flag: 'wx'` is `O_EXCL`: the existence test and the creation are one
    // syscall. Eight concurrent writers, one file, one winner — and the file holds
    // the winner's bytes rather than a mixture.
    const adapter = createCatalogFsAdapter(storeRootOf(workspaceRoot));
    const at = ['phases', 'implement', 'v1.json'];

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        adapter.writeFileIfAbsent(at, JSON.stringify({ writer: index }))
      )
    );

    expect(outcomes.filter((outcome) => outcome.outcome === 'written')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.outcome === 'exists')).toHaveLength(7);

    const contents = await readFile(join(storeRootOf(workspaceRoot), ...at), 'utf8');
    const parsed = JSON.parse(contents) as { writer: number };
    expect(outcomes[parsed.writer]).toEqual({ outcome: 'written' });
    expect((await treeOf(storeRootOf(workspaceRoot))).files).toEqual([
      'phases/implement/v1.json'
    ]);
  });

  it('refuses to write over a record left behind by a crashed save', async () => {
    // The deterministic form of the same race: an orphaned `v2.json` from a save
    // that wrote its record and died before its manifest. The next save computes
    // v2 from the manifest, finds the path taken, and refuses by name — it does not
    // overwrite, and it does not silently skip to v3 (FR-016, FR-030).
    const store = openStore(workspaceRoot);
    await activate(store, 'phase', 'implement', { n: 1 });

    const orphanPath = join(storeRootOf(workspaceRoot), 'phases', 'implement', 'v2.json');
    await mkdir(join(storeRootOf(workspaceRoot), 'phases', 'implement'), { recursive: true });
    await writeFile(orphanPath, '{"versionId":"v2","kind":"phase","id":"implement","body":{"crashed":true}}');

    const outcome = await saveDraft(store, 'phase', 'implement', { n: 2 });

    expect(outcome).toEqual({ outcome: 'refused', reason: 'version-exists' });
    // The orphan is untouched. Deleting it to make room would be a compensating
    // delete of content the store did not write and cannot account for (FR-029).
    expect(await readFile(orphanPath, 'utf8')).toContain('"crashed":true');
    expect(await versionIdsOf(store, 'phase', 'implement')).toEqual(['v1']);

    // And it reads as collectable rather than as a fault: an unreferenced record is
    // debris, not corruption (FR-026).
    const result = await store.read();
    expect(result.outcome).toBe('read');
    if (result.outcome !== 'read') return;
    expect(result.snapshot.faults).toEqual([]);
    expect(result.snapshot.collectable).toEqual([
      { kind: 'phase', id: 'implement', versionId: 'v2' }
    ]);
  });
});

describe('Feature 100 — the layer gate is per kind, and the manifest is one file', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await createWorkspace('per-kind');
  });

  afterEach(async () => {
    await removeWorkspace(workspaceRoot);
  });

  it('does not make a pipeline layer write stale because a phase layer was written', async () => {
    // FR-036, now the layer writes' gate rather than every write's. One revision per
    // kind, derived from the manifest's stored state for that kind, so importing a
    // Phase package does not invalidate a Pipeline import in flight.
    const store = openStore(workspaceRoot);
    const pipelineRevision = await revisionOf(store, 'pipeline');

    expect(
      await store.saveDraftLayer({
        kind: 'phase',
        definitions: [{ id: 'implement', body: { n: 1 } }],
        expectedRevision: await revisionOf(store, 'phase')
      })
    ).toMatchObject({ outcome: 'saved' });

    expect(await revisionOf(store, 'pipeline')).toBe(pipelineRevision);
    expect(
      await store.saveDraftLayer({
        kind: 'pipeline',
        definitions: [{ id: 'standard', body: { phases: ['implement'] } }],
        expectedRevision: pipelineRevision
      })
    ).toMatchObject({ outcome: 'saved', versions: [{ id: 'standard', versionId: 'v1' }] });
  });

  it('refuses a layer write whose kind has moved on, and names the authoritative revision', async () => {
    // The other half of the same gate: within one kind, a layer write is refused when
    // the kind's stored state changed under it, so a package import cannot merge into
    // a manifest it never read.
    const windowA = openStore(workspaceRoot);
    const windowB = openStore(workspaceRoot);
    const shared = await revisionOf(windowA, 'phase');

    await windowA.saveDraftLayer({
      kind: 'phase',
      definitions: [{ id: 'implement', body: { n: 1 } }],
      expectedRevision: shared
    });
    const second = await windowB.saveDraftLayer({
      kind: 'phase',
      definitions: [{ id: 'plan', body: { n: 1 } }],
      expectedRevision: shared
    });

    expect(second).toEqual({
      outcome: 'stale',
      actualRevision: await revisionOf(windowB, 'phase')
    });
    // And the loser's content is nowhere: `plan` was never written.
    expect(await versionIdsOf(windowB, 'phase', 'plan')).toEqual([]);
  });

  it('composes two kinds written one after the other, from revisions read up front', async () => {
    // The per-kind revision could have been a way to lose an entry: two windows
    // holding revisions from before either wrote, writing into one shared manifest.
    // It is not, because each write re-reads the manifest inside the call rather than
    // trusting the snapshot the revision came from — so the second write's manifest
    // is built on the first write's result even though its gate never looked at it.
    const windowA = openStore(workspaceRoot);
    const windowB = openStore(workspaceRoot);
    const phaseRevision = await revisionOf(windowA, 'phase');
    const pipelineRevision = await revisionOf(windowB, 'pipeline');

    expect(
      await windowA.saveDraftLayer({
        kind: 'phase',
        definitions: [{ id: 'implement', body: { n: 1 } }],
        expectedRevision: phaseRevision
      })
    ).toMatchObject({ outcome: 'saved' });
    expect(
      await windowB.saveDraftLayer({
        kind: 'pipeline',
        definitions: [{ id: 'standard', body: { n: 1 } }],
        expectedRevision: pipelineRevision
      })
    ).toMatchObject({ outcome: 'saved' });

    const cold = openStore(workspaceRoot);
    const result = await cold.read();
    expect(result.outcome).toBe('read');
    if (result.outcome !== 'read') return;
    expect(result.snapshot.definitions.map((definition) => definition.kind)).toEqual([
      'phase',
      'pipeline'
    ]);
    expect(result.snapshot.faults).toEqual([]);
    expect(result.snapshot.collectable).toEqual([]);
  });

  it('accounts for every record it wrote even when two definitions overlap in flight', async () => {
    // The documented boundary, and the reason it is stated as an invariant rather
    // than as an outcome. Feature 100 widened it: with a per-definition gate, two
    // saves of *different definitions* both pass their own gates — of the same kind
    // or not — so the only thing serialising them is the manifest write, and if both
    // loaded the manifest before either wrote it, the later write is built from the
    // earlier state and the first entry is not in it. The spec's own assumptions
    // record this as last-writer-wins on the manifest, and FR-030a rules out the lock
    // that would close it.
    //
    // What the store must do is stay honest: never fault, never delete, and account
    // for every record on disk as either history or debris. A record that is
    // neither — present, unnamed, and unreported — is the failure this pins.
    const windowA = openStore(workspaceRoot);
    const windowB = openStore(workspaceRoot);

    await Promise.all([
      windowA.applyLifecycleWrite({
        op: 'save-draft',
        kind: 'phase',
        id: 'implement',
        body: { n: 1 },
        expectedDraftVersion: 'no-draft'
      }),
      windowB.applyLifecycleWrite({
        op: 'save-draft',
        kind: 'phase',
        id: 'plan',
        body: { n: 1 },
        expectedDraftVersion: 'no-draft'
      })
    ]);

    const cold = openStore(workspaceRoot);
    const result = await cold.read();
    expect(result.outcome).toBe('read');
    if (result.outcome !== 'read') return;
    expect(result.snapshot.faults).toEqual([]);

    const named = new Set(
      result.snapshot.definitions.flatMap((definition) =>
        definition.versions.map((version) => `${definition.kind}/${definition.id}/${version.versionId}`)
      )
    );
    const debris = new Set(
      result.snapshot.collectable.map(
        (record) => `${record.kind}/${record.id}/${record.versionId}`
      )
    );
    const onDisk = (await treeOf(storeRootOf(workspaceRoot))).files.filter(
      (file) => file !== 'manifest.json'
    );
    expect(onDisk).toHaveLength(2);

    const KIND_OF: Readonly<Record<string, string>> = {
      phases: 'phase',
      pipelines: 'pipeline',
      workflows: 'workflow'
    };
    for (const file of onDisk) {
      const [directory, id, record] = file.split('/');
      const key = `${KIND_OF[directory!]}/${id}/${record!.replace('.json', '')}`;
      expect(named.has(key) || debris.has(key), `${file} is neither history nor debris`).toBe(true);
    }
  });
});
