// Feature 032 — Context-Preserving Phase Retries, Restarts, and Resumes.
//
// US1 (P1 MVP) — Delayed-retry continuation. When a delayed retry fires
// (the watchdog re-arms after a `transient_error` 15-min or `rate_limit`
// 60-min backoff), the next phase invocation MUST be dispatched with
// `isContinue: true` so the Claude CLI continues the prior conversation
// via the `-c` short flag.
//
// The flow under test:
//   1. `controller.startNew(feature, null)` invokes the runner once.
//   2. The runner returns `transient_error`.
//   3. The controller persists `delayedRetryCount=1`,
//      `pendingRetryCause='transient_error'`, and arms the watchdog.
//   4. The watchdog fires `resumeExisting()` after the backoff window.
//   5. The controller re-dispatches the same phase. Because the resume
//      flowed from a delayed retry (delayedRetryCount > 0 AND
//      pendingRetryCause WAS non-null pre-clear), the dispatch MUST set
//      `isContinue: true`.
//
// This test asserts the second `runSpy` call carries `isContinue: true`.
// It is EXPECTED TO FAIL until T015 wires the resume-path flag.
//
// Negative case: the FIRST invocation (a brand-new run with
// delayedRetryCount=0) MUST NOT carry `isContinue: true`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
import type { DelayedRetryWatchdog } from '../../../src/controller/workflow-controller';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import { QueueManager } from '../../../src/queue/queue-manager';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { PhaseRunner, PhaseRunOutput } from '../../../src/controller/phase-runner';
import type { SchegentStatusBar } from '../../../src/ui/status-bar';
import type { Notifier } from '../../../src/ui/notifications';
import type { Memento } from '../../../src/state/workspace-state';
import type { WorkspaceLockManager } from '../../../src/state/lock';

class FakeMemento implements Memento {
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

function makeStatusBar(): SchegentStatusBar {
  return {
    update: vi.fn(),
    dispose: vi.fn()
  } as unknown as SchegentStatusBar;
}

function makeNotifier(): Notifier {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  } as unknown as Notifier;
}

function makeLock(): WorkspaceLockManager & { release: ReturnType<typeof vi.fn> } {
  return {
    release: vi.fn(async () => {}),
    tryAcquire: vi.fn(),
    heartbeat: vi.fn(),
    isHeld: vi.fn(),
    ownerOfRecord: vi.fn(),
    withLock: async function (this: { release(): Promise<void> }, _scope: string, fn: (session: { retain(): void }) => Promise<unknown>) {
      let retain = false;
      try {
        return await fn({ retain: () => { retain = true; } });
      } finally {
        if (!retain) await this.release().catch(() => undefined);
      }
    },
    id: 'this-window'
  } as unknown as WorkspaceLockManager & { release: ReturnType<typeof vi.fn> };
}

function makeOutput(overrides: Partial<PhaseRunOutput> = {}): PhaseRunOutput {
  return {
    result: { kind: 'clean', auditEntry: null as never },
    outcome: 'clean',
    terminationReason: 'token',
    stdoutSummary: '',
    stderrSummary: '',
    exitCode: 0,
    auditEntryId: 'audit-1',
    warnings: [],
    cliSessionId: 'owned-claude-session',
    ...overrides
  };
}

function makeTransientOutput(): PhaseRunOutput {
  return {
    result: { kind: 'transient_error', exitCode: 1, auditEntry: null },
    outcome: 'transient_error',
    terminationReason: 'error',
    stdoutSummary: '',
    stderrSummary: 'cli aborted unexpectedly',
    exitCode: 1,
    auditEntryId: 'audit-tx',
    warnings: [],
    cliSessionId: 'owned-claude-session'
  };
}

function makeRateLimitedOutput(): PhaseRunOutput {
  return {
    result: { kind: 'rate_limited', cause: 'rate-limit', auditEntry: null },
    outcome: 'rate_limited',
    terminationReason: 'rate_limit',
    stdoutSummary: '',
    stderrSummary: 'over rate limit',
    exitCode: 1,
    auditEntryId: 'audit-rl',
    warnings: [],
    cliSessionId: 'owned-claude-session'
  };
}

