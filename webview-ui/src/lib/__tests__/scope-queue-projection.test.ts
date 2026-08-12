// Feature 092 (T108, FR-053, FR-057) — the Queue Detail tier reads the same
// surfaces the operations route always read, but scoped to ONE queue.
//
// `snapshot.queue` is the default queue's projection. Rather than teach every
// pane to take a queue id, one pure function rebuilds that projection from the
// named queue's own rows (`QueueRuntime.tasks`) and its own summary, and the
// panes keep reading a `QueueProjection`. The scoping is therefore testable
// without mounting anything, and the unscoped path is untouched.

import { describe, expect, it } from 'vitest';

import { scopeQueueProjection } from '../scope-queue-projection';
import { buildQueueRuntime } from './queue-runtime-fixture';
import { IDLE_DELAYED_RETRY } from '../snapshot-types';
import type {
  QueueItem,
  QueueProjection,
  QueueSummary,
  WorkflowSnapshot
} from '../snapshot-types';

function task(id: string, overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id,
    label: `task ${id}`,
    enqueuedAt: '2026-08-12T00:00:00.000Z',
    startedAt: null,
    updatedAt: '2026-08-12T00:00:00.000Z',
    completedAt: null,
    status: 'pending',
    retryCount: 0,
    lastErrorSummary: null,
    pausedReason: null,
    currentPhase: null,
    position: 0,
    ...overrides
  };
}

function summary(id: string, overrides: Partial<QueueSummary> = {}): QueueSummary {
  return {
    id,
    name: id,
    position: 0,
    state: 'active',
    pauseSource: null,
    schedule: null,
    taskCount: 0,
    ...overrides
  };
}

const DEFAULT_PROJECTION: QueueProjection = {
  inFlight: null,
  pending: [],
  recent: [],
  orderedItems: [],
  queues: [summary('default'), summary('q-beta', { position: 1 })],
  paused: false,
  lifecycle: 'active-empty'
};

function snapshotWith(
  tasks: readonly QueueItem[],
  overrides: {
    readonly lifecycle?: 'running' | 'operator-paused' | 'idle-pending' | 'active-empty';
    readonly summaries?: readonly QueueSummary[];
    readonly inFlightRunFeatureId?: string;
    readonly queue?: Partial<QueueProjection>;
  } = {}
): WorkflowSnapshot {
  const runtime = buildQueueRuntime({
    queueId: 'q-beta',
    name: 'nightly',
    position: 1,
    lifecycle: overrides.lifecycle ?? 'active-empty',
    tasks,
    pendingCount: tasks.filter((item) => item.status === 'pending').length,
    ...(overrides.inFlightRunFeatureId !== undefined
      ? {
          inFlightRun: {
            runId: overrides.inFlightRunFeatureId,
            status: 'running' as const,
            feature: {
              id: overrides.inFlightRunFeatureId,
              label: 'live',
              startedAt: '2026-08-12T00:00:00.000Z'
            },
            pipeline: null,
            elapsedMs: null,
            liveActivity: {
              summary: null,
              category: null,
              lastEventAt: null,
              freshness: 'idle' as const,
              staleSeconds: null
            },
            delayedRetry: IDLE_DELAYED_RETRY,
            resumeTargetPhaseId: null,
            outputs: []
          }
        }
      : {})
  });
  return {
    queue: {
      ...DEFAULT_PROJECTION,
      ...(overrides.summaries !== undefined ? { queues: overrides.summaries } : {}),
      ...(overrides.queue ?? {})
    },
    queues: [buildQueueRuntime({ queueId: 'default', position: 0 }), runtime]
  } as unknown as WorkflowSnapshot;
}

