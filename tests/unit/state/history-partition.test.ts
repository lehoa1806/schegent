// ---------------------------------------------------------------------------
// FR-R3-010 (T413) — the three properties partitioning `KEYS.history` was for.
//
// `history-store.test.ts` next door exercises one queue and says so. This file
// is the cross-partition half: what one queue's writes do to another's rows,
// and what an append costs once the description no longer lives in the record.
//
// All three are properties a single-queue test cannot see. Before the reshape
// there was one array, so "capped per queue" and "capped globally" were the
// same sentence, a duplicate could only ever be a duplicate of a neighbour in
// the same list, and the cost of an append was the cost of re-serialising every
// description in the workspace — invisible at one entry, quadratic at fifty.
// ---------------------------------------------------------------------------

import { HISTORY_UNATTRIBUTED_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  HISTORY_CAP_PER_QUEUE,
  KEYS,
  WorkspaceStateStore,
  type Memento,
  type PersistedHistoryEntry
} from '../../../src/state/workspace-state';
import { HistoryStore } from '../../../src/state/history-store';
import {
  DESCRIPTION_PREVIEW_MAX,
  type HistoryEntry
} from '../../../src/state/history-entry';
import { migrateV11ToV12 } from '../../../src/state/history-state-migrator';

class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  public updates = 0;
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.updates += 1;
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

function makeEntry(
  seq: number,
  overrides: Partial<HistoryEntry> = {}
): HistoryEntry {
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
    ...overrides
  };
}

function persistedMap(memento: FakeMemento): Record<string, PersistedHistoryEntry[]> {
  return (memento.get<Record<string, PersistedHistoryEntry[]>>(KEYS.history) ?? {});
}

let memento: FakeMemento;
let store: WorkspaceStateStore;
let history: HistoryStore;

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  history = new HistoryStore(store);
});

describe('per-partition capping', () => {
  it('caps each queue independently rather than the workspace as a whole', async () => {
    for (let i = 0; i < HISTORY_CAP_PER_QUEUE; i += 1) {
      await history.append('alpha', makeEntry(i));
      await history.append('beta', makeEntry(1_000 + i));
    }

    expect(history.listForQueue('alpha')).toHaveLength(HISTORY_CAP_PER_QUEUE);
    expect(history.listForQueue('beta')).toHaveLength(HISTORY_CAP_PER_QUEUE);
    // The property the reshape exists for: the workspace holds cap × queues,
    // not cap. Under the flat array the second queue's fiftieth completion
    // evicted the first queue's first, and nothing in the product said so.
    expect(history.list()).toHaveLength(HISTORY_CAP_PER_QUEUE * 2);
  });

  it('evicts only from the partition being appended to', async () => {
    for (let i = 0; i < HISTORY_CAP_PER_QUEUE; i += 1) {
      await history.append('alpha', makeEntry(i));
    }
    const betaBefore = ['b-1', 'b-2'];
    for (const runId of betaBefore) {
      await history.append('beta', makeEntry(0, { runId, featureId: runId }));
    }

    const evicted = await history.append('alpha', makeEntry(9_999));

    expect(evicted.map((row) => (row as HistoryEntry).runId)).toEqual(['run-0']);
    expect(history.listForQueue('alpha')).toHaveLength(HISTORY_CAP_PER_QUEUE);
    expect(history.listForQueue('beta').map((row) => row.runId).sort()).toEqual(betaBefore);
  });

  it('returns the evicted rows so the description sweep has something to act on', async () => {
    for (let i = 0; i < HISTORY_CAP_PER_QUEUE + 3; i += 1) {
      const evicted = await history.append('alpha', makeEntry(i));
      // Below the cap nothing is evicted; at and above it, exactly one row per
      // append. A caller that removed files for whatever this returned would
      // otherwise have to re-derive the eviction, which is how the on-disk set
      // and the record come to disagree.
      expect(evicted).toHaveLength(i < HISTORY_CAP_PER_QUEUE ? 0 : 1);
    }
  });

  it('keeps the unattributed partition capped like any other, and folds it into list()', async () => {
    for (let i = 0; i < HISTORY_CAP_PER_QUEUE + 2; i += 1) {
      await history.append(HISTORY_UNATTRIBUTED_QUEUE_ID, makeEntry(i));
    }
    await history.append('alpha', makeEntry(5_000));

    // A real partition, not a tombstone: `list()` shows it, and only
    // `listForQueue` tells it apart.
    expect(history.listForQueue(HISTORY_UNATTRIBUTED_QUEUE_ID)).toHaveLength(
      HISTORY_CAP_PER_QUEUE
    );
    expect(history.list()).toHaveLength(HISTORY_CAP_PER_QUEUE + 1);
    expect(history.listForQueue('alpha')).toHaveLength(1);
  });

  it('reports an unknown queue as empty rather than throwing', () => {
    expect(history.listForQueue('never-existed')).toEqual([]);
  });
});

