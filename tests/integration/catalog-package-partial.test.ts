// Feature 100 (FR-R3-016) T514f — a package publish that fails part-way through,
// on a real disk.
//
// The recovery story is the whole subject, and it rests on three things being true
// at once (FR-037, FR-038, FR-039):
//
//   - **Whatever landed stays landed.** No compensating delete on any path. A
//     rollback would need a cross-file transaction the store deliberately does not
//     have, so an attempted one is a second failure on top of the first — this time
//     destroying an operator's bytes.
//   - **The prefix is reported by name.** `published`, `draftedOnly`, and
//     `failedKind` are what turn "something went wrong" into a state an operator can
//     reason about, and what makes the next step obvious.
//   - **Re-running the same document completes it.** The rows that landed
//     short-circuit on content (FR-039) and the layer that did not is published, so
//     recovery is the ordinary path rather than a repair tool.
//
// Two failure points, because they leave genuinely different states behind:
//
//   1. **In pass 1**, before any pointer moves. Nothing is live; the prefix is drafts.
//   2. **In pass 2**, after an earlier layer published. The Phases are live and the
//      Pipeline is a draft — a half-applied document that is nonetheless a *coherent*
//      catalog, because the half that landed is the half nothing depends on.
//
// This is an integration test rather than a unit one because every claim is about
// bytes that outlive the call: which record files exist afterwards, that they are
// byte-identical after the re-run, and that a fresh window reading the directory
// cold agrees. The one thing not left to the real filesystem is *when* it fails —
// a disk will not produce an `EIO` on request, so the shipped adapter is wrapped by
// a decorator that fails exactly one write and delegates every other call. Every
// write that succeeds is a real write to a real disk.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nodeDigest, systemClock } from '../../src/activation/catalog-store-wiring';
import {
  createCatalogStore,
  createQueueRunProvenance,
  publishPackage,
  storedIds,
  storedRows,
  type CatalogStore
} from '../../src/catalog';
import type { CatalogFsPort } from '../../src/catalog/ports';
import { createDefinitionSemantics } from '../../src/config/definition-semantics';
import type {
  PackagePublishOutcome,
  PackagePublishRequest
} from '../../src/contracts/catalog-lifecycle';
import type { CatalogManifest, CatalogSnapshot } from '../../src/contracts/catalog-store';
import { createCatalogFsAdapter } from '../../src/lib/catalog-fs-adapter';
import { phaseBody, pipelineBody } from '../fixtures/catalog-lifecycle-harness';
import {
  createWorkspace,
  fingerprintOf,
  removeWorkspace,
  storeRootOf,
  treeOf,
  type Fingerprint
} from '../fixtures/catalog-real-fs';

/** The document under test: two Phases and the Pipeline that binds both. */
const PLAN = { id: 'plan', body: phaseBody('plan') };
const BUILD = { id: 'build', body: phaseBody('build') };
const PHASES = [PLAN, BUILD];
const PIPELINE = { id: 'ship-it', body: pipelineBody('ship-it', ['plan', 'build']) };

const semantics = createDefinitionSemantics({ defaultPipelineId: () => '' });

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await createWorkspace('100-package-partial');
});

afterEach(async () => {
  await removeWorkspace(workspaceRoot);
});

/** Does this manifest, as bytes about to be written, make `(kind, id)` live? */
function makesActive(contents: string, kind: string, id: string): boolean {
  const manifest = JSON.parse(contents) as CatalogManifest;
  const entry = manifest.entries.find((candidate) => candidate.kind === kind && candidate.id === id);
  return entry !== undefined && entry.activeVersionId !== null;
}

type WriteMatcher = (key: string, contents: string) => boolean;

/**
 * A window onto the real store whose **first** matching write fails.
 *
 * The wrapper delegates everything else, including every write that does not match
 * and every write after the one that fired, so the disk state a test then reads is
 * the state a genuine mid-document I/O failure would have left.
 */
function openStoreFailingWrite(matches: WriteMatcher, errno: string): CatalogStore {
  const inner = createCatalogFsAdapter(storeRootOf(workspaceRoot));
  let fired = false;
  const fails = (key: string, contents: string): boolean => {
    if (fired || !matches(key, contents)) return false;
    fired = true;
    return true;
  };
  const fs: CatalogFsPort = {
    readFile: (at) => inner.readFile(at),
    listDirectory: (at) => inner.listDirectory(at),
    removeFile: (at) => inner.removeFile(at),
    checkWritability: () => inner.checkWritability(),
    writeFileAtomic: async (at, contents) =>
      fails(at.join('/'), contents) ? { outcome: 'failed', errno } : inner.writeFileAtomic(at, contents),
    writeFileIfAbsent: async (at, contents) =>
      fails(at.join('/'), contents)
        ? { outcome: 'failed', errno }
        : inner.writeFileIfAbsent(at, contents)
  };
  return createCatalogStore({
    fs,
    clock: systemClock,
    digest: nodeDigest,
    provenance: createQueueRunProvenance(() => [])
  });
}

