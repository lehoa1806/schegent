import { describe, expect, it, vi } from 'vitest';

import { pauseQueuesAtLifecycleBoundary } from '../../../src/activation/queue-lifecycle-boundary';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { SanitizedLogger, type LogSink } from '../../../src/lib/logger';
import { QueueManager } from '../../../src/queue/queue-manager';
import { ScheduledStartCoordinator } from '../../../src/services/scheduled-start-coordinator';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import type { ManualPauseCause, WorkflowRun } from '../../../src/state/workflow-run';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';

class FakeMemento implements Memento {
  private readonly map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

class CapturingSink implements LogSink {
  public readonly lines: string[] = [];
  appendLine(line: string): void {
    this.lines.push(line);
  }
}

const FIXED_NOW = 1_770_000_000_000;

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-boundary-1',
    featureId: 'feat-1',
    featureDir: 'specs/233-auto-drain-teardown-close',
    status: 'running',
    currentPhase: 'speckit-implement',
    currentIteration: 1,
    startedAt: FIXED_NOW - 10_000,
    lastTransitionAt: FIXED_NOW - 5_000,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    creditPause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    ...overrides
  };
}

async function buildFixture(options: { primary?: boolean } = {}) {
  const memento = new FakeMemento();
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const sink = new CapturingSink();
  const logger = new SanitizedLogger([sink]);
  const queue = new QueueManager(store, logger);
  const auditEvents: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const fired: string[] = [];
  const scheduledStartCoordinator = new ScheduledStartCoordinator({
    store,
    auditWriter: {
      append: async (entry) => {
        auditEvents.push({ eventType: entry.eventType, payload: { ...entry.payload } });
        return undefined as never;
      }
    },
    logger,
    onFire: (queueId) => {
      fired.push(queueId);
    },
    now: () => FIXED_NOW
  });
  queue.setScheduledStartCancelHook({
    cancel: (queueId, reason) => scheduledStartCoordinator.cancel(queueId, reason)
  });
  const lock = {
    hasPrimacy: vi.fn(async () => options.primary ?? true)
  };
  return {
    memento,
    store,
    queue,
    logger,
    sink,
    lock,
    scheduledStartCoordinator,
    auditEvents,
    fired
  };
}

