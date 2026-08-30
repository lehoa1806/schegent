import { readFileSync } from 'node:fs';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import { resolve } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  HISTORY_CAP_PER_QUEUE,
  KEYS,
  QueueMutationRejected,
  RESET_CLEARED_KEYS,
  WorkspaceStateStore,
  type Memento,
  type StoreChangeKey
} from '../../../src/state/workspace-state';
import { HistoryStore } from '../../../src/state/history-store';
import { QueueManager } from '../../../src/queue/queue-manager';
import { MAX_PENDING_TASKS_PER_QUEUE, type FeatureRequest, type QueueState } from '../../../src/queue/feature-request';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { createQueue } from '../../../src/queue/queue-registry';
import type { WorkflowRun, WorkflowRunPipeline, WorkspaceLock } from '../../../src/state/workflow-run';
import type { SanitizedLogger } from '../../../src/lib/logger';
import { buildMutationPlan } from '../../../src/services/mutation-plan';
import { createPersistentGitApproval } from '../../../src/activation/git-approval';

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

/** The registry admits UUIDv4 only, and refuses the default id (`queue-registry.ts:353`). */
const SECOND_QUEUE_ID = '5ec04d00-1111-4222-8333-444444444444';

let memento: FakeMemento;
let store: WorkspaceStateStore;

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
});

function emptyQueue(): QueueState {
  return {
    requests: [],
    inFlightId: null,
    paused: false,
    pausedReason: null,
    updatedAt: 0,
    queueLifecycle: 'active-empty',
    pauseSource: null,
    scheduledStartAt: null,
    scheduledStartSource: null
  };
}

function sampleRun(): WorkflowRun {
  return {
    id: 'run-1',
    featureId: 'feat-1',
    featureDir: 'specs/001-x',
    status: 'running',
    currentPhase: 'speckit-specify',
    currentIteration: 1,
    startedAt: 0,
    lastTransitionAt: 0,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null
  };
}

function sampleLock(): WorkspaceLock {
  return {
    ownerId: 'owner-1',
    acquiredAt: 1,
    heartbeatAt: 1
  };
}

function pendingFeature(id: string, position = 0): FeatureRequest {
  return {
    id,
    description: id,
    enqueuedAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    startedAt: null,
    completedAt: null,
    status: 'pending',
    queueId: DEFAULT_QUEUE_ID,
    position,
    pauseCause: null,
    runId: null,
    retryCount: 0,
    lastError: null,
    pausedReason: null
  };
}

describe('WorkspaceStateStore.subscribe', () => {
  it('fires listener after setQueue with the queue key', async () => {
    const events: StoreChangeKey[] = [];
    store.subscribe((key) => events.push(key));
    await store.setQueue(emptyQueue());
    expect(events).toEqual([KEYS.queue]);
  });

  it('fires listener after setRun with the run key', async () => {
    const events: StoreChangeKey[] = [];
    store.subscribe((key) => events.push(key));
    await store.setRun(DEFAULT_QUEUE_ID, sampleRun(), unfencedCommit('test-fixture'));
    expect(events).toEqual([KEYS.run]);
  });

  it('fires listener after setLock with the lock key', async () => {
    const events: StoreChangeKey[] = [];
    store.subscribe((key) => events.push(key));
    await store.setLock(sampleLock());
    expect(events).toEqual([KEYS.lock]);
  });

  it('does not fire listener for getters or unrelated setters', async () => {
    const events: StoreChangeKey[] = [];
    store.subscribe((key) => events.push(key));

    store.getQueue(DEFAULT_QUEUE_ID);
    store.getRun(DEFAULT_QUEUE_ID);
    store.getLock();
    store.getWatchdog();
    store.getHistory();
    await store.setWatchdog({
      paused: false,
      pausedSince: null,
      nextPollAt: null,
      pollIntervalMs: 1000,
      lastStatusOk: null,
      cause: null
    });

    expect(events).toEqual([]);
  });

  it('disposing prevents subsequent fires for that listener only', async () => {
    const a: StoreChangeKey[] = [];
    const b: StoreChangeKey[] = [];
    const subA = store.subscribe((key) => a.push(key));
    store.subscribe((key) => b.push(key));

    await store.setQueue(emptyQueue());
    subA.dispose();
    await store.setRun(DEFAULT_QUEUE_ID, sampleRun(), unfencedCommit('test-fixture'));
    await store.setLock(sampleLock());

    expect(a).toEqual([KEYS.queue]);
    expect(b).toEqual([KEYS.queue, KEYS.run, KEYS.lock]);
  });

  it('isolates a throwing listener from other subscribers', async () => {
    const ok: StoreChangeKey[] = [];
    store.subscribe(() => {
      throw new Error('boom');
    });
    store.subscribe((key) => ok.push(key));

    await store.setQueue(emptyQueue());
    expect(ok).toEqual([KEYS.queue]);
  });

  it('fires once per setter call across multiple sequential writes', async () => {
    const events: StoreChangeKey[] = [];
    store.subscribe((key) => events.push(key));
    await store.setQueue(emptyQueue());
    await store.setQueue(emptyQueue());
    await store.setRun(DEFAULT_QUEUE_ID, sampleRun(), unfencedCommit('test-fixture'));
    await store.setRun(DEFAULT_QUEUE_ID, null, unfencedCommit('test-fixture'));
    await store.setLock(sampleLock());
    await store.setLock(null);
    expect(events).toEqual([
      KEYS.queue,
      KEYS.queue,
      KEYS.run,
      KEYS.run,
      KEYS.lock,
      KEYS.lock
    ]);
  });
});

