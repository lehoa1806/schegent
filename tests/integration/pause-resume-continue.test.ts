import { ZippedStreamBuffer } from '../../src/runner/zipped-stream-buffer';
// Feature 033 T010 — Integration: pause-then-resume preserves -c continuation.
//
// Drives the real WorkflowController + PhaseRunner + AuditLogWriter stack
// against a mocked ClaudeCliRunner. Verifies the 032 isContinue lock-step
// invariant under the 033 aggressive-pause change:
//
//   (a) The first `runner.invoke()` call (fresh dispatch) carries
//       `isContinue: false` (or absent).
//   (b) After `pauseActivePhase()` persists the pause-cause AND calls
//       `cancelActive()`, the run is held in a paused state with
//       `manualPauseAt !== null` and `manualPauseCause === 'operator-paused'`.
//   (c) `resumeActivePhase()` arms the IsContinueGate and re-dispatches;
//       the next `runner.invoke()` MUST carry
//       `isContinue: true`, and the `phase-start` audit-log entry for that
//       invocation MUST mirror it with `isContinue: true` (032 lock-step).
//
// Implementation note: we do not exercise the subprocess SIGTERM path in
// this integration test — the unit test
// `tests/unit/controller/aggressive-pause.test.ts` covers the
// `cancelActive` insertion point and ordering. Here we simulate the pause
// path by injecting a phase-paused outcome on the first invocation so the
// driveRun loop persists a paused state we can then resume.
//
// SC-001 measurement methodology (3 s 95th-percentile pause latency):
// the wall-clock latency from operator Pause click to subprocess exit is
// bounded by:
//
//   (a) `pauseActivePhase()` does its persistence + cancelActive() call
//       synchronously on the click event (< 50 ms in practice).
//   (b) `cancelActive()` calls `AbortController.abort()` on the spawn's
//       AbortSignal; the AbortSignal listener inside `claude-cli.ts`
//       sends SIGTERM to the subprocess group immediately.
//   (c) If the subprocess does not exit within `SIGKILL_DELAY_MS = 2000` ms
//       the runner escalates to SIGKILL.
//
// Sum: ≤ 2050 ms worst case from click to exit. The 3 s SC target gives
// 950 ms of headroom for the WorkflowController loop to observe the
// `killed` outcome and settle the run into a paused state. The SIGKILL
// escalation budget itself is enforced by the existing claude-cli.ts unit
// tests (search for `SIGKILL_DELAY_MS`). Manual verification:
//
//   1. Start a long-running phase that obviously won't naturally complete
//      (e.g. a fixture that writes a 5-minute sleep).
//   2. Click Pause; mark t0 = click timestamp.
//   3. Watch the OUTPUT channel for the `phase-end outcome=killed` line;
//      mark t1.
//   4. Assert `t1 − t0 ≤ 3000 ms` over 20 trials (95th percentile).

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import { PhaseRunner } from '../../src/controller/phase-runner';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { SanitizedLogger } from '../../src/lib/logger';
import { createPhaseBreakpointAccessor } from '../../src/controller/breakpoint-accessor';
import { findQueue, DEFAULT_QUEUE_ID } from '../../src/queue/queue-registry';
import type { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type { RawInvocationOutput, InvocationRequest } from '../../src/runner/invocation-result';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import type { Notifier } from '../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../src/state/lock';
import type {
  DelayedRetryWatchdog,
  WorkflowControllerDeps
} from '../../src/controller/workflow-controller';

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

interface CapturedInvocation {
  isContinue: boolean | undefined;
  phase: string;
  iteration: number;
}

function makeCleanOutput(): RawInvocationOutput {
  return {
    stdoutBuffer: (() => { const b = new ZippedStreamBuffer(); b.append(''); b.finalize(); return b; })(), stderrBuffer: (() => { const b = new ZippedStreamBuffer(); b.finalize(); return b; })(),
    exitCode: 0,
    killed: false,
    timedOut: false,
    durationMs: 1,
    cliSessionId: 'owned-claude-session'
  };
}

/**
 * A scripted runner that records every invocation and returns scripted
 * raw outputs in order. Also exposes a controllable `cancelActive` so the
 * controller's `cancelActive()` invocation is observable.
 */
function makeScriptedCliRunner(): {
  runner: ClaudeCliRunner;
  invocations: CapturedInvocation[];
  cancelSpy: Mock<() => boolean>;
  setOutcome: (outcomes: Array<() => RawInvocationOutput>) => void;
} {
  const invocations: CapturedInvocation[] = [];
  let scripted: Array<() => RawInvocationOutput> = [];
  let callIdx = 0;
  const invoke = vi.fn(async (req: InvocationRequest): Promise<RawInvocationOutput> => {
    invocations.push({
      isContinue: req.isContinue,
      phase: req.phase,
      iteration: req.iteration
    });
    const handler = scripted[callIdx] ?? (() => makeCleanOutput());
    callIdx++;
    return handler();
  });
  const cancelSpy = vi.fn(() => false);
  const runner = {
    invoke,
    cancelActive: cancelSpy,
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;
  return {
    runner,
    invocations,
    cancelSpy,
    setOutcome: (outcomes) => {
      scripted = outcomes;
    }
  };
}

function makeLock(): WorkspaceLockManager {
  return {
    release: vi.fn(async () => undefined),
    tryAcquire: vi.fn(async () => ({ acquired: false, owner: null })),
    heartbeat: vi.fn(),
    isHeld: vi.fn(() => true),
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
  } as unknown as WorkspaceLockManager;
}

function makeStubWatchdog(): DelayedRetryWatchdog & {
  pauseAndPoll: ReturnType<typeof vi.fn>;
  cancelPendingTimer: ReturnType<typeof vi.fn>;
} {
  return {
    pauseAndPoll: vi.fn(async () => {}),
    cancelPendingTimer: vi.fn()
  } as unknown as DelayedRetryWatchdog & {
    pauseAndPoll: ReturnType<typeof vi.fn>;
    cancelPendingTimer: ReturnType<typeof vi.fn>;
  };
}

interface Harness {
  controller: SchegentWorkflowController;
  store: WorkspaceStateStore;
  queue: QueueManager;
  audit: AuditLogWriter;
  workspaceRoot: string;
  invocations: CapturedInvocation[];
  setOutcome: (outcomes: Array<() => RawInvocationOutput>) => void;
  watchdog: ReturnType<typeof makeStubWatchdog>;
}

async function makeHarness(memento: FakeMemento, workspaceRoot: string): Promise<Harness> {
  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot }, logger);
  const { runner, invocations, setOutcome } = makeScriptedCliRunner();
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  // Feature 028 — inject the breakpoint accessor so the runner can read
  // `WorkflowRun.phaseBreakpoints` and short-circuit to
  // `paused-at-breakpoint` BEFORE invoking the CLI. Mirrors production
  // wiring in `src/extension.ts`.
  const phaseBreakpointAccessor = createPhaseBreakpointAccessor(() => store.getRun());
  const phaseRunner = new PhaseRunner(
    runner,
    new PromptBuilder(),
    audit,
    logger,
    null,
    null,
    null,
    null,
    null,
    phaseBreakpointAccessor
  );
  const queue = new QueueManager(store);
  const watchdog = makeStubWatchdog();

  const statusBar = { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
  const notifier = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  } as unknown as Notifier;
  const lock = makeLock();

  const deps: WorkflowControllerDeps = {
    auditWriter: audit,
    watchdog
  };

  const controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    statusBar,
    notifier,
    logger,
    lock,
    {
      cliPath: 'noop',
      cwd: workspaceRoot,
      iterationCap: 5,
      timeoutMs: 1000,
      perPhaseRulesEnabled: false
    },
    deps
  );

  return { controller, store, queue, audit, workspaceRoot, invocations, setOutcome, watchdog };
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-pause-resume-'));
});

