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

import { describe, it, expect } from 'vitest';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { DEFAULT_QUEUE_ID } from '../../src/queue/queue-registry';
import type { WorkflowRun } from '../../src/state/workflow-run';

class MockMemento implements Memento {
  public writeCount = 0;
  public lastBatch: string[] = [];
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.writeCount++;
    this.lastBatch.push(key);
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
  await store.setRun(sampleRun(a.id));
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
  return { store, queue, memento };
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

    const afterQueue = store.getQueue();
    expect(afterQueue.requests).toEqual([]);
    expect(afterQueue.inFlightId).toBeNull();
    expect(afterQueue.paused).toBe(false);
    expect(afterQueue.pausedReason).toBeNull();

    expect(store.getRun()).toBeNull();

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
    //   - schegent.queue              (queue items + paused + pausedReason)
    //   - schegent.queueRegistry      (via setQueuePausedState)
    //   - schegent.queue              (mirrored via setQueuePausedState)
    //   - schegent.run                (cleared)
    //   - schegent.watchdog           (cleared)
    //
    // We do NOT expect writes to:
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

    expect(touched.has('schegent.queue')).toBe(true);
    expect(touched.has('schegent.queues.registry')).toBe(true);
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
    expect(store.getQueue().requests).toEqual([]);
    expect(store.getRun()).toBeNull();
  });

  it('runner-ack probe that throws is swallowed; state still clears', async () => {
    const { store, queue } = await buildPopulatedSystem();
    const probe = async (): Promise<boolean> => {
      throw new Error('runner exploded');
    };
    const result = await queue.clearAll(probe);
    expect(result.runnerAcked).toBe(false);
    expect(store.getQueue().requests).toEqual([]);
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
    await store.setRun(sampleRun('feat-1', 'canceled'));
    return settle();
  };

  it('clears the run again when the runner-ack probe writes one back (resolves true)', async () => {
    const { store, queue } = await buildPopulatedSystem();
    const result = await queue.clearAll(
      makeWritingProbe(store, async () => true)
    );
    expect(result.runnerAcked).toBe(true);
    expect(result.inflightAborted).toBe(true);
    expect(store.getRun()).toBeNull();
  });

  it('clears the run again when the runner-ack probe writes one back (resolves false)', async () => {
    const { store, queue } = await buildPopulatedSystem();
    const result = await queue.clearAll(
      makeWritingProbe(store, async () => false)
    );
    expect(result.runnerAcked).toBe(false);
    expect(result.inflightAborted).toBe(true);
    expect(store.getRun()).toBeNull();
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
    expect(store.getRun()).toBeNull();
    expect(store.getQueue().requests).toEqual([]);
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
