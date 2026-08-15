/**
 * BUG-003 — the verify pause left the Run without the field that makes it
 * resumable.
 *
 * `PhaseSequencer.decideAfterPhase` returns `pause-verify` when a phase in
 * `VERIFY_PHASE_IDS` finishes non-clean. The driver's branch for it persisted
 * `status: 'paused'` and paused the Task row, and stopped there — where each of
 * its three sibling pause producers also stamps `manualPauseAt` /
 * `manualPauseCause`.
 *
 * That pair, not `status`, is what `PhaseControlService.resumeActivePhase`
 * tests: it refuses `run-not-paused` whenever `manualPauseAt === null &&
 * pendingRetryAt === null`. `resumeActivePhase` is the webview's Resume control
 * (`ui-wiring.ts`), so the Run reached a status the UI renders as paused with
 * the pair that lets it leave that status unset, and the control offered for it
 * always refused. The command-palette `resumeExisting` path reads neither field
 * and worked throughout, which is why `bugfix-pipeline-end-to-end.test.ts`
 * never caught this.
 *
 * The cause is `'verify-paused'` and deliberately not the task-level
 * `'phase-paused'` this same event sets on the Task row: `ManualPauseCause` and
 * `FeatureRequest.pauseCause` are disjoint vocabularies, and
 * `workflow-run-migrator.test.ts` pins that by feeding a task-level cause in and
 * requiring the pair be zeroed.
 *
 * Harness idiom follows `run-driver-manual-pause-identity.test.ts`:
 * `RunDriverDeps` as a loose literal, because naming a dozen collaborator
 * interfaces would dwarf the assertions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RunDriver } from '../../../src/services/run-driver';
import type { WorkflowRun } from '../../../src/state/workflow-run';

const NOW = 1_700_000_000_000;
const TASK_ID = 'task-1';
const QUEUE_ID = 'q-beta';
const VERIFY_PHASE = 'bugfix-verify-pre';

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    featureId: TASK_ID,
    featureDir: '/tmp/feat-1',
    status: 'running',
    currentPhase: VERIFY_PHASE,
    currentIteration: 0,
    startedAt: NOW,
    lastTransitionAt: NOW,
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
    pipeline: {
      id: 'bugfix',
      name: 'Bugfix',
      phases: [
        { id: VERIFY_PHASE, name: 'Verify pre', instruction: 'verify' },
        { id: 'bugfix-fix', name: 'Fix', instruction: 'fix' }
      ]
    },
    ...overrides
  } as unknown as WorkflowRun;
}

describe('RunDriver completes the verify pause (BUG-003)', () => {
  let deps: any;
  let persisted: WorkflowRun[];

  beforeEach(() => {
    vi.clearAllMocks();
    persisted = [];
    deps = {
      // A verify phase that finishes with issues outstanding — the exact input
      // `phase-sequencer.test.ts` uses to reach `pause-verify`.
      runner: {
        run: vi.fn().mockResolvedValue({
          result: {
            kind: 'remaining_issues',
            issues: [{ summary: 'missing test' }],
            auditEntry: null
          },
          outcome: 'issues_remain',
          terminationReason: 'token',
          stdoutSummary: '',
          stderrSummary: '',
          exitCode: 0,
          warnings: [],
          auditEntryId: null
        })
      },
      store: { findRunByTask: vi.fn(() => null) },
      queue: {
        notifyStatusChange: vi.fn(),
        finish: vi.fn(),
        pause: vi.fn(),
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
  });

  const pausedRun = (): WorkflowRun | undefined =>
    persisted.find((run) => run.status === 'paused');

  it('reaches the verify pause at all', async () => {
    // Guards the two assertions below: if the sequencer ever stops routing this
    // input to `pause-verify`, they would pass vacuously.
    await new RunDriver(deps).drive(makeRun(), 'desc');

    expect(pausedRun()).toBeDefined();
    expect(deps.queue.pause).toHaveBeenCalledWith(TASK_ID, 'phase-paused');
  });

  it('stamps the pause so the Run is resumable', async () => {
    // `resumeActivePhase` refuses `run-not-paused` unless one of `manualPauseAt`
    // / `pendingRetryAt` is set. This is the field that makes the Resume control
    // work on a verify-paused Run.
    await new RunDriver(deps).drive(makeRun(), 'desc');

    const paused = pausedRun();
    expect(paused?.manualPauseAt).toEqual(expect.any(Number));
    expect(paused?.manualPauseCause).toBe('verify-paused');
  });

  it('uses a run-level cause, not the task-level one it sets on the queue row', async () => {
    // The same event stamps two different vocabularies: `'phase-paused'` on the
    // Task row and `'verify-paused'` on the Run. `workflow-run-migrator.ts`
    // rejects a task-level cause on a Run and nulls the whole pair with it, so
    // reusing the string here would survive typecheck and silently un-pause the
    // Run on the next reload.
    await new RunDriver(deps).drive(makeRun(), 'desc');

    expect(deps.queue.pause).toHaveBeenCalledWith(TASK_ID, 'phase-paused');
    expect(pausedRun()?.manualPauseCause).not.toBe('phase-paused');
  });

  it('leaves resumeTargetPhaseId null so resume re-runs the verify phase', async () => {
    // `resumeTargetPhaseId` is `'breakpoint-paused'`-only by a migrator
    // invariant. It is also unnecessary: `currentPhase` stays on the verify
    // phase, which is what makes the resumed Run re-verify rather than skip
    // ahead — the behaviour `bugfix-pipeline-end-to-end.test.ts` pins.
    await new RunDriver(deps).drive(makeRun(), 'desc');

    const paused = pausedRun();
    expect(paused?.resumeTargetPhaseId).toBeNull();
    expect(paused?.currentPhase).toBe(VERIFY_PHASE);
  });
});