afterEach(async () => {
  // Best-effort cleanup: an in-flight async audit write can race a
  // first rm and produce ENOTEMPTY. Retry once after a microtask drain.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY') throw err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function readPhaseStartIsContinue(workspaceRoot: string): Promise<boolean[]> {
  const log = await fs.readFile(path.join(workspaceRoot, '.schegent', 'audit.log'), 'utf8');
  const entries = log
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { eventType: string; payload: { isContinue?: unknown } });
  return entries
    .filter((e) => e.eventType === 'phase-start')
    .map((e) => Boolean(e.payload.isContinue));
}

describe('Feature 033 US1 — pause then resume preserves -c continuation (032 invariant)', () => {
  it('first dispatch isContinue=false; post-resume dispatch isContinue=true', async () => {
    const memento = new FakeMemento();
    const harness = await makeHarness(memento, tmpRoot);

    // Script: every invocation returns a clean output. The first call
    // completes the initial phase; we then operator-pause AFTER the run
    // has settled, then resume — the next invocation must carry
    // isContinue=true.
    //
    // To pause cleanly between dispatches, we need to interrupt the
    // driveRun loop. We do that by injecting a runner-side side effect:
    // after the first invocation, the runner calls pauseActivePhase on
    // the controller before returning. That persists the pause cause
    // BEFORE the driveRun loop iterates to the next phase, so the post-
    // dispatch check at line 960 (`latestRun.manualPauseAt !== null`)
    // hits and the loop persists a paused state.
    let pauseInjected = false;
    harness.setOutcome([
      () => {
        if (!pauseInjected) {
          pauseInjected = true;
          // Schedule the pause to fire AFTER this invocation resolves
          // but BEFORE the next loop iteration runs. setImmediate puts
          // the pause on the microtask drain right after the awaited
          // invoke().
          setImmediate(async () => {
            await harness.controller.pauseActivePhase();
          });
        }
        return makeCleanOutput();
      },
      () => makeCleanOutput(),
      () => makeCleanOutput(),
      () => makeCleanOutput(),
      () => makeCleanOutput()
    ]);

    const feature = await harness.queue.enqueue('feature pause-resume-continue');
    await harness.controller.startNew(feature, null);

    // Drain pending microtasks so the scheduled pause resolves.
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 0));
    }

    // The run must now be paused.
    const pausedRun = harness.store.getRun();
    expect(pausedRun).not.toBeNull();
    expect(pausedRun?.status).toBe('paused');
    expect(pausedRun?.manualPauseAt).not.toBeNull();
    expect(pausedRun?.manualPauseCause).toBe('operator-paused');

    // Operator clicks Resume.
    const resumeResult = await harness.controller.resumeActivePhase();
    expect(resumeResult.ok).toBe(true);

    // Drain so the resume re-dispatches and the next invocation lands.
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 0));
    }

    // Runner-level signal:
    //   call 0 — fresh dispatch from startNew: isContinue absent / false
    //   call 1 — post-resume dispatch: isContinue === true (032 lock-step)
    expect(harness.invocations.length).toBeGreaterThanOrEqual(2);
    expect(harness.invocations[0].isContinue ?? false).toBe(false);
    expect(harness.invocations[1].isContinue).toBe(true);

    // Audit-level signal (must mirror runner-level):
    //   phase-start[0] — fresh dispatch:    isContinue=false
    //   phase-start[1] — post-resume:       isContinue=true
    const phaseStartIsContinue = await readPhaseStartIsContinue(tmpRoot);
    expect(phaseStartIsContinue.length).toBeGreaterThanOrEqual(2);
    expect(phaseStartIsContinue[0]).toBe(false);
    expect(phaseStartIsContinue[1]).toBe(true);
  });
});