const opts = {
  cliPath: 'claude',
  cwd: '/repo',
  iterationCap: 5,
  timeoutMs: 5_000,
};

let memento: FakeMemento;
let store: WorkspaceStateStore;
let queue: QueueManager;
let phaseRunner: PhaseRunner;
let runSpy: ReturnType<typeof vi.fn>;
let controller: SchegentWorkflowController;
let statusBar: SchegentStatusBar;
let notifier: Notifier;
let lock: WorkspaceLockManager & { release: ReturnType<typeof vi.fn> };
let auditWriter: { append: ReturnType<typeof vi.fn> };
let watchdog: {
  pauseAndPoll: ReturnType<typeof vi.fn>;
  cancelPendingTimer: ReturnType<typeof vi.fn>;
};

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  queue = new QueueManager(store);
  statusBar = makeStatusBar();
  notifier = makeNotifier();
  lock = makeLock();
  runSpy = vi.fn();
  phaseRunner = { run: runSpy } as unknown as PhaseRunner;
  const auditAppend = vi.fn();
  auditAppend.mockImplementation(async (entry: Record<string, unknown>) => ({
    id: 'mock-audit-id',
    timestamp: new Date().toISOString(),
    ...entry
  }));
  auditWriter = { append: auditAppend };
  const pauseAndPoll = vi.fn();
  pauseAndPoll.mockImplementation(async () => {});
  watchdog = {
    pauseAndPoll,
    cancelPendingTimer: vi.fn()
  };
  controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    statusBar,
    notifier,
    new SanitizedLogger(),
    lock,
    opts,
    {
      auditWriter: auditWriter as unknown as import('../../../src/audit/audit-log-writer').AuditLogWriter,
      watchdog: watchdog as unknown as DelayedRetryWatchdog
    }
  );
});

describe('Feature 032 US1 — delayed-retry resume sets isContinue=true', () => {
  it('first invocation has isContinue=false (fresh run, no prior context)', async () => {
    runSpy.mockImplementation(async () => makeOutput());
    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);

    // First call: brand-new run. Must NOT carry isContinue=true.
    expect(runSpy).toHaveBeenCalled();
    const firstCallInputs = runSpy.mock.calls[0][0];
    expect(firstCallInputs.isContinue ?? false).toBe(false);
  });

  it('second invocation after transient_error delayed-retry has isContinue=true', async () => {
    let calls = 0;
    runSpy.mockImplementation(async () => {
      calls++;
      if (calls === 1) return makeTransientOutput();
      return makeOutput();
    });

    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);

    // Pre-condition: first call did NOT continue.
    expect(runSpy.mock.calls[0][0].isContinue ?? false).toBe(false);

    // Pre-condition: state is paused with pendingRetryAt set.
    const paused = store.getRun()!;
    expect(paused.delayedRetryCount).toBe(1);
    expect(paused.pendingRetryCause).toBe('transient_error');

    // Simulate the watchdog firing the resume callback. After the
    // resume returns, `runSpy` will have been called once more (for the
    // retried phase) and possibly more times as the pipeline advances
    // through subsequent phases. We only care about call index 1: the
    // FIRST call after the resume, which is the continuation dispatch.
    await controller.resumeExisting();

    // Post-condition: second runner.run() call (the retry of the
    // transient-failed phase) MUST have isContinue=true.
    expect(runSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const secondCallInputs = runSpy.mock.calls[1][0];
    expect(secondCallInputs.isContinue).toBe(true);
  });

  it('second invocation after rate_limited delayed-retry has isContinue=true', async () => {
    let calls = 0;
    runSpy.mockImplementation(async () => {
      calls++;
      if (calls === 1) return makeRateLimitedOutput();
      return makeOutput();
    });

    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);

    expect(runSpy.mock.calls[0][0].isContinue ?? false).toBe(false);

    const paused = store.getRun()!;
    expect(paused.delayedRetryCount).toBe(1);
    expect(paused.pendingRetryCause).toBe('rate_limit');

    await controller.resumeExisting();

    expect(runSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const secondCallInputs = runSpy.mock.calls[1][0];
    expect(secondCallInputs.isContinue).toBe(true);
  });

  it('a fresh run after a clean prior phase resets isContinue to false on the next phase', async () => {
    // First two invocations succeed (no retry, no resume). The second
    // invocation is for a DIFFERENT phase (the controller advances after
    // a clean outcome). It is NOT a continuation; the prior phase's
    // conversation is logically separate. The dispatch MUST carry
    // isContinue=false (or omit it entirely).
    runSpy.mockImplementation(async () => makeOutput());

    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);

    // The controller called the runner multiple times (one per phase).
    // None of them are continuations — every call was a fresh dispatch.
    expect(runSpy.mock.calls.length).toBeGreaterThan(1);
    for (const [inputs] of runSpy.mock.calls) {
      expect((inputs as { isContinue?: boolean }).isContinue ?? false).toBe(false);
    }
  });
});

