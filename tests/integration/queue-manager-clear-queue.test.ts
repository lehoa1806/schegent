// FR-R3-150 (T1617, T1619, T1619a) — integration fixture for
// `QueueManager.clearQueue()`, the queue-scoped Clean All primitive.
//
// Pins the acceptance boundary in
// specs/188-queue-cleanup-scope/spec.md §2 "Selected-queue Clean All" and
// specs/188-queue-cleanup-scope/contracts/queue-scoped-reset.md:
//
//   - Clearing Queue B removes only Queue B's tasks/run/pause/schedule/timer
//     and leaves Default (and every sibling) byte-for-byte unchanged.
//   - A queue whose only leftover state is an armed schedule is not
//     falsely reported already-clean (LC-Q-05), and repeating the clear
//     after it runs correctly reports `wasNoop: true`.
//   - The schedule-cancel hook is invoked with only the selected queue id.
//   - An unknown queue id is refused rather than silently applied anywhere.

import { describe, it, expect, vi } from 'vitest';
import { unfencedCommit } from '../../src/state/ownership-claim';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import type { WorkflowRun } from '../../src/state/workflow-run';
import { ScheduledStartCoordinator } from '../../src/services/scheduled-start-coordinator';
import type { AuditEntry } from '../../src/audit/audit-entry';

