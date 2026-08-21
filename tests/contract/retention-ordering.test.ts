// Feature 103 (T072, T073 — US6) — the ordering guarantee behind FR-042, and the
// one implementation choice that can break it.
//
// FR-041 through FR-043 say three things that are only one thing: a retained
// history row pins the version it recorded; eviction releases the pin; and there
// is no step in between. "No step in between" is not a behaviour anyone can add —
// it is what remains true as long as nobody adds a cache. A memo on the pin set,
// a snapshot taken at the start of a housekeeping pass, a stamp written into the
// catalog when a row is first seen: each is an ordinary performance change, each
// makes retention answer from a history that has already moved, and none of them
// would fail any test that only checks the two endpoints.
//
// So both halves here read the pin set **twice**, across a mutation, and assert
// that the second answer differs. That is the whole point of the file. A change
// that makes it pass by making the second read cheaper has broken the thing it
// was measuring.
//
// Contract rather than unit, because the guarantee spans three modules that are
// separately reasonable: the history cap in `workspace-state.ts`, the pin set in
// `run-provenance-enumeration.ts`, and the walk in `catalog-retention.ts`. Each
// is correct alone; the ordering is a property of them composed.

import { beforeEach, describe, expect, it } from 'vitest';
import { planRetention, createQueueRunProvenance } from '../../src/catalog';
import { retainedHistoryPlans } from '../../src/activation/run-provenance-enumeration';
import { HistoryStore } from '../../src/state/history-store';
import {
  HISTORY_CAP_PER_QUEUE,
  KEYS,
  WorkspaceStateStore,
  type Memento
} from '../../src/state/workspace-state';
import type { HistoryEntry } from '../../src/state/history-entry';
import type { CatalogManifestEntry } from '../../src/contracts/catalog-store';
import type { CatalogVersionRef } from '../../src/contracts/catalog-version';

class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

const QUEUE = 'default';

/**
 * A small stand-in for `CATALOG_RETENTION_BOUND`.
 *
 * Passed explicitly so the fixtures stay readable: against a manifest of five
 * versions this leaves a surplus of two, which is enough to show the walk
 * advancing past an exemption without building fifty-odd versions to see it.
 * The shipped bound is asserted in `catalog-retention.test.ts`, which is where
 * that belongs.
 */
const BOUND = 3;

function versionRef(versionId: string): CatalogVersionRef {
  return { kind: 'pipeline', id: 'analysis', versionId };
}

/** One completed run, recording the version it froze. */
function entry(seq: number, catalogVersion?: CatalogVersionRef): HistoryEntry {
  const startedMs = 1_700_000_000_000 + seq * 1_000;
  return {
    runId: `run-${seq}`,
    featureId: `feat-${seq}`,
    descriptionPreview: `desc ${seq}`,
    terminalStatus: 'completed',
    startedAt: new Date(startedMs).toISOString(),
    completedAt: new Date(startedMs + 500).toISOString(),
    durationMs: 500,
    lastErrorSummary: null,
    auditLogPointer: `runId:run-${seq}`,
    ...(catalogVersion === undefined ? {} : { catalogVersion })
  };
}

/** A manifest entry holding `v1..vN`, active at the newest. */
function manifestEntry(count: number): CatalogManifestEntry {
  return {
    kind: 'pipeline',
    id: 'analysis',
    draftVersionId: null,
    activeVersionId: `v${count}`,
    createdAt: 1_000,
    updatedAt: 1_000 + count,
    versions: Array.from({ length: count }, (_unused, index) => ({
      versionId: `v${index + 1}`,
      contentHash: `sha256:${index + 1}`,
      createdAt: 1_000 + index,
      publishedAt: 1_000 + index,
      note: null
    }))
  };
}

let memento: FakeMemento;
let store: WorkspaceStateStore;
let history: HistoryStore;

/**
 * The reader exactly as activation composes it (`extension.ts`), including the
 * `list()` call inside the thunk.
 *
 * The `list()` has to be *inside*, and that is the assertion the whole file
 * rests on: hoisting it out is the smallest possible cache and reads as a
 * harmless simplification.
 */
function hostProvenance() {
  return createQueueRunProvenance(
    () => [],
    () => retainedHistoryPlans(history.list())
  );
}

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  history = new HistoryStore(store);
});