// Helper to wait for the `setImmediate` indirect resume to complete.
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('Feature 032 US2 — operator resume sets isContinue=true', () => {
  it('resumeActivePhase dispatches with isContinue=true after operator pause', async () => {
    // Two-phase scripted run: first phase exits clean (advancing the
    // pipeline). Then operator pauses the active phase before the second
    // dispatch begins. On resumeActivePhase, the SECOND dispatch (the
    // resumed phase) MUST carry isContinue=true.
    //
    // We can't easily wedge pause-between-dispatches under the synchronous
    // mock harness. Instead we drive: startNew → first phase returns
    // transient (pauses with pendingRetry) → resumeActivePhase (which
    // clears retry state AND triggers a fresh resumeExisting dispatch).
    // Because resumeActivePhase clears pendingRetryCause to null BEFORE
    // calling resumeExisting, the state-derivation path would NOT detect
    // this as a continuation — the entry point MUST arm the
    // IsContinueGate explicitly. That is the assertion under test.
    let calls = 0;
    runSpy.mockImplementation(async () => {
      calls++;
      if (calls === 1) return makeTransientOutput();
      return makeOutput();
    });

    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);

    // First call is fresh.
    expect(runSpy.mock.calls[0][0].isContinue ?? false).toBe(false);

    // resumeActivePhase: clears pendingRetry AND dispatches the resumed
    // phase. Returns immediately; the resume runs on setImmediate.
    const result = await controller.resumeActivePhase();
    expect(result.ok).toBe(true);

    // Drain the setImmediate callback that triggers the resume.
    await flushAsync();
    // The resume may have made multiple calls; we only care about the
    // FIRST call after the resume entry.
    await flushAsync();

    expect(runSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const resumeDispatch = runSpy.mock.calls[1][0];
    expect(resumeDispatch.isContinue).toBe(true);
  });

  it('restartActivePhase dispatches with isContinue=false (no continuation)', async () => {
    // After a transient_error pause, restartActivePhase clears all retry
    // state, resets the iteration counter, and dispatches afresh. This
    // dispatch MUST carry isContinue=false because the operator
    // explicitly chose to discard prior context.
    let calls = 0;
    runSpy.mockImplementation(async () => {
      calls++;
      if (calls === 1) return makeTransientOutput();
      return makeOutput();
    });

    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);
    expect(runSpy.mock.calls[0][0].isContinue ?? false).toBe(false);

    const result = await controller.restartActivePhase();
    expect(result.ok).toBe(true);
    await flushAsync();
    await flushAsync();

    expect(runSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    // The restarted-phase dispatch MUST NOT carry isContinue=true.
    const restartDispatch = runSpy.mock.calls[1][0];
    expect(restartDispatch.isContinue ?? false).toBe(false);
  });

  it('retryPhaseNow dispatches with isContinue=true (manual override of delayed retry)', async () => {
    // After a rate_limited pause, retryPhaseNow cancels the watchdog
    // timer AND dispatches the resumed phase. Because it is a manual
    // override of a delayed retry (which IS a continuation), the
    // dispatch MUST carry isContinue=true.
    let calls = 0;
    runSpy.mockImplementation(async () => {
      calls++;
      if (calls === 1) return makeRateLimitedOutput();
      return makeOutput();
    });

    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);
    expect(runSpy.mock.calls[0][0].isContinue ?? false).toBe(false);

    const result = await controller.retryPhaseNow();
    expect(result.ok).toBe(true);
    await flushAsync();
    await flushAsync();

    expect(runSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const retryDispatch = runSpy.mock.calls[1][0];
    expect(retryDispatch.isContinue).toBe(true);
  });
});

