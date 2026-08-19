// Feature 065 BUG-009 T078 (FR-030) — integration tests for the
// global-`orderedItems`-index reorder contract.
//
// FR-030: the `newPosition` argument carried by `CMD_REORDER_TASK` is an
// index into the projector's flattened `orderedItems` array (every
// `FeatureRequest` regardless of status, in operator reorder-history
// order). The host writer translates the global index to a pending-array
// index by counting non-pending rows that precede `newPosition` in the
// same pre-mutation projection snapshot, and only then mutates the
// pending sub-sequence. Non-pending rows (in-flight, paused, failed,
// completed, canceled) are stable anchors during a reorder — their
// `.position` values are preserved.
//
// Scenarios exercised here:
//   (a) drag a pending row past an `operator-paused` row at global index
//       K (where K falls between two pending rows) — succeeds, lands the
//       source at the correct pending-array slot, paused row's
//       `.position` unchanged.
//   (b) drag a pending row past a `failed` row at global index K —
//       succeeds similarly; failed row stable.
//   (c) drag rejected at the guard layer when the source row is
//       non-pending (`in-flight`, `paused`, `failed`) — no state
//       mutation, audit emitted with `cause: 'task-not-pending'`.
//   (d) no-op boundary — the translated pending-array index resolves to
//       the source row's current pending-array index — rejected with
//       `cause: 'no-op'`; pending order unchanged.

import { describe, it, expect } from 'vitest';
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

