// Feature 093 (T017) — the queue-addressed Run store accessors, pinned to
// contracts/run-store-accessors.md §2 (guarantees G-1..G-6).
//
// The contract's central claim is that "a Run reached without a queue" is made
// unrepresentable rather than checked for, so most of G-1 is enforced by the
// type checker and by the reachability guard in `tests/lint/`. What a runtime
// test can still pin is everything the types cannot: that a write refuses an id
// the registry does not know, that clearing removes a key instead of storing a
// null under it, that the projection is a copy, and that two concurrent writes
// to different queues both survive.
//
// That last one is the guarantee this feature exists to deliver. `KEYS.run` is a
// single memento key holding a whole map, so a per-queue write is a whole-map
// read-modify-write; two of them interleaved on a naive implementation is the
// clobber that drain step 4b was refusing second starts to avoid.

import { describe, it, expect, beforeEach } from 'vitest';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import {
  KEYS,
  QueueMutationRejected,
  WorkspaceStateStore,
  type Memento
} from '../../../src/state/workspace-state';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { migrateV10ToV11 } from '../../../src/state/run-state-migrator';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import { buildQueueRegistry, buildWorkflowRun, fixtureQueueId } from '../../fixtures/state/queue-fixtures';

const OTHER_QUEUE = fixtureQueueId(2);
const UNKNOWN_QUEUE = 'queue-that-was-never-registered';

/**
 * A memento whose writes can be made to settle on a later turn, so two
 * `setRun` calls can be interleaved at a deterministic await point rather than
 * by racing wall-clock timers.
 */
class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  /** When set, every `update()` waits on this before storing. */
  public gate: Promise<void> | null = null;

  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (this.gate) await this.gate;
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
  }

  seed(key: string, value: unknown): void {
    this.map.set(key, value);
  }
}

let memento: FakeMemento;
let store: WorkspaceStateStore;

/** A registry holding `default` and one other queue — nothing else is known. */
function seedRegistry(): void {
  memento.seed(KEYS.queueRegistry, buildQueueRegistry({ count: 2, defaultAtPosition: 0 }));
  memento.seed(KEYS.queueDefaultId, DEFAULT_QUEUE_ID);
}

beforeEach(() => {
  memento = new FakeMemento();
  seedRegistry();
  store = new WorkspaceStateStore(memento);
});

describe('getRun / setRun are addressed by queue (G-1)', () => {
  it('round-trips a Run under the queue it was written for', async () => {
    const run = buildWorkflowRun({ id: 'run-a' });

    await store.setRun(DEFAULT_QUEUE_ID, run, unfencedCommit('test-fixture'));

    expect(store.getRun(DEFAULT_QUEUE_ID)).toEqual(run);
  });

  it('does not leak one queue\'s Run to another', async () => {
    await store.setRun(OTHER_QUEUE, buildWorkflowRun({ id: 'run-other' }), unfencedCommit('test-fixture'));

    expect(store.getRun(DEFAULT_QUEUE_ID)).toBeNull();
    expect(store.getRun(OTHER_QUEUE)?.id).toBe('run-other');
  });

  it('holds one Run per queue at the same time — the point of the feature', async () => {
    await store.setRun(DEFAULT_QUEUE_ID, buildWorkflowRun({ id: 'run-1' }), unfencedCommit('test-fixture'));
    await store.setRun(OTHER_QUEUE, buildWorkflowRun({ id: 'run-2' }), unfencedCommit('test-fixture'));

    expect(store.getRun(DEFAULT_QUEUE_ID)?.id).toBe('run-1');
    expect(store.getRun(OTHER_QUEUE)?.id).toBe('run-2');
  });

  it('returns null for a queue with no active Run', () => {
    expect(store.getRun(DEFAULT_QUEUE_ID)).toBeNull();
  });
});

/**
 * The refusals below are asserted as **synchronous** throws, matching the
 * invariant check `setRun` has always made (`workflow-run-invariants.test.ts`
 * pins the same form). A rejected promise would read the same at every `await`
 * call site and differently at a `.catch()` one, so the existing shape is kept
 * rather than quietly widened.
 */
