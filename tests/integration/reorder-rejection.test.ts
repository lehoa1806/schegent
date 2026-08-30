// Feature 030 T028 (US2) — integration test for reorder rejection paths.
//
// Scenarios:
//   (a) Reorder request targeting an in-flight task — assert reject with
//       `cause: 'task-not-pending'`.
//   (b) Reorder request targeting a non-existent task — assert reject with
//       `cause: 'invalid-position'` (the unified handler treats unknown
//       taskId as an invalid target since there is no pending row to move).
//   (c) No-op reorder (same position) — assert reject with
//       `cause: 'no-op'` per data-model.md line 206.
//
// All rejections MUST still emit a `task-reordered` audit event with
// `outcome: 'rejected'` and the appropriate `cause`, plus
// `outcome: 'rejected'` on the command ack.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  KEYS,
  SCHEMA_VERSION,
  WorkspaceStateStore,
  type Memento
} from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { MessageRouter, type RouterDeps } from '../../src/ui/sidebar/message-router';
import { SanitizedLogger } from '../../src/lib/logger';
import {
  CMD_REORDER_TASK,
  type CommandAckMessage,
  type SidebarCommand
} from '../../src/ui/sidebar/messages';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { type QueueRegistry } from '../../src/queue/queue-registry';
import type { FeatureRequest, QueueState } from '../../src/queue/feature-request';
import type { AuditEventType } from '../../src/contracts/audit-events';

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

interface CapturedAuditEntry {
  runId: string;
  phase: string;
  iteration: number;
  eventType: AuditEventType;
  payload: Record<string, unknown>;
  outcome: 'info' | 'success' | 'failure';
  correlationId?: string;
}

interface Harness {
  memento: FakeMemento;
  store: WorkspaceStateStore;
  manager: QueueManager;
  router: MessageRouter;
  acks: CommandAckMessage[];
  auditEntries: CapturedAuditEntry[];
}

const NOW = 1_700_000_000_000;

function pendingReq(id: string, position: number, createdAt: number): FeatureRequest {
  return {
    id,
    description: `task ${id}`,
    enqueuedAt: createdAt,
    createdAt,
    startedAt: null,
    updatedAt: createdAt,
    completedAt: null,
    status: 'pending',
    queueId: DEFAULT_QUEUE_ID,
    position,
    pauseCause: null,
    runId: null,
    retryCount: 0,
    lastError: null,
    pausedReason: null
  };
}

function inFlightReq(id: string, position: number, createdAt: number): FeatureRequest {
  return {
    id,
    description: `task ${id}`,
    enqueuedAt: createdAt,
    createdAt,
    startedAt: createdAt + 100,
    updatedAt: createdAt + 100,
    completedAt: null,
    status: 'in-flight',
    queueId: DEFAULT_QUEUE_ID,
    position,
    pauseCause: null,
    runId: 'run-1',
    retryCount: 0,
    lastError: null,
    pausedReason: null
  };
}

async function makeHarness(): Promise<Harness> {
  const memento = new FakeMemento();
  await memento.update(KEYS.schemaVersion, SCHEMA_VERSION);
  await memento.update(KEYS.schemaVersionNumeric, 6);
  const registry: QueueRegistry = {
    entries: [
      {
        id: DEFAULT_QUEUE_ID,
        name: 'Default queue',
        position: 0,
        schedule: null,
        createdAt: NOW,
        updatedAt: NOW
      }
    ],
    updatedAt: NOW
  };
  // Seed one in-flight task (T0) + 3 pending tasks (T1, T2, T3).
  const queue: QueueState = {
    requests: [
      inFlightReq('T0', 0, NOW),
      pendingReq('T1', 0, NOW + 1),
      pendingReq('T2', 1, NOW + 2),
      pendingReq('T3', 2, NOW + 3)
    ],
    inFlightId: 'T0',
    paused: false,
    pausedReason: null,
    updatedAt: NOW,
    queueLifecycle: 'running',
    pauseSource: null,
    scheduledStartAt: null,
    scheduledStartSource: null
  };
  await memento.update(KEYS.queueRegistry, registry);
  await memento.update(KEYS.queue, queue);

  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const manager = new QueueManager(store);
  const acks: CommandAckMessage[] = [];
  const auditEntries: CapturedAuditEntry[] = [];
  const deps: RouterDeps = {
    executeCommand: (async () => undefined) as RouterDeps['executeCommand'],
    queueRemover: { remove: async () => false },
    queueOps: {
      retry: async () => ({ ok: true }),
      moveUp: (id: string) => manager.moveUp(id),
      moveDown: (id: string) => manager.moveDown(id),
      clearCompleted: () => manager.clearCompleted(),
      setQueuePausedState: (
        paused: boolean,
        queueId?: string,
        reason?: string | null,
        pauseSource?: 'operator' | 'cascade' | 'retry-cap'
      ) => manager.setQueuePausedState(paused, queueId, reason ?? null, pauseSource ?? 'operator'),
      modifyTask: (taskId: string, description: string) =>
        manager.modifyTask(taskId, description),
      reorderTask: (taskId: string, newPosition: number) =>
        manager.reorderTask(taskId, newPosition),
      reorderTaskInUnifiedQueue: (taskId: string, newPosition: number) =>
        manager.reorderTaskInUnifiedQueue(taskId, newPosition)
    },
    phaseOps: {
      skipPhase: async () => ({ ok: true }),
      disablePhase: async () => ({ ok: true }),
      enablePhase: async () => ({ ok: true })
    },
    isPrimary: () => true,
    isTrusted: () => true,
    logger: new SanitizedLogger(),
    audit: {
      append: async (entry) => {
        auditEntries.push(entry as CapturedAuditEntry);
        return undefined;
      }
    }
  };
  const router = new MessageRouter(deps);
  return { memento, store, manager, router, acks, auditEntries };
}

