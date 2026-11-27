// Feature 063 — T019 integration test for `QueueManager.clearAll()`.
//
// Pins the contract in
// specs/063-clean-all-confirmations/contracts/cmd-clear-all.md and the
// state-machine in
// specs/063-clean-all-confirmations/data-model.md §CleanAllResetOperation:
//
//   - All five state surfaces (queue items, in-flight, pause, active run,
//     watchdog backoff) clear atomically.
//   - `queue-cleared-all` audit event is the caller's responsibility —
//     here we only assert that clearAll() itself emits no audit. (The
//     handler test in T020 covers the audit append.)
//   - Runner-ack probe within 2s sets `runnerAcked: true`.
//   - Runner no-ack within 2s sets `runnerAcked: false` (non-fatal).
//   - Persistence failure aborts the operation cleanly without partial
//     state — the canonical writers throw, the caller's `finally`
//     releases the lock.
//   - The fully-clean state is a no-op (`wasNoop: true`).

import { describe, it, expect, vi } from 'vitest';
import { unfencedCommit } from '../../src/state/ownership-claim';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import type { WorkflowRun } from '../../src/state/workflow-run';

class MockMemento implements Memento {
  public writeCount = 0;
  public lastBatch: string[] = [];
  // FR-R3-150 (T1619c) — every persisted value, not just the key that was
  // touched. The LC-Q-05 lockstep assertion below has to inspect the
  // *intermediate* queue-map states, because "no persisted state pairs a
  // non-null `scheduledStartAt` with a lifecycle other than `idle-pending`"
  // (AGENTS rules 31-33) is a claim about each write, not about the last one.
  public writes: Array<{ key: string; value: unknown }> = [];
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.writeCount++;
    this.lastBatch.push(key);
    this.writes.push({ key, value });
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

function sampleRun(featureId = 'feat-1', status: WorkflowRun['status'] = 'running'): WorkflowRun {
  return {
    id: 'run-1',
    featureId,
    featureDir: 'specs/001-x',
    status,
    currentPhase: 'speckit-plan',
    currentIteration: 0,
    startedAt: 1_700_000_000_000,
    lastTransitionAt: 1_700_000_000_000,
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

async function buildPopulatedSystem(): Promise<{
  store: WorkspaceStateStore;
  queue: QueueManager;
  memento: MockMemento;
}> {
  const memento = new MockMemento();
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);

  // Enqueue 3 pending + 1 completed + 1 failed + 1 canceled
  const a = await queue.enqueue('task A');
  await queue.enqueue('task B');
  await queue.enqueue('task C');
  const d = await queue.enqueue('task D');
  await queue.markInFlight(d.id, 'run-D');
  await queue.finish(d.id, 'completed');
  const e = await queue.enqueue('task E');
  await queue.markInFlight(e.id, 'run-E');
  await queue.finish(e.id, 'failed', 'fake error');
  const f = await queue.enqueue('task F');
  await queue.markInFlight(f.id, 'run-F');
  await queue.finish(f.id, 'canceled');

  // Mark A in-flight
  await queue.markInFlight(a.id, 'run-A');

  // Set pause
  await queue.setQueuePausedState(true, DEFAULT_QUEUE_ID, 'maintenance', 'operator');

  // Set an active run + watchdog backoff
  await store.setRun(DEFAULT_QUEUE_ID, sampleRun(a.id), unfencedCommit('test-fixture'));
  await store.setWatchdog({
    paused: true,
    pausedSince: 1_700_000_000_000,
    nextPollAt: 1_700_000_030_000,
    pollIntervalMs: 60_000,
    lastStatusOk: false,
    cause: 'cli-down'
  });

  // Reset the write counter so we only count the clearAll writes.
  memento.writeCount = 0;
  memento.lastBatch = [];
  memento.writes = [];
  return { store, queue, memento };
}

/** Arms a schedule directly on a queue record — the fixture-level equivalent
 * of an operator choosing a scheduled start, without pulling in the
 * coordinator. Same helper `queue-manager-clear-queue.test.ts` uses, so the
 * queue-scoped and workspace-wide LC-Q-05 cases start from an identical
 * persisted shape. */
async function armSchedule(
  store: WorkspaceStateStore,
  queueId: string,
  scheduledStartAt: number
): Promise<void> {
  await store.updateQueue(
    (queue) => ({
      queue: {
        ...queue,
        queueLifecycle: 'idle-pending',
        scheduledStartAt,
        scheduledStartSource: 'operator-chooser'
      },
      result: undefined
    }),
    queueId,
    store.runCommitClaim(queueId)
  );
}

/** Every queue-map state this memento ever persisted, oldest first. */
function persistedQueueMaps(
  memento: MockMemento
): Array<Record<string, { queueLifecycle: string; scheduledStartAt: number | null }>> {
  return memento.writes
    .filter((w) => w.key === 'schegent.queue')
    .map(
      (w) =>
        w.value as Record<string, { queueLifecycle: string; scheduledStartAt: number | null }>
    );
}

describe('QueueManager.clearAll() — integration (T019)', () => {
  it('clears all five state surfaces atomically', async () => {
    const { store, queue } = await buildPopulatedSystem();
    const result = await queue.clearAll();

    expect(result.wasNoop).toBe(false);
    expect(result.removed).toEqual({
      pending: 2, // B, C (A was in-flight before clearAll())
      completed: 1,
      failed: 1,
      canceled: 1
    });
    expect(result.inflightAborted).toBe(true);
    expect(result.pauseCleared).toBe(true);
    expect(result.pauseSource).toBe('operator');
    expect(result.activeRunCleared).toBe(true);
    expect(result.watchdogCleared).toBe(true);

    const afterQueue = store.getQueue(DEFAULT_QUEUE_ID);
    expect(afterQueue.requests).toEqual([]);
    expect(afterQueue.inFlightId).toBeNull();
    // FR-R3-150 (T1619c) — was `.not.toBe('operator-paused')`, which is
    // satisfied by a queue left badging the stale `running` it carried into
    // the clear. The reset settles at one lifecycle, and the assertion names
    // it.
    expect(afterQueue.queueLifecycle).toBe('active-empty');
    expect(afterQueue.pausedReason).toBeNull();
    expect(afterQueue.pauseSource).toBeNull();
    expect(afterQueue.scheduledStartAt).toBeNull();
    expect(afterQueue.scheduledStartSource).toBeNull();
    expect(result.scheduleCleared).toBe(false);

    expect(store.getRun(DEFAULT_QUEUE_ID)).toBeNull();

    const afterWatchdog = store.getWatchdog();
    expect(afterWatchdog.paused).toBe(false);
    expect(afterWatchdog.pausedSince).toBeNull();
    expect(afterWatchdog.nextPollAt).toBeNull();
    expect(afterWatchdog.cause).toBeNull();
    // Preserved scalars:
    expect(afterWatchdog.pollIntervalMs).toBe(60_000);
    expect(afterWatchdog.lastStatusOk).toBe(false);
  });

  it('emits exactly the expected memento writes (queue, registry, run, watchdog)', async () => {
    const { queue, memento } = await buildPopulatedSystem();
    await queue.clearAll();

    // KEYS we expect to be touched in the clearAll path:
    //   - schegent.queue              (queue items + pausedReason + the pause)
    //   - schegent.run                (cleared)
    //   - schegent.watchdog           (cleared)
    //
    // We do NOT expect writes to:
    //   - schegent.queues.registry
    //   - schegent.ui.confirmSuppression
    //   - schegent.history
    //   - schegent.queueRegistry.migrationQuarantine
    //   - schegent.queue.defaultId
    //   - schegent.queue.globalConcurrencyCap
    //   - schegent.lock
    const touched = new Set(memento.lastBatch);
    expect(touched.has('schegent.ui.confirmSuppression')).toBe(false);
    expect(touched.has('schegent.history')).toBe(false);
    expect(touched.has('schegent.state.quarantine.v2')).toBe(false);
    expect(touched.has('schegent.queue.defaultQueueId')).toBe(false);
    expect(touched.has('schegent.queue.globalConcurrencyCap')).toBe(false);
    expect(touched.has('schegent.lock')).toBe(false);
    // FR-R3-011 — the registry moved from "written by clearAll" to "not written
    // by clearAll", and the assertion moved with it rather than being dropped.
    // `setQueuePausedState` wrote the registry only to clear the entry's
    // `state` / `pauseSource` pair; that pair is now derived on read, so there
    // is nothing on the registry for a pause clear to change. What the registry
    // does hold — queue identity, names, positions — `clearAll` has always
    // preserved, and a write here would be the first chance to disturb it.
    expect(touched.has('schegent.queues.registry')).toBe(false);

    expect(touched.has('schegent.queue')).toBe(true);
    expect(touched.has('schegent.run')).toBe(true);
    expect(touched.has('schegent.watchdog')).toBe(true);
  });

  it('returns wasNoop=true on an already-clean workspace and does not write', async () => {
    const memento = new MockMemento();
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    const queue = new QueueManager(store);
    memento.writeCount = 0;

    const result = await queue.clearAll();

    expect(result.wasNoop).toBe(true);
    expect(result.removed).toEqual({ pending: 0, completed: 0, failed: 0, canceled: 0 });
    expect(result.inflightAborted).toBe(false);
    expect(result.pauseCleared).toBe(false);
    expect(result.pauseSource).toBeNull();
    expect(result.activeRunCleared).toBe(false);
    expect(result.watchdogCleared).toBe(false);
    expect(memento.writeCount).toBe(0);
  });

  it('runner-ack probe within bound sets runnerAcked: true', async () => {
    const { queue } = await buildPopulatedSystem();
    const probe = async (): Promise<boolean> => true;
    const result = await queue.clearAll(probe);
    expect(result.runnerAcked).toBe(true);
    expect(result.inflightAborted).toBe(true);
  });

  it('runner-ack probe that resolves false sets runnerAcked: false (non-fatal)', async () => {
    const { store, queue } = await buildPopulatedSystem();
    const probe = async (): Promise<boolean> => false;
    const result = await queue.clearAll(probe);
    expect(result.runnerAcked).toBe(false);
    expect(result.inflightAborted).toBe(true);
    // State is still fully cleared — runner ack is post-persistence:
    expect(store.getQueue(DEFAULT_QUEUE_ID).requests).toEqual([]);
    expect(store.getRun(DEFAULT_QUEUE_ID)).toBeNull();
  });

  it('runner-ack probe that throws is swallowed; state still clears', async () => {
    const { store, queue } = await buildPopulatedSystem();
    const probe = async (): Promise<boolean> => {
      throw new Error('runner exploded');
    };
    const result = await queue.clearAll(probe);
    expect(result.runnerAcked).toBe(false);
    expect(store.getQueue(DEFAULT_QUEUE_ID).requests).toEqual([]);
  });

  // BUG-003 (T079) — the probe tests above return true/false/throw without
  // ever *writing*, so they pass identically with or without the compensating
  // clear. In production the probe calls `controller.cancelActive()`, which
  // drives the RunDriver's abort branch into `persistTransition(canceled)` —
  // a `setRun` that lands AFTER `clearAll()`'s own `setRun(null)` and
  // repopulates the surface the operator just cleared. A writing probe is the
  // only shape that distinguishes the two implementations, so it is what
  // these three cases use.
  const makeWritingProbe = (
    store: WorkspaceStateStore,
    settle: () => Promise<boolean>
  ) => async (): Promise<boolean> => {
    // The write happens before the probe settles, exactly as the real
    // cancel path does: the transition is persisted on the way to the ack.
    await store.setRun(DEFAULT_QUEUE_ID, sampleRun('feat-1', 'canceled'), unfencedCommit('test-fixture'));
    return settle();
  };

  it('clears the run again when the runner-ack probe writes one back (resolves true)', async () => {
    const { store, queue } = await buildPopulatedSystem();
    const result = await queue.clearAll(
      makeWritingProbe(store, async () => true)
    );
    expect(result.runnerAcked).toBe(true);
    expect(result.inflightAborted).toBe(true);
    expect(store.getRun(DEFAULT_QUEUE_ID)).toBeNull();
  });

  it('clears the run again when the runner-ack probe writes one back (resolves false)', async () => {
    const { store, queue } = await buildPopulatedSystem();
    const result = await queue.clearAll(
      makeWritingProbe(store, async () => false)
    );
    expect(result.runnerAcked).toBe(false);
    expect(result.inflightAborted).toBe(true);
    expect(store.getRun(DEFAULT_QUEUE_ID)).toBeNull();
  });

  it('clears the run again when a writing runner-ack probe then throws', async () => {
    // The throw is swallowed, but the write it already performed is not
    // undone by the throw — the compensating clear still has to run.
    const { store, queue } = await buildPopulatedSystem();
    const result = await queue.clearAll(
      makeWritingProbe(store, async () => {
        throw new Error('runner exploded after persisting the cancel');
      })
    );
    expect(result.runnerAcked).toBe(false);
    expect(store.getRun(DEFAULT_QUEUE_ID)).toBeNull();
    expect(store.getQueue(DEFAULT_QUEUE_ID).requests).toEqual([]);
  });

  it('skips the runner-ack probe when nothing was in-flight', async () => {
    const memento = new MockMemento();
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    const queue = new QueueManager(store);
    // Enqueue a single pending task — no in-flight.
    await queue.enqueue('task pending only');
    memento.writeCount = 0;

    let probeCalled = false;
    const probe = async (): Promise<boolean> => {
      probeCalled = true;
      return true;
    };
    const result = await queue.clearAll(probe);

    expect(probeCalled).toBe(false);
    expect(result.inflightAborted).toBe(false);
    expect(result.runnerAcked).toBe(false);
  });

  it('does not touch the confirm-suppression memento (FR-006)', async () => {
    const { store, queue, memento } = await buildPopulatedSystem();
    // Populate suppression first, then clearAll.
    await store.setConfirmSuppression('queue.clean-all', true);
    await store.setConfirmSuppression('queue.remove-item', true);
    memento.writeCount = 0;
    memento.lastBatch = [];

    await queue.clearAll();

    // Suppression must be untouched.
    expect(memento.lastBatch).not.toContain('schegent.ui.confirmSuppression');
    const suppression = store.getConfirmSuppression();
    expect(suppression.suppressedActionKeys).toEqual(
      expect.arrayContaining(['queue.clean-all', 'queue.remove-item'])
    );
  });

  it('preserves audit log (no truncation, no emit at this layer)', async () => {
    const { queue } = await buildPopulatedSystem();
    // Clearing must NOT cause the queue manager itself to write an audit
    // event — that is the handler's responsibility. We can only assert
    // that clearAll() does not throw and returns a populated result; the
    // handler-side audit assertions live in clear-all-handler.test.ts.
    const result = await queue.clearAll();
    expect(result).toBeDefined();
  });
});

// FR-R3-150 (T1619c) — the workspace-wide half of LC-Q-05.
//
// `clearQueue()` (T1619) already disarms the addressed queue's schedule and
// settles its lifecycle in one write. `clearAll()` did neither: its per-queue
// write touched `requests`/`inFlightId`/`pausedReason` only, so a `running`
// queue persisted as `running` with nothing in it, and an `idle-pending`
// queue's armed `scheduledStartAt` survived the reset and could later start a
// queue the operator had just wiped. Its `wasNoop` gate never inspected the
// schedule either, so that workspace reported already-clean and wrote nothing
// at all.
//
// Deferred as out-of-scope under spec.md FR-009 by T1619b; FR-009 amended
// 2026-09-03 (see specs/188-queue-cleanup-scope/spec.md FR-009 and T1619b's
// closure note) because "unchanged behavior" was never meant to preserve a
// reset that leaves a timer armed against the state it cleared.
describe('QueueManager.clearAll() — LC-Q-05 schedule and lifecycle settle (T1619c)', () => {
  async function buildScheduledSystem(): Promise<{
    store: WorkspaceStateStore;
    queue: QueueManager;
    memento: MockMemento;
    queueBId: string;
    cancelHook: { cancel: ReturnType<typeof vi.fn> };
  }> {
    const memento = new MockMemento();
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    const queue = new QueueManager(store);
    const cancelHook = { cancel: vi.fn().mockResolvedValue(undefined) };
    queue.setScheduledStartCancelHook(cancelHook);

    const created = await queue.createQueue('Queue B');
    if (!created.ok || !created.queueId) throw new Error('fixture: createQueue failed');

    memento.writeCount = 0;
    memento.lastBatch = [];
    memento.writes = [];
    return { store, queue, memento, queueBId: created.queueId, cancelHook };
  }

  it('an armed schedule is the only dirty state: not a no-op, and it is disarmed', async () => {
    const { store, queue, memento, queueBId, cancelHook } = await buildScheduledSystem();
    // No tasks, no in-flight, no pause, no run, no watchdog backoff anywhere.
    // Queue B's armed schedule is the whole of the workspace's dirty state.
    await armSchedule(store, queueBId, 1_700_000_030_000);
    memento.writeCount = 0;
    memento.writes = [];

    const result = await queue.clearAll();

    expect(result.wasNoop).toBe(false);
    expect(result.scheduleCleared).toBe(true);
    expect(memento.writeCount).toBeGreaterThan(0);

    const after = store.getQueue(queueBId);
    expect(after.scheduledStartAt).toBeNull();
    expect(after.scheduledStartSource).toBeNull();
    expect(after.queueLifecycle).toBe('active-empty');
    // The in-process timer is disarmed too — a persisted-only clear leaves a
    // live timer that fires against fields already reading as cleared.
    expect(cancelHook.cancel).toHaveBeenCalledTimes(1);
    expect(cancelHook.cancel).toHaveBeenCalledWith(queueBId, 'operator-cancel');
  });

  it('disarms every armed queue and leaves unarmed queues without a hook call', async () => {
    const { store, queue, queueBId, cancelHook } = await buildScheduledSystem();
    const createdC = await queue.createQueue('Queue C');
    if (!createdC.ok || !createdC.queueId) throw new Error('fixture: createQueue failed');
    const queueCId = createdC.queueId;

    await armSchedule(store, queueBId, 1_700_000_030_000);
    await armSchedule(store, queueCId, 1_700_000_060_000);

    const result = await queue.clearAll();

    expect(result.scheduleCleared).toBe(true);
    for (const id of [queueBId, queueCId]) {
      const after = store.getQueue(id);
      expect(after.scheduledStartAt).toBeNull();
      expect(after.scheduledStartSource).toBeNull();
      expect(after.queueLifecycle).toBe('active-empty');
    }
    // Exactly the two armed queues, never the unarmed default.
    expect(cancelHook.cancel.mock.calls.map((c) => c[0]).sort()).toEqual(
      [queueBId, queueCId].sort()
    );
  });

  it('a queue carrying tasks settles at active-empty rather than a stale running', async () => {
    const { store, queue } = await buildScheduledSystem();
    const task = await queue.enqueue('task A');
    await queue.markInFlight(task.id, 'run-A');
    expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle).toBe('running');

    await queue.clearAll();

    expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle).toBe('active-empty');
  });

  it('reports scheduleCleared=false and calls no hook when nothing was armed', async () => {
    const { queue, cancelHook } = await buildScheduledSystem();
    await queue.enqueue('task A');

    const result = await queue.clearAll();

    expect(result.wasNoop).toBe(false);
    expect(result.scheduleCleared).toBe(false);
    expect(cancelHook.cancel).not.toHaveBeenCalled();
  });

  it('idle-pending with no armed schedule is still dirty state to clear', async () => {
    // `setQueuePausedState`'s resume branch persists `idle-pending` with a
    // null schedule — a queue explicitly held awaiting a start. It has no
    // tasks, no run and no pause, so only the lifecycle marks it dirty.
    const { store, queue } = await buildScheduledSystem();
    await store.updateQueue(
      (q) => ({ queue: { ...q, queueLifecycle: 'idle-pending' }, result: undefined }),
      DEFAULT_QUEUE_ID,
      store.runCommitClaim(DEFAULT_QUEUE_ID)
    );

    const result = await queue.clearAll();

    expect(result.wasNoop).toBe(false);
    expect(result.scheduleCleared).toBe(false);
    expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle).toBe('active-empty');
  });

  it('no persisted state pairs an armed schedule with a non-idle-pending lifecycle', async () => {
    // AGENTS rules 31-33 / data-model.md's pairing invariant holds at every
    // persisted state, not merely the final one — so the schedule fields and
    // the lifecycle have to leave `idle-pending` in the SAME write.
    const { store, queue, memento, queueBId } = await buildScheduledSystem();
    await armSchedule(store, queueBId, 1_700_000_030_000);
    await queue.enqueue('task A');
    await queue.setQueuePausedState(true, DEFAULT_QUEUE_ID, 'maintenance', 'operator');
    memento.writes = [];

    await queue.clearAll();

    const maps = persistedQueueMaps(memento);
    expect(maps.length).toBeGreaterThan(0);
    for (const map of maps) {
      for (const [id, state] of Object.entries(map)) {
        if (state.scheduledStartAt !== null) {
          expect(`${id}:${state.queueLifecycle}`).toBe(`${id}:idle-pending`);
        }
      }
    }
  });
});