describe('Feature 032 US3 — first-attempt dispatch carries isContinue=false', () => {
  it('startNew dispatches with isContinue=false (or undefined)', async () => {
    runSpy.mockImplementation(async () => makeOutput());
    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);

    expect(runSpy).toHaveBeenCalled();
    const firstCallInputs = runSpy.mock.calls[0][0];
    expect(firstCallInputs.isContinue ?? false).toBe(false);
  });
});

describe('Feature 032 Phase 7 — loop iteration boundaries reset isContinue to false', () => {
  it('a loop iteration after a transient retry does NOT propagate isContinue', async () => {
    // First call transient_error → second call (retry) clean. After the
    // retry completes, subsequent dispatches in the same driveRun MUST
    // carry isContinue=false (loop iteration / phase advancement).
    let calls = 0;
    runSpy.mockImplementation(async () => {
      calls++;
      if (calls === 1) return makeTransientOutput();
      return makeOutput();
    });

    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);
    await controller.resumeExisting();
    await flushAsync();

    // The very first call (call index 0) is fresh.
    expect(runSpy.mock.calls[0][0].isContinue ?? false).toBe(false);
    // The retry dispatch (call index 1) is a continuation.
    expect(runSpy.mock.calls[1][0].isContinue).toBe(true);
    // Calls AFTER the retry (call index 2 onward) MUST be fresh dispatches:
    // the controller advanced to the next phase / iteration after the
    // retry's clean outcome, so the continuation hint was consumed and
    // reset.
    for (let i = 2; i < runSpy.mock.calls.length; i++) {
      expect((runSpy.mock.calls[i][0] as { isContinue?: boolean }).isContinue ?? false).toBe(
        false
      );
    }
  });

  it('a bugfix-loop iteration (issues_remain → re-iterate same phase) does NOT carry isContinue=true', async () => {
    // The bugfix loop is exercised when a phase outcome is
    // `issues_remain` / `open_questions` — the controller re-dispatches
    // the SAME phase with iteration++. None of those loop-iteration
    // dispatches are conversation continuations (they're fresh prompts
    // built by `PromptBuilder` against the latest pipeline state), so
    // `isContinue` must stay `false` across iteration boundaries even
    // when the same `driveRun` invocation drives them all.
    let calls = 0;
    runSpy.mockImplementation(async () => {
      calls++;
      // First two calls return `issues_remain` so the controller
      // re-dispatches the same phase with iteration++. Third call
      // returns `clean` so the run advances.
      if (calls <= 2) {
        return makeOutput({
          result: {
            kind: 'remaining_issues',
            issues: [],
            auditEntry: null as never
          },
          outcome: 'issues_remain',
          terminationReason: 'remaining_issues'
        });
      }
      return makeOutput();
    });

    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);
    await flushAsync();

    // EVERY call in this scenario is a fresh dispatch — no retry, no
    // resume, no pause. Bugfix-loop iterations MUST NOT inadvertently
    // chain `-c` across iterations.
    for (let i = 0; i < runSpy.mock.calls.length; i++) {
      expect((runSpy.mock.calls[i][0] as { isContinue?: boolean }).isContinue ?? false).toBe(
        false
      );
    }
  });
});