describe('dedupe', () => {
  it('ignores a re-append of the same run and terminal status', async () => {
    await history.append('alpha', makeEntry(1));
    const before = memento.updates;

    const evicted = await history.append('alpha', makeEntry(1));

    expect(evicted).toEqual([]);
    expect(history.listForQueue('alpha')).toHaveLength(1);
    // No write at all, not a write that happens to produce the same value: the
    // duplicate is refused inside the serialize chain, so a retried completion
    // costs nothing and cannot race a concurrent append into a lost update.
    expect(memento.updates).toBe(before);
  });

  it('admits the same run under a different terminal status', async () => {
    await history.append('alpha', makeEntry(1, { terminalStatus: 'failed' }));
    await history.append('alpha', makeEntry(1, { terminalStatus: 'completed' }));

    // Two distinct facts about one run. The key is the pair, not the run id —
    // collapsing on run id alone would silently drop the second, and a run that
    // failed and was then rerun to completion would keep only whichever landed
    // first.
    expect(history.listForQueue('alpha').map((row) => row.terminalStatus).sort()).toEqual([
      'completed',
      'failed'
    ]);
  });

  it('scopes dedupe to the partition, so the same run in two queues is kept twice', async () => {
    await history.append('alpha', makeEntry(1));
    await history.append('beta', makeEntry(1));

    // Pinned as a deliberate consequence rather than an accident. Deduping
    // across partitions would mean reading every queue's rows on every append —
    // the whole-history read the reshape removed — to suppress a case the
    // recorder cannot produce, since a run has one Task and a Task has one
    // queue. If it ever happens, two rows under two queues is the honest
    // record; one row under an arbitrary winner is not.
    expect(history.listForQueue('alpha')).toHaveLength(1);
    expect(history.listForQueue('beta')).toHaveLength(1);
    expect(history.list()).toHaveLength(2);
  });
});