describe('WorkspaceStateStore feature-017 queue foundations', () => {
  it('creates a default queue registry during initialization', () => {
    const registry = store.getQueueRegistry();
    expect(registry.entries).toHaveLength(1);
    expect(registry.entries[0].id).toBe(DEFAULT_QUEUE_ID);
    expect(store.getDefaultQueueId()).toBe(DEFAULT_QUEUE_ID);
  });

  it('rejects setting an unknown default queue id', async () => {
    expect(() => store.setDefaultQueueId('missing')).toThrow(QueueMutationRejected);
    try {
      // Typed as async, but the rejection this asserts is thrown synchronously
      // (line above) so no promise is ever created. Discard is explicit.
      void store.setDefaultQueueId('missing');
    } catch (err) {
      expect(err).toMatchObject({
        reason: 'unknown-queue-id'
      });
    }
  });

  it('inserts pending tasks into a queue with position shifting', async () => {
    await store.insertPendingRequest(pendingFeature('first'), { position: 0 });
    await store.insertPendingRequest(pendingFeature('second'), { position: 0 });

    const queue = store.getQueue(DEFAULT_QUEUE_ID);
    expect(queue.requests.map((request) => [request.id, request.position])).toEqual([
      ['first', 1],
      ['second', 0]
    ]);
  });

  it('keeps FIFO order when a task leaves pending before the next enqueue (BUG-004)', async () => {
    // The `position shifting` test above passes an explicit `position: 0` and
    // never moves a task out of `pending`, so the pending count and the next
    // free position never diverge and the pre-fix arithmetic passes it. This
    // walks the divergence: once A is promoted, a count-derived `insertAt`
    // lands on a slot C already occupies, C is shifted past the newcomer, and
    // the projector's `position ascending` sort reports B, D, C — the newest
    // task queue-jumping a task submitted before it.
    await store.insertPendingRequest(pendingFeature('A'), {});
    await store.insertPendingRequest(pendingFeature('B'), {});
    await store.insertPendingRequest(pendingFeature('C'), {});

    const beforePromotion = store.getQueue(DEFAULT_QUEUE_ID);
    await store.setQueue({
      ...beforePromotion,
      requests: beforePromotion.requests.map((request) =>
        request.id === 'A'
          ? { ...request, status: 'in-flight' as const, runId: 'run-A' }
          : request
      )
    });

    await store.insertPendingRequest(pendingFeature('D'), {});

    const pendingOrder = store
      .getQueue(DEFAULT_QUEUE_ID)
      .requests.filter((request) => request.status === 'pending')
      .sort((a, b) => a.position - b.position)
      .map((request) => request.id);
    expect(pendingOrder).toEqual(['B', 'C', 'D']);
  });

  it('serializes concurrent queue read-modify-write mutations without losing either enqueue', async () => {
    await Promise.all([
      store.insertPendingRequest(pendingFeature('concurrent-a')),
      store.insertPendingRequest(pendingFeature('concurrent-b'))
    ]);

    expect(store.getQueue(DEFAULT_QUEUE_ID).requests.map((request) => request.id).sort()).toEqual([
      'concurrent-a',
      'concurrent-b'
    ]);
  });

  it('rejects enqueue into an unknown queue', async () => {
    await expect(
      store.insertPendingRequest({ ...pendingFeature('bad'), queueId: 'missing' }, { queueId: 'missing' })
    ).rejects.toBeInstanceOf(QueueMutationRejected);
  });

  it('modifies pending task descriptions and rejects in-flight modification', async () => {
    await store.setQueue({
      ...emptyQueue(),
      requests: [
        pendingFeature('pending'),
        { ...pendingFeature('running', 1), status: 'in-flight', runId: 'run-1' }
      ]
    });

    const changed = await store.modifyPendingRequest('pending', { description: ' changed ' });
    expect(changed.description).toBe('changed');
    await expect(
      store.modifyPendingRequest('running', { description: 'nope' })
    ).rejects.toMatchObject({ reason: 'task-not-in-pending-state' });
  });

  it('reorders pending tasks within a queue', async () => {
    await store.setQueue({
      ...emptyQueue(),
      requests: [pendingFeature('first', 0), pendingFeature('second', 1), pendingFeature('third', 2)]
    });

    await store.reorderPendingRequest('third', 0);
    expect(store.getQueue(DEFAULT_QUEUE_ID).requests.map((request) => [request.id, request.position])).toEqual([
      ['first', 1],
      ['second', 2],
      ['third', 0]
    ]);
  });

  // Feature 030 (US3, T046) deleted the "moves pending tasks between queues
  // with target position shifting" test: it required a secondary queue via
  // `createQueue`, and the collapse to MAX_QUEUES=1 left none to create.
  // Feature 092 restored the cap to 20 and the path with it, but not the test.
  // Restored below against the current API.
  //
  // `position` is a PENDING-ARRAY INDEX on this writer, the same reading
  // `reorderPendingRequest` documents at `workspace-state.ts:1990`. An index
  // and a `.position` slot value coincide only while a queue's pending slots
  // run 0..n-1, so the cases below stage a target where they do not — that is
  // the arithmetic the deleted test was named for, and it is the half a
  // single-queue reorder test cannot reach.

  /** Registers a second queue alongside the default one. */
  async function addQueue(id: string, name: string): Promise<void> {
    await store.setQueueRegistry(
      createQueue(store.getQueueRegistry(), { id, name, now: 1_700_000_000_000 })
    );
  }

  /** The queue's pending ids in the order their positions put them in. */
  function pendingOrder(queueId: string): string[] {
    return store
      .getQueue(queueId)
      .requests.filter((request) => request.status === 'pending')
      .sort((a, b) => a.position - b.position)
      .map((request) => request.id);
  }

  /** The queue's pending `[id, position]` pairs, lowest slot first. */
  function pendingSlots(queueId: string): [string, number][] {
    return store
      .getQueue(queueId)
      .requests.filter((request) => request.status === 'pending')
      .sort((a, b) => a.position - b.position)
      .map((request) => [request.id, request.position]);
  }

  it('moves a pending task between queues with target position shifting', async () => {
    await addQueue(SECOND_QUEUE_ID, 'Second');
    await store.setQueue({
      ...emptyQueue(),
      requests: [pendingFeature('a', 0), pendingFeature('b', 1), pendingFeature('c', 2)]
    });
    await store.setQueue(
      {
        ...emptyQueue(),
        requests: [
          { ...pendingFeature('x', 0), queueId: SECOND_QUEUE_ID },
          { ...pendingFeature('y', 1), queueId: SECOND_QUEUE_ID }
        ]
      },
      SECOND_QUEUE_ID
    );

    const moved = await store.movePendingRequest('b', {
      targetQueueId: SECOND_QUEUE_ID,
      position: 1
    });

    expect(moved.queueId).toBe(SECOND_QUEUE_ID);
    expect(moved.position).toBe(1);
    // The target shifts to open the slot; the source closes the gap the row left.
    expect(pendingSlots(SECOND_QUEUE_ID)).toEqual([
      ['x', 0],
      ['b', 1],
      ['y', 2]
    ]);
    expect(pendingSlots(DEFAULT_QUEUE_ID)).toEqual([
      ['a', 0],
      ['c', 1]
    ]);
  });

  it('carries the task content verbatim and rewrites only the queue fields', async () => {
    await addQueue(SECOND_QUEUE_ID, 'Second');
    const original: FeatureRequest = {
      ...pendingFeature('carried', 0),
      description: 'author once, re-file many',
      pipelineId: 'pipeline-7',
      retryCount: 2
    };
    await store.setQueue({ ...emptyQueue(), requests: [original] });

    const moved = await store.movePendingRequest('carried', {
      targetQueueId: SECOND_QUEUE_ID
    });

    expect(moved).toMatchObject({
      id: 'carried',
      description: 'author once, re-file many',
      pipelineId: 'pipeline-7',
      retryCount: 2,
      enqueuedAt: original.enqueuedAt,
      createdAt: original.createdAt,
      queueId: SECOND_QUEUE_ID,
      position: 0
    });
    expect(moved.updatedAt).not.toBe(original.updatedAt);
    expect(store.getQueue(DEFAULT_QUEUE_ID).requests).toEqual([]);
  });

  it('appends to the end of a target whose pending slots do not start at 0', async () => {
    // The realistic shape: the target is already executing, so its running row
    // holds slot 0 and its pending rows sit at 1 and 2. `position` is a pending
    // index, so omitting it means "last of 2 pending" — index 2.
    await addQueue(SECOND_QUEUE_ID, 'Second');
    await store.setQueue({ ...emptyQueue(), requests: [pendingFeature('mover', 0)] });
    await store.setQueue(
      {
        ...emptyQueue(),
        requests: [
          {
            ...pendingFeature('running', 0),
            queueId: SECOND_QUEUE_ID,
            status: 'in-flight' as const,
            runId: 'run-1'
          },
          { ...pendingFeature('x', 1), queueId: SECOND_QUEUE_ID },
          { ...pendingFeature('y', 2), queueId: SECOND_QUEUE_ID }
        ],
        inFlightId: 'running'
      },
      SECOND_QUEUE_ID
    );

    await store.movePendingRequest('mover', { targetQueueId: SECOND_QUEUE_ID });

    expect(pendingOrder(SECOND_QUEUE_ID)).toEqual(['x', 'y', 'mover']);
  });

  it('inserts at a pending index rather than a slot value in a gapped target', async () => {
    await addQueue(SECOND_QUEUE_ID, 'Second');
    await store.setQueue({ ...emptyQueue(), requests: [pendingFeature('mover', 0)] });
    await store.setQueue(
      {
        ...emptyQueue(),
        requests: [
          {
            ...pendingFeature('running', 0),
            queueId: SECOND_QUEUE_ID,
            status: 'in-flight' as const,
            runId: 'run-1'
          },
          { ...pendingFeature('x', 1), queueId: SECOND_QUEUE_ID },
          { ...pendingFeature('y', 2), queueId: SECOND_QUEUE_ID }
        ],
        inFlightId: 'running'
      },
      SECOND_QUEUE_ID
    );

    // Pending index 1 is "between x and y", whatever slots those two hold.
    await store.movePendingRequest('mover', {
      targetQueueId: SECOND_QUEUE_ID,
      position: 1
    });

    expect(pendingOrder(SECOND_QUEUE_ID)).toEqual(['x', 'mover', 'y']);
    // The in-flight row is not pending and keeps its slot untouched.
    expect(
      store.getQueue(SECOND_QUEUE_ID).requests.find((request) => request.id === 'running')?.position
    ).toBe(0);
  });

  it('inserts ahead of every pending row without landing on an occupied slot', async () => {
    // Pending index 0 means "first of the pending rows", not "slot 0" — slot 0
    // belongs to the in-flight row.
    //
    // This case passes against the pre-fix writer as well, and is kept anyway.
    // That writer wrote the arrival onto the in-flight row's slot, but the
    // duplicate never surfaced: `compactRequestPositions()` re-derives every
    // position on read, and its sort is stable, so the arrival — last in array
    // order — landed after the row it was level with. The order was right by
    // the tie-break rather than by the arithmetic. What this pins is the
    // invariant that made the luck unnecessary, which the shift-every-row
    // branch below could break on its own.
    await addQueue(SECOND_QUEUE_ID, 'Second');
    await store.setQueue({ ...emptyQueue(), requests: [pendingFeature('mover', 0)] });
    await store.setQueue(
      {
        ...emptyQueue(),
        requests: [
          {
            ...pendingFeature('running', 0),
            queueId: SECOND_QUEUE_ID,
            status: 'in-flight' as const,
            runId: 'run-1'
          },
          { ...pendingFeature('x', 1), queueId: SECOND_QUEUE_ID },
          { ...pendingFeature('y', 2), queueId: SECOND_QUEUE_ID }
        ],
        inFlightId: 'running'
      },
      SECOND_QUEUE_ID
    );

    await store.movePendingRequest('mover', {
      targetQueueId: SECOND_QUEUE_ID,
      position: 0
    });

    expect(pendingOrder(SECOND_QUEUE_ID)).toEqual(['mover', 'x', 'y']);
    const positions = store.getQueue(SECOND_QUEUE_ID).requests.map((request) => request.position);
    expect(new Set(positions).size).toBe(positions.length);
    // The arrival is behind the row that is executing, not level with it.
    const slots = new Map(
      store.getQueue(SECOND_QUEUE_ID).requests.map((request) => [request.id, request.position])
    );
    expect(slots.get('running')).toBeLessThan(slots.get('mover') ?? -1);
  });

  it('leaves the source queue with no vacant slot after the row departs', async () => {
    // A gap here becomes a wrong insert later: the source is some other move's
    // target, and this writer reads slots to decide where a row lands.
    await addQueue(SECOND_QUEUE_ID, 'Second');
    await store.setQueue({
      ...emptyQueue(),
      requests: [pendingFeature('a', 0), pendingFeature('b', 1), pendingFeature('c', 2)]
    });

    await store.movePendingRequest('a', { targetQueueId: SECOND_QUEUE_ID });

    expect(pendingSlots(DEFAULT_QUEUE_ID)).toEqual([
      ['b', 0],
      ['c', 1]
    ]);
  });

  it('rejects a move to an unknown queue, a non-pending task, and an out-of-range index', async () => {
    await addQueue(SECOND_QUEUE_ID, 'Second');
    await store.setQueue({
      ...emptyQueue(),
      requests: [
        pendingFeature('pending-row', 0),
        { ...pendingFeature('running-row', 1), status: 'in-flight' as const, runId: 'run-1' }
      ]
    });

    await expect(
      store.movePendingRequest('pending-row', { targetQueueId: 'queue-that-is-not-there' })
    ).rejects.toMatchObject({ reason: 'unknown-queue-id' });
    await expect(
      store.movePendingRequest('running-row', { targetQueueId: SECOND_QUEUE_ID })
    ).rejects.toMatchObject({ reason: 'task-not-in-pending-state' });
    await expect(
      store.movePendingRequest('absent', { targetQueueId: SECOND_QUEUE_ID })
    ).rejects.toMatchObject({ reason: 'task-not-found' });
    // The empty target admits index 0 only — one past the pending count.
    await expect(
      store.movePendingRequest('pending-row', { targetQueueId: SECOND_QUEUE_ID, position: 1 })
    ).rejects.toMatchObject({ reason: 'position-out-of-range' });
  });

  it('refuses a move that would take the target past the pending cap', async () => {
    await addQueue(SECOND_QUEUE_ID, 'Second');
    await store.setQueue({ ...emptyQueue(), requests: [pendingFeature('mover', 0)] });
    await store.setQueue(
      {
        ...emptyQueue(),
        requests: Array.from({ length: MAX_PENDING_TASKS_PER_QUEUE }, (_, i) => ({
          ...pendingFeature(`full-${i}`, i),
          queueId: SECOND_QUEUE_ID
        }))
      },
      SECOND_QUEUE_ID
    );

    await expect(
      store.movePendingRequest('mover', { targetQueueId: SECOND_QUEUE_ID })
    ).rejects.toMatchObject({ reason: 'task-cap-reached' });
    // The refusal is total: the row is still on its own queue.
    expect(pendingOrder(DEFAULT_QUEUE_ID)).toEqual(['mover']);
  });

  it('rejects positions outside the target queue range', async () => {
    await expect(
      store.insertPendingRequest(pendingFeature('bad'), { position: 1 })
    ).rejects.toMatchObject({ reason: 'position-out-of-range' });
  });

  it('enforces the pending task cap per queue', async () => {
    await store.setQueue({
      ...emptyQueue(),
      requests: Array.from({ length: MAX_PENDING_TASKS_PER_QUEUE }, (_, i) =>
        pendingFeature(`task-${i}`, i)
      )
    });

    await expect(
      store.insertPendingRequest(pendingFeature('overflow'))
    ).rejects.toMatchObject({ reason: 'task-cap-reached' });
  });

  it('stores queue settings with closed reject reasons', async () => {
    // Feature 030 (US3, T046) — the original test set a non-default
    // `defaultQueueId` after creating a second queue. That path is gone
    // (cap=1) but the global concurrency cap setter still validates
    // its bound; pin that branch on the default registry.
    // Feature 056 Track 4 (FR-018..FR-022) pinned the cap window to [1, 1];
    // feature 092 (T056, FR-026/FR-027) reopened it to [1, 20], so 2 is now a
    // legal value and the rejecting branch moves to one past the upper bound.
    await store.setGlobalConcurrencyCap(1);
    expect(store.getDefaultQueueId()).toBe(DEFAULT_QUEUE_ID);
    expect(store.getGlobalConcurrencyCap()).toBe(1);
    await store.setGlobalConcurrencyCap(2);
    expect(store.getGlobalConcurrencyCap()).toBe(2);
    expect(() => store.setGlobalConcurrencyCap(21)).toThrow(QueueMutationRejected);
    expect(() => store.setGlobalConcurrencyCap(0)).toThrow(QueueMutationRejected);
  });

  it('enforces the manual pause pair invariant at the persistence boundary', async () => {
    expect(() => store.setRun(DEFAULT_QUEUE_ID, { ...sampleRun(), manualPauseAt: 1_700_000_000_000 }, unfencedCommit('test-fixture'))).toThrow(
      /manualPauseAt/
    );
  });

  it('sets and clears queue-sourced manual pause only for the matching in-flight task', async () => {
    const manager = new QueueManager(store);
    const running = { ...pendingFeature('running'), status: 'in-flight' as const, runId: 'run-1' };
    await store.setQueue({ ...emptyQueue(), requests: [running], inFlightId: 'running' });
    await store.setRun(DEFAULT_QUEUE_ID, { ...sampleRun(), featureId: 'running' }, unfencedCommit('test-fixture'));

    expect(await manager.setQueuePausedState(true, DEFAULT_QUEUE_ID)).toMatchObject({ ok: true });
    expect(store.getRun(DEFAULT_QUEUE_ID)?.manualPauseCause).toBe('queue-paused-mid-run');

    expect(await manager.setQueuePausedState(false, DEFAULT_QUEUE_ID)).toMatchObject({ ok: true });
    expect(store.getRun(DEFAULT_QUEUE_ID)?.manualPauseCause).toBeNull();
  });

  it('resuming a queue preserves operator-paused runs', async () => {
    const manager = new QueueManager(store);
    const running = { ...pendingFeature('running'), status: 'in-flight' as const, runId: 'run-1' };
    await store.setQueue({ ...emptyQueue(), requests: [running], inFlightId: 'running' });
    await store.setRun(DEFAULT_QUEUE_ID, {
      ...sampleRun(),
      featureId: 'running',
      manualPauseAt: 1_700_000_000_000,
      manualPauseCause: 'operator-paused'
    },
      unfencedCommit('test-fixture')
    );

    expect(await manager.setQueuePausedState(true, DEFAULT_QUEUE_ID)).toMatchObject({ ok: true });
    expect(store.getRun(DEFAULT_QUEUE_ID)?.manualPauseCause).toBe('operator-paused');

    expect(await manager.setQueuePausedState(false, DEFAULT_QUEUE_ID)).toMatchObject({ ok: true });
    expect(store.getRun(DEFAULT_QUEUE_ID)?.manualPauseCause).toBe('operator-paused');
  });
});