/** An ordinary window, as the host builds it. */
function openStore(): CatalogStore {
  return createCatalogStore({
    fs: createCatalogFsAdapter(storeRootOf(workspaceRoot)),
    clock: systemClock,
    digest: nodeDigest,
    provenance: createQueueRunProvenance(() => [])
  });
}

async function snapshotOf(store: CatalogStore): Promise<CatalogSnapshot> {
  const read = await store.read();
  if (read.outcome !== 'read') throw new Error(`store unreadable: ${read.fault.fault}`);
  return read.snapshot;
}

/**
 * The same document, gated on whatever the store is at now.
 *
 * Read fresh every time rather than remembered, because that is what re-importing
 * actually does — and because pass 1 of the failed attempt moved the revision of
 * every layer that landed.
 */
async function documentFor(store: CatalogStore): Promise<PackagePublishRequest> {
  const snapshot = await snapshotOf(store);
  return {
    layers: [
      { kind: 'phase', definitions: PHASES, expectedRevision: snapshot.revisions.phase },
      { kind: 'pipeline', definitions: [PIPELINE], expectedRevision: snapshot.revisions.pipeline }
    ]
  };
}

async function publishDocument(store: CatalogStore): Promise<PackagePublishOutcome> {
  return await publishPackage({ store, semantics }, await documentFor(store));
}

/** Every file under the store except the manifest, which is meant to change. */
async function recordsOf(): Promise<Fingerprint> {
  const print = await fingerprintOf(storeRootOf(workspaceRoot));
  return new Map([...print].filter(([relative]) => relative !== 'manifest.json'));
}

describe('a failure in pass 1 leaves drafts and nothing live (FR-037)', () => {
  /** Break the Pipeline's version record — the first write after the Phase layer. */
  const breakPipelineRecord: WriteMatcher = (key) => key === 'pipelines/ship-it/v1.json';

  it('reports the layer that landed, the layer that failed, and the cause', async () => {
    const outcome = await publishDocument(openStoreFailingWrite(breakPipelineRecord, 'EIO'));

    expect(outcome).toEqual({
      outcome: 'partial',
      // Pass 2 never started, so nothing was published — the prefix is drafts.
      published: [],
      draftedOnly: ['phase'],
      failedKind: 'pipeline',
      cause: 'EIO',
      // Two versions in, nowhere near the retention bound, so the Phase layer's
      // draft write trimmed nothing to make room.
      pruned: []
    });
  });

  it('leaves the Phase records written and nothing triggerable', async () => {
    await publishDocument(openStoreFailingWrite(breakPipelineRecord, 'EIO'));

    // A fresh window, reading the directory cold. The two selectors disagree here,
    // and that disagreement is the point: presence is a claim on an id at *every*
    // status, so an importer sees both Phases (FR-048), while the effective catalog
    // — what a run can trigger — is still empty. A partial import cannot change
    // what runs, because pass 1 moves no active pointer at all (FR-041).
    const snapshot = await snapshotOf(openStore());
    expect([...storedIds(snapshot, 'phase')].sort()).toEqual(['build', 'plan']);
    expect(storedRows(snapshot, 'phase')).toEqual([]);
    expect(storedRows(snapshot, 'pipeline')).toEqual([]);
    for (const definition of snapshot.definitions) {
      expect(definition.activeVersionId).toBeNull();
      expect(definition.draftVersionId).toBe('v1');
    }
    // The write that failed never reached the adapter, so the directory it would
    // have created is not there either.
    const tree = await treeOf(storeRootOf(workspaceRoot));
    expect(tree.files).toEqual(['manifest.json', 'phases/build/v1.json', 'phases/plan/v1.json']);
  });

  it('completes on a re-run of the same document, appending no version and rewriting nothing', async () => {
    await publishDocument(openStoreFailingWrite(breakPipelineRecord, 'EIO'));
    const landed = await recordsOf();

    const outcome = await publishDocument(openStore());

    expect(outcome).toEqual({
      outcome: 'published',
      published: [
        { kind: 'phase', ids: ['plan', 'build'] },
        { kind: 'pipeline', ids: ['ship-it'] }
      ],
      pruned: []
    });
    const snapshot = await snapshotOf(openStore());
    expect(storedRows(snapshot, 'phase')).toEqual([PLAN.body, BUILD.body]);
    expect(storedRows(snapshot, 'pipeline')).toEqual([PIPELINE.body]);
    // The Phase drafts the failed attempt wrote were *reused*, not superseded: the
    // content already matched, so the re-run's draft write short-circuited (FR-039).
    // Byte-identical including mtime, which is what rules out a rewrite with the
    // same bytes — and, since nothing here was removed either, rules out a
    // compensating delete followed by a re-create.
    const after = await recordsOf();
    for (const [relative, print] of landed) {
      expect(after.get(relative), `${relative} should be untouched`).toBe(print);
    }
    expect([...after.keys()].sort()).toEqual([
      'phases/build/v1.json',
      'phases/plan/v1.json',
      'pipelines/ship-it/v1.json'
    ]);
  });
});

