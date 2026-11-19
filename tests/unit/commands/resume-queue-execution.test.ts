import { describe, expect, it, vi } from 'vitest';

import {
  resumePausedQueueExecution,
  type ResumePausedQueueExecutionDeps
} from '../../../src/commands/resume-queue-execution';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import type { FeatureRequest, FeatureRequestStatus, QueueState } from '../../../src/queue/feature-request';
import type { ManualPauseCause, WorkflowRun } from '../../../src/state/workflow-run';

function makeRequest(
  id: string,
  description: string,
  status: FeatureRequestStatus,
  position: number
): FeatureRequest {
  return {
    id,
    description,
    status,
    position,
    enqueuedAt: 1,
    createdAt: 1,
    startedAt: null,
    completedAt: null,
    runId: null,
    retryCount: 0,
    lastError: null,
    pauseCause: null,
    pausedReason: null,
    updatedAt: 1
  };
}

function makeQueue(overrides: Partial<QueueState> = {}): QueueState {
  return {
    requests: [],
    inFlightId: null,
    queueLifecycle: 'active-empty',
    pauseSource: null,
    pausedReason: null,
    scheduledStartAt: null,
    scheduledStartSource: null,
    updatedAt: 1_770_000_000_000,
    ...overrides
  };
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-resume-1',
    featureId: 'feat-1',
    featureDir: 'specs/233-auto-drain-teardown-close',
    status: 'paused',
    currentPhase: 'speckit-implement',
    currentIteration: 1,
    startedAt: 1_770_000_000_000,
    lastTransitionAt: 1_770_000_000_000,
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

function buildRig(options: {
  queue: QueueState;
  run?: WorkflowRun | null;
  driving?: boolean;
  startIntentOutcome?: 'applied' | 'rejected-untrusted' | 'rejected-horizon' | 'noop';
}) {
  const order: string[] = [];
  const applyStartQueueIntent = vi.fn(async () => {
    order.push('applyStartQueueIntent');
    return { outcome: options.startIntentOutcome ?? ('applied' as const) };
  });
  const admitResume = vi.fn(async () => {
    order.push('admitResume');
    return { resumed: true, completed: Promise.resolve() };
  });
  const drainQueuedWork = vi.fn(async () => {
    order.push('drainQueuedWork');
  });
  const deps: ResumePausedQueueExecutionDeps = {
    store: {
      getQueue: (_queueId: string) => options.queue,
      getRun: (_queueId: string) => options.run ?? null
    },
    guardedRunService: {
      applyStartQueueIntent: applyStartQueueIntent as unknown as ResumePausedQueueExecutionDeps['guardedRunService']['applyStartQueueIntent']
    },
    controller: {
      isDriving: () => options.driving ?? false,
      admitResume: admitResume as unknown as ResumePausedQueueExecutionDeps['controller']['admitResume'],
      drainQueuedWork
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn()
    }
  };
  return { deps, order, applyStartQueueIntent, admitResume, drainQueuedWork };
}

describe('BUG-001 (FR-019, SC-009) — resumePausedQueueExecution', () => {
  it('1. exits idle-pending -> running and calls admitResume when a queue-paused-mid-run Run has pending tasks behind it', async () => {
    const queue = makeQueue({
      queueLifecycle: 'idle-pending',
      inFlightId: null,
      requests: [
        makeRequest('feat-1', 'paused run task', 'paused', 0),
        makeRequest('feat-2', 'pending behind', 'pending', 1)
      ]
    });
    const run = makeRun({
      featureId: 'feat-1',
      status: 'paused',
      manualPauseAt: null,
      manualPauseCause: null
    });
    const rig = buildRig({ queue, run });

    const outcome = await resumePausedQueueExecution(DEFAULT_QUEUE_ID, rig.deps, 'continue');

    expect(outcome).toEqual({ action: 'resumed-run' });
    expect(rig.applyStartQueueIntent).toHaveBeenCalledWith(
      { startMode: 'now', source: 'operator-restart' },
      { queueId: DEFAULT_QUEUE_ID }
    );
    expect(rig.admitResume).toHaveBeenCalledWith(DEFAULT_QUEUE_ID, { customPrompt: 'continue' });
    expect(rig.order).toEqual(['applyStartQueueIntent', 'admitResume']);
    expect(rig.drainQueuedWork).not.toHaveBeenCalled();
  });

  it('2. invokes controller.admitResume directly when a paused Run has no pending tasks behind it', async () => {
    const queue = makeQueue({
      queueLifecycle: 'active-empty',
      inFlightId: null,
      requests: [makeRequest('feat-1', 'paused run task', 'paused', 0)]
    });
    const run = makeRun({
      featureId: 'feat-1',
      status: 'paused',
      manualPauseAt: 1_770_000_000_000,
      manualPauseCause: 'queue-paused-mid-run'
    });
    const rig = buildRig({ queue, run });

    const outcome = await resumePausedQueueExecution(DEFAULT_QUEUE_ID, rig.deps);

    expect(outcome).toEqual({ action: 'resumed-run' });
    expect(rig.applyStartQueueIntent).not.toHaveBeenCalled();
    expect(rig.admitResume).toHaveBeenCalledWith(DEFAULT_QUEUE_ID, {});
    expect(rig.drainQueuedWork).not.toHaveBeenCalled();
  });

  it('3. exits idle-pending -> running via applyStartQueueIntent and calls drainQueuedWork for a pending-only queue', async () => {
    const queue = makeQueue({
      queueLifecycle: 'idle-pending',
      inFlightId: null,
      requests: [makeRequest('feat-pending', 'waiting task', 'pending', 0)]
    });
    const rig = buildRig({ queue, run: null });

    const outcome = await resumePausedQueueExecution(DEFAULT_QUEUE_ID, rig.deps);

    expect(outcome).toEqual({ action: 'drained-pending' });
    expect(rig.applyStartQueueIntent).toHaveBeenCalledWith(
      { startMode: 'now', source: 'operator-restart' },
      { queueId: DEFAULT_QUEUE_ID }
    );
    expect(rig.drainQueuedWork).toHaveBeenCalledWith(DEFAULT_QUEUE_ID);
    expect(rig.order).toEqual(['applyStartQueueIntent', 'drainQueuedWork']);
    expect(rig.admitResume).not.toHaveBeenCalled();
  });

  it.each<ManualPauseCause>([
    'breakpoint-paused',
    'verify-paused',
    'operator-paused',
    'spend-bound-reached'
  ])(
    '4. preserves phase-level pause (%s) without calling admitResume or drainQueuedWork',
    async (cause) => {
      const queue = makeQueue({
        queueLifecycle: 'idle-pending',
        inFlightId: null,
        requests: [
          makeRequest('feat-1', 'paused at phase', 'paused', 0),
          makeRequest('feat-2', 'pending behind', 'pending', 1)
        ]
      });
      const run = makeRun({
        featureId: 'feat-1',
        status: 'paused',
        manualPauseAt: 1_770_000_000_000,
        manualPauseCause: cause,
        resumeTargetPhaseId: cause === 'breakpoint-paused' ? 'speckit-plan' : null
      });
      const rig = buildRig({ queue, run });

      const outcome = await resumePausedQueueExecution(DEFAULT_QUEUE_ID, rig.deps);

      expect(outcome).toEqual({ action: 'preserved-phase-pause' });
      expect(rig.applyStartQueueIntent).not.toHaveBeenCalled();
      expect(rig.admitResume).not.toHaveBeenCalled();
      expect(rig.drainQueuedWork).not.toHaveBeenCalled();
    }
  );

  it('5. leaves an empty queue in active-empty without draining or resuming', async () => {
    const queue = makeQueue({ queueLifecycle: 'active-empty', requests: [] });
    const rig = buildRig({ queue, run: null });

    const outcome = await resumePausedQueueExecution(DEFAULT_QUEUE_ID, rig.deps);

    expect(outcome).toEqual({ action: 'noop', reason: 'empty' });
    expect(rig.applyStartQueueIntent).not.toHaveBeenCalled();
    expect(rig.admitResume).not.toHaveBeenCalled();
    expect(rig.drainQueuedWork).not.toHaveBeenCalled();
  });

  it('6. refuses to drain or resume if applyStartQueueIntent is rejected (e.g. untrusted)', async () => {
    const queue = makeQueue({
      queueLifecycle: 'idle-pending',
      requests: [makeRequest('feat-pending', 'waiting task', 'pending', 0)]
    });
    const rig = buildRig({ queue, run: null, startIntentOutcome: 'rejected-untrusted' });

    const outcome = await resumePausedQueueExecution(DEFAULT_QUEUE_ID, rig.deps);

    expect(outcome).toEqual({ action: 'noop', reason: 'rejected-untrusted' });
    expect(rig.admitResume).not.toHaveBeenCalled();
    expect(rig.drainQueuedWork).not.toHaveBeenCalled();
  });
});
