// FR-R3-150 (T1622b) — unit tests for `deriveClearDoneContext`, the Clear
// Done analogue of `deriveCleanAllContext` (see `clean-all-context.test.ts`).
// Replaces the inline `{ completedCount }` literal `QueueDetailTier.svelte`
// used to build, which named no queue at all.

import { describe, expect, it } from 'vitest';
import { deriveClearDoneContext } from '../queue-derived';
import type { QueueItem, WorkflowSnapshot } from '../snapshot-types';
import { buildQueueRuntime } from './queue-runtime-fixture';

function task(
  overrides: Partial<QueueItem> & { id: string; status: QueueItem['status'] }
): QueueItem {
  return Object.freeze({
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    enqueuedAt: '2026-05-22T00:00:00.000Z',
    startedAt: null,
    updatedAt: '2026-05-22T00:00:00.000Z',
    completedAt: null,
    status: overrides.status,
    retryCount: 0,
    lastErrorSummary: null,
    pausedReason: null,
    currentPhase: null,
    position: overrides.position ?? 0,
    phaseProgress: null
  });
}

function mkSnapshot(betaTasks: readonly QueueItem[]): WorkflowSnapshot {
  return {
    schemaVersion: 4,
    isPrimary: true,
    queues: Object.freeze([
      buildQueueRuntime({
        queueId: 'default',
        name: 'Default',
        tasks: [task({ id: 'default-only', status: 'completed' })]
      }),
      buildQueueRuntime({ queueId: 'q-beta', name: 'nightly', tasks: betaTasks })
    ]),
    queue: {
      inFlight: null,
      pending: Object.freeze([]),
      recent: Object.freeze([]),
      orderedItems: Object.freeze([]),
      paused: false
    },
    auditTail: [],
    monitor: null,
    history: [],
    producedAt: '2026-05-22T00:00:00.000Z',
    availablePipelines: [],
    availablePhases: [],
    availableModels: []
  } as unknown as WorkflowSnapshot;
}

describe('deriveClearDoneContext', () => {
  it('counts only the addressed queue’s completed tasks, never a sibling’s', () => {
    const ctx = deriveClearDoneContext(
      mkSnapshot([
        task({ id: 'c1', status: 'completed' }),
        task({ id: 'c2', status: 'completed' }),
        task({ id: 'p1', status: 'pending' })
      ]),
      'q-beta'
    );
    expect(ctx).toEqual({ queueId: 'q-beta', queueName: 'nightly', completedCount: 2 });
  });

  it('names the addressed queue, not Default, when Default is the one open', () => {
    const ctx = deriveClearDoneContext(mkSnapshot([]), 'default');
    expect(ctx).toEqual({ queueId: 'default', queueName: 'Default', completedCount: 1 });
  });

  it('an empty queue reports zero, not a leaked sibling count', () => {
    const ctx = deriveClearDoneContext(mkSnapshot([]), 'q-beta');
    expect(ctx.completedCount).toBe(0);
  });

  it('falls back to the queueId when no runtime names the queue', () => {
    const ctx = deriveClearDoneContext(mkSnapshot([]), 'unknown-queue');
    expect(ctx).toEqual({ queueId: 'unknown-queue', queueName: 'unknown-queue', completedCount: 0 });
  });
});