describe('BUG-001 (FR-015, FR-016, FR-017) — pauseQueuesAtLifecycleBoundary', () => {
  it('1. pauses a running queue with an in-flight Run and a pending task behind it', async () => {
    const f = await buildFixture();
    const first = await f.queue.enqueue('first in-flight task');
    const second = await f.queue.enqueue('second pending task');
    const run = makeRun({
      featureId: first.id,
      status: 'running',
      pendingRetryAt: null,
      pendingRetryCause: null
    });
    await f.queue.admitRun(first.id, run);
    expect(f.store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle).toBe('running');
    expect(f.store.getQueue(DEFAULT_QUEUE_ID).inFlightId).toBe(first.id);

    await pauseQueuesAtLifecycleBoundary({
      store: f.store,
      queue: f.queue,
      lock: f.lock,
      scheduledStartCoordinator: f.scheduledStartCoordinator,
      logger: f.logger,
      now: () => FIXED_NOW
    });

    const afterQueue = f.store.getQueue(DEFAULT_QUEUE_ID);
    expect(afterQueue.queueLifecycle).toBe('operator-paused');
    expect(afterQueue.pauseSource).toBe('operator');
    expect(afterQueue.pausedReason).toBe('extension-closed');
    expect(afterQueue.scheduledStartAt).toBeNull();
    expect(afterQueue.scheduledStartSource).toBeNull();
    expect(afterQueue.inFlightId).toBeNull();
    expect(afterQueue.requests.find((r) => r.id === first.id)?.status).toBe('paused');
    expect(afterQueue.requests.find((r) => r.id === second.id)?.status).toBe('pending');

    const afterRun = f.store.getRun(DEFAULT_QUEUE_ID);
    expect(afterRun?.status).toBe('paused');
    expect(afterRun?.manualPauseAt).toBe(FIXED_NOW);
    expect(afterRun?.manualPauseCause).toBe('queue-paused-mid-run');
    expect(afterRun?.pendingRetryAt).toBeNull();
    expect(afterRun?.pendingRetryCause).toBeNull();
    expect(afterRun?.creditPause).toBeNull();
  });

  it('1b. clears armed pendingRetryAt/pendingRetryCause and creditPause when pausing a waiting Run', async () => {
    const f = await buildFixture();
    const retryTask = await f.queue.enqueue('delayed retry task');
    const retryRun = makeRun({
      id: 'run-retry',
      featureId: retryTask.id,
      status: 'paused',
      pendingRetryAt: FIXED_NOW - 1_000,
      pendingRetryCause: 'rate_limit'
    });
    await f.store.setRun(DEFAULT_QUEUE_ID, retryRun, unfencedCommit('test-fixture'));
    await f.queue.markInFlight(retryTask.id, retryRun.id);

    const created = await f.queue.createQueue('Second');
    expect(created.ok && created.queueId).toBeTruthy();
    const secondQueueId = created.queueId!;
    const creditTask = await f.queue.enqueue('credit paused task', { queueId: secondQueueId });
    const creditRun = makeRun({
      id: 'run-credit',
      featureId: creditTask.id,
      status: 'paused',
      creditPause: { pausedAt: FIXED_NOW - 5_000, windowStartedAt: FIXED_NOW - 4_000, stoppedAt: null }
    });
    await f.store.setRun(secondQueueId, creditRun, unfencedCommit('test-fixture'));
    await f.queue.markInFlight(creditTask.id, creditRun.id);

    await pauseQueuesAtLifecycleBoundary({
      store: f.store,
      queue: f.queue,
      lock: f.lock,
      scheduledStartCoordinator: f.scheduledStartCoordinator,
      logger: f.logger,
      now: () => FIXED_NOW
    });

    for (const qId of [DEFAULT_QUEUE_ID, secondQueueId]) {
      const q = f.store.getQueue(qId);
      const r = f.store.getRun(qId);
      expect(q.queueLifecycle).toBe('operator-paused');
      expect(q.pausedReason).toBe('extension-closed');
      expect(q.inFlightId).toBeNull();
      expect(r?.status).toBe('paused');
      expect(r?.pendingRetryAt).toBeNull();
      expect(r?.pendingRetryCause).toBeNull();
      expect(r?.creditPause).toBeNull();
      expect(r?.manualPauseAt).toBe(FIXED_NOW);
      expect(r?.manualPauseCause).toBe('queue-paused-mid-run');
    }
  });

  it.each([
    ['future schedule', FIXED_NOW + 60_000],
    ['elapsed schedule', FIXED_NOW - 60_000]
  ])('2. cancels armed timer and pauses an idle-pending queue carrying a %s', async (_label, scheduledAt) => {
    const f = await buildFixture();
    await f.queue.enqueue('scheduled task');
    await f.store.updateQueue(
      (q) => ({
        queue: {
          ...q,
          queueLifecycle: 'idle-pending',
          scheduledStartAt: scheduledAt,
          scheduledStartSource: 'operator-restart'
        },
        result: undefined
      }),
      DEFAULT_QUEUE_ID,
      unfencedCommit('test-fixture')
    );
    await f.scheduledStartCoordinator.arm(DEFAULT_QUEUE_ID, FIXED_NOW + 60_000, 'operator-restart');
    expect(f.scheduledStartCoordinator.hasActiveTimer(DEFAULT_QUEUE_ID)).toBe(true);

    await pauseQueuesAtLifecycleBoundary({
      store: f.store,
      queue: f.queue,
      lock: f.lock,
      scheduledStartCoordinator: f.scheduledStartCoordinator,
      logger: f.logger,
      now: () => FIXED_NOW
    });

    const after = f.store.getQueue(DEFAULT_QUEUE_ID);
    expect(f.scheduledStartCoordinator.hasActiveTimer(DEFAULT_QUEUE_ID)).toBe(false);
    expect(after.queueLifecycle).toBe('operator-paused');
    expect(after.pauseSource).toBe('operator');
    expect(after.pausedReason).toBe('extension-closed');
    expect(after.scheduledStartAt).toBeNull();
    expect(after.scheduledStartSource).toBeNull();
    expect(f.fired).toEqual([]);
    expect(f.auditEvents.some((e) => e.eventType === 'scheduled-start-canceled')).toBe(true);
  });

  it('3. pauses an idle-pending queue holding pending tasks with no schedule', async () => {
    const f = await buildFixture();
    await f.queue.enqueue('pending idle task');
    await f.store.updateQueue(
      (q) => ({
        queue: { ...q, queueLifecycle: 'idle-pending', scheduledStartAt: null, scheduledStartSource: null },
        result: undefined
      }),
      DEFAULT_QUEUE_ID,
      unfencedCommit('test-fixture')
    );

    await pauseQueuesAtLifecycleBoundary({
      store: f.store,
      queue: f.queue,
      lock: f.lock,
      scheduledStartCoordinator: f.scheduledStartCoordinator,
      logger: f.logger,
      now: () => FIXED_NOW
    });

    const after = f.store.getQueue(DEFAULT_QUEUE_ID);
    expect(after.queueLifecycle).toBe('operator-paused');
    expect(after.pauseSource).toBe('operator');
    expect(after.pausedReason).toBe('extension-closed');
  });

  it('4. leaves an active-empty queue with zero non-terminal work untouched', async () => {
    const f = await buildFixture();
    const done = await f.queue.enqueue('already completed');
    await f.queue.markInFlight(done.id, 'run-done');
    await f.queue.finish(done.id, 'completed');
    const before = f.store.getQueue(DEFAULT_QUEUE_ID);
    expect(before.queueLifecycle).toBe('active-empty');

    const updateQueueSpy = vi.spyOn(f.store, 'updateQueue');

    await pauseQueuesAtLifecycleBoundary({
      store: f.store,
      queue: f.queue,
      lock: f.lock,
      scheduledStartCoordinator: f.scheduledStartCoordinator,
      logger: f.logger,
      now: () => FIXED_NOW
    });

    expect(f.store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle).toBe('active-empty');
    expect(updateQueueSpy).not.toHaveBeenCalled();
  });

  it.each<ManualPauseCause>([
    'breakpoint-paused',
    'verify-paused',
    'operator-paused',
    'spend-bound-reached'
  ])(
    '5. preserves existing operator-paused attribution and phase-level manualPauseCause (%s)',
    async (phaseCause) => {
      const f = await buildFixture();
      const task = await f.queue.enqueue('phase-paused task');
      const run = makeRun({
        featureId: task.id,
        status: 'paused',
        manualPauseAt: FIXED_NOW - 20_000,
        manualPauseCause: phaseCause,
        resumeTargetPhaseId: phaseCause === 'breakpoint-paused' ? 'speckit-plan' : null
      });
      await f.store.setRun(DEFAULT_QUEUE_ID, run, unfencedCommit('test-fixture'));
      await f.queue.markInFlight(task.id, run.id);
      await f.queue.setQueuePausedState(true, DEFAULT_QUEUE_ID, 'custom-reason', 'cascade');

      await pauseQueuesAtLifecycleBoundary({
        store: f.store,
        queue: f.queue,
        lock: f.lock,
        scheduledStartCoordinator: f.scheduledStartCoordinator,
        logger: f.logger,
        now: () => FIXED_NOW
      });

      const afterQueue = f.store.getQueue(DEFAULT_QUEUE_ID);
      expect(afterQueue.queueLifecycle).toBe('operator-paused');
      expect(afterQueue.pauseSource).toBe('cascade');
      expect(afterQueue.pausedReason).toBe('custom-reason');
      expect(afterQueue.inFlightId).toBeNull();
      expect(afterQueue.requests.find((r) => r.id === task.id)?.status).toBe('paused');

      const afterRun = f.store.getRun(DEFAULT_QUEUE_ID);
      expect(afterRun?.status).toBe('paused');
      expect(afterRun?.manualPauseCause).toBe(phaseCause);
      expect(afterRun?.manualPauseAt).toBe(FIXED_NOW - 20_000);
      expect(afterRun?.resumeTargetPhaseId).toBe(
        phaseCause === 'breakpoint-paused' ? 'speckit-plan' : null
      );
    }
  );

  it('5b. pauses a non-terminal Run lacking manualPauseAt on an already-operator-paused queue while keeping attribution', async () => {
    const f = await buildFixture();
    const task = await f.queue.enqueue('run without manualPauseAt');
    await f.store.updateQueue(
      (q) => ({
        queue: {
          ...q,
          queueLifecycle: 'operator-paused',
          pauseSource: 'retry-cap',
          pausedReason: 'retry-cap-exhausted:run-x'
        },
        result: undefined
      }),
      DEFAULT_QUEUE_ID,
      unfencedCommit('test-fixture')
    );
    const run = makeRun({
      featureId: task.id,
      status: 'running',
      manualPauseAt: null,
      manualPauseCause: null
    });
    await f.store.setRun(DEFAULT_QUEUE_ID, run, unfencedCommit('test-fixture'));

    await pauseQueuesAtLifecycleBoundary({
      store: f.store,
      queue: f.queue,
      lock: f.lock,
      scheduledStartCoordinator: f.scheduledStartCoordinator,
      logger: f.logger,
      now: () => FIXED_NOW
    });

    const afterQueue = f.store.getQueue(DEFAULT_QUEUE_ID);
    expect(afterQueue.pauseSource).toBe('retry-cap');
    expect(afterQueue.pausedReason).toBe('retry-cap-exhausted:run-x');
    const afterRun = f.store.getRun(DEFAULT_QUEUE_ID);
    expect(afterRun?.status).toBe('paused');
    expect(afterRun?.manualPauseAt).toBe(FIXED_NOW);
    expect(afterRun?.manualPauseCause).toBe('queue-paused-mid-run');
  });

  it('6. writes nothing when this window does not hold workspace primacy', async () => {
    const f = await buildFixture({ primary: false });
    const task = await f.queue.enqueue('running task');
    await f.queue.admitRun(task.id, makeRun({ featureId: task.id, status: 'running' }));
    const updateQueueSpy = vi.spyOn(f.store, 'updateQueue');
    const updateRunSpy = vi.spyOn(f.store, 'updateRun');

    await pauseQueuesAtLifecycleBoundary({
      store: f.store,
      queue: f.queue,
      lock: f.lock,
      scheduledStartCoordinator: f.scheduledStartCoordinator,
      logger: f.logger,
      now: () => FIXED_NOW
    });

    expect(updateQueueSpy).not.toHaveBeenCalled();
    expect(updateRunSpy).not.toHaveBeenCalled();
    expect(f.store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle).toBe('running');
    expect(f.store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('running');
  });

  it('7. logs and swallows store write errors so teardown never aborts', async () => {
    const f = await buildFixture();
    const task = await f.queue.enqueue('task whose store write fails');
    await f.queue.admitRun(task.id, makeRun({ featureId: task.id, status: 'running' }));
    vi.spyOn(f.store, 'updateRun').mockRejectedValue(new Error('memento unavailable'));

    await expect(
      pauseQueuesAtLifecycleBoundary({
        store: f.store,
        queue: f.queue,
        lock: f.lock,
        scheduledStartCoordinator: f.scheduledStartCoordinator,
        logger: f.logger,
        now: () => FIXED_NOW
      })
    ).resolves.toBeUndefined();

    expect(f.sink.lines.some((line) => line.includes('WARN'))).toBe(true);
  });
});