describe('an unknown queue id is refused, not created (G-6, RM-1)', () => {
  it('refuses a write for a queue absent from the registry', () => {
    expect(() => store.setRun(UNKNOWN_QUEUE, buildWorkflowRun(), unfencedCommit('test-fixture'))).toThrow(QueueMutationRejected);
  });

  it('persists nothing when it refuses', () => {
    expect(() => store.setRun(UNKNOWN_QUEUE, buildWorkflowRun(), unfencedCommit('test-fixture'))).toThrow();

    expect(store.getRunMap()).toEqual({});
  });

  /**
   * Clearing is the one direction an unknown id is allowed, because queue
   * deletion drops the registry entry first: refusing the cleanup that follows
   * would strand the deleted queue's Run record permanently.
   */
  it('allows clearing an id the registry no longer knows', async () => {
    await expect(store.setRun(UNKNOWN_QUEUE, null, unfencedCommit('test-fixture'))).resolves.toBeUndefined();
  });

  /**
   * Reading is not a way to assert a queue exists. An unknown id reads as "no
   * active Run", the same as a known-but-idle queue: a read has nothing to
   * corrupt, and making it throw would turn every projection into a call site
   * that must first check the registry.
   */
  it('reads an unknown queue as empty rather than throwing', () => {
    expect(store.getRun(UNKNOWN_QUEUE)).toBeNull();
  });
});

describe('clearing removes the key (G-5)', () => {
  it('drops the entry rather than storing a null under it', async () => {
    await store.setRun(DEFAULT_QUEUE_ID, buildWorkflowRun({ id: 'run-a' }), unfencedCommit('test-fixture'));

    await store.setRun(DEFAULT_QUEUE_ID, null, unfencedCommit('test-fixture'));

    expect(store.getRun(DEFAULT_QUEUE_ID)).toBeNull();
    expect(Object.keys(store.getRunMap())).toEqual([]);
    expect(store.getRunMap()).not.toHaveProperty(DEFAULT_QUEUE_ID);
  });

  it('leaves sibling queues untouched when one is cleared', async () => {
    await store.setRun(DEFAULT_QUEUE_ID, buildWorkflowRun({ id: 'run-1' }), unfencedCommit('test-fixture'));
    await store.setRun(OTHER_QUEUE, buildWorkflowRun({ id: 'run-2' }), unfencedCommit('test-fixture'));

    await store.setRun(DEFAULT_QUEUE_ID, null, unfencedCommit('test-fixture'));

    expect(Object.keys(store.getRunMap())).toEqual([OTHER_QUEUE]);
  });

  it('is a no-op when the queue already has no Run', async () => {
    await expect(store.setRun(OTHER_QUEUE, null, unfencedCommit('test-fixture'))).resolves.toBeUndefined();

    expect(store.getRunMap()).toEqual({});
  });

  /**
   * `Object.keys(getRunMap())` is exactly the set of queues with an active Run.
   * Concurrency accounting reads that count, so a retained null key would
   * inflate the in-flight tally and make an idle workspace look saturated.
   */
  it('keeps the key set equal to the set of queues actually running', async () => {
    await store.setRun(DEFAULT_QUEUE_ID, buildWorkflowRun({ id: 'run-1' }), unfencedCommit('test-fixture'));
    await store.setRun(OTHER_QUEUE, buildWorkflowRun({ id: 'run-2' }), unfencedCommit('test-fixture'));
    await store.setRun(OTHER_QUEUE, null, unfencedCommit('test-fixture'));

    expect(Object.keys(store.getRunMap())).toEqual([DEFAULT_QUEUE_ID]);
  });
});

describe('getRunMap is a read-only projection (G-4)', () => {
  it('does not write through to stored state when mutated', async () => {
    await store.setRun(DEFAULT_QUEUE_ID, buildWorkflowRun({ id: 'run-a' }), unfencedCommit('test-fixture'));

    const projection = store.getRunMap() as Record<string, WorkflowRun>;
    delete projection[DEFAULT_QUEUE_ID];
    projection[UNKNOWN_QUEUE] = buildWorkflowRun({ id: 'smuggled' });

    expect(store.getRun(DEFAULT_QUEUE_ID)?.id).toBe('run-a');
    expect(Object.keys(store.getRunMap())).toEqual([DEFAULT_QUEUE_ID]);
  });

  it('reads empty on a workspace that has never run anything', () => {
    expect(store.getRunMap()).toEqual({});
  });
});