describe('Persistence migration (T065 / SC-013)', () => {
  it('backfills missing 004 fields when reading a pre-004 QueueState', async () => {
    const memento = new FakeMemento();
    const pre004: { paused?: boolean; inFlightId: string | null; requests: unknown[] } = {
      inFlightId: null,
      requests: [
        {
          id: 'q-old',
          description: 'legacy item without retryCount',
          enqueuedAt: 1700000000000,
          status: 'pending',
          position: 0,
          runId: null
        }
      ]
    };
    await memento.update(KEYS.schemaVersion, '1.0.0');
    await memento.update(KEYS.queue, pre004);

    const s = new WorkspaceStateStore(memento);
    await s.initialize();
    const queue = s.getQueue(DEFAULT_QUEUE_ID);
    expect(queue.queueLifecycle).not.toBe('operator-paused');
    expect(queue.pausedReason).toBeNull();
    expect(queue.requests).toHaveLength(1);
    const r = queue.requests[0];
    expect(r.retryCount).toBe(0);
    expect(r.lastError).toBeNull();
    expect(r.pausedReason).toBeNull();
    expect(r.startedAt).toBeNull();
    expect(r.completedAt).toBeNull();
    expect(r.createdAt).toBe(1700000000000);
    // Feature 030 (US3, T046) — the v5 → v6 coalesce pass re-stamps
    // `updatedAt: Date.now()` on every pending request as part of the
    // dense-position rewrite. The pre-004 backfill itself still seeds
    // `updatedAt: enqueuedAt`; the v5→v6 step then overrides it. Pin
    // the post-migration behavior: `updatedAt >= createdAt`.
    expect(r.updatedAt).toBeGreaterThanOrEqual(r.createdAt);
  });

  it('preserves existing 004 fields when reading a post-004 QueueState', async () => {
    const memento = new FakeMemento();
    const post004: QueueState = {
      paused: true,
      pausedReason: 'rate-limited',
      inFlightId: null,
      updatedAt: 1700000000000,
      queueLifecycle: 'operator-paused',
      pauseSource: null,
      scheduledStartAt: null,
      scheduledStartSource: null,
      requests: [
        {
          id: 'q-new',
          description: 'modern item',
          enqueuedAt: 1700000000000,
          createdAt: 1700000000000,
          updatedAt: 1700000000050,
          startedAt: null,
          completedAt: null,
          status: 'failed',
          position: 0,
          runId: null,
          retryCount: 2,
          lastError: 'oops',
          pausedReason: null
        }
      ]
    };
    await memento.update(KEYS.schemaVersion, '1.0.0');
    await memento.update(KEYS.queue, post004);

    const s = new WorkspaceStateStore(memento);
    await s.initialize();
    const queue = s.getQueue(DEFAULT_QUEUE_ID);
    expect(queue.queueLifecycle).toBe('operator-paused');
    expect(queue.pausedReason).toBe('rate-limited');
    expect(queue.requests[0].retryCount).toBe(2);
    expect(queue.requests[0].lastError).toBe('oops');
  });

  it('returns a valid empty QueueState when memento has no queue at all', async () => {
    const memento = new FakeMemento();
    const s = new WorkspaceStateStore(memento);
    await s.initialize();
    const queue = s.getQueue(DEFAULT_QUEUE_ID);
    expect(queue.requests).toEqual([]);
    expect(queue.queueLifecycle).not.toBe('operator-paused');
    expect(queue.pausedReason).toBeNull();
    expect(queue.inFlightId).toBeNull();
    expect(typeof queue.updatedAt).toBe('number');
  });

  it('repairs contaminated default pipeline snapshots during initialize', async () => {
    const memento = new FakeMemento();
    await memento.update(KEYS.schemaVersion, '1.0.0');
    await memento.update(KEYS.schemaVersionNumeric, 6);
    await memento.update(KEYS.run, {
      ...sampleRun(),
      pipeline: {
        id: 'speckit-new-feature',
        name: 'Spec-kit New Feature',
        phases: [
          { id: 'speckit-specify', name: 'Specify', instruction: 'x', loopable: false },
          { id: 'speckit-clarify', name: 'Clarify', instruction: 'x', loopable: true },
          { id: 'speckit-plan', name: 'Plan', instruction: 'x', loopable: false },
          { id: 'speckit-tasks', name: 'Tasks', instruction: 'x', loopable: false },
          { id: 'speckit-analyze', name: 'Analyze', instruction: 'x', loopable: true },
          { id: 'speckit-implement', name: 'Implement', instruction: 'x', loopable: false },
          { id: 'finalize', name: 'Finalize', instruction: 'x', loopable: false },
          { id: 'done', name: 'Done', instruction: 'x', loopable: false },
          { id: 'bugfix-report', name: 'Bugfix Report', instruction: 'x', loopable: false }
        ]
      }
    });

    const s = new WorkspaceStateStore(memento);
    const initResult = await s.initialize();

    expect(initResult.runRepairEvents).toHaveLength(1);
    expect(initResult.runRepairEvents[0]).toMatchObject({
      type: 'workflow-run-repaired',
      removedPhaseCount: 1,
      remainingPhaseCount: 8
    });
    expect(s.getRun(DEFAULT_QUEUE_ID)?.pipeline?.phases.map((p) => p.id)).toEqual([
      'speckit-specify',
      'speckit-clarify',
      'speckit-plan',
      'speckit-tasks',
      'speckit-analyze',
      'speckit-implement',
      'finalize',
      'done'
    ]);
  });

  it('history-store: pre-004 history (no descriptionPreview/durationMs/auditLogPointer) is normalized', async () => {
    const memento = new FakeMemento();
    await memento.update(KEYS.schemaVersion, '1.0.0');
    // Persisted shape that lacks 004's descriptionPreview, durationMs, and auditLogPointer
    await memento.update(KEYS.history, [
      {
        runId: 'run-legacy',
        featureId: 'feat-legacy',
        startedAt: 1700000000000,
        completedAt: 1700000000200,
        status: 'completed'
      }
    ]);
    const s = new WorkspaceStateStore(memento);
    await s.initialize();
    const hs = new HistoryStore(s);
    const list = hs.list();
    expect(list).toHaveLength(1);
    const e = list[0];
    expect(e.runId).toBe('run-legacy');
    expect(e.terminalStatus).toBe('completed');
    expect(typeof e.descriptionPreview).toBe('string');
    expect(e.durationMs).toBe(200);
    expect(e.auditLogPointer).toBe('runId:run-legacy');
  });
});

