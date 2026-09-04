// Feature 201 (T032, US3, FR-019, FR-020) — deleting a Phase of a Task that
// does not exist is refused for the reason that is true, at the layer that can
// see it.
//
// `WorkflowController#removeTaskPhase` resolves the Task's queue and hands the
// pair to the service. The resolver it used, `queueIdForTask`, is *lenient*:
// `store.getRequest(taskId)?.queueId ?? DEFAULT_QUEUE_ID` (queue-manager.ts).
// So an id naming no request row at all resolved to the default queue, and the
// service then compared it against whatever that queue happened to be running.
// If the queue was idle the operator got `no-run-in-flight` — a statement about
// a queue they never named. If it was busy with something else they got a
// refusal about a Run that is not theirs. Neither says "there is no such Task".
//
// The strict sibling `queueIdForExistingTask` answers `null` for a row that
// does not exist, and `null` is the fact the lenient one throws away. The
// existence question therefore belongs here and only here: the service is
// handed a queue id and cannot tell a guessed one from a real one.
//
// Why a real `QueueManager` and `WorkspaceStateStore` rather than mocks: the
// whole subject is which of two resolvers runs against real request rows, and
// a mocked resolver would be the test asserting its own fixture.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import { QueueManager } from '../../../src/queue/queue-manager';
import type { PhaseRunner } from '../../../src/controller/phase-runner';
import type { SchegentStatusBar } from '../../../src/ui/status-bar';
import type { Notifier } from '../../../src/ui/notifications';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { WorkspaceLockManager } from '../../../src/state/lock';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import { SPECKIT_ALL_PHASE_DEFS } from '../../fixtures/speckit-catalog-fixture';
import type { Memento } from '../../../src/state/workspace-state';
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

const PIPELINE = Object.freeze({
  id: 'speckit-new-feature',
  name: 'Spec-kit New Feature',
  phases: Object.freeze(
    ['speckit-specify', 'speckit-clarify', 'speckit-plan'].map((id) =>
      Object.freeze(SPECKIT_ALL_PHASE_DEFS.find((phase) => phase.id === id)!)
    )
  )
});

const NOW = Date.parse('2026-09-05T12:00:00.000Z');

let memento: FakeMemento;
let store: WorkspaceStateStore;
let queue: QueueManager;
let controller: SchegentWorkflowController;

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  queue = new QueueManager(store);
  controller = new SchegentWorkflowController(
    { run: vi.fn(), evictStagnationTracker: vi.fn() } as unknown as PhaseRunner,
    store,
    queue,
    { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier,
    new SanitizedLogger(),
    {
      release: vi.fn(async () => {}),
      tryAcquire: vi.fn(),
      heartbeat: vi.fn(),
      isHeld: vi.fn(),
      ownerOfRecord: vi.fn(),
      id: 'this-window'
    } as unknown as WorkspaceLockManager,
    { cliPath: 'claude', cwd: '/repo', iterationCap: 5, timeoutMs: 5_000 },
    { auditWriter: { append: async (entry) => ({ ...entry, id: 'a', timestamp: '' }) as never } }
  );
  const driver = (controller as unknown as {
    sessions: { acquire: (id: string) => { driver: Record<string, unknown> } };
  }).sessions.acquire(DEFAULT_QUEUE_ID).driver;
  vi.spyOn(driver as never, 'noteActivePhaseOverrideAbort').mockImplementation(() => undefined);
  (controller as unknown as { cancelActive: unknown }).cancelActive = vi.fn();
  (controller as unknown as { resumeExisting: unknown }).resumeExisting = vi.fn(async () => {});
});

/** A real request row with a real Run on the default queue. */
async function seedRun(): Promise<WorkflowRun> {
  const feature = await queue.enqueue('deletion refusal feature');
  await queue.markInFlight(feature.id, 'run-del-1');
  const run: WorkflowRun = {
    id: 'run-del-1',
    featureId: feature.id,
    featureDir: 'specs/201-existing',
    status: 'running',
    currentPhase: 'speckit-clarify',
    currentIteration: 1,
    startedAt: NOW,
    lastTransitionAt: NOW,
    phasesCompleted: [],
    lastError: null,
    pipeline: PIPELINE,
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
  return run;
}

describe('WorkflowController#removeTaskPhase — the Task id is checked before the queue', () => {
  it('refuses unknown-task-id for an id naming no request row, on an idle default queue', async () => {
    // No `seedRun()`: the default queue exists and is idle. Under the lenient
    // resolver the unknown id resolved *to* that queue and the service
    // answered `no-run-in-flight` — a true statement about a queue the
    // operator never addressed, and a false implication that their Task is
    // real and merely not running.
    expect(await controller.removeTaskPhase('task-that-never-existed', 'speckit-plan')).toEqual({
      ok: false,
      reason: 'unknown-task-id'
    });
  });

  it('refuses unknown-task-id even when the default queue is busy with a real Run', async () => {
    // The other half, and the one the idle case cannot reach: with a Run in
    // flight the lenient resolver's guess lands on a live queue, so the id
    // reached the service pointed at real state and came back as a refusal
    // about a Run that has nothing to do with the request. The strict resolver
    // never gets that far.
    const run = await seedRun();
    expect(await controller.removeTaskPhase('task-that-never-existed', 'speckit-plan')).toEqual({
      ok: false,
      reason: 'unknown-task-id'
    });

    // NON-VACUITY: the same call on the real Task id is accepted, so the
    // refusal above is about the id and not about the fixture being unable to
    // delete anything.
    expect(await controller.removeTaskPhase(run.featureId, 'speckit-plan')).toMatchObject({
      ok: true
    });
  });

  it('a known Task whose queue is running a different Run is refused for a different reason', async () => {
    // FR-018 — the distinction the single `unknown-task-id` reason collapsed.
    // Both ids below are known; only the second is what the addressed queue is
    // actually running. The first must NOT be told its Task is unknown,
    // because it is not.
    const enqueuedFirst = await queue.enqueue('the task that is not running');
    await seedRun();

    expect(await controller.removeTaskPhase(enqueuedFirst.id, 'speckit-plan')).toEqual({
      ok: false,
      reason: 'no-active-run-for-task'
    });
  });
});
