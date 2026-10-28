// Feature 011 — FR-013: restart handshake.
//
// pendingRetryAt persists across "restart" (re-initialize store); a past
// deadline is handed on as a `backoff-elapsed` wakeup (FR-R4-F02, U2 G6); a
// future deadline re-arms the retry coordinator's own timer for the time left.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
import { RecordingDeadlineTimer } from '../../recording-deadline-timer';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import { QueueManager } from '../../../src/queue/queue-manager';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { PhaseRunner } from '../../../src/controller/phase-runner';
import type { SchegentStatusBar } from '../../../src/ui/status-bar';
import type { Notifier } from '../../../src/ui/notifications';
import type { Memento } from '../../../src/state/workspace-state';
import type { WorkspaceLockManager } from '../../../src/state/lock';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import { TRANSIENT_BACKOFF_MS } from '../../../src/contracts/retry-bounds';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';

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
  deadlineTimer: RecordingDeadlineTimer
): { controller: SchegentWorkflowController; store: WorkspaceStateStore } {
  const store = new WorkspaceStateStore(memento);
  const queue = new QueueManager(store);
  const phaseRunner = { run: vi.fn(), evictStagnationTracker: vi.fn() } as unknown as PhaseRunner;
  const controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    makeStatusBar(),
    makeNotifier(),
    new SanitizedLogger(),
    makeLock(),
    opts,
    { deadlineTimer }
  );
  return { controller, store };
}

let memento: FakeMemento;
let deadlineTimer: RecordingDeadlineTimer;

beforeEach(() => {
  memento = new FakeMemento();
  deadlineTimer = new RecordingDeadlineTimer();
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
  // The Task row the Run addresses. It used to be left out, which made this a
  // workspace holding a Run whose Task exists in no queue — a state the runtime
  // cannot reach (a Run in retry backoff is a queued Task waiting to resume) and
  // one the load-time orphan reconciler now ends on sight, clearing the very
  // `pendingRetryAt` this suite is about. Seeding the row is what the fixture
  // always meant.
  void memento.update('schegent.queue', {
    requests: [
      {
        id: 'feat-1',
        description: 'the task in retry backoff',
        addedAt: 1,
        updatedAt: 1,
        status: 'in-flight',
        runId: 'run-1',
        retryCount: 1,
        attempts: [],
        phaseHistory: []
      }
    ],
    inFlightId: 'feat-1',
    paused: false,
    pausedReason: null,
    updatedAt: 1,
    queueLifecycle: 'running',
    pauseSource: null,
    scheduledStartAt: null,
    scheduledStartSource: null
  });
  return run;
}

describe('FR-013 — restart handshake for pendingRetryAt', () => {
  it('pendingRetryAt persists across store re-initialization', async () => {
    const futureMs = Date.now() + TRANSIENT_BACKOFF_MS;
    persistRunWithPendingRetry(memento, futureMs);

    // Re-initialize the store (simulates VS Code restart).
    const { store } = makeController(memento, deadlineTimer);
    await store.initialize();
    const reloaded = store.getRun(DEFAULT_QUEUE_ID);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.pendingRetryAt).toBe(futureMs);
    expect(reloaded!.pendingRetryCause).toBe('transient_error');
    expect(reloaded!.delayedRetryCount).toBe(1);
  });

  it('future deadline re-arms the retry timer with delay = pendingRetryAt - now', async () => {
    const delayMs = 90_000; // 90 seconds out
    const futureMs = Date.now() + delayMs;
    persistRunWithPendingRetry(memento, futureMs);

    const { controller, store } = makeController(memento, deadlineTimer);
    await store.initialize();

    await controller.resumeExistingFromActivation();

    expect(deadlineTimer.sets).toHaveLength(1);
    expect(controller.hasPendingDelayedRetry(DEFAULT_QUEUE_ID)).toBe(true);
    const override = deadlineTimer.sets[0].delayMs;
    // Allow ~50ms slack for clock drift.
    expect(override).toBeGreaterThanOrEqual(delayMs - 100);
    expect(override).toBeLessThanOrEqual(delayMs + 100);
  });

  it('past deadline is handed on as a backoff-elapsed wakeup (no timer armed)', async () => {
    const pastMs = Date.now() - 60_000;
    persistRunWithPendingRetry(memento, pastMs);

    const { controller, store } = makeController(memento, deadlineTimer);
    await store.initialize();
    const handler = vi.fn(async () => undefined);
    controller.setBackoffElapsedHandler(handler);

    await controller.resumeExistingFromActivation();

    // The elapsed deadline goes to the admission handler, not to a timer.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      cause: 'backoff-elapsed',
      queueId: DEFAULT_QUEUE_ID,
      deadline: pastMs
    });
    expect(deadlineTimer.sets).toHaveLength(0);
  });

  it('no-op when run has no pendingRetryAt', async () => {
    const { controller, store } = makeController(memento, deadlineTimer);
    await store.initialize();

    await controller.resumeExistingFromActivation();

    expect(deadlineTimer.sets).toHaveLength(0);
  });
});