describe('bounded append cost', () => {
  /**
   * The regression this bounds. `originalDescription` held up to
   * `MAX_DESCRIPTION_LENGTH` (32,000) characters of operator-authored text, and
   * every append rewrote the whole array — so recording that a run finished cost
   * a function of the *content* of the fifty runs before it. What replaced it is
   * an 80-character preview and a reference, both bounded by construction.
   */
  const HUGE = 'x'.repeat(32_000);

  it('bounds a persisted row regardless of how long the description was', async () => {
    await history.append(
      'alpha',
      makeEntry(1, {
        descriptionPreview: HUGE.slice(0, DESCRIPTION_PREVIEW_MAX),
        descriptionRef: '.schegent/history/run-1.txt',
        descriptionLength: HUGE.length
      })
    );

    const rows = persistedMap(memento)['alpha'];
    expect(rows).toHaveLength(1);
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain(HUGE);
    // Generous, and still two orders of magnitude under the text it replaced.
    // The number that matters is that it does not scale with `HUGE.length`.
    expect(serialized.length).toBeLessThan(1_000);
  });

  it('keeps a full partition bounded no matter how many appends preceded it', async () => {
    for (let i = 0; i < HISTORY_CAP_PER_QUEUE * 4; i += 1) {
      await history.append(
        'alpha',
        makeEntry(i, {
          descriptionPreview: HUGE.slice(0, DESCRIPTION_PREVIEW_MAX),
          descriptionRef: `.schegent/history/run-${i}.txt`,
          descriptionLength: HUGE.length
        })
      );
    }

    const rows = persistedMap(memento)['alpha'];
    expect(rows).toHaveLength(HISTORY_CAP_PER_QUEUE);
    // 200 appends of a 32,000-character description. Under the old shape the
    // final write alone would have serialised ~1.6 MB; the bound here holds for
    // the whole key, not just the row.
    expect(JSON.stringify(persistedMap(memento)).length).toBeLessThan(
      HISTORY_CAP_PER_QUEUE * 1_000
    );
  });

  it('leaves sibling partitions byte-identical across an append', async () => {
    await history.append('beta', makeEntry(7));
    const betaBefore = JSON.stringify(persistedMap(memento)['beta']);

    for (let i = 0; i < 10; i += 1) {
      await history.append('alpha', makeEntry(i));
    }

    // The whole-map read-modify-write rewrites the key, but a sibling's rows go
    // back exactly as they came out. This is what makes an append's *content*
    // cost a function of its own partition even though the write is whole-map.
    expect(JSON.stringify(persistedMap(memento)['beta'])).toBe(betaBefore);
  });
});

describe('migration partitioning', () => {
  const NOW = 1_700_000_000_000;

  it('files each legacy row under the queue its task belongs to', () => {
    const flat = [
      { runId: 'r1', featureId: 't-a' },
      { runId: 'r2', featureId: 't-b' },
      { runId: 'r3', featureId: 't-a' }
    ];
    const result = migrateV11ToV12(flat, (taskId) => (taskId === 't-a' ? 'alpha' : 'beta'), NOW);

    expect(result.changed).toBe(true);
    expect(result.history['alpha']).toHaveLength(2);
    expect(result.history['beta']).toHaveLength(1);
    expect(result.history[HISTORY_UNATTRIBUTED_QUEUE_ID]).toBeUndefined();
  });

  it('files an unresolvable task under the documented fallback partition', () => {
    const result = migrateV11ToV12(
      [{ runId: 'r1', featureId: 'gone' }, { runId: 'r2', featureId: 'gone' }],
      () => null,
      NOW
    );

    expect(result.history[HISTORY_UNATTRIBUTED_QUEUE_ID]).toHaveLength(2);
    expect(result.events).toContainEqual({
      type: 'history-entries-unattributed',
      occurredAt: NOW,
      queueId: HISTORY_UNATTRIBUTED_QUEUE_ID,
      entryCount: 2,
      reason: 'task-not-in-any-queue'
    });
  });

  it('does not re-cap while partitioning', () => {
    // A legacy array holds at most the flat cap, so every partition it produces
    // already satisfies the per-queue cap. Applying the cap here would make a
    // forward-only step *delete* records, which is the one kind that cannot be
    // re-attempted after a crash.
    const flat = Array.from({ length: HISTORY_CAP_PER_QUEUE }, (_unused, i) => ({
      runId: `r${i}`,
      featureId: 't-a'
    }));
    const result = migrateV11ToV12(flat, () => 'alpha', NOW);

    expect(result.history['alpha']).toHaveLength(HISTORY_CAP_PER_QUEUE);
  });

  it('leaves an already-partitioned record alone and writes nothing', () => {
    const already = { alpha: [{ runId: 'r1' }], beta: [] };
    const result = migrateV11ToV12(already, () => 'alpha', NOW);

    expect(result.changed).toBe(false);
    expect(result.events).toEqual([]);
    expect(result.history).toBe(already);
  });
});