describe('a failure in pass 2 leaves the earlier layer live (FR-038)', () => {
  /**
   * Break the publication of the Pipeline layer.
   *
   * Matched on what the write *means* rather than on its ordinal: this document
   * writes the manifest four times, and "the fourth one" would silently become the
   * wrong write the moment a layer is added to the document above.
   */
  const breakPipelinePublication: WriteMatcher = (key, contents) =>
    key === 'manifest.json' && makesActive(contents, 'pipeline', 'ship-it');

  it('reports the published layer and the one still drafted', async () => {
    const outcome = await publishDocument(openStoreFailingWrite(breakPipelinePublication, 'EIO'));

    expect(outcome).toEqual({
      outcome: 'partial',
      published: [{ kind: 'phase', ids: ['plan', 'build'] }],
      draftedOnly: ['pipeline'],
      failedKind: 'pipeline',
      // A layer publication writes one file, so the store has no prefix to describe
      // and reports the refusal by name rather than the errno. The `EIO` is lost at
      // that seam by design: `PublishLayerOutcome` has no partial arm because a
      // single-file write either landed or did not.
      cause: 'not-writable',
      pruned: []
    });
  });

  it('leaves a coherent catalog: the Phases live, the Pipeline a draft', async () => {
    await publishDocument(openStoreFailingWrite(breakPipelinePublication, 'EIO'));

    const snapshot = await snapshotOf(openStore());
    expect(storedRows(snapshot, 'phase')).toEqual([PLAN.body, BUILD.body]);
    // The half that landed is the half nothing depends on. A Pipeline made live
    // over Phases that had not landed would be the incoherent direction, which is
    // why the passes run Phases first (FR-035).
    expect(storedRows(snapshot, 'pipeline')).toEqual([]);
    expect([...storedIds(snapshot, 'pipeline')]).toEqual(['ship-it']);
    const pipeline = snapshot.definitions.find((definition) => definition.kind === 'pipeline');
    expect(pipeline?.draftVersionId).toBe('v1');
    expect(pipeline?.activeVersionId).toBeNull();
    expect(snapshot.faults).toEqual([]);
    expect(snapshot.collectable).toEqual([]);
  });

  it('keeps the record of the layer that failed to publish', async () => {
    await publishDocument(openStoreFailingWrite(breakPipelinePublication, 'EIO'));

    // The pointer never moved, but the record it would have pointed at is on disk
    // and is readable. Nothing is deleted on a failure path (FR-038), so the
    // operator's imported body is not lost with the publication that failed.
    const read = await openStore().readVersion('pipeline', 'ship-it', 'v1');
    expect(read.outcome).toBe('read');
    if (read.outcome !== 'read') return;
    expect(read.record.body).toEqual(PIPELINE.body);
  });

  it('completes on a re-run, publishing only what was outstanding', async () => {
    await publishDocument(openStoreFailingWrite(breakPipelinePublication, 'EIO'));
    const landed = await recordsOf();

    const outcome = await publishDocument(openStore());

    // The Phase layer publishes nothing the second time: every id it names is
    // already live at that content, so its publication is a set of skips and its
    // reported ids are empty. Re-running a document is idempotent rather than
    // additive (FR-039, FR-039a).
    expect(outcome).toEqual({
      outcome: 'published',
      published: [
        { kind: 'phase', ids: [] },
        { kind: 'pipeline', ids: ['ship-it'] }
      ],
      pruned: []
    });
    const snapshot = await snapshotOf(openStore());
    expect(storedRows(snapshot, 'phase')).toEqual([PLAN.body, BUILD.body]);
    expect(storedRows(snapshot, 'pipeline')).toEqual([PIPELINE.body]);
    // Three records before, the same three after, byte-for-byte. A re-import that
    // appended a v2 anywhere would have manufactured history out of a retry.
    expect(await recordsOf()).toEqual(landed);
  });
});
