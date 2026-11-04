import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RESTART_FAILED_TOAST,
  runRestartCanceledTask
} from '../../../src/commands/restart-canceled-task';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import { QueueManager } from '../../../src/queue/queue-manager';
import { SanitizedLogger } from '../../../src/lib/logger';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { MAX_PENDING_TASKS_PER_QUEUE } from '../../../src/queue/feature-request';
import {
  completeComposableNodeAttempt,
  dispatchComposableNode
} from '../../../src/services/workflow-execution/connected-run-coordinator';
import { createComposableWorkflowRunSnapshot } from '../../../src/services/workflow-execution/connected-run-factory';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type { Notifier } from '../../../src/ui/notifications';

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

let memento: FakeMemento;
let store: WorkspaceStateStore;
let queue: QueueManager;
let audit: AuditLogWriter & { append: ReturnType<typeof vi.fn> };
let notifier: Notifier;
let logger: SanitizedLogger;

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  queue = new QueueManager(store);
  audit = makeAudit();
  notifier = makeNotifier();
  logger = new SanitizedLogger();
});

describe('runRestartCanceledTask — a row a Workflow attempt started', () => {
  async function seedCanceledLeaf(attemptEnded: boolean): Promise<string> {
    const task = await queue.enqueue('leaf of a workflow');
    await queue.markInFlight(task.id, 'run-of-the-leaf');
    await queue.finish(task.id, 'canceled');
    const created = createComposableWorkflowRunSnapshot({
      connectedRunId: 'connected-composable',
      workflow: {
        workflowId: 'wf-composable',
        name: 'Release',
        version: 1,
        startNodeIds: ['draft'],
        nodes: [{ nodeId: 'draft', kind: 'phase', phaseId: 'draft-phase' }],
        connections: []
      },
      effectivePhases: [{ phaseId: 'draft-phase', name: 'Draft', version: 1, instruction: 'Draft' }],
      startedAt: 1_700_000_000_000
    });
    if (created.outcome !== 'created') throw new Error('fixture refused');
    expect((await store.compareAndSetConnectedRun(created.run, 0)).outcome).toBe('written');
    const coordinator = {
      connectedRuns: store,
      dispatchPhase: () => Promise.resolve({ outcome: 'dispatched' as const, queueItemId: task.id })
    };
    await dispatchComposableNode(coordinator, {
      run: created.run,
      invocationId: created.rootInvocationId,
      nodeId: 'draft',
      startedAt: 1_700_000_000_001
    });
    if (attemptEnded) {
      const run = store.getConnectedRun('connected-composable');
      if (run === null) throw new Error('fixture lost its run');
      await completeComposableNodeAttempt(coordinator, {
        run,
        invocationId: created.rootInvocationId,
        nodeId: 'draft',
        status: 'canceled',
        completedAt: 1_700_000_000_002
      });
    }
    return task.id;
  }

  it('refuses when the attempt has ended, and says where to retry from', async () => {
    const taskId = await seedCanceledLeaf(true);

    const result = await runRestartCanceledTask({ store, queue, audit, notifier, logger, taskId });

    expect(result).toEqual({ ok: false, reason: 'workflow-attempt-ended' });
    expect(queue.findById(taskId)?.status).toBe('canceled');
    expect(audit.append).not.toHaveBeenCalled();
    expect(notifier.warn).toHaveBeenCalledWith(expect.stringContaining('Workflow run'));
  });

  it('still restarts a row whose attempt is waiting on it', async () => {
    const taskId = await seedCanceledLeaf(false);

    const result = await runRestartCanceledTask({ store, queue, audit, notifier, logger, taskId });

    expect(result.ok).toBe(true);
    expect(queue.findById(taskId)?.status).toBe('pending');
  });
});

