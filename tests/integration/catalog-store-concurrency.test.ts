// Feature 099 (FR-R3-015) T496d — two windows on one workspace (FR-030, FR-030a, SC-019).
//
// The store adds no lock. The expected-revision gate is the whole of its
// concurrency control, and beneath it `flag: 'wx'` on the version record is the
// backstop the kernel arbitrates. Both claims are about a real filesystem: a fake
// enforces write-once by consulting a Map, which is a check-then-act — the very
// race the real primitive exists to close.
//
// What "exactly one new version" is protecting: two windows starting from the same
// revision both compute the same next version id. Without the gate they would both
// believe they published, and the loser's content would be gone with no refusal
// anywhere. With it, one publishes and the other is told, by name, that its read
// state was superseded — and the loser's next save, after a re-read, succeeds.
//
// The cross-kind case is the documented boundary rather than a defect: the revision
// is per kind (FR-044), the manifest is one file, and the spec's own assumptions
// record concurrent saves as last-writer-wins on it. It is pinned here so nobody
// later reads the per-kind revision as a stronger promise than it is.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CatalogStore } from '../../src/catalog';
import type { CatalogKind } from '../../src/contracts/catalog-store';
import { createCatalogFsAdapter } from '../../src/lib/catalog-fs-adapter';
import {
  createWorkspace,
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

describe('Feature 099 — two windows saving one definition (T496d)', () => {
  let workspaceRoot: string;
  /** Two independent stores over one directory. They share nothing but the bytes. */
  let windowA: CatalogStore;
  let windowB: CatalogStore;

  beforeEach(async () => {
    workspaceRoot = await createWorkspace('concurrency');
    windowA = openStore(workspaceRoot);
    windowB = openStore(workspaceRoot);
    await windowA.save({
      kind: 'phase',
      id: 'implement',
      body: { n: 1 },
      expectedRevision: await revisionOf(windowA, 'phase')
    });
  });

  afterEach(async () => {
    await removeWorkspace(workspaceRoot);
  });

  it('publishes the first and refuses the second as stale', async () => {
    // Deterministic form: both windows read, then both save. The second holds a
    // revision the first has already superseded.
    const shared = await revisionOf(windowA, 'phase');
    expect(await revisionOf(windowB, 'phase')).toBe(shared);

    const first = await windowA.save({
      kind: 'phase',
      id: 'implement',
      body: { n: 2, from: 'A' },
      expectedRevision: shared
    });
    const second = await windowB.save({
      kind: 'phase',
      id: 'implement',
      body: { n: 2, from: 'B' },
      expectedRevision: shared
    });

    expect(first).toMatchObject({ outcome: 'saved', versionId: 'v2' });
    expect(second).toMatchObject({ outcome: 'stale' });
    if (second.outcome !== 'stale') return;
    // The refusal carries the authoritative revision, so the loser can re-read and
    // retry without guessing (FR-044).
    expect(second.actualRevision).toBe(await revisionOf(windowB, 'phase'));
    expect(second.actualRevision).not.toBe(shared);

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
    // second window re-reads, gets the authoritative revision, and publishes.
    const shared = await revisionOf(windowA, 'phase');
    await windowA.save({
      kind: 'phase',
      id: 'implement',
      body: { n: 2, from: 'A' },
      expectedRevision: shared
    });
    const refused = await windowB.save({
      kind: 'phase',
      id: 'implement',
      body: { n: 3, from: 'B' },
      expectedRevision: shared
    });
    expect(refused.outcome).toBe('stale');

    const retried = await windowB.save({
      kind: 'phase',
      id: 'implement',
      body: { n: 3, from: 'B' },
      expectedRevision: await revisionOf(windowB, 'phase')
    });

    expect(retried).toMatchObject({ outcome: 'saved', versionId: 'v3' });
    expect(await versionIdsOf(windowA, 'phase', 'implement')).toEqual(['v1', 'v2', 'v3']);
  });

  it('produces exactly one new version when the two saves genuinely overlap', async () => {
    // The interleaving here is real and not controlled: whichever window loses may
    // lose at the revision gate or at the record write, and which arm it lands on
    // depends on scheduling. The invariant is the same either way and is what
    // SC-019 actually asserts — so it is stated that way rather than pinned to one
    // arm that a faster disk would flip.
    const shared = await revisionOf(windowA, 'phase');

    const [first, second] = await Promise.all([
      windowA.save({
        kind: 'phase',
        id: 'implement',
        body: { n: 2, from: 'A' },
        expectedRevision: shared
      }),
      windowB.save({
        kind: 'phase',
        id: 'implement',
        body: { n: 2, from: 'B' },
        expectedRevision: shared
      })
    ]);

    const saved = [first, second].filter((outcome) => outcome.outcome === 'saved');
    const rejected = [first, second].filter((outcome) => outcome.outcome !== 'saved');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ versionId: 'v2' });
    // Both refusals are refusals: the loser is never told it published, and never
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
    const shared = await revisionOf(windowA, 'phase');
    await Promise.all([
      windowA.save({ kind: 'phase', id: 'implement', body: { from: 'A' }, expectedRevision: shared }),
      windowB.save({ kind: 'phase', id: 'implement', body: { from: 'B' }, expectedRevision: shared }),
      windowA.save({ kind: 'pipeline', id: 'standard', body: { from: 'A' }, expectedRevision: await revisionOf(windowA, 'pipeline') })
    ]);

    const tree = await treeOf(storeRootOf(workspaceRoot));
    for (const file of tree.files) {
      expect(file === 'manifest.json' || /^(phases|pipelines|workflows)\/[^/]+\/v\d+\.json$/.test(file)).toBe(
        true
      );
    }
  });
});

