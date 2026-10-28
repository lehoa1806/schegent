// FR-R4-F02 (spec 240, US6; contract W6 G19, W6b G22; US6-6) — two controls and the credit pause.
//
// 1. Resume. A Run whose credit polling stopped (`creditPause.stoppedAt` set) is resumed by the
//    operator's Resume, and by nothing else. That resume writes `creditPause: null`, runs no
//    status check and starts no poll: the account is the operator's word at that point.
//
// 2. Skip. Skipping a failed Run that has a pending deadline used to reset the WHOLE watchdog
//    record, because the deadline lived there. The record is credit-only now, so that write would
//    end a sibling queue's credit polling. At `5d700407` the record was reset (recorded in
//    measurements.md, US6); only the queue's own deadline is cancelled now (FR-024 of feature 093:
//    a control affects only the queue it names).
import { describe, expect, it, vi } from 'vitest';
import { PhaseControlService } from '../../../src/controller/phase-control-service';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import type { WorkflowRun } from '../../../src/state/workflow-run';

const QUEUE_A = 'queue-a';
const QUEUE_B = 'queue-b';

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-a',
    featureId: 'task-a',
    featureDir: '',
    startedAt: 1,
    lastTransitionAt: 1,
    status: 'paused',
    currentPhase: 'alpha',
    currentIteration: 1,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    phaseOverrides: [],
    resumeTargetPhaseId: null,
    creditPause: null,
    pipeline: {
      id: 'ab-flow',
      name: 'A then B',
      phases: [
        { id: 'alpha', name: 'Alpha', instruction: 'a' },
        { id: 'beta', name: 'Beta', instruction: 'b' }
      ]
    },
    ...overrides
  } as unknown as WorkflowRun;
}

function makeService(runs: Readonly<Record<string, WorkflowRun>>) {
  const updateRun = vi.fn(
    async (
      queueId: string,
      update: { patch: (current: WorkflowRun) => Partial<WorkflowRun> }
    ): Promise<WorkflowRun> => {
      const run = runs[queueId]!;
      return { ...run, ...update.patch(run) };
    }
  );
  const setWatchdog = vi.fn(async () => {});
  const cancelPendingTimer = vi.fn();
  const resumeExisting = vi.fn(async () => true);
  const service = new PhaseControlService({
    store: {
      getRun: vi.fn((queueId: string) => runs[queueId] ?? null),
      updateRun,
      getQueue: vi.fn(() => null),
      setWatchdog,
      runCommitClaim: vi.fn(() => unfencedCommit('test-fixture'))
    },
    queue: {
      cascadedPause: vi.fn(async () => {}),
      cascadedResume: vi.fn(async () => {}),
      setQueuePausedState: vi.fn(async () => {})
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    retryCoordinator: { cancelPendingTimer },
    isDriving: vi.fn(() => false),
    noteActivePhaseOverrideAbort: vi.fn(),
    armIsContinue: vi.fn(),
    cancelActive: vi.fn(),
    resumeExisting,
    auditor: {
      appendPhaseControl: vi.fn(async () => {}),
      emitTaskPaused: vi.fn(async () => {}),
      emitPhaseJumped: vi.fn(async () => {}),
      appendBreakpoint: vi.fn(async () => {})
    }
  } as unknown as ConstructorParameters<typeof PhaseControlService>[0]);
  return { service, updateRun, setWatchdog, cancelPendingTimer, resumeExisting };
}

describe('Resume on a Run whose credit polling stopped (W6 G19, US6-6)', () => {
  const STOPPED = { pausedAt: 1, windowStartedAt: 2, stoppedAt: 3 };

  it('resumes it, writes creditPause: null, and starts no poll and no status check', async () => {
    const { service, updateRun, setWatchdog, resumeExisting } = makeService({
      [QUEUE_A]: makeRun({ creditPause: STOPPED })
    });

    const result = await service.resumeActivePhase(QUEUE_A);
    expect(result).toEqual({ ok: true });
    await vi.waitFor(() => expect(resumeExisting).toHaveBeenCalledTimes(1));

    const patch = updateRun.mock.calls[0]![1].patch(makeRun({ creditPause: STOPPED }));
    expect(patch).toMatchObject({ status: 'running', creditPause: null });
    // No watchdog write at all: no poll is armed and no record is touched.
    expect(setWatchdog).not.toHaveBeenCalled();
  });

  it('control: an ordinary operator-paused Run resumes the same way and clears nothing it did not have', async () => {
    const { service, updateRun } = makeService({
      [QUEUE_A]: makeRun({ manualPauseAt: 5, manualPauseCause: 'operator-paused' })
    });

    expect(await service.resumeActivePhase(QUEUE_A)).toEqual({ ok: true });

    const patch = updateRun.mock.calls[0]![1].patch(makeRun({ manualPauseAt: 5, manualPauseCause: 'operator-paused' }));
    expect(patch).toMatchObject({ status: 'running', manualPauseAt: null, manualPauseCause: null, creditPause: null });
  });
});

describe('Skip on one queue leaves the watchdog record and the other queues alone (W6b G22)', () => {
  it('cancels the named queue\'s own deadline and does not write the watchdog record', async () => {
    const failedWithDeadline = makeRun({
      status: 'failed',
      pendingRetryAt: Date.now() + 60_000,
      pendingRetryCause: 'transient_error',
      delayedRetryCount: 1
    });
    const siblingCreditPaused = makeRun({
      id: 'run-b',
      featureId: 'task-b',
      creditPause: { pausedAt: 1, windowStartedAt: 2, stoppedAt: null }
    });
    const { service, setWatchdog, cancelPendingTimer } = makeService({
      [QUEUE_A]: failedWithDeadline,
      [QUEUE_B]: siblingCreditPaused
    });

    await service.skipPhase(QUEUE_A, 'alpha');

    expect(cancelPendingTimer).toHaveBeenCalledWith(QUEUE_A);
    expect(cancelPendingTimer).not.toHaveBeenCalledWith(QUEUE_B);
    expect(setWatchdog).not.toHaveBeenCalled();
  });
});
