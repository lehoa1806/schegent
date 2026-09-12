// Feature 065 / BUG-006 (T069) — projector contract for paused-task
// composition + paused-row enrichment, and (second describe block, BUG-009 /
// FR-029) the flattened `orderedItems` contract that the T069 reopen names as
// cases (d)/(e)/(f).
//
// The first block pins three properties:
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
import { RECENT_QUEUE_MAX } from '../../../../src/ui/sidebar/snapshot';
import { DEFAULT_QUEUE_ID } from '../../../../src/contracts/queue-identity';
import type {
  FeatureRequest,
  FeatureRequestStatus,
  QueueState
} from '../../../../src/queue/feature-request';

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
    pauseSource: null,
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
      pauseSource: null,
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
      pauseSource: null,
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
      pauseSource: null,
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

    expect(projection.pending[0].paused).toBeUndefined(); // 2026-09-06 coincidental: a projected task row, not QueueState
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
      pauseSource: null,
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

// Feature 065 / BUG-009 (T069 reopen, cases (d)/(e)/(f); FR-029) — the
// flattened `orderedItems` contract.
//
// Ordering authority: FR-029 (spec.md) requires `orderedItems` to carry every
// request "regardless of status ... in the operator's reorder-history order
// (i.e., the underlying `requests` array's insertion + reorder order)", which
// is `position` order — the same coordinate system FR-030's global-index
// reorder writers consume, and the order `RunsSurface.svelte` renders. The
// T069/T077 parenthetical "in-flight first, then pending, then recent" is
// bucket concatenation, which is a DIFFERENT order and is not what FR-029
// specifies or what the projector emits; `pins reorder-history order over
// bucket concatenation` below is the discriminating case. tasks.md records the
// supersession.
function baseQueue(requests: readonly FeatureRequest[], inFlightId: string | null = null): QueueState {
  return makeQueue({ requests: requests.slice(), inFlightId });
}

function projectWith(queue: QueueState) {
  return projectQueue(queue, {
    sanitize: passThroughSanitize,
    inFlightPhase: null,
    inFlightId: queue.inFlightId,
    scheduledStartSource: queue.scheduledStartSource,
    scheduledStartAt: queue.scheduledStartAt
  });
}

const bucketTotal = (p: ReturnType<typeof projectWith>): number =>
  (p.inFlight === null ? 0 : 1) + p.pending.length + p.recent.length;