describe('scopeQueueProjection — rows come from the named queue (FR-057)', () => {
  it('lists that queue’s rows as orderedItems, in position order', () => {
    const snapshot = snapshotWith([
      task('second', { position: 1 }),
      task('first', { position: 0 })
    ]);

    const scoped = scopeQueueProjection(snapshot, 'q-beta');

    expect(scoped.orderedItems.map((item) => item.id)).toEqual(['first', 'second']);
  });

  it('does not borrow the default queue’s rows', () => {
    const snapshot = snapshotWith([task('mine')], {
      queue: { orderedItems: [task('theirs')], pending: [task('theirs')] }
    });

    const scoped = scopeQueueProjection(snapshot, 'q-beta');

    expect(scoped.orderedItems.map((item) => item.id)).toEqual(['mine']);
    expect(scoped.pending.map((item) => item.id)).toEqual(['mine']);
  });

  it('buckets the rows the way the legacy panes read them', () => {
    const snapshot = snapshotWith([
      task('running-one', { position: 0, status: 'in-flight' }),
      task('waiting', { position: 1, status: 'pending' }),
      task('done', { position: 2, status: 'completed' }),
      task('broke', { position: 3, status: 'failed' }),
      task('stopped', { position: 4, status: 'canceled' })
    ]);

    const scoped = scopeQueueProjection(snapshot, 'q-beta');

    expect(scoped.inFlight?.id).toBe('running-one');
    expect(scoped.pending.map((item) => item.id)).toEqual(['waiting']);
    expect(scoped.recent.map((item) => item.id)).toEqual(['done', 'broke', 'stopped']);
  });

  it('treats a paused row as pending, not as history', () => {
    const snapshot = snapshotWith([task('held', { status: 'paused' })]);

    const scoped = scopeQueueProjection(snapshot, 'q-beta');

    expect(scoped.pending.map((item) => item.id)).toEqual(['held']);
    expect(scoped.recent).toEqual([]);
  });

  it('reports the paused row the queue’s Run is executing as inFlight', () => {
    // A breakpoint-paused Run still occupies the slot; the row's status is
    // `paused` but the queue is not free, and the tier must not show the slot
    // as empty.
    const snapshot = snapshotWith([task('held', { status: 'paused' })], {
      inFlightRunFeatureId: 'held'
    });

    const scoped = scopeQueueProjection(snapshot, 'q-beta');

    expect(scoped.inFlight?.id).toBe('held');
    expect(scoped.pending).toEqual([]);
  });
});

describe('scopeQueueProjection — the queue’s own control state', () => {
  it('reads paused from that queue’s summary, not the default queue’s flag', () => {
    const snapshot = snapshotWith([], {
      summaries: [
        summary('default'),
        summary('q-beta', { position: 1, state: 'manually-paused', pauseSource: 'operator' })
      ],
      queue: { paused: false }
    });

    const scoped = scopeQueueProjection(snapshot, 'q-beta');

    expect(scoped.paused).toBe(true);
  });

  it('reads lifecycle, schedule and source from that queue', () => {
    const snapshot = snapshotWith([], {
      lifecycle: 'idle-pending',
      summaries: [
        summary('default'),
        summary('q-beta', {
          position: 1,
          schedule: {
            expression: 'in 30m',
            kind: 'relative',
            targetAt: '2026-08-12T00:30:00.000Z'
          }
        })
      ]
    });

    const scoped = scopeQueueProjection(snapshot, 'q-beta');

    expect(scoped.lifecycle).toBe('idle-pending');
    expect(scoped.scheduledStartAt).toBe(Date.parse('2026-08-12T00:30:00.000Z'));
  });

  it('keeps the full registry on the projection so a queue switcher stays possible', () => {
    const snapshot = snapshotWith([]);

    const scoped = scopeQueueProjection(snapshot, 'q-beta');

    expect(scoped.queues?.map((entry) => entry.id)).toEqual(['default', 'q-beta']);
  });

  it('answers the empty projection for a queue that is not in the snapshot (FR-062)', () => {
    const snapshot = snapshotWith([task('mine')]);

    const scoped = scopeQueueProjection(snapshot, 'q-vanished');

    expect(scoped.orderedItems).toEqual([]);
    expect(scoped.inFlight).toBeNull();
    expect(scoped.paused).toBe(false);
  });

  it('freezes what it returns', () => {
    const scoped = scopeQueueProjection(snapshotWith([task('a')]), 'q-beta');

    expect(Object.isFrozen(scoped)).toBe(true);
    expect(Object.isFrozen(scoped.orderedItems)).toBe(true);
  });
});