describe('the pin set is re-read, not remembered (FR-042, FR-056)', () => {
  it('answers differently across two consecutive reads when a row arrives', async () => {
    const provenance = hostProvenance();

    expect(await provenance.isReferenced('pipeline', 'analysis', 'v4')).toBe(false);
    await history.append(QUEUE, entry(1, versionRef('v4')));
    expect(await provenance.isReferenced('pipeline', 'analysis', 'v4')).toBe('history-referenced');
  });

  it('answers differently across two consecutive reads when the row leaves', async () => {
    await history.append(QUEUE, entry(1, versionRef('v4')));
    const provenance = hostProvenance();

    expect(await provenance.isReferenced('pipeline', 'analysis', 'v4')).toBe('history-referenced');
    // Written through the memento rather than through an append, because this is
    // the case an append cannot produce: history changing out of band — a second
    // window, or a workspace-state reset. The store has no cache in front of the
    // memento, so the pin set sees it, and a pin set that added one would not.
    await memento.update(KEYS.history, {});
    expect(await provenance.isReferenced('pipeline', 'analysis', 'v4')).toBe(false);
  });

  it('changes its answer inside a single retention walk', async () => {
    // The sharpest form: the mutation happens *while* `planRetention` is walking,
    // between the question about `v1` and the question about `v2`. A snapshot
    // taken when the walk began would answer both from the world before, which is
    // precisely the "intervening step" FR-042 forbids.
    await history.append(QUEUE, entry(1, versionRef('v1')));
    await history.append(QUEUE, entry(2, versionRef('v2')));
    const provenance = hostProvenance();

    const asked: string[] = [];
    const plan = await planRetention(
      manifestEntry(5),
      async (candidate) => {
        asked.push(candidate);
        const answer = await provenance.isReferenced('pipeline', 'analysis', candidate);
        if (candidate === 'v1') await memento.update(KEYS.history, {});
        return answer;
      },
      BOUND
    );

    expect(asked).toEqual(['v1', 'v2', 'v3']);
    // `v1` was pinned when it was asked about; `v2` was pinned a moment earlier
    // and is not pinned by the time the walk reaches it.
    expect(plan.exempt).toEqual([{ versionId: 'v1', why: 'history-referenced' }]);
    expect(plan.remove).toEqual(['v2', 'v3']);
  });
});

describe('eviction releases the pin with no step in between (FR-041, FR-042, FR-043)', () => {
  it('exempts the version while its run is retained, naming history as the reason', async () => {
    await history.append(QUEUE, entry(1, versionRef('v1')));
    const provenance = hostProvenance();

    const plan = await planRetention(
      manifestEntry(5),
      (candidate) => provenance.isReferenced('pipeline', 'analysis', candidate),
      BOUND
    );

    expect(plan.exempt).toEqual([{ versionId: 'v1', why: 'history-referenced' }]);
    // FR-035a — the walk advances past the exemption to meet the surplus rather
    // than stopping at it, so one pinned old version cannot hold the bound open.
    expect(plan.remove).toEqual(['v2', 'v3']);
  });

  it('makes the evicted run’s version a candidate on the very next prune', async () => {
    await history.append(QUEUE, entry(0, versionRef('v1')));
    const provenance = hostProvenance();
    const prune = () =>
      planRetention(
        manifestEntry(5),
        (candidate) => provenance.isReferenced('pipeline', 'analysis', candidate),
        BOUND
      );

    expect((await prune()).remove).toEqual(['v2', 'v3']);

    // Fill the partition until the cap rolls `run-0` off the end. Nothing else
    // happens: no flush, no housekeeping pass, no second write.
    for (let seq = 1; seq <= HISTORY_CAP_PER_QUEUE; seq += 1) {
      await history.append(QUEUE, entry(seq, versionRef('v5')));
    }
    expect(history.list().some((record) => record.runId === 'run-0')).toBe(false);

    expect((await prune()).remove).toEqual(['v1', 'v2']);
  });

  it('reports the eviction that released it, rather than dropping it silently', async () => {
    for (let seq = 0; seq < HISTORY_CAP_PER_QUEUE; seq += 1) {
      await history.append(QUEUE, entry(seq, versionRef('v1')));
    }

    // The cap is enforced by the append itself, which returns what it removed —
    // the same synchrony the ordering guarantee depends on. An eviction discovered
    // later by a sweep would be the intervening step.
    const evicted = await history.append(QUEUE, entry(HISTORY_CAP_PER_QUEUE, versionRef('v5')));

    // Raw persisted blobs, which is what the store keeps — it evicts what it was
    // given rather than a normalized copy, so the caller can match its own records
    // against them.
    expect(evicted.map((row) => (row as { runId?: unknown }).runId)).toEqual(['run-0']);
  });

  it('keeps the version pinned while any retained row still records it', async () => {
    // Two rows, one version. Evicting the older one releases nothing, because the
    // pin is a property of the set and not of a particular row — a per-row
    // refcount would be a second piece of state to get wrong.
    await history.append(QUEUE, entry(0, versionRef('v1')));
    await history.append(QUEUE, entry(1, versionRef('v1')));
    const provenance = hostProvenance();

    for (let seq = 2; seq <= HISTORY_CAP_PER_QUEUE; seq += 1) {
      await history.append(QUEUE, entry(seq, versionRef('v5')));
    }

    expect(history.list().some((record) => record.runId === 'run-0')).toBe(false);
    expect(history.list().some((record) => record.runId === 'run-1')).toBe(true);
    expect(await provenance.isReferenced('pipeline', 'analysis', 'v1')).toBe('history-referenced');
  });
});
