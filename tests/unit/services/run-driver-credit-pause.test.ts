/**
 * FR-R4-F02 (spec 240, contract W5 G15, G16; data-model §3 writers) — the credit arm names its
 * pause.
 *
 * At `5d700407` the `pause-rate-limit` branch of `RunDriver.drive()` persists `status: 'paused'` and
 * nothing else: the Run is paused, with no pending retry pair and no manual pair, which is the same
 * shape a cap-exhausted pause leaves. Nothing could tell a credit pause from any other pause, so a
 * sweep over "paused Runs" resumed whichever it found. The branch now writes `creditPause` in the
 * SAME `persistTransition` as the status, so there is no moment at which the Run is paused for
 * credits and does not say so, and it still calls the rate-limit handler afterwards.
 *
 * No production outcome reaches this branch today (`transition()` maps every rate-limited outcome
 * to a delayed retry; plan "Noticed, not in scope"), so the tests reach it through the sequencer's
 * decision seam, `decideAfterPhase`. Harness idiom follows `run-driver-verify-pause.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunDriver } from '../../../src/services/run-driver';
import { PhaseSequencer } from '../../../src/controller/phase-sequencer';
import type { PhaseResult, WorkflowRun } from '../../../src/state/workflow-run';

const NOW = 1_700_000_000_000;
const TASK_ID = 'task-1';
const QUEUE_ID = 'q-beta';
const PHASE = 'speckit-plan';

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    featureId: TASK_ID,
    featureDir: '/tmp/feat-1',
    status: 'running',
    currentPhase: PHASE,
    currentIteration: 0,
    startedAt: NOW - 10_000,
    lastTransitionAt: NOW - 10_000,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    creditPause: null,
    pipeline: {
      id: 'speckit-new-feature',
      name: 'Default',
      phases: [
        { id: PHASE, name: 'Plan', instruction: 'plan' },
        { id: 'speckit-tasks', name: 'Tasks', instruction: 'tasks' }
      ]
    },
    ...overrides
  } as unknown as WorkflowRun;
}

const PHASE_RESULT: PhaseResult = {
  phase: PHASE,
  iteration: 0,
  startedAt: NOW - 5_000,
  endedAt: NOW - 1_000,
  result: 'failed',
  terminationReason: 'process-exit',
  exitCode: 143,
  stdoutSummary: '',
  stderrSummary: '',
  auditEntryId: null
} as unknown as PhaseResult;

const OPEN_CREDIT_PAUSE = { pausedAt: NOW, windowStartedAt: null, stoppedAt: null };

describe('RunDriver stamps the credit pause (contract W5 G15)', () => {
  let deps: any;
  let persisted: WorkflowRun[];
  let order: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    persisted = [];
    order = [];
    deps = {
      runner: {
        run: vi.fn().mockResolvedValue({
          result: { kind: 'rate_limited', cause: 'rate-limit', auditEntry: null },
          outcome: 'rate_limited',
          terminationReason: 'process-exit',
          stdoutSummary: '',
          stderrSummary: '',
          exitCode: 143,
          warnings: [],
          auditEntryId: null
        }),
        evictStagnationTracker: vi.fn()
      },
      store: { findRunByTask: vi.fn(() => null) },
      queue: {
        notifyStatusChange: vi.fn(),
        finish: vi.fn(async () => ({ ok: true })),
        pause: vi.fn(async () => ({ ok: true })),
        cascadedPause: vi.fn(),
        findById: vi.fn(() => ({ id: TASK_ID, queueId: QUEUE_ID }))
      },
      statusBar: { update: vi.fn() },
      notifier: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
      lock: {},
      options: { cliPath: 'claude', cwd: '/tmp', iterationCap: 5 },
      monitor: { emit: vi.fn() },
      historyRecorder: { recordPhaseOutput: vi.fn(), record: vi.fn() },
      retryCoordinator: {
        registerAttempt: vi.fn(),
        resetPhase: vi.fn(),
        maybeEmitRetryRecovered: vi.fn(async (run: WorkflowRun) => run),
        handleRateLimitPause: vi.fn(async () => {
          order.push('handleRateLimitPause');
        })
      },
      isContinueGate: { consume: vi.fn().mockReturnValue(false) },
      persistTransition: vi.fn(async (_prev: WorkflowRun, next: WorkflowRun) => {
        persisted.push(next);
        order.push(`persist:${next.status}`);
        return next;
      }),
      appendPhaseControlAudit: vi.fn(),
      appendRunnerProbeFailedAudit: vi.fn(),
      appendBreakpointAudit: vi.fn(),
      emitRunEndedBreakpointAudit: vi.fn(),
      emitTaskLifecycleAudit: vi.fn(),
      emitOptionalPhaseFailureContinuedAudit: vi.fn(),
      scheduleAutoDrain: vi.fn()
    };
    // The decision seam: the one input that reaches the credit arm.
    vi.spyOn(PhaseSequencer.prototype, 'decideAfterPhase').mockReturnValue({
      kind: 'pause-rate-limit',
      cause: 'rate-limit',
      phaseResult: PHASE_RESULT,
      warnings: [],
      evictStagnationTracker: true
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const pausedWrites = (): WorkflowRun[] => persisted.filter((run) => run.status === 'paused');
  const creditPauseOf = (run: WorkflowRun | undefined): unknown =>
    (run as unknown as { creditPause?: unknown } | undefined)?.creditPause;

  it('reaches the credit arm at all', async () => {
    await new RunDriver(deps).drive(makeRun(), 'desc');
    expect(pausedWrites()).toHaveLength(1);
    expect(deps.retryCoordinator.handleRateLimitPause).toHaveBeenCalledTimes(1);
  });

  it('writes creditPause in the one persistTransition that writes status paused', async () => {
    await new RunDriver(deps).drive(makeRun(), 'desc');

    const paused = pausedWrites();
    expect(paused).toHaveLength(1);
    expect(creditPauseOf(paused[0])).toEqual(OPEN_CREDIT_PAUSE);
    expect(paused[0]?.pendingRetryAt).toBeNull();
    expect(paused[0]?.pendingRetryCause).toBeNull();
    expect(paused[0]?.manualPauseCause).toBeNull();
  });

  it('calls the rate-limit handler after the pause is persisted, as before', async () => {
    await new RunDriver(deps).drive(makeRun(), 'desc');

    const pausedAt = order.indexOf('persist:paused');
    const handlerAt = order.indexOf('handleRateLimitPause');
    expect(pausedAt).toBeGreaterThanOrEqual(0);
    expect(handlerAt).toBeGreaterThan(pausedAt);
    const [, handedRun] = deps.retryCoordinator.handleRateLimitPause.mock.calls[0];
    expect(creditPauseOf(handedRun)).toEqual(OPEN_CREDIT_PAUSE);
  });
});

describe('RunDriver clears the credit pause on a terminal write', () => {
  it('persists creditPause null when a failed write is made from a Run that carried one', async () => {
    const persisted: WorkflowRun[] = [];
    const deps: any = {
      runner: { run: vi.fn(), evictStagnationTracker: vi.fn() },
      store: { findRunByTask: vi.fn(() => null) },
      queue: {
        notifyStatusChange: vi.fn(),
        finish: vi.fn(async () => ({ ok: true })),
        pause: vi.fn(async () => ({ ok: true })),
        cascadedPause: vi.fn(),
        findById: vi.fn(() => ({ id: TASK_ID, queueId: QUEUE_ID }))
      },
      statusBar: { update: vi.fn() },
      notifier: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
      lock: {},
      // Audit evidence unavailable: the driver fails the Run closed, a terminal write built from
      // the Run it was handed.
      options: { cliPath: 'claude', cwd: '/tmp', iterationCap: 5, isAuditEvidenceAvailable: () => false },
      monitor: { emit: vi.fn() },
      historyRecorder: { recordPhaseOutput: vi.fn(), record: vi.fn() },
      retryCoordinator: {
        registerAttempt: vi.fn(),
        resetPhase: vi.fn(),
        maybeEmitRetryRecovered: vi.fn(async (run: WorkflowRun) => run)
      },
      isContinueGate: { consume: vi.fn().mockReturnValue(false) },
      persistTransition: vi.fn(async (_prev: WorkflowRun, next: WorkflowRun) => {
        persisted.push(next);
        return next;
      }),
      appendPhaseControlAudit: vi.fn(),
      appendRunnerProbeFailedAudit: vi.fn(),
      appendBreakpointAudit: vi.fn(),
      emitRunEndedBreakpointAudit: vi.fn(),
      emitTaskLifecycleAudit: vi.fn(),
      emitOptionalPhaseFailureContinuedAudit: vi.fn(),
      scheduleAutoDrain: vi.fn()
    };

    await new RunDriver(deps).drive(makeRun({ creditPause: OPEN_CREDIT_PAUSE } as Partial<WorkflowRun>), 'desc');

    const failed = persisted.filter((run) => run.status === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    for (const run of failed) {
      expect((run as unknown as { creditPause?: unknown }).creditPause).toBeNull();
    }
  });
});