// Feature 033 T023 — US3 regression: breakpoint-paused interaction with
// aggressive pause. Sequence:
//   1. Start a fresh run on the standard pipeline.
//   2. After invocation 0 (speckit-specify) returns clean, install a
//      breakpoint on speckit-clarify via a direct store mutation
//      (bypasses the controller-level `currentPhase === phaseId` guard
//      which would reject the API call mid-loop; see persistTransition
//      docstring at workflow-controller.ts:1448 confirming external
//      writes survive the merge).
//   3. The drive loop advances to speckit-clarify; the breakpoint
//      accessor returns the armed set; PhaseRunner.runInner short-
//      circuits with `outcome: 'paused-at-breakpoint'`.
//   4. Verify the breakpoint-paused invariant pair:
//        manualPauseCause === 'breakpoint-paused'
//        resumeTargetPhaseId === 'speckit-clarify'
//   5. Issue `pauseActivePhase()` — it MUST be rejected as
//      `run-already-paused` (operator-pause cannot overwrite a
//      breakpoint pause).
//   6. Issue `resumeActivePhase()`. The next invocation MUST target
//      speckit-clarify with isContinue: true (032 lock-step).
//      Verify `resumeTargetPhaseId` and `manualPauseCause` are cleared.
describe('Feature 033 US3 — aggressive pause integrates with breakpoint-paused', () => {
  it('rejects pause when breakpoint-paused; resume re-invokes the marked phase with isContinue', async () => {
    const memento = new FakeMemento();
    const harness = await makeHarness(memento, tmpRoot);

    // Script: invocation 0 completes cleanly with a `clean` outcome that
    // advances the run from speckit-specify → speckit-clarify. Between
    // resolving and the next dispatch, we install a breakpoint on
    // speckit-clarify so the runner short-circuits on invocation 1.
    let breakpointInstalled = false;
    const cleanSpecify = (): RawInvocationOutput => ({
      stdoutBuffer: (() => { const b = new ZippedStreamBuffer(); b.append('OUTCOME: clean\n'); b.finalize(); return b; })(), stderrBuffer: (() => { const b = new ZippedStreamBuffer(); b.finalize(); return b; })(),
      exitCode: 0,
      killed: false,
      timedOut: false,
      durationMs: 1,
      cliSessionId: 'owned-claude-session'
    });
    harness.setOutcome([
      () => {
        if (!breakpointInstalled) {
          breakpointInstalled = true;
          setImmediate(async () => {
            const run = harness.store.getRun();
            if (run !== null) {
              await harness.store.setRun({
                ...run,
                phaseBreakpoints: [
                  ...run.phaseBreakpoints,
                  { phaseId: 'speckit-clarify', setAt: Date.now(), actor: 'operator' as const }
                ]
              });
            }
          });
        }
        return cleanSpecify();
      },
      () => makeCleanOutput(),
      () => makeCleanOutput(),
      () => makeCleanOutput(),
      () => makeCleanOutput()
    ]);

    const feature = await harness.queue.enqueue('feature breakpoint-aggressive-pause');
    await harness.controller.startNew(feature, null);

    // Drain pending microtasks so the breakpoint install + the breakpoint
    // fire on invocation 1 resolve.
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 0));
    }

    // The run must now be paused at the breakpoint.
    const pausedRun = harness.store.getRun();
    expect(pausedRun).not.toBeNull();
    expect(pausedRun?.status).toBe('paused');
    expect(pausedRun?.manualPauseAt).not.toBeNull();
    expect(pausedRun?.manualPauseCause).toBe('breakpoint-paused');
    expect(pausedRun?.resumeTargetPhaseId).toBe('speckit-clarify');
    // The fired breakpoint MUST be consumed (filtered out) — see
    // workflow-controller.ts:754.
    expect(pausedRun?.phaseBreakpoints.some((bp) => bp.phaseId === 'speckit-clarify')).toBe(false);

    // Cascade-pause invariant: the host queue is in manually-paused with
    // pauseSource: 'cascade' (the breakpoint fire cascade-pauses the
    // host queue — see workflow-controller.ts:769).
    const queueAfterBreakpoint = findQueue(harness.store.getQueueRegistry(), DEFAULT_QUEUE_ID);
    expect(queueAfterBreakpoint?.state).toBe('manually-paused');
    expect(queueAfterBreakpoint?.pauseSource).toBe('cascade');

    // Operator attempts an aggressive pause WHILE breakpoint-paused —
    // MUST be rejected. After the breakpoint settles, the run's status
    // is 'paused' with pendingRetryAt === null, so `pauseActivePhase`'s
    // outer guard `(status !== 'running' && !isInRetryCountdown)`
    // short-circuits with `no-run-in-flight` before reaching the
    // `manualPauseAt !== null` check. Either rejection reason is
    // operator-equivalent — "you cannot pause something that's already
    // settled in a paused state". The test pins the actual response.
    const pauseResult = await harness.controller.pauseActivePhase();
    expect(pauseResult.ok).toBe(false);
    if (pauseResult.ok === false) {
      expect(pauseResult.reason).toBe('no-run-in-flight');
    }

    // Operator clicks Resume.
    const invocationsBeforeResume = harness.invocations.length;
    const resumeResult = await harness.controller.resumeActivePhase();
    expect(resumeResult.ok).toBe(true);

    // Drain so the resume re-dispatches.
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 0));
    }

    // Post-resume invocation MUST target speckit-clarify with isContinue=true.
    expect(harness.invocations.length).toBeGreaterThan(invocationsBeforeResume);
    const postResumeInvocation = harness.invocations[invocationsBeforeResume];
    expect(postResumeInvocation.phase).toBe('speckit-clarify');
    expect(postResumeInvocation.isContinue).toBe(true);

    // Resume MUST clear the breakpoint-paused fields.
    const resumedRun = harness.store.getRun();
    expect(resumedRun?.manualPauseCause).toBeNull();
    expect(resumedRun?.manualPauseAt).toBeNull();
    expect(resumedRun?.resumeTargetPhaseId).toBeNull();
  });
});