async function dispatch(
  h: Harness,
  command: SidebarCommand
): Promise<CommandAckMessage> {
  await h.router.dispatch(command, async (msg) => {
    h.acks.push(msg);
    return true;
  });
  return h.acks[h.acks.length - 1];
}

function pendingOrder(h: Harness): string[] {
  return h.store
    .getQueue(DEFAULT_QUEUE_ID)
    .requests.filter((r) => r.status === 'pending')
    .sort((a, b) => a.position - b.position)
    .map((r) => r.id);
}

describe('Feature 030 (US2, T028) — reorder rejection paths', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
  });

  it('reorder targeting an in-flight task rejects with cause "task-not-pending"', async () => {
    const ack = await dispatch(harness, {
      type: CMD_REORDER_TASK,
      correlationId: 'reject-in-flight',
      payload: { taskId: 'T0', newPosition: 2 }
    });
    expect(ack.status).toBe('rejected');
    // State unchanged: pending order is still T1, T2, T3.
    expect(pendingOrder(harness)).toEqual(['T1', 'T2', 'T3']);
    // T0 is still in-flight.
    expect(harness.store.getQueue(DEFAULT_QUEUE_ID).inFlightId).toBe('T0');
    // Audit event emitted with rejection metadata.
    const reorderEvents = harness.auditEntries.filter(
      (e) => e.eventType === 'task-reordered'
    );
    expect(reorderEvents).toHaveLength(1);
    expect(reorderEvents[0].payload).toMatchObject({
      taskId: 'T0',
      queueId: 'default',
      outcome: 'rejected',
      cause: 'task-not-pending'
    });
  });

  it('reorder targeting a non-existent task rejects with cause "invalid-position"', async () => {
    const ack = await dispatch(harness, {
      type: CMD_REORDER_TASK,
      correlationId: 'reject-unknown',
      payload: { taskId: 'T-does-not-exist', newPosition: 0 }
    });
    expect(ack.status).toBe('rejected');
    // State unchanged.
    expect(pendingOrder(harness)).toEqual(['T1', 'T2', 'T3']);
    // Audit event emitted with rejection metadata.
    const reorderEvents = harness.auditEntries.filter(
      (e) => e.eventType === 'task-reordered'
    );
    expect(reorderEvents).toHaveLength(1);
    expect(reorderEvents[0].payload).toMatchObject({
      taskId: 'T-does-not-exist',
      queueId: 'default',
      outcome: 'rejected',
      cause: 'invalid-position'
    });
  });

  it('no-op reorder (same position) rejects with cause "no-op"', async () => {
    // Feature 065 BUG-009 T078/T082 (FR-030) — `newPosition` is interpreted
    // in the global `orderedItems` index space. Fixture: T0(in-flight, 0),
    // T1(pending, 0), T2(pending, 1), T3(pending, 2). The `sortedAll`
    // projection is [T0, T1, T2, T3]; T2 sits at global index 2. Counting
    // non-pending rows preceding global index 2 yields 1 (T0); the
    // translated pending-array index is 2 - 1 = 1, which equals T2's
    // current pending-array index (T2 is index 1 in `sortedPending`
    // [T1, T2, T3]). The translated equality triggers the no-op rejection.
    // Per data-model.md line 206 and FR-030.
    const ack = await dispatch(harness, {
      type: CMD_REORDER_TASK,
      correlationId: 'reject-noop',
      payload: { taskId: 'T2', newPosition: 2 }
    });
    expect(ack.status).toBe('rejected');
    // State unchanged.
    expect(pendingOrder(harness)).toEqual(['T1', 'T2', 'T3']);
    // Audit event emitted with rejection metadata.
    const reorderEvents = harness.auditEntries.filter(
      (e) => e.eventType === 'task-reordered'
    );
    expect(reorderEvents).toHaveLength(1);
    expect(reorderEvents[0].payload).toMatchObject({
      taskId: 'T2',
      queueId: 'default',
      outcome: 'rejected',
      cause: 'no-op'
    });
  });

  it('reorder with out-of-range newPosition rejects with cause "invalid-position"', async () => {
    // Pending count is 3 — valid newPosition ∈ {0, 1, 2}. Position 10
    // is out of range.
    const ack = await dispatch(harness, {
      type: CMD_REORDER_TASK,
      correlationId: 'reject-oor',
      payload: { taskId: 'T2', newPosition: 10 }
    });
    expect(ack.status).toBe('rejected');
    expect(pendingOrder(harness)).toEqual(['T1', 'T2', 'T3']);
    const reorderEvents = harness.auditEntries.filter(
      (e) => e.eventType === 'task-reordered'
    );
    expect(reorderEvents).toHaveLength(1);
    expect(reorderEvents[0].payload).toMatchObject({
      taskId: 'T2',
      queueId: 'default',
      outcome: 'rejected',
      cause: 'invalid-position'
    });
  });
});
