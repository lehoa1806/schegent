// Feature 063 (US3, T050) — unit tests for `deriveCleanAllContext`. The
// helper centralizes the impact-inventory derivation that the Clean All
// confirmation modal's body template substitutes. Keeping it isolated
// from Dashboard rendering lets each branch (empty queue, in-flight,
// pause-by-cascade vs operator, active run) be asserted by exact-value
// equality rather than by re-running the full Dashboard mount.

import { describe, expect, it } from 'vitest';
import { deriveCleanAllContext } from '../queue-derived';
import type {
  QueueItem,
  QueueProjection,
  QueueSummary,
  WorkflowSnapshot
} from '../snapshot-types';

function queueItem(
  overrides: Partial<QueueItem> & { id: string; status: QueueItem['status'] }
): QueueItem {
  return Object.freeze({
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    enqueuedAt: overrides.enqueuedAt ?? '2026-05-22T00:00:00.000Z',
    startedAt: overrides.startedAt ?? null,
    updatedAt: overrides.updatedAt ?? '2026-05-22T00:00:00.000Z',
    completedAt: overrides.completedAt ?? null,
    status: overrides.status,
    retryCount: overrides.retryCount ?? 0,
    lastErrorSummary: overrides.lastErrorSummary ?? null,
    pausedReason: overrides.pausedReason ?? null,
    currentPhase: overrides.currentPhase ?? null,
    position: overrides.position ?? 0
  });
}

function queueSummary(
  overrides: Partial<QueueSummary> & { pauseSource: QueueSummary['pauseSource'] }
): QueueSummary {
  return Object.freeze({
    id: overrides.id ?? 'default',
    name: overrides.name ?? 'Default queue',
    position: overrides.position ?? 0,
    state: overrides.state ?? (overrides.pauseSource ? 'manually-paused' : 'active'),
    pauseSource: overrides.pauseSource,
    schedule: overrides.schedule ?? null,
    taskCount: overrides.taskCount ?? 0
  });
}

// Only the fields read by `deriveCleanAllContext` need to be valid; the
// rest of `WorkflowSnapshot` is filled with the cheapest legal defaults
// so the cast at the call site is safe.
function mkSnapshot(
  queue: QueueProjection,
  activeRunId: string | null = null
): WorkflowSnapshot {
  return {
    schemaVersion: 3,
    isPrimary: true,
    status: 'idle',
    activeFeature: null,
    phases: [],
    queue,
    activeRunId,
    auditTail: [],
    liveActivity: {
      summary: null,
      category: null,
      lastEventAt: null,
      freshness: 'stale',
      staleSeconds: null
    },
    workflowElapsedMs: null,
    monitor: null,
    history: [],
    producedAt: '2026-05-22T00:00:00.000Z',
    availablePipelines: [],
    availablePhases: [],
    availableModels: []
  } as unknown as unknown as WorkflowSnapshot;
}

function emptyQueue(): QueueProjection {
  return Object.freeze({
    orderedItems: [],
    inFlight: null,
    pending: [],
    recent: [],
    paused: false
  });
}