describe('Feature 099 — write-once is the kernel, not a check (T496d, FR-030)', () => {
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
    await store.save({
      kind: 'phase',
      id: 'implement',
      body: { n: 1 },
      expectedRevision: await revisionOf(store, 'phase')
    });

    const orphanPath = join(storeRootOf(workspaceRoot), 'phases', 'implement', 'v2.json');
    await mkdir(join(storeRootOf(workspaceRoot), 'phases', 'implement'), { recursive: true });
    await writeFile(orphanPath, '{"versionId":"v2","kind":"phase","id":"implement","body":{"crashed":true}}');

    const outcome = await store.save({
      kind: 'phase',
      id: 'implement',
      body: { n: 2 },
      expectedRevision: await revisionOf(store, 'phase')
    });

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

describe('Feature 099 — the revision is per kind, and the manifest is one file', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await createWorkspace('per-kind');
  });

  afterEach(async () => {
    await removeWorkspace(workspaceRoot);
  });

  it('does not make a pipeline save stale because a phase was saved', async () => {
    // FR-044. One revision per kind, derived from the manifest's stored state for
    // that kind, so editing phases does not invalidate a pipeline editor's read.
    const store = openStore(workspaceRoot);
    const pipelineRevision = await revisionOf(store, 'pipeline');

    await store.save({
      kind: 'phase',
      id: 'implement',
      body: { n: 1 },
      expectedRevision: await revisionOf(store, 'phase')
    });

    expect(await revisionOf(store, 'pipeline')).toBe(pipelineRevision);
    expect(
      await store.save({
        kind: 'pipeline',
        id: 'standard',
        body: { phases: ['implement'] },
        expectedRevision: pipelineRevision
      })
    ).toMatchObject({ outcome: 'saved', versionId: 'v1' });
  });

  it('composes two kinds saved one after the other, from revisions read up front', async () => {
    // The per-kind revision could have been a way to lose an entry: two windows
    // holding revisions from before either wrote, saving into one shared manifest.
    // It is not, because `save` re-reads the manifest inside the call rather than
    // trusting the snapshot the revision came from — so the second save's manifest
    // is built on the first save's result even though its gate never looked at it.
    const windowA = openStore(workspaceRoot);
    const windowB = openStore(workspaceRoot);
    const phaseRevision = await revisionOf(windowA, 'phase');
    const pipelineRevision = await revisionOf(windowB, 'pipeline');

    expect(
      await windowA.save({
        kind: 'phase',
        id: 'implement',
        body: { n: 1 },
        expectedRevision: phaseRevision
      })
    ).toMatchObject({ outcome: 'saved' });
    expect(
      await windowB.save({
        kind: 'pipeline',
        id: 'standard',
        body: { n: 1 },
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

  it('accounts for every record it wrote even when two kinds overlap in flight', async () => {
    // The documented boundary, and the reason it is stated as an invariant rather
    // than as an outcome. Two saves of *different kinds* both pass their own
    // per-kind gate, so the only thing serialising them is the manifest write — and
    // if both loaded the manifest before either wrote it, the later write is built
    // from the earlier state and the first entry is not in it. The spec's own
    // assumptions record this as last-writer-wins on the manifest, and FR-030a
    // rules out the lock that would close it.
    //
    // What the store must do is stay honest: never fault, never delete, and account
    // for every record on disk as either history or debris. A record that is
    // neither — present, unnamed, and unreported — is the failure this pins.
    const windowA = openStore(workspaceRoot);
    const windowB = openStore(workspaceRoot);

    await Promise.all([
      windowA.save({
        kind: 'phase',
        id: 'implement',
        body: { n: 1 },
        expectedRevision: await revisionOf(windowA, 'phase')
      }),
      windowB.save({
        kind: 'pipeline',
        id: 'standard',
        body: { n: 1 },
        expectedRevision: await revisionOf(windowB, 'pipeline')
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