// Found in the cumulative 093–095 review. `readRunMap()` imported the migrator's
// "is this a Run?" rule but restated the map rule as
// `typeof raw === 'object' && !Array.isArray(raw)`, which is laxer than
// `isRunStateMap` — it accepts a map whose *values* are not Runs. On that one
// input the pre-write read and the migrator disagreed, which is precisely what
// the method's own comment says cannot happen: this read cast the junk and
// handed callers values typed `WorkflowRun` that are not one, while the
// migrator classified the same record `unrecognised-record-shape`.
//
// The seeded records below are shapes a downgrade, a partial write or a hand-
// edited workspace can leave behind. Each asserts the *agreement*, not merely
// the emptiness: whatever `readRunMap` answers before the write must be what
// the migrator is about to make true.
describe('a record the migrator would repair reads as empty, not as junk', () => {
  const UNREADABLE: ReadonlyArray<readonly [string, unknown]> = [
    ['values that are not Runs', { [DEFAULT_QUEUE_ID]: { nothing: 'like a run' } }],
    ['a value with an unknown status', { [DEFAULT_QUEUE_ID]: { id: 'r', featureId: 't', status: 'sideways' } }],
    ['one good entry and one bad', {
      [DEFAULT_QUEUE_ID]: buildWorkflowRun({ id: 'run-a' }),
      [OTHER_QUEUE]: 'not a run'
    }],
    ['a primitive', 'not an object'],
    ['an array', [buildWorkflowRun({ id: 'run-a' })]]
  ];

  for (const [label, raw] of UNREADABLE) {
    it(`reads empty for ${label}`, () => {
      memento.seed(KEYS.run, raw);

      expect(store.getRunMap()).toEqual({});
      expect(store.getRun(DEFAULT_QUEUE_ID)).toBeNull();
      expect(store.findRunByTask('task-a')).toBeNull();
    });
  }

  it('agrees with the migrator, which is the property that failed', () => {
    // The mixed record is the sharpest case: the old rule returned it whole, so
    // one caller saw a live Run on the default queue and the migrator saw a
    // record to repair. Both must now answer "nothing is executing".
    const mixed = {
      [DEFAULT_QUEUE_ID]: buildWorkflowRun({ id: 'run-a' }),
      [OTHER_QUEUE]: 'not a run'
    };
    memento.seed(KEYS.run, mixed);

    const migrated = migrateV10ToV11(mixed, () => DEFAULT_QUEUE_ID, 0);

    expect(migrated.runs).toEqual({});
    expect(migrated.events.some((e) => e.type === 'run-record-repaired')).toBe(true);
    expect(store.getRunMap()).toEqual(migrated.runs);
  });

  it('still lifts a genuine v10 record — the case the laxer rule was there for', () => {
    const legacy = buildWorkflowRun({ id: 'run-legacy', featureId: 'task-legacy' });
    memento.seed(KEYS.run, legacy);

    expect(store.getRun(DEFAULT_QUEUE_ID)?.id).toBe('run-legacy');
    expect(store.findRunByTask('task-legacy')?.queueId).toBe(DEFAULT_QUEUE_ID);
  });
});

describe('findRunByTask resolves a Run together with its queue (G-1)', () => {
  it('returns the queue alongside the Run, never the Run alone', async () => {
    const run = buildWorkflowRun({ id: 'run-a', featureId: 'task-a' });
    await store.setRun(OTHER_QUEUE, run, unfencedCommit('test-fixture'));

    expect(store.findRunByTask('task-a')).toEqual({ queueId: OTHER_QUEUE, run });
  });

  it('returns null for a task no active Run is executing', async () => {
    await store.setRun(OTHER_QUEUE, buildWorkflowRun({ featureId: 'task-a' }), unfencedCommit('test-fixture'));

    expect(store.findRunByTask('task-b')).toBeNull();
  });

  it('finds the right Run when several queues are running at once', async () => {
    await store.setRun(DEFAULT_QUEUE_ID, buildWorkflowRun({ id: 'run-1', featureId: 'task-1' }), unfencedCommit('test-fixture'));
    await store.setRun(OTHER_QUEUE, buildWorkflowRun({ id: 'run-2', featureId: 'task-2' }), unfencedCommit('test-fixture'));

    expect(store.findRunByTask('task-2')?.queueId).toBe(OTHER_QUEUE);
    expect(store.findRunByTask('task-1')?.queueId).toBe(DEFAULT_QUEUE_ID);
  });
});

describe('run invariants are validated on every write path (G-2)', () => {
  it('refuses a half-set retry pair', () => {
    const invalid = { ...buildWorkflowRun(), pendingRetryAt: 1234, pendingRetryCause: null };

    expect(() => store.setRun(DEFAULT_QUEUE_ID, invalid, unfencedCommit('test-fixture'))).toThrow(/invariant violation/i);
  });

  it('persists nothing when the invariant check refuses', () => {
    const invalid = { ...buildWorkflowRun(), pendingRetryAt: 1234, pendingRetryCause: null };

    expect(() => store.setRun(DEFAULT_QUEUE_ID, invalid, unfencedCommit('test-fixture'))).toThrow();

    expect(store.getRunMap()).toEqual({});
  });
});

