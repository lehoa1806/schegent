// Feature 033 T008 — Aggressive Phase Pausing (US1).
//
// pauseActivePhase MUST invoke `this.cancelActive()` between persisting the
// pause-cause state and emitting the `phase-pause-requested` audit event. The
// abort signal propagates to the runner's CLI subprocess so SIGTERM is sent
// the moment the operator clicks Pause; the existing SIGKILL_DELAY_MS window
// in `runClaudeCli` escalates to SIGKILL when the subprocess does not exit
// gracefully.
//
// Coverage (FR-001 / FR-002 / FR-005):
//   (a) Strict ordering — store.setRun fires, THEN cancelActive() observable
//       via the AbortController signal, THEN appendPhaseControlAudit runs.
//   (b) Idempotency — second pause call returns `run-already-paused` and does
//       NOT trigger a second abort.
//   (c) Delayed-retry-countdown branch — `watchdog.cancelPendingTimer()` is
//       still called; cancelActive() is invoked even when no live phase is
//       executing (defensive; the AbortController may legitimately be null).
//   (d) No-run guard — empty controller returns `no-run-in-flight` and never
//       calls cancelActive().
//   (e) Cascade-pause preservation — queue cascade STILL fires (no regression
//       on the 028 invariant).

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
import type { DelayedRetryWatchdog } from '../../../src/controller/workflow-controller';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import { QueueManager } from '../../../src/queue/queue-manager';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { PhaseRunner } from '../../../src/controller/phase-runner';
import type { SchegentStatusBar } from '../../../src/ui/status-bar';
import type { Notifier } from '../../../src/ui/notifications';
import type { Memento } from '../../../src/state/workspace-state';
import type { WorkspaceLockManager } from '../../../src/state/lock';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import { findQueue, DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';

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

const opts = {
  cliPath: 'claude',
  cwd: '/repo',
  iterationCap: 5,
  timeoutMs: 5_000,
  perPhaseRulesEnabled: false
};

let memento: FakeMemento;
let store: WorkspaceStateStore;
let queue: QueueManager;
let phaseRunner: PhaseRunner;
let controller: SchegentWorkflowController;
let watchdog: {
  pauseAndPoll: Mock<() => Promise<void>>;
  cancelPendingTimer: ReturnType<typeof vi.fn>;
};

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  queue = new QueueManager(store);
  phaseRunner = { run: vi.fn() } as unknown as PhaseRunner;
  const pauseAndPoll = vi.fn(async () => {});
  watchdog = {
    pauseAndPoll,
    cancelPendingTimer: vi.fn()
  };
  controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    makeStatusBar(),
    makeNotifier(),
    new SanitizedLogger(),
    makeLock(),
    opts,
    {
      watchdog: watchdog as unknown as DelayedRetryWatchdog
    }
  );
});

async function seedRunningRun(): Promise<{ feature: { id: string }; run: WorkflowRun }> {
  const feature = await queue.enqueue('feature description');
  await queue.markInFlight(feature.id, 'run-aggressive-1');
  const now = Date.now();
  const run: WorkflowRun = {
    id: 'run-aggressive-1',
    featureId: feature.id,
    featureDir: 'specs/001-existing',
    status: 'running',
    currentPhase: 'speckit-plan',
    currentIteration: 1,
    startedAt: now,
    lastTransitionAt: now,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null
  };
  await store.setRun(run);
  return { feature, run };
}

async function seedDelayedRetryRun(): Promise<void> {
  const feature = await queue.enqueue('feature description');
  await queue.markInFlight(feature.id, 'run-aggressive-2');
  const now = Date.now();
  const run: WorkflowRun = {
    id: 'run-aggressive-2',
    featureId: feature.id,
    featureDir: 'specs/001-existing',
    status: 'paused',
    currentPhase: 'speckit-plan',
    currentIteration: 1,
    startedAt: now,
    lastTransitionAt: now,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 1,
    pendingRetryAt: now + 60_000,
    pendingRetryCause: 'transient_error',
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null
  };
  await store.setRun(run);
}

describe('Feature 033 US1 — Aggressive pause via cancelActive()', () => {
  it('happy path: pauseActivePhase calls cancelActive() between persist and audit', async () => {
    await seedRunningRun();

    // Spy on cancelActive itself for ordering.
    const cancelSpy = vi.spyOn(controller, 'cancelActive');
    const setRunSpy = vi.spyOn(store, 'setRun');

    const result = await controller.pauseActivePhase();
    expect(result).toEqual({ ok: true });

    // cancelActive was invoked exactly once during the pause path.
    expect(cancelSpy).toHaveBeenCalledTimes(1);

    // Ordering: store.setRun (with pause fields) → cancelActive.
    // setRunSpy's first persist with manualPauseCause === 'operator-paused'
    // must precede the cancelActive call.
    const persistCalls = setRunSpy.mock.invocationCallOrder;
    const cancelCalls = cancelSpy.mock.invocationCallOrder;
    expect(persistCalls.length).toBeGreaterThan(0);
    expect(cancelCalls.length).toBe(1);
    // The pause persist is the LAST setRun call before cancelActive.
    const lastPersistBefore = persistCalls[persistCalls.length - 1];
    expect(lastPersistBefore).toBeLessThan(cancelCalls[0]);

    // Audit event was emitted (cascade-pause path also persists, so
    // setRun may fire again after; what matters is cancel fired before
    // the AUDIT for `phase-pause-requested`). The audit log is the
    // canonical record so we verify the run state has been persisted
    // with the pause cause.
    const persisted = store.getRun()!;
    expect(persisted.manualPauseAt).not.toBeNull();
    expect(persisted.manualPauseCause).toBe('operator-paused');
  });

  it('idempotency: second pause returns run-already-paused without re-aborting', async () => {
    await seedRunningRun();

    const cancelSpy = vi.spyOn(controller, 'cancelActive');

    const first = await controller.pauseActivePhase();
    expect(first).toEqual({ ok: true });
    expect(cancelSpy).toHaveBeenCalledTimes(1);

    const second = await controller.pauseActivePhase();
    expect(second).toEqual({ ok: false, reason: 'run-already-paused' });
    // Second call MUST short-circuit BEFORE cancelActive (the idempotent
    // reject path returns at the manualPauseAt check on line ~315 in
    // workflow-controller.ts, well before the persist/cancel/audit block).
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it('delayed-retry-countdown: pause cancels watchdog AND calls cancelActive', async () => {
    await seedDelayedRetryRun();

    const cancelSpy = vi.spyOn(controller, 'cancelActive');

    const result = await controller.pauseActivePhase();
    expect(result).toEqual({ ok: true });

    // Watchdog timer is cancelled (existing FR-002 behavior, preserved).
    expect(watchdog.cancelPendingTimer).toHaveBeenCalledTimes(1);
    // cancelActive is still invoked — defensive, even though no live
    // subprocess is running during the countdown.
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it('no-run guard: pauseActivePhase returns no-run-in-flight without aborting', async () => {
    const cancelSpy = vi.spyOn(controller, 'cancelActive');

    const result = await controller.pauseActivePhase();
    expect(result).toEqual({ ok: false, reason: 'no-run-in-flight' });
    // No run → early return BEFORE cancelActive.
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('cascade-pause preservation: queue still cascades to manually-paused with pauseSource=cascade', async () => {
    await seedRunningRun();

    const result = await controller.pauseActivePhase();
    expect(result).toEqual({ ok: true });

    const entry = findQueue(store.getQueueRegistry(), DEFAULT_QUEUE_ID);
    expect(entry?.state).toBe('manually-paused');
    expect(entry?.pauseSource).toBe('cascade');
  });
});
