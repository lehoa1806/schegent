/**
 * FR-R5-F19 (spec 278, T19.1, FR-001, T011) — the call site of the blocker notice.
 *
 * `drive()` hands every phase result to `handlePostPhaseDecisionSideEffects`, so the notice fires on
 * whichever branch the sequencer picks. These cases pin that the driver delivers it through the
 * notifier once per Run, that the text carries the cleaned label and no issue summary, and that a
 * second drive of the same Run id in the same host session does not repeat it.
 *
 * Harness idiom follows `run-driver-last-phase-issues.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RunDriver } from '../../../src/services/run-driver';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import { fakeRunLogger } from './fake-run-logger';

const NOW = 1_700_000_000_000;
const TASK_ID = 'task-1';

function makeRun(lastPhase: string, id = 'run-1'): WorkflowRun {
  return {
    id,
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

describe('RunDriver raises the first-blocker notice (FR-R5-F19, FR-001)', () => {
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
            issues: [{ tag: 'needs-decision', summary: 'Pick the retention window' }],
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
      logger: fakeRunLogger(),
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

  const blockerWarnings = (): string[] =>
    deps.notifier.warn.mock.calls
      .map((call: unknown[]) => String(call.at(0)))
      .filter((message: string) => message.includes('waiting on a decision'));

  it('notifies once on the failing branch, with the label and without the summary', async () => {
    await new RunDriver(deps).drive(makeRun('finalize'), 'Add the export button');

    const messages = blockerWarnings();
    expect(messages).toHaveLength(1);
    expect(messages.at(0)).toContain('Add the export button');
    expect(messages.at(0)).not.toContain('Pick the retention window');
  });

  it('notifies once on the continue branch, when a later phase reports clean', async () => {
    const blocking = await deps.runner.run();
    deps.runner.run
      .mockResolvedValueOnce(blocking)
      .mockResolvedValue({ ...blocking, result: { kind: 'clean', auditEntry: null }, outcome: 'success' });

    await new RunDriver(deps).drive(makeRun('finalize'), 'desc');

    expect(deps.runner.run.mock.calls.length).toBeGreaterThan(1);
    expect(blockerWarnings()).toHaveLength(1);
  }, 20_000);

  it('does not repeat when the same Run id is driven again, as a resumed failed Run is', async () => {
    const driver = new RunDriver(deps);
    await driver.drive(makeRun('finalize'), 'desc');
    await driver.drive(makeRun('finalize'), 'desc');

    expect(blockerWarnings()).toHaveLength(1);
  });

  it('notifies once per Run id', async () => {
    const driver = new RunDriver(deps);
    await driver.drive(makeRun('finalize', 'run-1'), 'desc');
    await driver.drive(makeRun('finalize', 'run-2'), 'desc');

    expect(blockerWarnings()).toHaveLength(2);
  });
});