describe('concurrent single-queue writes preserve both entries (G-3)', () => {
  /**
   * The whole-map read-modify-write, tested at the only point where it can
   * fail. Both calls are issued before either write settles, so an
   * implementation that captured the map before awaiting would write back a
   * snapshot missing its sibling — which is exactly what a "last write wins" on
   * one memento key does.
   */
  it('does not clobber a sibling when two queues are written at once', async () => {
    let release!: () => void;
    memento.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = store.setRun(DEFAULT_QUEUE_ID, buildWorkflowRun({ id: 'run-1' }), unfencedCommit('test-fixture'));
    const second = store.setRun(OTHER_QUEUE, buildWorkflowRun({ id: 'run-2' }), unfencedCommit('test-fixture'));
    release();
    memento.gate = null;
    await Promise.all([first, second]);

    expect(store.getRun(DEFAULT_QUEUE_ID)?.id).toBe('run-1');
    expect(store.getRun(OTHER_QUEUE)?.id).toBe('run-2');
  });

  it('survives a burst of interleaved writes across both queues', async () => {
    const writes: Promise<void>[] = [];
    for (let index = 0; index < 8; index += 1) {
      const queueId = index % 2 === 0 ? DEFAULT_QUEUE_ID : OTHER_QUEUE;
      writes.push(store.setRun(queueId, buildWorkflowRun({ id: `run-${index}` }), unfencedCommit('test-fixture')));
    }

    await Promise.all(writes);

    expect(Object.keys(store.getRunMap()).sort()).toEqual([DEFAULT_QUEUE_ID, OTHER_QUEUE].sort());
    expect(store.getRun(DEFAULT_QUEUE_ID)?.id).toBe('run-6');
    expect(store.getRun(OTHER_QUEUE)?.id).toBe('run-7');
  });

  it('clears one queue without dropping a concurrent sibling write', async () => {
    await store.setRun(DEFAULT_QUEUE_ID, buildWorkflowRun({ id: 'run-1' }), unfencedCommit('test-fixture'));

    await Promise.all([
      store.setRun(DEFAULT_QUEUE_ID, null, unfencedCommit('test-fixture')),
      store.setRun(OTHER_QUEUE, buildWorkflowRun({ id: 'run-2' }), unfencedCommit('test-fixture'))
    ]);

    expect(Object.keys(store.getRunMap())).toEqual([OTHER_QUEUE]);
  });
});

/**
 * Feature 093 (T048) — the terminal transition journal, keyed by run id.
 *
 * The store's half of the change: a record with one entry per in-flight
 * transition, a legacy single intent lifted rather than dropped, and an
 * unreadable entry skipped rather than allowed to poison the read. Every case
 * here is what makes the coordinator's per-entry replay possible at all.
 */
describe('terminal transition journal (Feature 093 T048)', () => {
  const intentFor = (runId: string, taskId: string) => ({
    schemaVersion: 1 as const,
    run: buildWorkflowRun({ id: runId, featureId: taskId, status: 'completed' as const }),
    createdAt: 1
  });

  it('holds one entry per run and clears only the named one', async () => {
    await store.setTerminalTransitionIntent('run-a', intentFor('run-a', 'task-a'));
    await store.setTerminalTransitionIntent('run-b', intentFor('run-b', 'task-b'));

    expect(Object.keys(store.getTerminalTransitionIntents()).sort()).toEqual(['run-a', 'run-b']);

    await store.setTerminalTransitionIntent('run-a', null);

    expect(Object.keys(store.getTerminalTransitionIntents())).toEqual(['run-b']);
  });

  it('lifts a legacy single intent under its own run id rather than dropping it', () => {
    memento.seed(KEYS.terminalTransitionIntent, intentFor('run-legacy', 'task-legacy'));

    const entries = store.getTerminalTransitionIntents();

    expect(Object.keys(entries)).toEqual(['run-legacy']);
    expect(entries['run-legacy'].run.featureId).toBe('task-legacy');
  });

  it('reads an absent or unreadable record as an empty journal', () => {
    expect(store.getTerminalTransitionIntents()).toEqual({});

    memento.seed(KEYS.terminalTransitionIntent, { 'run-x': { schemaVersion: 2, run: null } });

    expect(store.getTerminalTransitionIntents()).toEqual({});
  });

  it('keeps a sibling entry through interleaved writes on the same key', async () => {
    await Promise.all([
      store.setTerminalTransitionIntent('run-a', intentFor('run-a', 'task-a')),
      store.setTerminalTransitionIntent('run-b', intentFor('run-b', 'task-b'))
    ]);

    expect(Object.keys(store.getTerminalTransitionIntents()).sort()).toEqual(['run-a', 'run-b']);
  });
});
