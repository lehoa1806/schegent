import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCancel } from '../../../src/commands/cancel';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import { QueueManager } from '../../../src/queue/queue-manager';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type { Notifier } from '../../../src/ui/notifications';
import type { WorkflowRun } from '../../../src/state/workflow-run';
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

function makeController(): SchegentWorkflowController {
  return { cancelActive: vi.fn() } as unknown as SchegentWorkflowController;
}

function makeAudit(): AuditLogWriter & { append: ReturnType<typeof vi.fn> } {
  return { append: vi.fn(async () => {}) } as unknown as AuditLogWriter & {
    append: ReturnType<typeof vi.fn>;
  };
}

function makeNotifier(): Notifier {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  } as unknown as Notifier;
}

// Feature 093 (T068b, FR-028) — `makeLock()` is gone with the dependency it
// stood in for. `runCancel` no longer takes a `WorkspaceLockManager`, so there
// is no longer a release to assert did not happen: the seam refuses to hand the
// command a lock at all, which is a stronger statement than a spy reading zero.
// The behavioral claim — a cancel leaves the window primary while a sibling Run
// is still executing — is asserted where two Runs actually exist, in
// tests/integration/concurrent-run-execution.test.ts (T068c).

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    featureId: 'feat-1',
    featureDir: 'specs/001-x',
    status: 'running',
    currentPhase: 'speckit-plan',
    currentIteration: 0,
    startedAt: 1_700_000_000_000,
    lastTransitionAt: 1_700_000_000_000,
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
    ...overrides
  };
}

let memento: FakeMemento;
let store: WorkspaceStateStore;
let queue: QueueManager;
let controller: SchegentWorkflowController;
let audit: AuditLogWriter & { append: ReturnType<typeof vi.fn> };
let notifier: Notifier;
let logger: SanitizedLogger;

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  queue = new QueueManager(store);
  controller = makeController();
  audit = makeAudit();
  notifier = makeNotifier();
  logger = new SanitizedLogger();
});

// Feature 093 (T068b) — this block was `lock release (BUG-005)` and asserted
// the opposite of what it now asserts. BUG-005 was filed when a Run's drive
// held window primacy through a `withLock` wrapper: a cancel that skipped the
// release left the workspace locked with nothing running, so "cancel releases
// the lock" was the fix. 092's T136 removed that wrapper and made primacy the
// window's for its whole lifetime, which inverted the sign — the release these
// tests pinned is now the defect, because `WorkspaceLockManager.release()`
// keeps no reference count and every Run in a window shares one owner id.
// The tests are kept for the cancel outcomes they always also asserted; only
// the lock clauses are gone, along with the lock itself.
describe('runCancel — palette path (no taskId)', () => {
  it('cancels the in-flight run and routes through the controller', async () => {
    const feature = await queue.enqueue('feature description');
    await queue.markInFlight(feature.id, 'run-1');
    await store.setRun(DEFAULT_QUEUE_ID, makeRun({ featureId: feature.id }));

    const result = await runCancel({ controller, store, queue, audit, notifier, logger });

    expect(result.ok).toBe(true);
    expect(controller.cancelActive).toHaveBeenCalledOnce();
    expect(store.getRun(DEFAULT_QUEUE_ID)!.status).toBe('canceled');
  });

  it('refuses when there is no run', async () => {
    const result = await runCancel({ controller, store, queue, audit, notifier, logger });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-active-run');
    expect(controller.cancelActive).not.toHaveBeenCalled();
    expect(notifier.info).toHaveBeenCalledWith(expect.stringContaining('no in-flight run'));
  });

  it('refuses when the persisted run is not running', async () => {
    await store.setRun(DEFAULT_QUEUE_ID, makeRun({ status: 'completed' }));

    const result = await runCancel({ controller, store, queue, audit, notifier, logger });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-active-run');
    expect(controller.cancelActive).not.toHaveBeenCalled();
    expect(notifier.info).toHaveBeenCalledWith(expect.stringContaining('no in-flight run'));
  });
});