function baseReq(id: string, position: number, createdAt: number): FeatureRequest {
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

function pendingReq(id: string, position: number, createdAt: number): FeatureRequest {
  return baseReq(id, position, createdAt);
}

function pausedReq(id: string, position: number, createdAt: number): FeatureRequest {
  return {
    ...baseReq(id, position, createdAt),
    status: 'paused',
    pauseCause: 'manually-paused-task',
    pausedReason: 'operator-paused'
  };
}

function failedReq(id: string, position: number, createdAt: number): FeatureRequest {
  return {
    ...baseReq(id, position, createdAt),
    status: 'failed',
    completedAt: createdAt + 100,
    lastError: 'simulated failure'
  };
}

function inFlightReq(id: string, position: number, createdAt: number): FeatureRequest {
  return {
    ...baseReq(id, position, createdAt),
    status: 'in-flight',
    startedAt: createdAt + 100,
    updatedAt: createdAt + 100,
    runId: `run-${id}`
  };
}

async function makeHarness(
  requests: readonly FeatureRequest[],
  inFlightId: string | null
): Promise<Harness> {
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
  const queue: QueueState = {
    requests: requests.slice(),
    inFlightId,
    paused: false,
    pausedReason: null,
    updatedAt: NOW,
    queueLifecycle: inFlightId !== null ? 'running' : 'idle-pending',
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
      ) =>
        manager.setQueuePausedState(
          paused,
          queueId,
          reason ?? null,
          pauseSource ?? 'operator'
        ),
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

function snapshotOrder(h: Harness): Array<{ id: string; status: string; position: number }> {
  return h.store
    .getQueue(DEFAULT_QUEUE_ID)
    .requests.slice()
    .sort((a, b) => a.position - b.position)
    .map((r) => ({ id: r.id, status: r.status, position: r.position }));
}

describe('Feature 065 BUG-009 T078 (FR-030) — global-index reorder contract', () => {
  // ─── Scenario (a) ────────────────────────────────────────────────
  // Fixture: T1(pending, 0), T2(paused, 1), T3(pending, 2), T4(pending, 3)
  // orderedItems: [T1, T2, T3, T4]
  // Drag T1 to global index 2 (the row currently visually occupied by T3).
  // Non-pending count before global index 2 = 1 (T2).
  // translatedPendingIdx = 2 - 1 = 1.
  // T1 is at pending-array idx 0; pendingPeers = [T1, T3, T4].
  // Reshuffle to slot 1 → pendingPeers reorder to [T3, T1, T4].
  // pendingSlots = [0, 2, 3] (the global positions T1/T3/T4 currently
  // occupy). After reshuffle: T3 → 0, T1 → 2, T4 → 3. T2 (paused) keeps
  // its position 1 as a stable anchor.
  it('(a) drag pending row past an operator-paused row succeeds, paused row stable', async () => {
    const h = await makeHarness(
      [
        pendingReq('T1', 0, NOW + 1),
        pausedReq('T2', 1, NOW + 2),
        pendingReq('T3', 2, NOW + 3),
        pendingReq('T4', 3, NOW + 4)
      ],
      null
    );

    const ack = await dispatch(h, {
      type: CMD_REORDER_TASK,
      correlationId: 'past-paused',
      payload: { taskId: 'T1', newPosition: 2 }
    });

    expect(ack.status).toBe('accepted');
    expect(snapshotOrder(h)).toEqual([
      { id: 'T3', status: 'pending', position: 0 },
      { id: 'T2', status: 'paused', position: 1 },
      { id: 'T1', status: 'pending', position: 2 },
      { id: 'T4', status: 'pending', position: 3 }
    ]);

    // Audit event payload carries the pending-array idx (FR-030 audit
    // coordinate is unchanged — host-side readers consume pending-only
    // indices).
    const reorderEvents = h.auditEntries.filter(
      (e) => e.eventType === 'task-reordered'
    );
    expect(reorderEvents).toHaveLength(1);
    expect(reorderEvents[0].payload).toMatchObject({
      taskId: 'T1',
      queueId: 'default',
      fromPosition: 0,
      toPosition: 1,
      newPosition: 1,
      source: 'drag',
      outcome: 'success'
    });
  });

  // ─── Scenario (b) ────────────────────────────────────────────────
  // Same shape as (a) but the non-pending anchor is a `failed` row.
  // Fixture: T1(pending, 0), T2(failed, 1), T3(pending, 2), T4(pending, 3)
  // Drag T1 to global index 2 → translatedPendingIdx = 1 → same outcome
  // as (a) with T2 still at position 1, status 'failed'.
  it('(b) drag pending row past a failed row succeeds, failed row stable', async () => {
    const h = await makeHarness(
      [
        pendingReq('T1', 0, NOW + 1),
        failedReq('T2', 1, NOW + 2),
        pendingReq('T3', 2, NOW + 3),
        pendingReq('T4', 3, NOW + 4)
      ],
      null
    );

    const ack = await dispatch(h, {
      type: CMD_REORDER_TASK,
      correlationId: 'past-failed',
      payload: { taskId: 'T1', newPosition: 2 }
    });

    expect(ack.status).toBe('accepted');
    expect(snapshotOrder(h)).toEqual([
      { id: 'T3', status: 'pending', position: 0 },
      { id: 'T2', status: 'failed', position: 1 },
      { id: 'T1', status: 'pending', position: 2 },
      { id: 'T4', status: 'pending', position: 3 }
    ]);

    const reorderEvents = h.auditEntries.filter(
      (e) => e.eventType === 'task-reordered'
    );
    expect(reorderEvents).toHaveLength(1);
    expect(reorderEvents[0].payload).toMatchObject({
      taskId: 'T1',
      queueId: 'default',
      fromPosition: 0,
      toPosition: 1,
      newPosition: 1,
      source: 'drag',
      outcome: 'success'
    });
  });

  // ─── Scenario (c) ────────────────────────────────────────────────
  // FR-030 source-eligibility guard: only pending rows can be the drag
  // SOURCE. Dragging an in-flight / paused / failed source MUST be
  // rejected with cause: 'task-not-pending' and zero state mutation.
  describe('(c) drag with non-pending source rejects at the guard layer', () => {
    it('rejects drag with in-flight source', async () => {
      const h = await makeHarness(
        [
          inFlightReq('T0', 0, NOW),
          pendingReq('T1', 1, NOW + 1),
          pendingReq('T2', 2, NOW + 2)
        ],
        'T0'
      );

      const before = snapshotOrder(h);
      const ack = await dispatch(h, {
        type: CMD_REORDER_TASK,
        correlationId: 'reject-inflight',
        payload: { taskId: 'T0', newPosition: 2 }
      });

      expect(ack.status).toBe('rejected');
      expect(snapshotOrder(h)).toEqual(before);
      expect(h.store.getQueue(DEFAULT_QUEUE_ID).inFlightId).toBe('T0');

      const reorderEvents = h.auditEntries.filter(
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

    it('rejects drag with paused source', async () => {
      const h = await makeHarness(
        [
          pendingReq('T1', 0, NOW + 1),
          pausedReq('T2', 1, NOW + 2),
          pendingReq('T3', 2, NOW + 3)
        ],
        null
      );

      const before = snapshotOrder(h);
      const ack = await dispatch(h, {
        type: CMD_REORDER_TASK,
        correlationId: 'reject-paused',
        payload: { taskId: 'T2', newPosition: 0 }
      });

      expect(ack.status).toBe('rejected');
      expect(snapshotOrder(h)).toEqual(before);

      const reorderEvents = h.auditEntries.filter(
        (e) => e.eventType === 'task-reordered'
      );
      expect(reorderEvents).toHaveLength(1);
      expect(reorderEvents[0].payload).toMatchObject({
        taskId: 'T2',
        queueId: 'default',
        outcome: 'rejected',
        cause: 'task-not-pending'
      });
    });

    it('rejects drag with failed source', async () => {
      const h = await makeHarness(
        [
          pendingReq('T1', 0, NOW + 1),
          failedReq('T2', 1, NOW + 2),
          pendingReq('T3', 2, NOW + 3)
        ],
        null
      );

      const before = snapshotOrder(h);
      const ack = await dispatch(h, {
        type: CMD_REORDER_TASK,
        correlationId: 'reject-failed',
        payload: { taskId: 'T2', newPosition: 0 }
      });

      expect(ack.status).toBe('rejected');
      expect(snapshotOrder(h)).toEqual(before);

      const reorderEvents = h.auditEntries.filter(
        (e) => e.eventType === 'task-reordered'
      );
      expect(reorderEvents).toHaveLength(1);
      expect(reorderEvents[0].payload).toMatchObject({
        taskId: 'T2',
        queueId: 'default',
        outcome: 'rejected',
        cause: 'task-not-pending'
      });
    });
  });

  // ─── Scenario (d) ────────────────────────────────────────────────
  // No-op boundary: the global index translates back to the source's
  // current pending-array index. Rejected with cause: 'no-op'; state
  // unchanged.
  //
  // Fixture: T1(pending, 0), T2(paused, 1), T3(pending, 2)
  // pendingPeers = [T1, T3]. T3 at pending-array idx 1.
  // Drag T3 to global index 2 (its own current row).
  // nonPendingBefore = 1 (T2). translatedPendingIdx = 2 - 1 = 1.
  // 1 === fromPendingIdx 1 → no-op.
  it('(d) no-op boundary rejects with cause "no-op", state unchanged', async () => {
    const h = await makeHarness(
      [
        pendingReq('T1', 0, NOW + 1),
        pausedReq('T2', 1, NOW + 2),
        pendingReq('T3', 2, NOW + 3)
      ],
      null
    );

    const before = snapshotOrder(h);
    const ack = await dispatch(h, {
      type: CMD_REORDER_TASK,
      correlationId: 'reject-noop',
      payload: { taskId: 'T3', newPosition: 2 }
    });

    expect(ack.status).toBe('rejected');
    expect(snapshotOrder(h)).toEqual(before);

    const reorderEvents = h.auditEntries.filter(
      (e) => e.eventType === 'task-reordered'
    );
    expect(reorderEvents).toHaveLength(1);
    expect(reorderEvents[0].payload).toMatchObject({
      taskId: 'T3',
      queueId: 'default',
      outcome: 'rejected',
      cause: 'no-op'
    });
  });
});