class MockMemento implements Memento {
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

function sampleRun(featureId: string, runId: string): WorkflowRun {
  return {
    id: runId,
    featureId,
    featureDir: 'specs/001-x',
    status: 'running',
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

/** Arms a schedule directly on the queue record — the fixture-level
 * equivalent of an operator choosing a scheduled start, without pulling in
 * the coordinator itself. */
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

async function buildTwoQueueSystem(): Promise<{
  store: WorkspaceStateStore;
  queue: QueueManager;
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
  const queueBId = created.queueId;

  // Default: its own independent tasks + run, untouched by anything done to
  // Queue B below.
  await queue.enqueue('default task 1');
  const defaultInFlight = await queue.enqueue('default in-flight');
  await queue.markInFlight(defaultInFlight.id, 'run-default');
  await store.setRun(
    DEFAULT_QUEUE_ID,
    sampleRun(defaultInFlight.id, 'run-default'),
    unfencedCommit('test-fixture')
  );

  // Queue B: tasks in every status, an active run, a pause, and an armed
  // scheduled start. The completed task is finished before the in-flight
  // one is marked, since `PER_QUEUE_CAPACITY` allows only one in-flight
  // request at a time per queue.
  await queue.enqueue('b pending 1', { queueId: queueBId });
  const bDone = await queue.enqueue('b completed', { queueId: queueBId });
  await queue.markInFlight(bDone.id, 'run-b-done');
  await queue.finish(bDone.id, 'completed');
  const bInFlight = await queue.enqueue('b in-flight', { queueId: queueBId });
  await queue.markInFlight(bInFlight.id, 'run-b');
  await store.setRun(queueBId, sampleRun(bInFlight.id, 'run-b'), unfencedCommit('test-fixture'));
  await queue.setQueuePausedState(true, queueBId, 'maintenance', 'operator');

  return { store, queue, queueBId, cancelHook };
}

describe('QueueManager.clearQueue() — integration (FR-R3-150, T1617/T1619/T1619a)', () => {
  it('clears only the addressed queue; Default is byte-for-byte unchanged', async () => {
    const { store, queue, queueBId } = await buildTwoQueueSystem();
    const defaultBefore = store.getQueue(DEFAULT_QUEUE_ID);
    const defaultRunBefore = store.getRun(DEFAULT_QUEUE_ID);

    const result = await queue.clearQueue(queueBId);

    expect(result.outcome).toBe('cleared');
    if (result.outcome !== 'cleared') throw new Error('unreachable');
    expect(result.wasNoop).toBe(false);
    expect(result.removed).toEqual({ pending: 1, completed: 1, failed: 0, canceled: 0 });
    expect(result.inflightAborted).toBe(true);
    expect(result.pauseCleared).toBe(true);
    expect(result.pauseSource).toBe('operator');
    expect(result.activeRunCleared).toBe(true);
    expect(result.lifecycle).toBe('active-empty');

    const bAfter = store.getQueue(queueBId);
    expect(bAfter.requests).toEqual([]);
    expect(bAfter.inFlightId).toBeNull();
    expect(bAfter.pausedReason).toBeNull();
    expect(bAfter.queueLifecycle).toBe('active-empty');
    expect(store.getRun(queueBId)).toBeNull();

    // Sibling isolation (FR-006): Default is untouched.
    expect(store.getQueue(DEFAULT_QUEUE_ID)).toEqual(defaultBefore);
    expect(store.getRun(DEFAULT_QUEUE_ID)).toEqual(defaultRunBefore);

    // Repeating against the now-clean Queue B is a no-op (FR-008).
    const repeat = await queue.clearQueue(queueBId);
    expect(repeat.outcome).toBe('cleared');
    if (repeat.outcome !== 'cleared') throw new Error('unreachable');
    expect(repeat.wasNoop).toBe(true);
  });

  it('a schedule-only queue (no tasks/run/pause) is not falsely reported clean (LC-Q-05)', async () => {
    const memento = new MockMemento();
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    const queue = new QueueManager(store);
    const cancelHook = { cancel: vi.fn().mockResolvedValue(undefined) };
    queue.setScheduledStartCancelHook(cancelHook);

    const created = await queue.createQueue('Queue B');
    if (!created.ok || !created.queueId) throw new Error('fixture: createQueue failed');
    const queueBId = created.queueId;
    await armSchedule(store, queueBId, 1_700_000_030_000);

    const result = await queue.clearQueue(queueBId);
    expect(result.outcome).toBe('cleared');
    if (result.outcome !== 'cleared') throw new Error('unreachable');
    expect(result.wasNoop).toBe(false);
    expect(result.scheduleCleared).toBe(true);

    const after = store.getQueue(queueBId);
    expect(after.scheduledStartAt).toBeNull();
    expect(after.scheduledStartSource).toBeNull();
    expect(after.queueLifecycle).toBe('active-empty');
    expect(cancelHook.cancel).toHaveBeenCalledExactlyOnceWith(queueBId, 'operator-cancel');

    // Repeating the check afterward correctly reports the queue as already
    // clean (SC-004).
    const repeat = await queue.clearQueue(queueBId);
    expect(repeat.outcome).toBe('cleared');
    if (repeat.outcome !== 'cleared') throw new Error('unreachable');
    expect(repeat.wasNoop).toBe(true);
  });

  it('refuses an unknown queue id rather than applying anywhere (FR-011)', async () => {
    const { queue } = await buildTwoQueueSystem();
    const result = await queue.clearQueue('no-such-queue');
    expect(result).toEqual({ outcome: 'refused', reason: 'unknown-queue-id' });
  });

  it('the schedule-cancel hook receives only the selected queue id, never a sibling\'s', async () => {
    const memento = new MockMemento();
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    const queue = new QueueManager(store);
    const cancelHook = { cancel: vi.fn().mockResolvedValue(undefined) };
    queue.setScheduledStartCancelHook(cancelHook);

    const created = await queue.createQueue('Queue B');
    if (!created.ok || !created.queueId) throw new Error('fixture: createQueue failed');
    const queueBId = created.queueId;
    // Default also carries an armed schedule — clearing Queue B must never
    // reach it.
    await armSchedule(store, DEFAULT_QUEUE_ID, 1_700_000_030_000);
    await armSchedule(store, queueBId, 1_700_000_030_000);

    await queue.clearQueue(queueBId);

    expect(cancelHook.cancel).toHaveBeenCalledExactlyOnceWith(queueBId, 'operator-cancel');
    const defaultAfter = store.getQueue(DEFAULT_QUEUE_ID);
    expect(defaultAfter.scheduledStartAt).toBe(1_700_000_030_000);
    expect(defaultAfter.queueLifecycle).toBe('idle-pending');
  });

  // FR-R3-150 (T1623, SC-005) — a REAL coordinator, not the spy the cases
  // above use, so this pins the actual timer being cleared rather than just
  // the hook being called with the right arguments. Two separate proofs, per
  // SC-005's own wording ("0 scheduled-start timers remain armed ... verified
  // by observing that no scheduled action occurs after the original trigger
  // time has passed"): the timer is gone from the coordinator's own registry,
  // AND advancing a fake clock past the original trigger fires nothing.
  it('SC-005: after clearQueue no scheduled-start timer remains armed, and none fires past its trigger', async () => {
    vi.useFakeTimers();
    try {
      const memento = new MockMemento();
      const store = new WorkspaceStateStore(memento);
      await store.initialize();
      const queue = new QueueManager(store);
      const onFire = vi.fn();
      const auditWriter = {
        append: vi.fn(async (entry: unknown) => entry as AuditEntry)
      };
      const coordinator = new ScheduledStartCoordinator({
        store,
        auditWriter,
        logger: { warn: vi.fn() },
        onFire
      });
      queue.setScheduledStartCancelHook(coordinator);

      const created = await queue.createQueue('Queue B');
      if (!created.ok || !created.queueId) throw new Error('fixture: createQueue failed');
      const queueBId = created.queueId;

      const targetAt = Date.now() + 30_000;
      await armSchedule(store, queueBId, targetAt);
      await coordinator.arm(queueBId, targetAt, 'operator-chooser');
      expect(coordinator.armedQueueIds()).toContain(queueBId);

      const result = await queue.clearQueue(queueBId);
      expect(result.outcome).toBe('cleared');
      if (result.outcome !== 'cleared') throw new Error('unreachable');
      expect(result.scheduleCleared).toBe(true);

      // The timer is gone, not merely primed to no-op when it fires.
      expect(coordinator.armedQueueIds()).not.toContain(queueBId);

      // Advancing well past the original trigger fires nothing for this queue.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onFire).not.toHaveBeenCalled();
      expect(auditWriter.append).not.toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'scheduled-start-fired' })
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