// Feature 103 (T075, US6) — history retention is still one rule at one cap.
//
// FR-044 and FR-045 are negative requirements, and negative requirements only
// hold if something asserts the absence. US6 gave the catalog a reason to care
// how long a history row lives, and the tempting follow-on is to give history a
// second rule to make that reason cheaper: an age sweep so old rows stop pinning
// versions, or a per-definition limit so one busy Pipeline cannot hold fifty.
//
// Either would be a second retention policy free to disagree with the first, and
// the disagreement is silent — a row visible on the surface whose version has
// been pruned, which is the exact failure FR-040 exists to prevent. The cap is
// the only rule, it is applied at one site, and eviction is the only way out.
describe('history retention is the per-queue cap and nothing else (FR-044, FR-045)', () => {
  const HISTORY_SRC = readFileSync(
    resolve(__dirname, '../../../src/state/workspace-state.ts'),
    'utf8'
  );

  function historyEntry(seq: number, completedMs: number, versionId: string) {
    return {
      runId: `run-${seq}`,
      featureId: `feat-${seq}`,
      descriptionPreview: `desc ${seq}`,
      terminalStatus: 'completed' as const,
      startedAt: new Date(completedMs - 500).toISOString(),
      completedAt: new Date(completedMs).toISOString(),
      durationMs: 500,
      lastErrorSummary: null,
      auditLogPointer: `runId:run-${seq}`,
      catalogVersion: { kind: 'pipeline' as const, id: 'analysis', versionId }
    };
  }

  it('applies the cap at exactly one site', () => {
    // Twice in the file: the constant, and the single overflow calculation in
    // `appendHistory`. A third occurrence is a second place the depth is decided.
    expect(HISTORY_SRC.match(/HISTORY_CAP_PER_QUEUE/g) ?? []).toHaveLength(2);
    expect(HISTORY_CAP_PER_QUEUE).toBe(50);
  });

  it('keeps an entry regardless of how old it is, while it is under the cap', async () => {
    // Ten years apart, in reverse chronological order of arrival. Nothing here
    // reads a clock, so nothing here can age anything out.
    const decadeMs = 10 * 365 * 24 * 60 * 60 * 1_000;
    const history = new HistoryStore(store);
    await history.append('alpha', historyEntry(0, 1_700_000_000_000 - decadeMs, 'v1'));
    await history.append('alpha', historyEntry(1, 1_700_000_000_000, 'v2'));

    expect(history.listForQueue('alpha')).toHaveLength(2);
    expect(history.listForQueue('alpha').some((row) => row.runId === 'run-0')).toBe(true);
  });

  it('imposes no per-definition limit inside a partition', async () => {
    // Fifty runs of one Pipeline at one version. A per-definition cap — the
    // obvious way to bound how much any single definition can pin — would trim
    // this and release the pin while rows the operator can still see remain.
    const history = new HistoryStore(store);
    for (let seq = 0; seq < HISTORY_CAP_PER_QUEUE; seq += 1) {
      await history.append('alpha', historyEntry(seq, 1_700_000_000_000 + seq * 1_000, 'v1'));
    }

    const rows = history.listForQueue('alpha');
    expect(rows).toHaveLength(HISTORY_CAP_PER_QUEUE);
    expect(rows.every((row) => row.catalogVersion?.versionId === 'v1')).toBe(true);
  });

  it('evicts exactly one entry per append once the cap is reached, and reports it', async () => {
    const history = new HistoryStore(store);
    for (let seq = 0; seq < HISTORY_CAP_PER_QUEUE; seq += 1) {
      expect(
        await history.append('alpha', historyEntry(seq, 1_700_000_000_000 + seq * 1_000, 'v1'))
      ).toEqual([]);
    }

    const evicted = await history.append('alpha', historyEntry(50, 1_700_000_050_000, 'v2'));

    // Returned synchronously from the append, not discovered later by a sweep.
    // That synchrony is what FR-042 rests on: the pin is gone by the time the
    // append resolves, so the very next prune sees the release.
    expect(evicted).toHaveLength(1);
    expect(history.listForQueue('alpha')).toHaveLength(HISTORY_CAP_PER_QUEUE);
  });

  it('counts each partition on its own, so one busy queue evicts nothing elsewhere', async () => {
    const history = new HistoryStore(store);
    await history.append('beta', historyEntry(0, 1_700_000_000_000, 'v1'));
    for (let seq = 1; seq <= HISTORY_CAP_PER_QUEUE + 10; seq += 1) {
      await history.append('alpha', historyEntry(seq, 1_700_000_000_000 + seq * 1_000, 'v2'));
    }

    expect(history.listForQueue('alpha')).toHaveLength(HISTORY_CAP_PER_QUEUE);
    expect(history.listForQueue('beta')).toHaveLength(1);
  });
});

