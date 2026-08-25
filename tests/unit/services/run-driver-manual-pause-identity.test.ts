/**
 * Feature 093 (T040) — the manual-pause identity check, at the layer that owns it.
 *
 * `PhaseSequencer` used to take `latestRun: WorkflowRun | null` and compare its
 * `id` against the Run it was deciding for. It could not do otherwise: the
 * caller read the single ambient Run slot, so the snapshot it handed over might
 * belong to somebody else. T040 narrowed the parameter to
 * `latestManualPauseAt: number | null`, which makes a foreign Run's pause
 * timestamp unrepresentable at that boundary — and moves the question to
 * `RunDriver.latestSnapshotOf()`, the one place that can answer it, because it
 * resolves the snapshot by the Run's own Task and knows what "still mine" means.
 *
 * These tests replace the deleted sequencer case
 * ("does not route to pause-manual when latestRun.id mismatches"). They exercise
 * the real `drive()` loop so the claim is about the driver's behaviour, not
 * about a private helper's return value.
 *
 * The scenario that makes this matter under N concurrent Runs: `deleteTask`
 * cancels this Run and the drain immediately starts a successor on the same
 * queue. The successor answers to the same Task id. It is not a newer snapshot
 * of this Run, and its pause state is not this Run's to act on.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RunDriver } from '../../../src/services/run-driver';
import type { WorkflowRun } from '../../../src/state/workflow-run';

const NOW = 1_700_000_000_000;
const TASK_ID = 'task-1';

/**
 * Two phases, so a Run that is *not* paused advances rather than completing on
 * the first output. The pause branch breaks out before advancing either way;
 * the second phase only exists so "did not pause" and "completed" stay distinct
 * observable outcomes.
 */
function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    featureId: TASK_ID,
    featureDir: '/tmp/feat-1',
    status: 'running',
    currentPhase: 'phase-1',
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
      id: 'pipe-1',
      name: 'Pipe',
      phases: [
        { id: 'phase-1', name: 'Phase 1', instruction: 'do something' },
        { id: 'phase-2', name: 'Phase 2', instruction: 'do something else' }
      ]
    },
    ...overrides
  } as unknown as WorkflowRun;
}

// `deps` follows the harness idiom of this directory (see
// `run-driver-probe.test.ts`): `RunDriverDeps` is built as a loose literal
// rather than fully typed, because naming a dozen collaborator interfaces would
// dwarf a test that asserts one call.
describe('RunDriver resolves the manual-pause snapshot by the Run own identity (T040)', () => {
  let deps: any;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = {
      runner: {
        run: vi.fn().mockResolvedValue({
          result: { kind: 'clean', auditEntry: null },
          outcome: 'clean',
          terminationReason: 'token',
          stdoutSummary: '',
          stderrSummary: '',
          exitCode: 0,
          warnings: [],
          auditEntryId: null
        })
      },
      store: { findRunByTask: vi.fn(() => null),
        // FR-R3-077 — no record to judge, so the read side has nothing to decline.
        readRunIfLive: vi.fn(async () => ({ outcome: 'absent' as const })) },
      queue: {
        notifyStatusChange: vi.fn(),
        finish: vi.fn(),
        pause: vi.fn(),
        cascadedPause: vi.fn(),
        findById: vi.fn(() => null)
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
      persistTransition: vi.fn(async (_prev: WorkflowRun, next: WorkflowRun) => next),
      appendPhaseControlAudit: vi.fn(),
      appendRunnerProbeFailedAudit: vi.fn(),
      appendBreakpointAudit: vi.fn(),
      emitRunEndedBreakpointAudit: vi.fn(),
      emitTaskLifecycleAudit: vi.fn(),
      emitOptionalPhaseFailureContinuedAudit: vi.fn(),
      scheduleAutoDrain: vi.fn()
    };
  });

  it('pauses when the persisted snapshot is this Run and carries a manual pause', async () => {
    const run = makeRun();
    deps.store.findRunByTask.mockReturnValue({
      queueId: 'default',
      run: makeRun({ manualPauseAt: NOW, manualPauseCause: 'operator-paused' })
    });

    await new RunDriver(deps).drive(run, 'desc');

    expect(deps.queue.pause).toHaveBeenCalledWith(TASK_ID, 'phase-paused');
  });

  it('ignores a successor Run pause on the same Task', async () => {
    // `deleteTask` canceled `run-1`; the drain started `run-2` on the same queue
    // and the operator paused *that* one. Same `featureId`, different Run. The
    // old sequencer-level guard is what used to catch this; the driver's
    // resolution catches it now, before the sequencer is even asked.
    const run = makeRun({ id: 'run-1' });
    deps.store.findRunByTask.mockReturnValue({
      queueId: 'default',
      run: makeRun({ id: 'run-2', manualPauseAt: NOW, manualPauseCause: 'operator-paused' })
    });

    await new RunDriver(deps).drive(run, 'desc');

    expect(deps.queue.pause).not.toHaveBeenCalledWith(TASK_ID, 'phase-paused');
  });

  it('ignores a Task with no persisted Run at all', async () => {
    const run = makeRun();
    deps.store.findRunByTask.mockReturnValue(null);

    await new RunDriver(deps).drive(run, 'desc');

    expect(deps.queue.pause).not.toHaveBeenCalledWith(TASK_ID, 'phase-paused');
  });

  it('addresses the snapshot by Task id, never by queue', async () => {
    // The resolution rule itself (data-model C-2): the driver asks for the Run
    // belonging to *its* Task. Pinning the argument keeps a future refactor from
    // quietly reintroducing an ambient or queue-guessed read.
    const run = makeRun();
    await new RunDriver(deps).drive(run, 'desc');
    expect(deps.store.findRunByTask).toHaveBeenCalledWith(TASK_ID);
  });
});