describe('queue-projector — flattened orderedItems (T069 (d)/(e)/(f) / BUG-009 / FR-029)', () => {
  // (d) — every row, exactly once, regardless of status.
  it('(d) carries every request exactly once regardless of status', () => {
    const statuses: readonly FeatureRequestStatus[] = [
      'pending',
      'in-flight',
      'paused',
      'completed',
      'canceled',
      'failed'
    ];
    const requests = statuses.map((status, i) =>
      makeRequest({ id: `task-${status}`, status, position: i })
    );

    const projection = projectWith(baseQueue(requests, 'task-in-flight'));

    const ids = projection.orderedItems.map((item) => item.id);
    expect(ids).toHaveLength(requests.length);
    expect(new Set(ids).size).toBe(requests.length); // exactly once — no duplicates
    expect(new Set(ids)).toEqual(new Set(requests.map((r) => r.id)));
  });

  // (d) — the order itself. This is the case that separates FR-029's
  // reorder-history order from the bucket-concatenation order the T069 text
  // parenthetically described.
  it('(d) pins reorder-history order over bucket concatenation', () => {
    // Bucket concatenation would yield [live, next, done]; position order
    // yields [done, live, next]. The completed row sorts FIRST because its
    // position is lowest, not last because it is terminal.
    const done = makeRequest({ id: 'done', status: 'completed', position: 0 });
    const live = makeRequest({ id: 'live', status: 'in-flight', position: 1 });
    const next = makeRequest({ id: 'next', status: 'pending', position: 2 });

    const projection = projectWith(baseQueue([done, live, next], 'live'));

    expect(projection.orderedItems.map((i) => i.id)).toEqual(['done', 'live', 'next']);
  });

  it('(d) sorts by position, not by the requests array order', () => {
    const requests = [
      makeRequest({ id: 'third', status: 'pending', position: 2 }),
      makeRequest({ id: 'first', status: 'pending', position: 0 }),
      makeRequest({ id: 'second', status: 'pending', position: 1 })
    ];

    const projection = projectWith(baseQueue(requests));

    expect(projection.orderedItems.map((i) => i.id)).toEqual(['first', 'second', 'third']);
  });

  // (e) — orderedItems agrees with the bucket-routing decisions of (a)/(b)/(c).
  it('(e) agrees with the bucket routing for paused-from-in-flight and paused-from-pending rows', () => {
    const systemPaused = makeRequest({
      id: 'sys-paused',
      status: 'paused',
      position: 0,
      pauseCause: 'phase-paused'
    });
    const operatorPaused = makeRequest({
      id: 'op-paused',
      status: 'paused',
      position: 1,
      pauseCause: 'manually-paused-task'
    });
    const active = makeRequest({ id: 'active', status: 'pending', position: 2 });

    const projection = projectWith(
      makeQueue({
        requests: [systemPaused, operatorPaused, active],
        inFlightId: 'sys-paused',
        queueLifecycle: 'idle-pending',
        scheduledStartAt: 99_999,
        scheduledStartSource: 'system-rate-limit-recovery'
      })
    );

    // Bucket routing (cases (a)/(b)) still holds...
    expect(projection.inFlight!.id).toBe('sys-paused');
    expect(projection.pending.map((i) => i.id)).toEqual(['op-paused', 'active']);

    // ...and the flattened view carries the same rows with identical
    // enrichment, so a consumer reading only orderedItems sees the same
    // pause-source decision the buckets encode.
    const flat = new Map(projection.orderedItems.map((i) => [i.id, i]));
    expect(flat.get('sys-paused')!.paused).toEqual(projection.inFlight!.paused);
    expect(flat.get('op-paused')!.paused).toEqual(projection.pending[0].paused);
    expect(flat.get('sys-paused')!.paused!.pauseSource).toBe('system-paused');
    expect(flat.get('op-paused')!.paused!.pauseSource).toBe('operator-paused');
  });

  // (e) / FR-029(c) — the stable-identifier invariant: pausing a row must not
  // move it, which is the jumpiness FR-029 was written to eliminate.
  it('(e) keeps a row at the same index across a pause transition', () => {
    const before = [
      makeRequest({ id: 'a', status: 'completed', position: 0 }),
      makeRequest({ id: 'b', status: 'in-flight', position: 1 }),
      makeRequest({ id: 'c', status: 'pending', position: 2 })
    ];
    const after = [
      before[0],
      { ...before[1], status: 'paused' as const, pauseCause: 'manually-paused-task' as const },
      before[2]
    ];

    const indexOfB = (requests: readonly FeatureRequest[], inFlightId: string | null): number =>
      projectWith(baseQueue(requests, inFlightId)).orderedItems.findIndex((i) => i.id === 'b');

    // Operator pause clears inFlightId, which moves 'b' across buckets...
    expect(indexOfB(before, 'b')).toBe(1);
    expect(indexOfB(after, null)).toBe(1); // ...but not within orderedItems.
  });

  // (f) — conservation. No row dropped, no row duplicated.
  it('(f) conserves every row across 12 fixture inputs', () => {
    const statuses: readonly FeatureRequestStatus[] = [
      'pending',
      'in-flight',
      'paused',
      'completed',
      'canceled',
      'failed'
    ];

    for (let n = 1; n <= 12; n++) {
      const requests = Array.from({ length: n }, (_, i) =>
        makeRequest({
          id: `task-${i}`,
          status: statuses[(i + n) % statuses.length],
          position: (i * 7) % n // deliberately non-monotonic w.r.t. array order
        })
      );
      const projection = projectWith(baseQueue(requests, `task-0`));

      const ids = projection.orderedItems.map((i) => i.id);
      expect(ids, `fixture n=${n}`).toHaveLength(n);
      expect(new Set(ids).size, `fixture n=${n} — duplicate row`).toBe(n);

      const positions = projection.orderedItems.map((i) => i.position);
      expect(positions, `fixture n=${n} — not position-ordered`).toEqual(
        positions.slice().sort((a, b) => a - b)
      );
    }
  });

  it('(f) equals the bucket total while terminal rows stay within RECENT_QUEUE_MAX', () => {
    const requests = [
      makeRequest({ id: 'live', status: 'in-flight', position: 0 }),
      makeRequest({ id: 'p1', status: 'pending', position: 1 }),
      makeRequest({ id: 'p2', status: 'pending', position: 2 }),
      makeRequest({ id: 'r1', status: 'completed', position: 3 }),
      makeRequest({ id: 'r2', status: 'failed', position: 4 })
    ];

    const projection = projectWith(baseQueue(requests, 'live'));

    expect(projection.recent.length).toBeLessThanOrEqual(RECENT_QUEUE_MAX);
    expect(projection.orderedItems).toHaveLength(bucketTotal(projection));
  });

  // The T069 reopen states (f) as an unconditional equality. It is not one:
  // `recent` is capped at RECENT_QUEUE_MAX and `orderedItems` is not, so above
  // the cap the buckets under-report and orderedItems is the complete list.
  // Pinned so the divergence is a recorded contract rather than a latent
  // surprise for the next reader of that task row.
  it('(f) exceeds the bucket total above RECENT_QUEUE_MAX — orderedItems is uncapped', () => {
    const terminalCount = RECENT_QUEUE_MAX + 2;
    const requests = [
      makeRequest({ id: 'pending-row', status: 'pending', position: 0 }),
      ...Array.from({ length: terminalCount }, (_, i) =>
        makeRequest({
          id: `done-${i}`,
          status: 'completed',
          position: i + 1,
          enqueuedAt: 1_000 + i
        })
      )
    ];

    const projection = projectWith(baseQueue(requests));

    expect(projection.recent).toHaveLength(RECENT_QUEUE_MAX); // capped
    expect(projection.orderedItems).toHaveLength(requests.length); // uncapped
    expect(projection.orderedItems.length).toBeGreaterThan(bucketTotal(projection));

    // Every terminal row the `recent` cap dropped is still reachable.
    const flatIds = new Set(projection.orderedItems.map((i) => i.id));
    for (const request of requests) expect(flatIds.has(request.id)).toBe(true);
  });

  it('(f) emits an empty orderedItems for an empty queue', () => {
    const projection = projectWith(baseQueue([]));

    expect(projection.orderedItems).toEqual([]);
    expect(bucketTotal(projection)).toBe(0);
  });
});
