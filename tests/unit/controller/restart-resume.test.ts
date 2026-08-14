// Feature 011 — FR-013: restart handshake.
//
// pendingRetryAt persists across "restart" (re-initialize store); past
// deadline resumes on next tick; future deadline re-arms watchdog with
// `durationOverrideMs`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
import { TRANSIENT_BACKOFF_MS } from '../../../src/controller/retry-constants';
import { DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';

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
};

function makeController(
  memento: FakeMemento,
  watchdog: {
    pauseAndPoll: ReturnType<typeof vi.fn>;
    cancelPendingTimer: ReturnType<typeof vi.fn>;
  }
): { controller: SchegentWorkflowController; store: WorkspaceStateStore } {
  const store = new WorkspaceStateStore(memento);
  const queue = new QueueManager(store);
  const phaseRunner = { run: vi.fn() } as unknown as PhaseRunner;
  const controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    makeStatusBar(),
    makeNotifier(),
    new SanitizedLogger(),
    makeLock(),
    opts,
    { watchdog: watchdog as unknown as DelayedRetryWatchdog }
  );
  return { controller, store };
}

let memento: FakeMemento;
let watchdog: {
  pauseAndPoll: ReturnType<typeof vi.fn>;
  cancelPendingTimer: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  memento = new FakeMemento();
  const pauseAndPoll = vi.fn();
  pauseAndPoll.mockImplementation(async () => {});
  watchdog = {
    pauseAndPoll,
    cancelPendingTimer: vi.fn()
  };
});

function persistRunWithPendingRetry(
  memento: FakeMemento,
  pendingRetryAt: number | null
): WorkflowRun {
  const run: WorkflowRun = {
    id: 'run-1',
    featureId: 'feat-1',
    featureDir: '',
    status: 'paused',
    currentPhase: 'speckit-specify',
    currentIteration: 1,
    startedAt: Date.now() - 60_000,
    lastTransitionAt: Date.now() - 60_000,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 1,
    pendingRetryAt,
    pendingRetryCause: pendingRetryAt !== null ? 'transient_error' : null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null
  };
  void memento.update('schegent.run', run);
  return run;
}

describe('FR-013 — restart handshake for pendingRetryAt', () => {
  it('pendingRetryAt persists across store re-initialization', async () => {
    const futureMs = Date.now() + TRANSIENT_BACKOFF_MS;
    persistRunWithPendingRetry(memento, futureMs);

    // Re-initialize the store (simulates VS Code restart).
    const { store } = makeController(memento, watchdog);
    await store.initialize();
    const reloaded = store.getRun(DEFAULT_QUEUE_ID);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.pendingRetryAt).toBe(futureMs);
    expect(reloaded!.pendingRetryCause).toBe('transient_error');
    expect(reloaded!.delayedRetryCount).toBe(1);
  });

  it('future deadline re-arms watchdog with delay = pendingRetryAt - now', async () => {
    const delayMs = 90_000; // 90 seconds out
    const futureMs = Date.now() + delayMs;
    persistRunWithPendingRetry(memento, futureMs);

    const { controller, store } = makeController(memento, watchdog);
    await store.initialize();

    await controller.resumeExistingFromActivation();

    expect(watchdog.pauseAndPoll).toHaveBeenCalledTimes(1);
    const call = watchdog.pauseAndPoll.mock.calls[0];
    expect(call[0]).toBe('transient_error');
    expect(call[1]).toEqual(
      expect.objectContaining({
        skipStatusCheck: true
      })
    );
    const override = (call[1] as { durationOverrideMs: number }).durationOverrideMs;
    // Allow ~50ms slack for clock drift.
    expect(override).toBeGreaterThanOrEqual(delayMs - 100);
    expect(override).toBeLessThanOrEqual(delayMs + 100);
  });

  it('past deadline resumes on next tick (no watchdog re-arm)', async () => {
    const pastMs = Date.now() - 60_000;
    persistRunWithPendingRetry(memento, pastMs);

    const { controller, store } = makeController(memento, watchdog);
    await store.initialize();

    await controller.resumeExistingFromActivation();

    // Past-deadline path uses setImmediate(resumeExisting), NOT
    // watchdog.pauseAndPoll.
    expect(watchdog.pauseAndPoll).not.toHaveBeenCalled();
  });

  it('no-op when run has no pendingRetryAt', async () => {
    const { controller, store } = makeController(memento, watchdog);
    await store.initialize();

    await controller.resumeExistingFromActivation();

    expect(watchdog.pauseAndPoll).not.toHaveBeenCalled();
  });
});