describe('deriveCleanAllContext', () => {
  it('empty snapshot → all counts zero, no in-flight, no pause, no active run', () => {
    const snapshot = mkSnapshot(emptyQueue(), null);
    expect(deriveCleanAllContext(snapshot)).toEqual({
      pendingCount: 0,
      completedCount: 0,
      failedCount: 0,
      canceledCount: 0,
      inflightTitle: null,
      pauseSource: null,
      hasActiveRun: false
    });
  });

  it('populated snapshot returns the exact impact inventory the body template substitutes', () => {
    const queue: QueueProjection = Object.freeze({ orderedItems: [],
      inFlight: queueItem({
        id: 'inflight-1',
        status: 'in-flight',
        label: 'Run feature 063 specify'
      }),
      pending: [
        queueItem({ id: 'p1', status: 'pending', position: 1 }),
        queueItem({ id: 'p2', status: 'pending', position: 2 }),
        queueItem({ id: 'p3', status: 'pending', position: 3 })
      ],
      recent: [
        queueItem({ id: 'c1', status: 'completed' }),
        queueItem({ id: 'c2', status: 'completed' }),
        queueItem({ id: 'f1', status: 'failed' }),
        queueItem({ id: 'x1', status: 'canceled' })
      ],
      queues: [queueSummary({ pauseSource: 'cascade', taskCount: 4 })],
      paused: true
    });
    const snapshot = mkSnapshot(queue, 'run-abc');
    expect(deriveCleanAllContext(snapshot)).toEqual({
      pendingCount: 3,
      completedCount: 2,
      failedCount: 1,
      canceledCount: 1,
      inflightTitle: 'Run feature 063 specify',
      pauseSource: 'cascade',
      hasActiveRun: true
    });
  });

  it('pauseSource prefers queues[0].pauseSource over the legacy paused flag', () => {
    const queue: QueueProjection = Object.freeze({ orderedItems: [],
      inFlight: null,
      pending: [],
      recent: [],
      queues: [queueSummary({ pauseSource: 'operator' })],
      paused: false
    });
    const ctx = deriveCleanAllContext(mkSnapshot(queue));
    expect(ctx.pauseSource).toBe('operator');
  });

  it("when queues[] is absent, pauseSource falls back to 'operator' iff queue.paused is true", () => {
    const queue: QueueProjection = Object.freeze({ orderedItems: [],
      inFlight: null,
      pending: [],
      recent: [],
      paused: true
    });
    const ctx = deriveCleanAllContext(mkSnapshot(queue));
    expect(ctx.pauseSource).toBe('operator');
  });

  it('when queues[] is absent and queue.paused is false, pauseSource is null', () => {
    const queue: QueueProjection = Object.freeze({ orderedItems: [],
      inFlight: null,
      pending: [],
      recent: [],
      paused: false
    });
    const ctx = deriveCleanAllContext(mkSnapshot(queue));
    expect(ctx.pauseSource).toBeNull();
  });

  it('queues[0].pauseSource=null overrides the legacy paused flag (no false-positive pause)', () => {
    // If the default queue summary projects pauseSource=null, the helper
    // trusts the summary even if the legacy top-level `paused` flag is
    // out of sync.
    const queue: QueueProjection = Object.freeze({ orderedItems: [],
      inFlight: null,
      pending: [],
      recent: [],
      queues: [queueSummary({ pauseSource: null })],
      paused: true
    });
    const ctx = deriveCleanAllContext(mkSnapshot(queue));
    expect(ctx.pauseSource).toBeNull();
  });

  it('inflightTitle reads the inFlight label, not the id', () => {
    const queue: QueueProjection = Object.freeze({ orderedItems: [],
      inFlight: queueItem({
        id: 'task-uuid-not-used-here',
        status: 'in-flight',
        label: 'Operator-visible label'
      }),
      pending: [],
      recent: [],
      paused: false
    });
    const ctx = deriveCleanAllContext(mkSnapshot(queue));
    expect(ctx.inflightTitle).toBe('Operator-visible label');
  });

  it('hasActiveRun is true iff activeRunId is a non-null string', () => {
    expect(deriveCleanAllContext(mkSnapshot(emptyQueue(), 'run-1')).hasActiveRun).toBe(true);
    expect(deriveCleanAllContext(mkSnapshot(emptyQueue(), null)).hasActiveRun).toBe(false);
  });

  it('recent counts ignore non-terminal statuses (in-flight/pending mixed in by mistake)', () => {
    // Defensive: if the host accidentally projects a non-terminal status
    // into recent[], the count should still only reflect terminal rows.
    const queue: QueueProjection = Object.freeze({ orderedItems: [],
      inFlight: null,
      pending: [],
      recent: [
        queueItem({ id: 'c1', status: 'completed' }),
        queueItem({ id: 'f1', status: 'failed' }),
        queueItem({ id: 'x1', status: 'canceled' }),
        queueItem({ id: 'stray-pending', status: 'pending' }),
        queueItem({ id: 'stray-inflight', status: 'in-flight' })
      ],
      paused: false
    });
    const ctx = deriveCleanAllContext(mkSnapshot(queue));
    expect(ctx.completedCount).toBe(1);
    expect(ctx.failedCount).toBe(1);
    expect(ctx.canceledCount).toBe(1);
  });
});