describe('runRestartCanceledTask — BUG-001', () => {
  it('rejects an empty taskId', async () => {
    const result = await runRestartCanceledTask({
      store,
      queue,
      audit,
      notifier,
      logger,
      taskId: '   '
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-taskId');
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('rejects when no FeatureRequest matches', async () => {
    const result = await runRestartCanceledTask({
      store,
      queue,
      audit,
      notifier,
      logger,
      taskId: 'unknown-task-id'
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-found');
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('rejects when the target is not in canceled status', async () => {
    const feature = await queue.enqueue('pending task');

    const result = await runRestartCanceledTask({
      store,
      queue,
      audit,
      notifier,
      logger,
      taskId: feature.id
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('illegal-state');
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('transitions a canceled task back to pending and emits the audit event', async () => {
    const feature = await queue.enqueue('canceled task');
    await queue.markInFlight(feature.id, 'run-prev');
    await queue.finish(feature.id, 'canceled');
    const beforeRetryCount = queue.findById(feature.id)!.retryCount;

    const result = await runRestartCanceledTask({
      store,
      queue,
      audit,
      notifier,
      logger,
      taskId: feature.id
    });

    expect(result.ok).toBe(true);
    const restarted = queue.findById(feature.id)!;
    expect(restarted.status).toBe('pending');
    expect(restarted.runId).toBeNull(); // 2026-09-06 coincidental: a queue task, not the audit envelope
    expect(restarted.startedAt).toBeNull();
    expect(restarted.completedAt).toBeNull();
    expect(restarted.lastError).toBeNull();
    expect(restarted.pausedReason).toBeNull();
    expect(restarted.pauseCause).toBeNull();
    expect(restarted.retryCount).toBe(beforeRetryCount + 1);
    // Identity-preserving fields untouched.
    expect(restarted.description).toBe('canceled task');
    expect(restarted.queueId).toBe(DEFAULT_QUEUE_ID);

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'task-restarted-from-canceled',
        payload: expect.objectContaining({
          taskId: feature.id,
          queueId: DEFAULT_QUEUE_ID,
          previousRunId: 'run-prev'
        })
      })
    );
  });

  it('rejects when the target queue is already at the pending cap', async () => {
    const target = await queue.enqueue('to-restart');
    await queue.markInFlight(target.id, 'run-x');
    await queue.finish(target.id, 'canceled');

    // Fill the default queue up to the cap with pending tasks.
    const snapshot = store.getQueue(DEFAULT_QUEUE_ID);
    const filler = [] as typeof snapshot.requests;
    for (let i = 0; i < MAX_PENDING_TASKS_PER_QUEUE; i += 1) {
      filler.push({
        id: `filler-${i}`,
        description: `filler ${i}`,
        enqueuedAt: 1,
        createdAt: 1,
        startedAt: null,
        updatedAt: 1,
        completedAt: null,
        status: 'pending',
        queueId: DEFAULT_QUEUE_ID,
        position: i,
        pauseCause: null,
        runId: null,
        retryCount: 0,
        lastError: null,
        pausedReason: null
      });
    }
    await store.setQueue({
      ...snapshot,
      requests: [...snapshot.requests, ...filler]
    });

    const result = await runRestartCanceledTask({
      store,
      queue,
      audit,
      notifier,
      logger,
      taskId: target.id
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('task-cap-reached');
    expect(audit.append).not.toHaveBeenCalled();
    expect(queue.findById(target.id)?.status).toBe('canceled');
  });
});

// FR-R4-F05 (T12; contract F, F6; contract O, O5; FR-014, FR-015) — the generic arm.
//
// It used to toast `Schegent: restart failed — ${message}` and log the bare message, so a
// path in an exception reached the operator's screen. The toast is fixed text now and
// the detail goes to the log through `describeFailure`; the two typed refusals keep
// their codes and add no toast.
describe('runRestartCanceledTask — the unexpected-failure arm (FR-R4-F05)', () => {
  const PATH = '/synthetic/home/user-252/secret.txt';

  async function canceledTask(): Promise<string> {
    const feature = await queue.enqueue('canceled task');
    await queue.markInFlight(feature.id, 'run-prev');
    await queue.finish(feature.id, 'canceled');
    return feature.id;
  }

  it('toasts the fixed text and logs the detail when an Error carries a path', async () => {
    const taskId = await canceledTask();
    audit.append.mockRejectedValueOnce(new Error(`audit write failed at ${PATH}`));
    const errorLog = vi.spyOn(logger, 'error');

    const result = await runRestartCanceledTask({ store, queue, audit, notifier, logger, taskId });

    expect(result).toEqual({ ok: false, reason: 'unexpected-error' });
    expect(notifier.error).toHaveBeenCalledTimes(1);
    expect(notifier.error).toHaveBeenCalledWith(RESTART_FAILED_TOAST);
    expect(String(vi.mocked(notifier.error).mock.calls[0]?.[0])).not.toContain('user-252');
    expect(errorLog).toHaveBeenCalledWith(
      'restart-canceled-task: unexpected failure',
      expect.objectContaining({ error: expect.stringContaining('user-252') })
    );
  });

  it('toasts the fixed text for a thrown null', async () => {
    const taskId = await canceledTask();
    audit.append.mockRejectedValueOnce(null);

    const result = await runRestartCanceledTask({ store, queue, audit, notifier, logger, taskId });

    expect(result).toEqual({ ok: false, reason: 'unexpected-error' });
    expect(notifier.error).toHaveBeenCalledWith(RESTART_FAILED_TOAST);
  });

  it('words the toast without an exception, a path or a code', () => {
    expect(RESTART_FAILED_TOAST).toBe(
      'Schegent: the task could not be restarted. See the Schegent log for details.'
    );
  });

  it('keeps illegal-state and task-cap-reached as codes, with no failure toast', async () => {
    const pending = await queue.enqueue('pending task');

    const illegal = await runRestartCanceledTask({
      store,
      queue,
      audit,
      notifier,
      logger,
      taskId: pending.id
    });

    expect(illegal).toEqual({ ok: false, reason: 'illegal-state' });
    expect(notifier.error).not.toHaveBeenCalled();
  });
});
