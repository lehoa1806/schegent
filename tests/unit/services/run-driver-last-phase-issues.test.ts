/**
 * FR-R3-199 — a Run whose last phase reported remaining issues was marked
 * completed.
 *
 * `transition()` advanced such a phase to `done` like a clean one, and the
 * driver's completed arm did the rest: the ordinary "completed" notice, the
 * queue's next task, and under `errors-only` retention a deleted transcript.
 * The phase now halts the Run `failed`, and the failure arm leaves
 * `currentPhase` on it, so a resume re-runs the phase in place.
 *
 * The shipped bugfix pipeline ends on `bugfix-verify-post`, whose verify pause
 * predates the rule and must survive it.
 *
 * Harness idiom follows `run-driver-verify-pause.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RunDriver } from '../../../src/services/run-driver';
import type { WorkflowRun } from '../../../src/state/workflow-run';

const NOW = 1_700_000_000_000;
const TASK_ID = 'task-1';

function makeRun(lastPhase: string): WorkflowRun {
  return {
    id: 'run-1',
    featureId: TASK_ID,
    featureDir: '/tmp/feat-1',
    status: 'running',
    currentPhase: lastPhase,
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
      id: 'pipe',
      name: 'Pipe',
      phases: [
        { id: 'implement', name: 'Implement', instruction: 'implement' },
        { id: lastPhase, name: 'Last', instruction: 'finish' }
      ]
    }
  } as unknown as WorkflowRun;
}

describe('RunDriver ends a Run whose last phase reports remaining issues (FR-R3-199)', () => {
  let deps: any;
  let persisted: WorkflowRun[];

  beforeEach(() => {
    vi.clearAllMocks();
    persisted = [];
    deps = {
      runner: {
        run: vi.fn().mockResolvedValue({
          result: {
            kind: 'remaining_issues',
            issues: [{ summary: 'not merged' }],
            auditEntry: null
          },
          outcome: 'issues_remain',
          terminationReason: 'token',
          stdoutSummary: '',
          stderrSummary: '',
          exitCode: 0,
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
        findById: vi.fn(() => ({ id: TASK_ID, queueId: 'q-1' }))
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

  const statuses = (): string[] => persisted.map((run) => run.status);

  it('ends the Run failed on that phase, where a resume re-runs it', async () => {
    await new RunDriver(deps).drive(makeRun('finalize'), 'desc');

    expect(statuses()).not.toContain('completed');
    const failed = persisted.find((run) => run.status === 'failed');
    expect(failed?.currentPhase).toBe('finalize');
    expect(failed?.lastError?.phase).toBe('finalize');
    expect(deps.queue.finish).toHaveBeenCalledWith(TASK_ID, 'failed', expect.anything());
    expect(deps.notifier.warn).toHaveBeenCalledWith(
      expect.stringContaining('finalize failed — the last phase reported remaining issues')
    );
  });

  it('still pauses a bugfix-verify-post that ends the pipeline', async () => {
    await new RunDriver(deps).drive(makeRun('bugfix-verify-post'), 'desc');

    expect(statuses()).not.toContain('failed');
    const paused = persisted.find((run) => run.status === 'paused');
    expect(paused?.currentPhase).toBe('bugfix-verify-post');
    expect(paused?.manualPauseCause).toBe('verify-paused');
  });
});
