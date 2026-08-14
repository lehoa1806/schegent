// Feature 092 (T134, BUG-002) — the window-primacy lease's lifetime.
//
// `WorkspaceLockManager` is the per-workspace *window-primacy* lease: one holder
// per workspace, which is what makes `isPrimary` mean anything. Its tenure is
// activation-to-disposal — `extension.ts` acquires it at activation and releases
// it at `dispose()`.
//
// `RunDriver.drive()` wrapped its whole body in `withLock('drive-run', …)`.
// `withLock` acquires idempotently for the same owner and keeps no reference
// count, so with two Runs in one window the FIRST one to finish releases
// primacy for BOTH — and for the window itself
// (specs/092-multi-queue-concurrency/bugs/BUG-002.md). Drain step 4b hides this
// today by refusing to start a second Run at all, which is why this file
// constructs the two scopes at the driver seam instead of through `drainAll()`:
// driven through the drain it would pass vacuously and prove nothing.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RunDriver } from '../../src/services/run-driver';
import type { RunDriverDeps } from '../../src/services/run-driver';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { WorkspaceLockManager, type Clock, type Scheduler } from '../../src/state/lock';
import { SanitizedLogger } from '../../src/lib/logger';
import type { PhaseRunOutput } from '../../src/controller/phase-runner';
import type { WorkflowRun } from '../../src/state/workflow-run';
import { DEFAULT_QUEUE_ID } from '../../src/queue/queue-registry';

const T0 = 1_700_000_000_000;

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

/**
 * Frozen so nothing here can pass by staleness reclaim: a window that lost
 * primacy has genuinely lost it, and a rival that re-acquires has genuinely
 * taken it rather than waited out `STALENESS_THRESHOLD_MS`.
 */
class FrozenClock implements Clock {
  now(): number {
    return T0;
  }
}

const noopScheduler: Scheduler = {
  setInterval() {
    return { clear() {} };
  }
};

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const CLEAN_PHASE_OUTPUT: PhaseRunOutput = {
  result: { kind: 'clean', auditEntry: null as never },
  outcome: 'clean',
  terminationReason: 'token',
  stdoutSummary: '',
  stderrSummary: '',
  exitCode: 0,
  warnings: [],
  auditEntryId: null
} as PhaseRunOutput;

function runFixture(id: string, featureId: string): WorkflowRun {
  return {
    id,
    featureId,
    startedAt: T0,
    updatedAt: T0,
    status: 'running',
    currentPhase: 'plan',
    currentIteration: 0,
    pipeline: {
      id: 'pipe-1',
      name: 'Pipe',
      phases: [{ id: 'plan', title: 'Plan', runner: 'claude', effort: 'normal' }]
    },
    phasesCompleted: [],
    pendingRetry: false,
    delayedRetryCount: 0,
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    phaseOverrides: [],
    resumeTargetPhaseId: null
  } as unknown as WorkflowRun;
}

/**
 * One driver, its own run-state store, sharing the caller's lock.
 *
 * Each driver gets a separate store on purpose. `KEYS.run` still holds a single
 * `WorkflowRun` (FR-008 guarantee 3 froze that), so two concurrent Runs in one
 * window would overwrite each other's row — an artifact of that key's shape and
 * not the subject here. Isolating it leaves exactly one shared variable across
 * the two drivers: the window-primacy lease.
 */
async function makeDriver(
  lock: WorkspaceLockManager,
  gate: Promise<void> | null
): Promise<{ driver: RunDriver; store: WorkspaceStateStore; entered: Promise<void> }> {
  const store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  const enteredSignal = deferred();

  const runner = {
    run: vi.fn(async () => {
      enteredSignal.resolve();
      if (gate) await gate;
      return CLEAN_PHASE_OUTPUT;
    }),
    abort: vi.fn(),
    appendCapExhaustedPhaseEnd: vi.fn().mockResolvedValue(undefined)
  };

  const deps: RunDriverDeps = {
    store,
    runner: runner as never,
    logger: new SanitizedLogger([]),
    options: { iterationCap: 5, cwd: '/test/cwd', cliPath: '/test/bin' } as never,
    monitor: null,
    retryCoordinator: {
      registerAttempt: vi.fn(),
      clear: vi.fn(),
      isRetryCapExhaustedOnNextFailure: vi.fn().mockReturnValue(false),
      handleDelayedRetry: vi.fn(),
      maybeEmitRetryRecovered: vi.fn().mockImplementation(async (r) => r)
    } as never,
    queue: { finish: vi.fn(), pause: vi.fn(), findById: vi.fn(() => null) } as never,
    notifier: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    statusBar: { update: vi.fn(), dispose: vi.fn() } as never,
    historyRecorder: { record: vi.fn() } as never,
    emitRunEndedBreakpointAudit: vi.fn(),
    emitTaskLifecycleAudit: vi.fn(),
    emitOptionalPhaseFailureContinued: vi.fn(),
    appendPhaseControlAudit: vi.fn(),
    appendRunnerProbeFailedAudit: vi.fn(),
    appendBreakpointAudit: vi.fn(),
    isContinueGate: { consume: vi.fn().mockReturnValue(false) } as never,
    lock,
    persistTransition: async (_oldRun, newRun) => {
      await store.setRun(DEFAULT_QUEUE_ID, newRun);
      return newRun;
    },
    scheduleAutoDrain: vi.fn()
  };

  return { driver: new RunDriver(deps), store, entered: enteredSignal.promise };
}

