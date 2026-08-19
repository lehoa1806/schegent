import { describe, it, expect, beforeEach } from 'vitest';
import {
  KEYS,
  QueueMutationRejected,
  WorkspaceStateStore,
  type Memento,
  type StoreChangeKey
} from '../../../src/state/workspace-state';
import { HistoryStore } from '../../../src/state/history-store';
import { QueueManager } from '../../../src/queue/queue-manager';
import { MAX_PENDING_TASKS_PER_QUEUE, type FeatureRequest, type QueueState } from '../../../src/queue/feature-request';
import { DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';
import type { WorkflowRun, WorkspaceLock } from '../../../src/state/workflow-run';

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
    await store.setRun(DEFAULT_QUEUE_ID, sampleRun());
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
    await store.setRun(DEFAULT_QUEUE_ID, sampleRun());
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
    await store.setRun(DEFAULT_QUEUE_ID, sampleRun());
    await store.setRun(DEFAULT_QUEUE_ID, null);
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
      store.setDefaultQueueId('missing');
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

  // Feature 030 (US3, T046) — the "moves pending tasks between queues
  // with target position shifting" test required creating a secondary
  // queue via `createQueue`, which is now blocked by MAX_QUEUES=1. The
  // cross-queue movePendingRequest path is structurally unreachable
  // on a single-queue registry; the same-queue reorder path is still
  // exercised by the "reorders pending tasks within a queue" test
  // above.

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
    expect(() => store.setRun(DEFAULT_QUEUE_ID, { ...sampleRun(), manualPauseAt: 1_700_000_000_000 })).toThrow(
      /manualPauseAt/
    );
  });

  it('sets and clears queue-sourced manual pause only for the matching in-flight task', async () => {
    const manager = new QueueManager(store);
    const running = { ...pendingFeature('running'), status: 'in-flight' as const, runId: 'run-1' };
    await store.setQueue({ ...emptyQueue(), requests: [running], inFlightId: 'running' });
    await store.setRun(DEFAULT_QUEUE_ID, { ...sampleRun(), featureId: 'running' });

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
    });

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
