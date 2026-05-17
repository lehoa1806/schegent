import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runRestartCanceledTask } from '../../../src/commands/restart-canceled-task';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import { QueueManager } from '../../../src/queue/queue-manager';
import { SanitizedLogger } from '../../../src/lib/logger';
import { DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';
import { MAX_PENDING_TASKS_PER_QUEUE } from '../../../src/queue/feature-request';
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
    expect(restarted.runId).toBeNull();
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
    const snapshot = store.getQueue();
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
