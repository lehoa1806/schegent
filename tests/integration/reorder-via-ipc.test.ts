// Feature 030 T027 (US2) — integration test for the reorder IPC path.
//
// Scenarios:
//   (a) Seed 5 pending tasks. Dispatch CMD_REORDER_TASK with
//       { taskId: T5, newPosition: 0 }. Assert new pending order is
//       T5 → T1 → T2 → T3 → T4.
//   (b) Dispatch CMD_MOVE_QUEUE_ITEM_UP for T4 twice; assert T4 moves
//       up by two positions.
//   (c) Round-trip through the persistence layer: read state back from
//       the FakeMemento and confirm the pending order is materialized.
//   (d) Reversibility sub-scenario (SC-007): perform a reorder, then
//       perform the inverse, assert returns to the original order with
//       no state corruption (in-flight task preserved, every row's
//       queueId stays 'default', no duplicate positions).
//
// The router routes CMD_REORDER_TASK and CMD_MOVE_QUEUE_ITEM_UP via
// the existing host handlers; the new behavior under test is that
// `reorderTaskInUnifiedQueue` produces the audit `task-reordered`
// event (verified end-to-end on the audit append spy).

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
  CMD_MOVE_QUEUE_ITEM_UP,
  type CommandAckMessage,
  type SidebarCommand
} from '../../src/ui/sidebar/messages';
import {
  DEFAULT_QUEUE_ID,
  type QueueRegistry
} from '../../src/queue/queue-registry';
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

async function makeHarness(): Promise<Harness> {
  const memento = new FakeMemento();
  // Seed a clean v6 state with 5 pending tasks (T1..T5) at positions 0..4.
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
  const queue: QueueState = {
    requests: [
      pendingReq('T1', 0, NOW + 1),
      pendingReq('T2', 1, NOW + 2),
      pendingReq('T3', 2, NOW + 3),
      pendingReq('T4', 3, NOW + 4),
      pendingReq('T5', 4, NOW + 5)
    ],
    inFlightId: null,
    paused: false,
    pausedReason: null,
    updatedAt: NOW,
    queueLifecycle: 'active-empty',
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
      clearFailed: () => manager.clearFailed(),
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

describe('Feature 030 (US2, T027) — reorder via IPC end-to-end', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
  });

  it('seeds 5 pending tasks T1..T5 in order', () => {
    expect(pendingOrder(harness)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
  });

  it('CMD_REORDER_TASK { taskId: T5, newPosition: 0 } yields T5 → T1 → T2 → T3 → T4', async () => {
    const ack = await dispatch(harness, {
      type: CMD_REORDER_TASK,
      correlationId: 'reorder-1',
      payload: { taskId: 'T5', newPosition: 0 }
    });
    expect(ack.status).toBe('accepted');
    expect(pendingOrder(harness)).toEqual(['T5', 'T1', 'T2', 'T3', 'T4']);
    // Audit event emitted with the unified `task-reordered` payload shape.
    const reorderEvents = harness.auditEntries.filter(
      (e) => e.eventType === 'task-reordered'
    );
    expect(reorderEvents).toHaveLength(1);
    expect(reorderEvents[0].payload).toMatchObject({
      taskId: 'T5',
      queueId: 'default',
      newPosition: 0
    });
  });

  it('CMD_MOVE_QUEUE_ITEM_UP for T4 twice yields T1 → T2 → T4 → T3 → T5 then T1 → T4 → T2 → T3 → T5', async () => {
    // First move: T4 moves up one position (swaps with T3).
    const firstAck = await dispatch(harness, {
      type: CMD_MOVE_QUEUE_ITEM_UP,
      correlationId: 'up-1',
      payload: { id: 'T4' }
    });
    expect(firstAck.status).toBe('accepted');
    expect(pendingOrder(harness)).toEqual(['T1', 'T2', 'T4', 'T3', 'T5']);
    // Second move: T4 moves up one more (swaps with T2).
    const secondAck = await dispatch(harness, {
      type: CMD_MOVE_QUEUE_ITEM_UP,
      correlationId: 'up-2',
      payload: { id: 'T4' }
    });
    expect(secondAck.status).toBe('accepted');
    expect(pendingOrder(harness)).toEqual(['T1', 'T4', 'T2', 'T3', 'T5']);
  });

  it('reorder round-trips through the persistence layer (Memento)', async () => {
    await dispatch(harness, {
      type: CMD_REORDER_TASK,
      correlationId: 'persist-1',
      payload: { taskId: 'T5', newPosition: 0 }
    });
    // Read the raw memento bytes back through a fresh store instance — the
    // reorder MUST survive the round-trip.
    const fresh = new WorkspaceStateStore(harness.memento);
    await fresh.initialize();
    const reloaded = fresh
      .getQueue(DEFAULT_QUEUE_ID)
      .requests.filter((r) => r.status === 'pending')
      .sort((a, b) => a.position - b.position)
      .map((r) => r.id);
    expect(reloaded).toEqual(['T5', 'T1', 'T2', 'T3', 'T4']);
  });

  it('reversibility (SC-007): inverse reorder returns to original order with no corruption', async () => {
    // Forward: move T5 to position 0 → T5 → T1 → T2 → T3 → T4.
    const forwardAck = await dispatch(harness, {
      type: CMD_REORDER_TASK,
      correlationId: 'fwd',
      payload: { taskId: 'T5', newPosition: 0 }
    });
    expect(forwardAck.status).toBe('accepted');
    expect(pendingOrder(harness)).toEqual(['T5', 'T1', 'T2', 'T3', 'T4']);
    // Inverse: move T5 back to position 4 → T1 → T2 → T3 → T4 → T5.
    const inverseAck = await dispatch(harness, {
      type: CMD_REORDER_TASK,
      correlationId: 'inv',
      payload: { taskId: 'T5', newPosition: 4 }
    });
    expect(inverseAck.status).toBe('accepted');
    expect(pendingOrder(harness)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
    // No state corruption: every row's queueId is still 'default',
    // positions are dense (0..4), no duplicates.
    const requests = harness.store
      .getQueue(DEFAULT_QUEUE_ID)
      .requests.filter((r) => r.status === 'pending');
    expect(requests.every((r) => r.queueId === 'default')).toBe(true);
    const positions = requests.map((r) => r.position).sort((a, b) => a - b);
    expect(positions).toEqual([0, 1, 2, 3, 4]);
  });
});