let lockMemento: FakeMemento;
let lock: WorkspaceLockManager;

beforeEach(async () => {
  // The lock's own store. Shared with the rival window below, because a rival is
  // a second process reading the same persisted `KEYS.lock`.
  lockMemento = new FakeMemento();
  const lockStore = new WorkspaceStateStore(lockMemento);
  await lockStore.initialize();
  lock = new WorkspaceLockManager(lockStore, 'window-a', new FrozenClock(), noopScheduler);
});

async function rivalWindow(): Promise<WorkspaceLockManager> {
  const store = new WorkspaceStateStore(lockMemento);
  await store.initialize();
  return new WorkspaceLockManager(store, 'window-b', new FrozenClock(), noopScheduler);
}

describe('feature 092 (T134, BUG-002, FR-032a, SC-013) — primacy outlives the first Run to finish', () => {
  it('keeps the window primary when one of two concurrent Runs terminates', async () => {
    // Activation (src/extension.ts:1157). This, not a Run, is what opens the
    // tenure.
    await expect(lock.tryAcquire()).resolves.toMatchObject({ acquired: true });

    const gate = deferred();
    const second = await makeDriver(lock, gate.promise);
    const first = await makeDriver(lock, null);

    // Park the second Run inside its scope, then run the first to completion.
    const secondDrive = second.driver.drive(runFixture('run-2', 'task-2'), 'second');
    await second.entered;
    await first.driver.drive(runFixture('run-1', 'task-1'), 'first');
    expect(first.store.getRun(DEFAULT_QUEUE_ID)?.currentPhase).toBe('done');

    // The first Run has ended. The second is still in flight, and the window is
    // still the window.
    expect(lock.isHeld()).toBe(true);

    // Both `isPrimary` producers `extension.ts` wires, evaluated as written.
    const isPrimaryFromHeld = () => lock.isHeld(); // extension.ts:672
    const isPrimaryFromForeign = () => !lock.isForeignLockHeld(); // extension.ts:936
    expect(isPrimaryFromHeld()).toBe(true);
    // Non-discriminating on its own — it asks whether a *foreign* holder exists,
    // so a self-inflicted release reads as "primary" either way. Asserted
    // because FR-032a covers both producers, not because it detects the defect.
    expect(isPrimaryFromForeign()).toBe(true);

    // The load-bearing consequence: with primacy dropped, a second window walks
    // in while this one is still running work. Asserted last — `tryAcquire`
    // writes.
    const rival = await rivalWindow();
    await expect(rival.tryAcquire()).resolves.toMatchObject({
      acquired: false,
      ownerId: 'window-a'
    });

    gate.resolve();
    await secondDrive;
    expect(second.store.getRun(DEFAULT_QUEUE_ID)?.currentPhase).toBe('done');
  });

  it('leaves the tenure to activation and disposal, so both Runs ending keeps it held', async () => {
    await lock.tryAcquire();

    const first = await makeDriver(lock, null);
    const second = await makeDriver(lock, null);
    await first.driver.drive(runFixture('run-1', 'task-1'), 'first');
    await second.driver.drive(runFixture('run-2', 'task-2'), 'second');

    // No Run is in flight, and primacy is still this window's: only `dispose()`
    // ends it (src/extension.ts:1181). A Run finishing is not a disposal.
    expect(lock.isHeld()).toBe(true);
    const rival = await rivalWindow();
    await expect(rival.tryAcquire()).resolves.toMatchObject({ acquired: false });

    // And disposal still works.
    await lock.release();
    expect(lock.isHeld()).toBe(false);
    const successor = await rivalWindow();
    await expect(successor.tryAcquire()).resolves.toMatchObject({ acquired: true });
  });
});