/**
 * FR-R3-146 (FR-006, FR-011) — the durable Git-plan grant, and the reader that
 * has to survive whatever is in `.schegent/state.json`.
 *
 * The whole input table from `contracts/git-plan-grants.md` is here, not a
 * sample of it. This record is consulted before a Git-mutating run and a reader
 * that threw would take activation down with it; one that guessed would grant
 * consent for a plan nobody approved. Both failures are silent until the day
 * they are not, so every row is asserted rather than assumed.
 */
describe('git plan grants — a total reader that fails closed (FR-R3-146)', () => {
  const GRANT = Object.freeze({
    fingerprint: 'a'.repeat(64),
    grantedAt: 1_700_000_000_000,
    pipelineId: 'spec-driven',
    phaseIds: Object.freeze(['speckit-implement', 'speckit-git-commit'])
  });

  let warnings: string[];
  let logged: WorkspaceStateStore;
  let loggedMemento: FakeMemento;

  beforeEach(async () => {
    warnings = [];
    loggedMemento = new FakeMemento();
    logged = new WorkspaceStateStore(loggedMemento, {
      warn: (message: string) => warnings.push(message)
    } as unknown as SanitizedLogger);
    await logged.initialize();
  });

  /** Put a raw value under the key without going through the writer. */
  const stored = async (raw: unknown): Promise<void> => {
    await loggedMemento.update(KEYS.gitPlanGrants, raw);
  };

  it('reads an absent key as no grants, and says nothing about it', () => {
    expect(logged.getGitPlanGrants()).toEqual({});
    expect(logged.hasGitPlanGrant(GRANT.fingerprint)).toBe(false);
    // A fresh workspace is not a fault. A warning here would be in every log
    // this product ever writes, which is how the ones that matter get filtered.
    expect(warnings).toEqual([]);
  });

  it.each([
    ['null', null],
    ['a string', 'schegent.consent.gitPlanGrants.v1'],
    ['a number', 7],
    ['an array', [{ ...GRANT }]]
  ])('reads %s as no grants, warns once, and does not throw', async (_label, raw) => {
    await stored(raw);

    expect(logged.getGitPlanGrants()).toEqual({});
    expect(warnings).toHaveLength(1);
    // The warning names the key, so an operator can find the record it is about.
    expect(warnings[0]).toContain(KEYS.gitPlanGrants);
  });

  it('reads a well-formed map as its entries, with nothing to report', async () => {
    await stored({ [GRANT.fingerprint]: { ...GRANT } });

    const grants = logged.getGitPlanGrants();
    expect(Object.keys(grants)).toEqual([GRANT.fingerprint]);
    expect(grants[GRANT.fingerprint]).toEqual(GRANT);
    expect(logged.hasGitPlanGrant(GRANT.fingerprint)).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('keeps the well-formed entries of a partly-malformed map, and warns per drop', async () => {
    const other = { ...GRANT, fingerprint: 'b'.repeat(64) };
    await stored({
      [GRANT.fingerprint]: { ...GRANT },
      [other.fingerprint]: other,
      ['c'.repeat(64)]: 'not a record at all'
    });

    const grants = logged.getGitPlanGrants();
    // The two good entries survive: one bad neighbour must not cost a grant the
    // operator gave, or a corrupt file becomes a re-prompt for every plan.
    expect(Object.keys(grants).sort()).toEqual([GRANT.fingerprint, other.fingerprint].sort());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('c'.repeat(64));
  });

  it.each([
    ['`fingerprint` disagrees with its key', { ...GRANT, fingerprint: 'd'.repeat(64) }],
    ['`fingerprint` is absent', { grantedAt: 1, pipelineId: 'p', phaseIds: [] }],
    ['`grantedAt` is absent', { fingerprint: GRANT.fingerprint, pipelineId: 'p', phaseIds: [] }],
    ['`grantedAt` is not finite', { ...GRANT, grantedAt: Number.NaN }],
    ['`grantedAt` is a string', { ...GRANT, grantedAt: '1700000000000' }],
    ['`pipelineId` is absent', { fingerprint: GRANT.fingerprint, grantedAt: 1, phaseIds: [] }],
    ['`phaseIds` is not an array', { ...GRANT, phaseIds: 'speckit-implement' }],
    ['`phaseIds` holds a non-string', { ...GRANT, phaseIds: ['ok', 3] }],
    ['the entry is null', null]
  ])('drops an entry where %s, and grants nothing for it', async (_label, entry) => {
    await stored({ [GRANT.fingerprint]: entry });

    expect(logged.getGitPlanGrants()).toEqual({});
    expect(logged.hasGitPlanGrant(GRANT.fingerprint)).toBe(false);
    expect(warnings).toHaveLength(1);
  });

  it('is authoritative on the key, not on the field, when the two disagree', async () => {
    // Written out because it is the one rejection that could plausibly have gone
    // the other way. The key is what a lookup matches on, so honouring the field
    // would mean consulting fingerprint A and finding a record that says B.
    const impostor = 'e'.repeat(64);
    await stored({ [impostor]: { ...GRANT } });

    expect(logged.hasGitPlanGrant(impostor)).toBe(false);
    expect(logged.hasGitPlanGrant(GRANT.fingerprint)).toBe(false);
  });

  it('does not read an inherited property as a grant', async () => {
    // `grants['toString']` is a function on Object.prototype. A truthiness check
    // would read that as consent.
    await stored({});
    expect(logged.hasGitPlanGrant('toString')).toBe(false);
  });

  it('reports an unreadable record once, not once per consultation', async () => {
    await stored('not a map');
    for (let i = 0; i < 5; i += 1) logged.getGitPlanGrants();
    // A drain consults this per task. Five identical lines is how the line that
    // matters gets filtered out.
    expect(warnings).toHaveLength(1);
  });
});

/**
 * FR-R3-146 (FR-008) — the write never widens.
 *
 * The property SC-004 rests on: consent is bound to one fingerprint, and a plan
 * that differs by a single phase is a different plan.
 */
describe('git plan grants — the writer (FR-R3-146)', () => {
  const grant = (fingerprint: string, grantedAt = 1_700_000_000_000) => ({
    fingerprint,
    grantedAt,
    pipelineId: 'spec-driven',
    phaseIds: ['speckit-implement']
  });

  it('records exactly the fingerprint approved, and nothing near it', async () => {
    await store.recordGitPlanGrant(grant('a'.repeat(64)));

    expect(store.hasGitPlanGrant('a'.repeat(64))).toBe(true);
    // One character different: a different plan, and not granted.
    expect(store.hasGitPlanGrant(`${'a'.repeat(63)}b`)).toBe(false);
    expect(Object.keys(store.getGitPlanGrants())).toHaveLength(1);
  });

  it('is idempotent, refreshing grantedAt rather than duplicating or failing', async () => {
    await store.recordGitPlanGrant(grant('a'.repeat(64), 1_700_000_000_000));
    await store.recordGitPlanGrant(grant('a'.repeat(64), 1_700_000_999_000));

    const grants = store.getGitPlanGrants();
    expect(Object.keys(grants)).toHaveLength(1);
    expect(grants).toMatchObject({ ['a'.repeat(64)]: { grantedAt: 1_700_000_999_000 } });
  });

  it('leaves grants for other plans exactly as they were', async () => {
    await store.recordGitPlanGrant(grant('a'.repeat(64)));
    await store.recordGitPlanGrant(grant('b'.repeat(64)));

    expect(Object.keys(store.getGitPlanGrants()).sort()).toEqual(
      ['a'.repeat(64), 'b'.repeat(64)].sort()
    );
  });

  it('keeps what it stored legible without reading source (FR-012)', async () => {
    await store.recordGitPlanGrant({
      fingerprint: 'a'.repeat(64),
      grantedAt: 1_700_000_000_000,
      pipelineId: 'spec-driven',
      phaseIds: ['speckit-implement', 'speckit-git-commit']
    });

    // What an operator opening `.schegent/state.json` sees: which pipeline, which
    // phases, when. A bare fingerprint would be a grant nobody can audit.
    const raw = memento.get<Record<string, unknown>>(KEYS.gitPlanGrants);
    expect(JSON.stringify(raw)).toContain('spec-driven');
    expect(JSON.stringify(raw)).toContain('speckit-git-commit');
    expect(JSON.stringify(raw)).toContain('1700000000000');
  });

  it('is withdrawn by a reset, so clearing state restores the prompt', async () => {
    await store.recordGitPlanGrant(grant('a'.repeat(64)));
    expect(store.hasGitPlanGrant('a'.repeat(64))).toBe(true);

    for (const key of RESET_CLEARED_KEYS) await memento.update(key, undefined);

    expect(store.hasGitPlanGrant('a'.repeat(64))).toBe(false);
  });

  // FR-R3-146 (FR-002, SC-002, US3) — a declined prompt writes no grant.
  //
  // Only `recordGitPlanGrant` writes, and only the modal's `'persist'` decision
  // calls it. So the store's half of "a decline leaves nothing behind" is that
  // ASKING costs nothing: consulting the record must not bring it into existence,
  // or a workspace where every prompt was dismissed would still gain a key.
  it('writes nothing when it is only consulted', async () => {
    expect(store.hasGitPlanGrant('a'.repeat(64))).toBe(false);
    expect(store.getGitPlanGrants()).toEqual({});

    expect(memento.get(KEYS.gitPlanGrants)).toBeUndefined();
  });

  it('leaves an existing record untouched when a later plan is declined', async () => {
    await store.recordGitPlanGrant(grant('a'.repeat(64)));
    const before = JSON.stringify(memento.get(KEYS.gitPlanGrants));

    // The operator dismisses the modal for a different plan: nothing is recorded
    // for it, and the grant they did give is not disturbed.
    expect(store.hasGitPlanGrant('b'.repeat(64))).toBe(false);

    expect(JSON.stringify(memento.get(KEYS.gitPlanGrants))).toBe(before);
    expect(Object.keys(store.getGitPlanGrants())).toEqual(['a'.repeat(64)]);
  });

  // FR-R3-146 (FR-012, SC-005, US4) — the grant outlives the window, not just the Run.
  //
  // The legibility test above reads the record the same store just wrote. This one
  // closes the window: a second `WorkspaceStateStore` over the same state, through
  // `initialize()` and therefore through the forward-migration ladder, which is the
  // path that would silently drop an unrecognised key. Fields are compared as
  // values, not as substrings of JSON, so a reader that kept the fingerprint and
  // discarded the audit trail fails here.
  it('round-trips through a new window with the audit trail intact', async () => {
    const fingerprint = 'c'.repeat(64);
    await store.recordGitPlanGrant({
      fingerprint,
      grantedAt: 1_700_000_000_000,
      pipelineId: 'spec-driven',
      phaseIds: ['speckit-implement', 'speckit-git-commit']
    });

    const reopened = new WorkspaceStateStore(memento);
    await reopened.initialize();

    expect(reopened.hasGitPlanGrant(fingerprint)).toBe(true);
    expect(reopened.getGitPlanGrants()).toMatchObject({
      [fingerprint]: {
        fingerprint,
        grantedAt: 1_700_000_000_000,
        pipelineId: 'spec-driven',
        phaseIds: ['speckit-implement', 'speckit-git-commit']
      }
    });
  });

  // FR-R3-146 (FR-013, US4-2) — withdrawal at the granularity the grant was given.
  //
  // The reset test above withdraws everything. This is the withdrawal an operator
  // actually performs: open `.schegent/state.json`, remove the one entry they no
  // longer stand behind, keep the rest. The prompt has to come back for that plan
  // and only that plan, and consenting again has to work — a withdrawal that
  // permanently poisoned a fingerprint would be a worse trap than never asking.
  it('is withdrawn one entry at a time, and only that plan asks again', async () => {
    const withdrawn = 'a'.repeat(64);
    const kept = 'b'.repeat(64);
    await store.recordGitPlanGrant(grant(withdrawn));
    await store.recordGitPlanGrant(grant(kept));

    await memento.update(
      KEYS.gitPlanGrants,
      Object.fromEntries(
        Object.entries(store.getGitPlanGrants()).filter(([key]) => key !== withdrawn)
      )
    );

    expect(store.hasGitPlanGrant(withdrawn)).toBe(false);
    expect(store.hasGitPlanGrant(kept)).toBe(true);

    // And it can be given again: withdrawal restores the question, not a refusal.
    await store.recordGitPlanGrant(grant(withdrawn));
    expect(store.hasGitPlanGrant(withdrawn)).toBe(true);
  });
});

/**
 * FR-R3-146 (FR-010, SC-006, US5) — the upgrade.
 *
 * A workspace that has been running Schegent for months has queues, Runs and
 * history in `.schegent/state.json` and no consent key at all, because the code
 * that wrote that file did not have one. This feature adds exactly one key and no
 * migration rung, on the `connectedRuns` precedent: a new key's ABSENCE already
 * means "nothing granted", and a rung that wrote `{}` would be a state change
 * dressed as a no-op.
 *
 * The fixture is built through the public API rather than by hand-writing raw
 * memento values, because that is what makes it a faithful pre-feature file: the
 * feature touched no other key, so state written without ever calling
 * `recordGitPlanGrant` IS what the previous build produced. The test asserts that
 * premise instead of assuming it.
 */
describe('git plan grants — state written before the feature existed (FR-R3-146)', () => {
  const GIT_PIPELINE: WorkflowRunPipeline = Object.freeze({
    id: 'spec-driven',
    name: 'Spec Driven',
    phases: Object.freeze([
      Object.freeze({ id: 'speckit-specify', name: 'Specify', sideEffects: 'workspace' as const }),
      Object.freeze({ id: 'speckit-implement', name: 'Implement', sideEffects: 'git' as const })
    ])
  });

  let warnings: string[];
  let upgraded: WorkspaceStateStore;

  /** A workspace with real work in it and no consent key. */
  beforeEach(async () => {
    const before = new WorkspaceStateStore(memento);
    await before.initialize();
    await before.insertPendingRequest(pendingFeature('legacy-task'));
    await before.setRun(DEFAULT_QUEUE_ID, sampleRun(), unfencedCommit('test-fixture'));
    await new HistoryStore(before).append(DEFAULT_QUEUE_ID, {
      runId: 'run-1',
      featureId: 'feat-1',
      descriptionPreview: 'desc 1',
      terminalStatus: 'completed' as const,
      startedAt: new Date(1_700_000_000_000).toISOString(),
      completedAt: new Date(1_700_000_000_500).toISOString(),
      durationMs: 500,
      lastErrorSummary: null,
      auditLogPointer: 'runId:run-1',
      catalogVersion: { kind: 'pipeline' as const, id: 'spec-driven', versionId: 'v1' }
    });

    // The premise: nothing under this file's own key. If a future change starts
    // writing it unprompted, this fixture stops being a pre-feature one and the
    // rest of the describe stops meaning what it says.
    expect(memento.get(KEYS.gitPlanGrants)).toBeUndefined();

    warnings = [];
    upgraded = new WorkspaceStateStore(memento, {
      warn: (message: string) => warnings.push(message)
    } as unknown as SanitizedLogger);
    await upgraded.initialize();
  });

  it('loads without loss and without a word about the key it does not have', () => {
    expect(upgraded.getGitPlanGrants()).toEqual({});
    // An upgrade is not a fault. A warning here would appear in every log written
    // by every workspace that upgraded, which is how the ones that matter are lost.
    expect(warnings).toEqual([]);

    expect(upgraded.getQueue(DEFAULT_QUEUE_ID).requests.map((r) => r.id)).toEqual(['legacy-task']);
    expect(upgraded.getRun(DEFAULT_QUEUE_ID)?.id).toBe('run-1');
    expect(new HistoryStore(upgraded).listForQueue(DEFAULT_QUEUE_ID)).toHaveLength(1);

    // Reading it did not create it: an upgrade that never grants anything leaves
    // the file exactly as it found it.
    expect(memento.get(KEYS.gitPlanGrants)).toBeUndefined();
  });

  it('never reads absence as a grant, so a Git-capable plan still asks', async () => {
    // A real plan, not a placeholder fingerprint: the value the consultation
    // actually carries is the sha256 of the pipeline, and "absent means empty" has
    // to hold for that value and not merely for a string of a's.
    const plan = buildMutationPlan(GIT_PIPELINE);
    expect(plan.gitCapablePhaseIds).toEqual(['speckit-implement']);
    expect(upgraded.hasGitPlanGrant(plan.fingerprint)).toBe(false);

    // And end to end: the caller reaches the modal rather than skipping it. This
    // is the property SC-006 rests on — an upgrade must not silently inherit
    // consent nobody in this workspace ever gave.
    const asked: string[] = [];
    const approve = createPersistentGitApproval({
      request: async (asking) => {
        asked.push(asking.fingerprint);
        return 'denied';
      },
      isGranted: (fingerprint) => upgraded.hasGitPlanGrant(fingerprint),
      persist: () => Promise.reject(new Error('must not be reached')),
      logger: { info: () => {}, warn: () => {} } as unknown as SanitizedLogger
    });

    expect(await approve(plan)).toBe(false);
    expect(asked).toEqual([plan.fingerprint]);
  });
});