describe('runCancel — sidebar path (taskId) — BUG-001', () => {
  it('rejects when no FeatureRequest matches the taskId', async () => {
    const result = await runCancel({
      controller,
      store,
      queue,
      audit,
      notifier,
      logger,
      taskId: 'does-not-exist'
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-found');
    expect(controller.cancelActive).not.toHaveBeenCalled();
  });

  it('rejects when the target FeatureRequest is terminal (canceled)', async () => {
    const feature = await queue.enqueue('terminal task');
    await queue.finish(feature.id, 'canceled');

    const result = await runCancel({
      controller,
      store,
      queue,
      audit,
      notifier,
      logger,
      taskId: feature.id
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('illegal-state');
    expect(controller.cancelActive).not.toHaveBeenCalled();
  });

  it('cancels a pending task without signaling the controller', async () => {
    const feature = await queue.enqueue('pending task');

    const result = await runCancel({
      controller,
      store,
      queue,
      audit,
      notifier,
      logger,
      taskId: feature.id
    });

    expect(result.ok).toBe(true);
    expect(queue.findById(feature.id)?.status).toBe('canceled');
    expect(controller.cancelActive).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'task-canceled',
        payload: expect.objectContaining({
          taskId: feature.id,
          reason: 'user-cancel-pending'
        })
      })
    );
  });

  it('cancels the matching in-flight task and routes through the controller', async () => {
    const feature = await queue.enqueue('in-flight task');
    await queue.markInFlight(feature.id, 'run-1');
    await store.setRun(DEFAULT_QUEUE_ID, makeRun({ id: 'run-1', featureId: feature.id }));

    const result = await runCancel({
      controller,
      store,
      queue,
      audit,
      notifier,
      logger,
      taskId: feature.id
    });

    expect(result.ok).toBe(true);
    expect(controller.cancelActive).toHaveBeenCalledOnce();
    expect(store.getRun(DEFAULT_QUEUE_ID)!.status).toBe('canceled');
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'task-canceled',
        payload: expect.objectContaining({
          taskId: feature.id,
          runId: 'run-1'
        })
      })
    );
  });

  it('cap=2 cross-queue: cancels the operator-selected task, not the singular active run', async () => {
    // Cap=2 simulation. With the legacy palette path the host resolves the
    // cancel target via the singular `store.getRun()` projection, which
    // would target featureA even when the operator clicked the row for
    // featureB. The new path resolves by `FeatureRequest.id` and targets
    // the row identity instead.
    const featureA = await queue.enqueue('queue-A task');
    await queue.markInFlight(featureA.id, 'run-A');
    await store.setRun(DEFAULT_QUEUE_ID, makeRun({ id: 'run-A', featureId: featureA.id }));

    const featureB = await queue.enqueue('queue-B task');
    // Simulate a second in-flight FeatureRequest (cap=2). Bypass capacity
    // by writing directly through the store the way the controller would
    // when global concurrency cap > 1.
    const snapshot = store.getQueue(DEFAULT_QUEUE_ID);
    await store.setQueue({
      ...snapshot,
      requests: snapshot.requests.map((r) =>
        r.id === featureB.id ? { ...r, status: 'in-flight' as const, runId: 'run-B' } : r
      )
    });

    const result = await runCancel({
      controller,
      store,
      queue,
      audit,
      notifier,
      logger,
      taskId: featureB.id
    });

    expect(result.ok).toBe(true);
    // featureB transitions to canceled; featureA stays in-flight.
    expect(queue.findById(featureB.id)?.status).toBe('canceled');
    expect(queue.findById(featureA.id)?.status).toBe('in-flight');
    // The singular tracked run (run-A → featureA) is untouched.
    expect(store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('running');
    // The controller is NOT signaled — featureB is not the singular
    // active run, so the controller-side abort path is skipped to
    // protect featureA's run.
    expect(controller.cancelActive).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'task-canceled',
        payload: expect.objectContaining({
          taskId: featureB.id,
          reason: 'user-cancel-stale-in-flight'
        })
      })
    );
  });

  it('post-pause/resume drift: cancels the in-flight FeatureRequest even when singular run was swapped', async () => {
    // After a queue pause/resume cycle a different task may be in flight
    // than the singular `store.getRun()` projection. The cancel path
    // must still target the operator-selected row, not the projection.
    const featureSwapped = await queue.enqueue('swapped task');
    await queue.markInFlight(featureSwapped.id, 'run-old');
    // Singular run projection still references the prior (now-completed) run.
    await store.setRun(DEFAULT_QUEUE_ID, makeRun({ id: 'run-old', featureId: 'stale-feature-id', status: 'completed' }));

    const result = await runCancel({
      controller,
      store,
      queue,
      audit,
      notifier,
      logger,
      taskId: featureSwapped.id
    });

    expect(result.ok).toBe(true);
    expect(queue.findById(featureSwapped.id)?.status).toBe('canceled');
    // The singular run projection is untouched because it does not
    // reference featureSwapped.
    expect(store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('completed');
    expect(controller.cancelActive).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'task-canceled',
        payload: expect.objectContaining({
          taskId: featureSwapped.id,
          reason: 'user-cancel-stale-in-flight'
        })
      })
    );
  });
});