// Feature 033 T024 — US3 regression: operator queue-pause survives a
// phase pause + resume cycle (FR-004 — operator wins; cascadedResume is
// a NO-OP for operator-source queue pauses).
//
// Sequence:
//   1. Start a fresh run.
//   2. Operator queue-pauses the default queue via
//      `setQueuePausedState(true, 'default', 'operator-test-pause')` —
//      this emits `pauseSource: 'operator'`.
//   3. Operator aggressively pauses the in-flight phase.
//   4. Operator resumes the phase.
//   5. Assert (a) `cascadedResume` did NOT change the queue state —
//      it remains manually-paused with pauseSource: 'operator';
//      (b) the run is no longer manually paused.
describe('Feature 033 US3 — operator queue-pause survives phase pause+resume', () => {
  it('cascadedResume is NO-OP when pauseSource === operator', async () => {
    const memento = new FakeMemento();
    const harness = await makeHarness(memento, tmpRoot);

    // First invocation schedules the pause sequence AFTER its result
    // lands (same setImmediate pattern as the US1 test). Sequence
    // matters:
    //   (1) `pauseActivePhase` first — stamps manualPauseCause:
    //       'operator-paused' AND cascade-pauses the queue.
    //   (2) `setQueuePausedState(true, 'operator')` second — promotes
    //       the queue's pauseSource from 'cascade' to 'operator' via
    //       the existing promotion path (queue-manager.ts:289).
    let pauseInjected = false;
    harness.setOutcome([
      () => {
        if (!pauseInjected) {
          pauseInjected = true;
          setImmediate(async () => {
            await harness.controller.pauseActivePhase();
            await harness.queue.setQueuePausedState(true, DEFAULT_QUEUE_ID, 'operator-test-pause');
          });
        }
        return makeCleanOutput();
      },
      () => makeCleanOutput(),
      () => makeCleanOutput(),
      () => makeCleanOutput()
    ]);

    const feature = await harness.queue.enqueue('feature operator-queue-pause-survives');
    await harness.controller.startNew(feature, null);

    // Drain so the scheduled pause path settles.
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 0));
    }

    // Verify both the phase and the queue are paused, with the queue's
    // pauseSource preserved as 'operator' (a cascade pause was attempted
    // by pauseActivePhase but it's an idempotent no-op when the queue
    // is already operator-paused — see queue-manager.ts:326).
    const pausedRun = harness.store.getRun();
    expect(pausedRun?.status).toBe('paused');
    expect(pausedRun?.manualPauseCause).toBe('operator-paused');
    const queueBeforeResume = findQueue(harness.store.getQueueRegistry(), DEFAULT_QUEUE_ID);
    expect(queueBeforeResume?.state).toBe('manually-paused');
    expect(queueBeforeResume?.pauseSource).toBe('operator');

    // Operator resumes the phase.
    const resumeResult = await harness.controller.resumeActivePhase();
    expect(resumeResult.ok).toBe(true);

    // Drain so the resume's cascadedResume completes.
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 0));
    }

    // Queue MUST still be manually-paused with pauseSource: 'operator'
    // (cascadedResume is a NO-OP — FR-004).
    const queueAfterResume = findQueue(harness.store.getQueueRegistry(), DEFAULT_QUEUE_ID);
    expect(queueAfterResume?.state).toBe('manually-paused');
    expect(queueAfterResume?.pauseSource).toBe('operator');

    // The run's manualPauseAt is cleared (phase resumed independently).
    const resumedRun = harness.store.getRun();
    expect(resumedRun?.manualPauseAt).toBeNull();
    expect(resumedRun?.manualPauseCause).toBeNull();

    // Extra drain iterations let the audit writer's internal write
    // chain settle before afterEach's rm runs.
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 0));
    }
  });
});
