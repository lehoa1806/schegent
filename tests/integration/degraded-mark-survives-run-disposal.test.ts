// FR-R3-157 (T037, FR-011a, SC-009, contract C3.4) — the degraded mark outlives
// the Run that produced it.
//
// THIS IS THE TEST THAT CATCHES CONTRACT C4, AND THE DISPOSAL IS THE POINT.
// Runs are held one per queue (`KEYS.run` is a `Record<queueId, WorkflowRun>`), so
// the moment the next task in a queue starts, the previous task's Run record is
// overwritten and every trace of which phases it carried past their cap goes with
// it. A mark that lives only on the Run therefore reads correct in every unit test
// that keeps the Run alive, and reads BLANK in production the instant a second task
// begins — a degraded run become indistinguishable from a clean one, which is the
// single thing FR-006 forbids and the defect feature 198 was raised to fix for the
// neighbouring field.
//
// So this test does the one thing the unit tests deliberately do not: it disposes
// of the Run, by starting a real second task on the same queue, and then asks the
// first task's row what happened to it.
//
// It is wired end to end rather than by calling `queue.finish()` directly, because
// the capture is not something the test should perform on the code's behalf. The
// real chain is `RunDriver.drive()` -> `TerminalTransitionCoordinator.complete()`
// -> `QueueManager.finish()`, and a test that skipped to the last link would pass
// against a driver that never reached it.
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { SanitizedLogger } from '../../src/lib/logger';
import { QueueManager } from '../../src/queue/queue-manager';
import { RunDriver, type RunDriverDeps } from '../../src/services/run-driver';
import { TerminalTransitionCoordinator } from '../../src/services/terminal-transition-coordinator';
import { unfencedCommit } from '../../src/state/ownership-claim';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import type { PhaseRunOutput } from '../../src/controller/phase-runner';
import type { WorkflowRun } from '../../src/state/workflow-run';

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

/** A phase output whose retry condition can never be satisfied, so the cap decides. */
const UNSATISFIED: PhaseRunOutput = {
  result: { kind: 'clean', auditEntry: { metrics: { open_questions: 3 } } },
  outcome: 'clean',
  terminationReason: 'token',
  stdoutSummary: '',
  stderrSummary: '',
  exitCode: 0,
  warnings: [],
  auditEntryId: null
} as unknown as PhaseRunOutput;

const degradingPhase = {
  id: 'audit',
  title: 'Audit',
  runner: 'claude',
  effort: 'normal',
  retryCondition: 'open_questions > 0',
  onRetryCap: 'continue-degraded'
};

const cleanPhase = { id: 'audit', title: 'Audit', runner: 'claude', effort: 'normal' };

async function makeWorld(): Promise<{
  store: WorkspaceStateStore;
  queue: QueueManager;
  driveTask: (featureId: string, runId: string, phases: readonly unknown[]) => Promise<void>;
}> {
  const store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  const queue = new QueueManager(store);
  const logger = new SanitizedLogger([]);

  // The real coordinator, over the real queue manager. This is the link that turns
  // a terminal Run into a terminal Task, and it is where `finish()` is called from
  // in production.
  const terminalTransitions = new TerminalTransitionCoordinator(
    store,
    queue,
    { record: vi.fn().mockResolvedValue({ outcome: 'recorded' }) },
    logger
  );

  const deps = {
    store,
    runner: {
      run: vi.fn().mockResolvedValue(UNSATISFIED),
      abort: vi.fn(),
      appendCapExhaustedPhaseEnd: vi.fn().mockResolvedValue(undefined),
      evictStagnationTracker: vi.fn()
    },
    logger,
    options: { iterationCap: 1, cwd: '/test/cwd', cliPath: '/test/bin' },
    monitor: null,
    retryCoordinator: {
      registerAttempt: vi.fn(),
      clear: vi.fn(),
      isRetryCapExhaustedOnNextFailure: vi.fn().mockReturnValue(false),
      handleDelayedRetry: vi.fn(),
      maybeEmitRetryRecovered: vi.fn().mockImplementation(async (r: unknown) => r)
    },
    queue,
    terminalTransitions,
    notifier: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    statusBar: { update: vi.fn(), dispose: vi.fn() },
    historyRecorder: { record: vi.fn() },
    checkpoints: { checkpoint: vi.fn().mockResolvedValue(undefined) },
    emitRunEndedBreakpointAudit: vi.fn(),
    emitTaskLifecycleAudit: vi.fn(),
    emitOptionalPhaseFailureContinued: vi.fn(),
    emitRunSnapshotDeclined: vi.fn(),
    emitOutputTargetRefusedAtDispatch: vi.fn(),
    appendPhaseControlAudit: vi.fn(),
    appendRunnerProbeFailedAudit: vi.fn(),
    appendBreakpointAudit: vi.fn(),
    isContinueGate: { consume: vi.fn().mockReturnValue(false), arm: vi.fn() },
    lock: {
      release: vi.fn(async () => {}),
      tryAcquire: vi.fn(),
      heartbeat: vi.fn(),
      isHeld: vi.fn(),
      ownerOfRecord: vi.fn(),
      id: 'this-window'
    },
    persistTransition: async (_previous: WorkflowRun, next: WorkflowRun) => {
      await store.setRun(DEFAULT_QUEUE_ID, next, unfencedCommit('test-fixture'));
      return next;
    },
    scheduleAutoDrain: vi.fn(),
    releaseExecutionLease: vi.fn(),
    onRunTerminal: vi.fn()
  } as unknown as RunDriverDeps;

  const driver = new RunDriver(deps);

  return {
    store,
    queue,
    /**
     * Start a task's Run on the shared queue and drive it to a terminal status.
     *
     * The `setRun` here is the disposal: `KEYS.run` holds one Run per queue, so
     * writing the second task's Run over the first task's is exactly what the
     * host does when the next task starts, and exactly what destroys the evidence
     * this feature has to preserve.
     */
    async driveTask(featureId: string, runId: string, phases: readonly unknown[]): Promise<void> {
      const run = {
        id: runId,
        taskId: featureId,
        featureId,
        featureDir: 'specs/199',
        startedAt: Date.now(),
        updatedAt: Date.now(),
        status: 'running',
        currentPhase: 'audit',
        currentIteration: 0,
        pipeline: { id: 'pipe', name: 'Pipe', phases },
        phasesCompleted: [],
        lastError: null,
        pendingRetry: false,
        delayedRetryCount: 0,
        pendingRetryAt: null,
        pendingRetryCause: null,
        manualPauseAt: null,
        manualPauseCause: null,
        phaseBreakpoints: [],
        phaseOverrides: [],
        resumeTargetPhaseId: null
      } as unknown as WorkflowRun;
      await store.setRun(DEFAULT_QUEUE_ID, run, unfencedCommit('test-fixture'));
      await driver.drive(store.getRun(DEFAULT_QUEUE_ID)!, featureId);
    }
  };
}

