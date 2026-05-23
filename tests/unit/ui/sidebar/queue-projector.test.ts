// Feature 065 / BUG-006 (T069) — projector contract for paused-task
// composition + paused-row enrichment.
//
// Pins three properties:
//   1. A paused task whose id equals `queue.inFlightId` (preserved on the
//      system-armed scheduled-restore path) lands in the `inFlight` slot
//      with `paused.pauseSource === 'system-paused'` and the resolved
//      restoration target on `paused.resetsAtMs`.
//   2. A paused task whose id is NOT `queue.inFlightId` (operator-paused
//      path clears the pointer) lands in the `pending` array with
//      `paused.pauseSource === 'operator-paused'`, sorted by position
//      alongside actual pending rows.
//   3. The projector NEVER drops a paused task from the projection (no
//      Activity Feed selection bind loss across either pause source).

import { describe, it, expect } from 'vitest';
import { projectQueue } from '../../../../src/ui/sidebar/queue-projector';
import { DEFAULT_QUEUE_ID } from '../../../../src/queue/queue-registry';
import type { FeatureRequest, QueueState } from '../../../../src/queue/feature-request';

function makeRequest(overrides: Partial<FeatureRequest> & Pick<FeatureRequest, 'id'>): FeatureRequest {
  const base: FeatureRequest = {
    id: overrides.id,
    description: `task-${overrides.id}`,
    enqueuedAt: 1_000,
    createdAt: 1_000,
    startedAt: null,
    updatedAt: 1_000,
    completedAt: null,
    status: 'pending',
    queueId: DEFAULT_QUEUE_ID,
    position: 0,
    pauseCause: null,
    runId: null,
    retryCount: 0,
    lastError: null,
    pausedReason: null,
    pipelineId: undefined
  };
  return { ...base, ...overrides };
}

function makeQueue(overrides: Partial<QueueState>): QueueState {
  return {
    requests: [],
    inFlightId: null,
    paused: false,
    pausedReason: null,
    updatedAt: 1_000,
    queueLifecycle: 'running',
    scheduledStartAt: null,
    scheduledStartSource: null,
    ...overrides
  };
}

const passThroughSanitize = (s: string): string => s;

describe('queue-projector — paused-task composition (T069 / BUG-006)', () => {
  it('routes a system-rate-limit-paused task to the inFlight slot with paused metadata', () => {
    const paused = makeRequest({
      id: 'task-a',
      status: 'paused',
      position: 0,
      pauseCause: 'phase-paused',
      pipelineId: 'standard'
    });
    const queue = makeQueue({
      requests: [paused],
      inFlightId: 'task-a',
      queueLifecycle: 'idle-pending',
      scheduledStartAt: 99_999,
      scheduledStartSource: 'system-rate-limit-recovery'
    });

    const projection = projectQueue(queue, {
      sanitize: passThroughSanitize,
      inFlightPhase: null,
      inFlightId: queue.inFlightId,
      scheduledStartSource: queue.scheduledStartSource,
      scheduledStartAt: queue.scheduledStartAt
    });

    expect(projection.inFlight).not.toBeNull();
    expect(projection.inFlight!.id).toBe('task-a');
    expect(projection.inFlight!.paused).toEqual({
      pauseSource: 'system-paused',
      pauseCauseCategory: 'rate-limit',
      resetsAtMs: 99_999
    });
    expect(projection.pending).toHaveLength(0);
  });

  it('routes an operator-paused task to the pending bucket with operator-paused metadata', () => {
    const paused = makeRequest({
      id: 'task-b',
      status: 'paused',
      position: 0,
      pauseCause: 'manually-paused-task'
    });
    const queue = makeQueue({
      requests: [paused],
      // Operator pause clears inFlightId.
      inFlightId: null,
      queueLifecycle: 'operator-paused',
      paused: true
    });

    const projection = projectQueue(queue, {
      sanitize: passThroughSanitize,
      inFlightPhase: null,
      inFlightId: null,
      scheduledStartSource: null,
      scheduledStartAt: null
    });

    expect(projection.inFlight).toBeNull();
    expect(projection.pending).toHaveLength(1);
    expect(projection.pending[0].id).toBe('task-b');
    expect(projection.pending[0].paused).toEqual({ pauseSource: 'operator-paused' });
  });

  it('preserves paused tasks alongside pending tasks (no drop)', () => {
    const pendingTask = makeRequest({ id: 'task-pending', status: 'pending', position: 1 });
    const pausedTask = makeRequest({
      id: 'task-paused',
      status: 'paused',
      position: 0,
      pauseCause: 'manually-paused-task'
    });
    const queue = makeQueue({
      requests: [pendingTask, pausedTask],
      inFlightId: null,
      queueLifecycle: 'operator-paused',
      paused: true
    });

    const projection = projectQueue(queue, {
      sanitize: passThroughSanitize,
      inFlightPhase: null,
      inFlightId: null,
      scheduledStartSource: null,
      scheduledStartAt: null
    });

    expect(projection.pending).toHaveLength(2);
    // Sorted by position ascending.
    expect(projection.pending[0].id).toBe('task-paused');
    expect(projection.pending[1].id).toBe('task-pending');
  });

  it('omits the paused field on non-paused tasks', () => {
    const pendingTask = makeRequest({ id: 'task-pending', status: 'pending', position: 0 });
    const queue = makeQueue({
      requests: [pendingTask],
      inFlightId: null
    });

    const projection = projectQueue(queue, {
      sanitize: passThroughSanitize,
      inFlightPhase: null,
      inFlightId: null,
      scheduledStartSource: null,
      scheduledStartAt: null
    });

    expect(projection.pending[0].paused).toBeUndefined();
  });

  it('does not synthesize system-paused metadata when scheduledStartSource is null', () => {
    // Defensive: even if inFlightId points at a paused task, the
    // operator-paused branch must apply when no system-armed restore is
    // present on the queue.
    const paused = makeRequest({
      id: 'task-c',
      status: 'paused',
      position: 0,
      pauseCause: 'phase-paused'
    });
    const queue = makeQueue({
      requests: [paused],
      inFlightId: 'task-c',
      queueLifecycle: 'operator-paused',
      paused: true
    });

    const projection = projectQueue(queue, {
      sanitize: passThroughSanitize,
      inFlightPhase: null,
      inFlightId: 'task-c',
      scheduledStartSource: null,
      scheduledStartAt: null
    });

    expect(projection.inFlight!.paused).toEqual({ pauseSource: 'operator-paused' });
  });
});
