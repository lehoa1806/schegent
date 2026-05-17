// Feature 028 — Cascade-pause unit tests for the SchegentWorkflowController.
//
// pauseActivePhase: phase-pause cascades to host queue → `pauseSource: 'cascade'`.
// resumeActivePhase: clears the cascade pause but leaves an operator-pause intact.
// Operator-pause wins: a pre-existing operator pause is NOT demoted to cascade
// when a phase pause subsequently fires (FR-004 / FR-005).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
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

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  queue = new QueueManager(store);
  phaseRunner = { run: vi.fn() } as unknown as PhaseRunner;
  controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    makeStatusBar(),
    makeNotifier(),
    new SanitizedLogger(),
    makeLock(),
    opts
  );
});

async function seedInFlightRun(
  queueId: string = DEFAULT_QUEUE_ID
): Promise<{ feature: { id: string }; run: WorkflowRun }> {
  const feature = await queue.enqueue('feature description', { queueId });
  await queue.markInFlight(feature.id, 'run-cascade-1');
  const now = Date.now();
  const run: WorkflowRun = {
    id: 'run-cascade-1',
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

describe('SchegentWorkflowController — cascade-pause integration (Feature 028, US1)', () => {
  it('pauseActivePhase cascades to the host queue with pauseSource = "cascade"', async () => {
    await seedInFlightRun(DEFAULT_QUEUE_ID);

    const result = await controller.pauseActivePhase();

    expect(result).toEqual({ ok: true });
    const persisted = store.getRun()!;
    expect(persisted.manualPauseAt).not.toBeNull();
    expect(persisted.manualPauseCause).toBe('operator-paused');
    const entry = findQueue(store.getQueueRegistry(), DEFAULT_QUEUE_ID);
    expect(entry?.state).toBe('manually-paused');
    expect(entry?.pauseSource).toBe('cascade');
  });

  it('resumeActivePhase clears the cascade pause it installed', async () => {
    await seedInFlightRun(DEFAULT_QUEUE_ID);

    await controller.pauseActivePhase();
    let entry = findQueue(store.getQueueRegistry(), DEFAULT_QUEUE_ID);
    expect(entry?.pauseSource).toBe('cascade');

    const resumed = await controller.resumeActivePhase();
    expect(resumed).toEqual({ ok: true });

    entry = findQueue(store.getQueueRegistry(), DEFAULT_QUEUE_ID);
    expect(entry?.state).toBe('active');
    expect(entry?.pauseSource).toBeNull();
    const run = store.getRun()!;
    expect(run.manualPauseAt).toBeNull();
    expect(run.manualPauseCause).toBeNull();
  });

  it('resumeActivePhase leaves an operator queue-pause intact (FR-004)', async () => {
    await seedInFlightRun(DEFAULT_QUEUE_ID);

    // Cascade pauses the queue via phase pause.
    await controller.pauseActivePhase();
    let entry = findQueue(store.getQueueRegistry(), DEFAULT_QUEUE_ID);
    expect(entry?.pauseSource).toBe('cascade');

    // Operator independently pauses the queue while the phase is paused —
    // promotes the source to 'operator'. (Idempotent: explicit operator
    // pause-during-cascade promotion is the contract from FR-005.)
    const opPause = await queue.setQueuePausedState(true, DEFAULT_QUEUE_ID, 'operator-action');
    expect(opPause.ok).toBe(true);
    entry = findQueue(store.getQueueRegistry(), DEFAULT_QUEUE_ID);
    expect(entry?.pauseSource).toBe('operator');

    // Resuming the phase MUST NOT auto-resume the operator-paused queue.
    const resumed = await controller.resumeActivePhase();
    expect(resumed).toEqual({ ok: true });
    entry = findQueue(store.getQueueRegistry(), DEFAULT_QUEUE_ID);
    expect(entry?.state).toBe('manually-paused');
    expect(entry?.pauseSource).toBe('operator');
  });

  it('cascadedPause is a no-op when the queue is already operator-paused (operator wins)', async () => {
    await seedInFlightRun(DEFAULT_QUEUE_ID);

    // Operator pauses the queue first.
    await queue.setQueuePausedState(true, DEFAULT_QUEUE_ID, 'first');
    let entry = findQueue(store.getQueueRegistry(), DEFAULT_QUEUE_ID);
    expect(entry?.pauseSource).toBe('operator');

    // Now pause the active phase. Cascade attempts to pause, but the queue
    // is already operator-paused → pauseSource stays 'operator'.
    // (manualPauseCause on the matching run flips to 'queue-paused-mid-run'
    // when setQueuePausedState fires; pauseActivePhase then attempts to
    // operate on a run whose manualPauseAt is non-null — covered by the
    // existing `run-already-paused` reject path. Here we exercise the
    // pure cascade-only path by clearing the run's pause first.)
    const run = store.getRun()!;
    await store.setRun({ ...run, manualPauseAt: null, manualPauseCause: null });

    await queue.cascadedPause(DEFAULT_QUEUE_ID);
    entry = findQueue(store.getQueueRegistry(), DEFAULT_QUEUE_ID);
    expect(entry?.state).toBe('manually-paused');
    expect(entry?.pauseSource).toBe('operator');
  });
});