describe('FR-R3-157 (T037) — a degraded task keeps its mark after its Run is disposed', () => {
  it('still names the phase and the condition once a sibling has run and finished (SC-009, C3.4)', async () => {
    const { store, queue, driveTask } = await makeWorld();
    const a = await queue.enqueue('degrades in audit');
    const b = await queue.enqueue('runs afterwards, cleanly');

    await queue.markInFlight(a.id, 'run-a');
    await driveTask(a.id, 'run-a', [degradingPhase]);

    // The capture must already have happened, from the Run that is about to be
    // destroyed. Asserted here so a later failure is unambiguous about which half
    // broke: the capture, or the survival.
    expect(queue.findById(a.id)?.degradedPhases).toEqual([
      { phaseId: 'audit', condition: 'open_questions > 0' }
    ]);

    // ── the disposal ──────────────────────────────────────────────────────────
    // A's Run is findable right now. Asserted before the disposal so the `toBeNull`
    // below means "destroyed" rather than "never there" — without this line a test
    // that failed to persist any Run at all would report the disposal as a success.
    expect(store.findRunByTask(a.id)?.run.degradedPhases).toEqual([
      { phaseId: 'audit', condition: 'open_questions > 0' }
    ]);

    await queue.markInFlight(b.id, 'run-b');
    await driveTask(b.id, 'run-b', [cleanPhase]);

    // And now it is gone: one Run per queue, and B's overwrote it. Anything still
    // reporting A's degradation is reporting it from A's own record.
    expect(store.findRunByTask(a.id)).toBeNull();

    const row = queue.findById(a.id);
    expect(row?.degradedPhases).toEqual([{ phaseId: 'audit', condition: 'open_questions > 0' }]);
    // Both names, spelled out. A mark that survived as a bare boolean would leave
    // the row saying something went wrong without saying what or where, which
    // FR-010 rules out as a way of satisfying this.
    expect(row?.degradedPhases?.[0]?.phaseId).toBe('audit');
    expect(row?.degradedPhases?.[0]?.condition).toBe('open_questions > 0');
  });

  it('does not spread the mark to the sibling that ran cleanly (C3.5)', async () => {
    // The other direction of the same hazard. A capture that read "the queue's
    // current Run" instead of the finishing task's would not only lose A's mark —
    // it would hand B a degradation B never had, and a row accusing a clean run is
    // worse than one that merely forgot.
    const { queue, driveTask } = await makeWorld();
    const a = await queue.enqueue('degrades in audit');
    const b = await queue.enqueue('runs afterwards, cleanly');

    await queue.markInFlight(a.id, 'run-a');
    await driveTask(a.id, 'run-a', [degradingPhase]);
    await queue.markInFlight(b.id, 'run-b');
    await driveTask(b.id, 'run-b', [cleanPhase]);

    expect(queue.findById(b.id)).not.toHaveProperty('degradedPhases');
  });
});
