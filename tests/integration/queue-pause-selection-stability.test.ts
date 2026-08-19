// Feature 065 / BUG-006 (T070) — Activity Feed selection-stability across
// the `in-flight → paused → in-flight` transition.
//
// The host-side projector emits a `QueueProjection` that drives both the
// Activity Feed selection binding and the Phase Progression view. The
// invariant (FR-027): a paused task MUST continue to appear in the
// projection, at a stable slot, so the client-side `selectedFeatureId`
// binding never falls through to "No selection". The slot is determined
// by `queue.inFlightId`:
//   - Operator pause clears `inFlightId` → paused task lands in `pending`.
//   - System (rate-limit) pause preserves `inFlightId` via
//     `preserveInFlightForRestore: true` → paused task lands in `inFlight`.
//
// This test drives both pause sources end-to-end at the host layer:
//   1. Operator pause: assert projection routes the paused task to
//      pending with `paused.pauseSource === 'operator-paused'`.
//   2. System pause: arm a scheduled-restore source on the queue, pause
//      with preserveInFlightForRestore, assert projection routes the
//      paused task to the `inFlight` slot with
//      `paused.pauseSource === 'system-paused'`,
//      `pauseCauseCategory === 'rate-limit'`, and a finite `resetsAtMs`.
//   3. Resume (system path): clear paused state + lifecycle returns to
//      running → projection task is back in the `inFlight` slot.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { projectQueue } from '../../src/ui/sidebar/queue-projector';
import { makeHarness, type Harness } from './enqueue-start-separation.helpers';

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(() => {
  h.cleanup();
});

const passSanitize = (s: string): string => s;

describe('Feature 065 BUG-006 (T070) — queue-pause selection stability (FR-027)', () => {
  it('operator pause: paused row lands in `pending` bucket with operator-paused metadata (no drop)', async () => {
    // Arrange: enqueue + mark in-flight.
    const enq = await h.queue.enqueue('selection-stability-operator', {
      pipelineId: 'default'
    });
    await h.queue.markInFlight(enq.id, 'run-1');

    // Pre-pause baseline — task is in-flight.
    const beforePauseQueue = h.store.getQueue('default');
    expect(beforePauseQueue.inFlightId).toBe(enq.id);

    const beforePauseProjection = projectQueue(beforePauseQueue, {
      sanitize: passSanitize,
      inFlightPhase: null,
      inFlightId: beforePauseQueue.inFlightId,
      scheduledStartSource: beforePauseQueue.scheduledStartSource ?? null,
      scheduledStartAt: beforePauseQueue.scheduledStartAt ?? null
    });
    expect(beforePauseProjection.inFlight?.id).toBe(enq.id);
    expect(beforePauseProjection.inFlight?.status).toBe('in-flight');

    // Act: operator pause (preserveInFlightForRestore=false → clears inFlightId).
    const paused = await h.queue.pause(enq.id, 'manually-paused-task', false);
    expect(paused).toBe(true);

    const afterPauseQueue = h.store.getQueue('default');
    expect(afterPauseQueue.inFlightId).toBeNull();

    // Assert: projection still includes the task (no drop) in the
    // `pending` bucket with operator-paused metadata.
    const projection = projectQueue(afterPauseQueue, {
      sanitize: passSanitize,
      inFlightPhase: null,
      inFlightId: afterPauseQueue.inFlightId,
      scheduledStartSource: afterPauseQueue.scheduledStartSource ?? null,
      scheduledStartAt: afterPauseQueue.scheduledStartAt ?? null
    });
    expect(projection.inFlight).toBeNull();
    expect(projection.pending).toHaveLength(1);
    expect(projection.pending[0].id).toBe(enq.id);
    expect(projection.pending[0].paused).toEqual({
      pauseSource: 'operator-paused'
    });
  });

  it('system rate-limit pause: paused row lands in `inFlight` slot with system-paused metadata + restore target', async () => {
    // Arrange: enqueue + mark in-flight.
    const enq = await h.queue.enqueue('selection-stability-system', {
      pipelineId: 'default'
    });
    await h.queue.markInFlight(enq.id, 'run-1');

    // Arm a system-rate-limit scheduled-restore on the queue. This
    // mirrors the side-effect of `GuardedRunService.transitionToScheduledRestore`.
    const scheduledAt = h.clock.now() + 30 * 60 * 1000; // 30 minutes ahead
    const beforePause = h.store.getQueue('default');
    await h.store.setQueue({
      ...beforePause,
      queueLifecycle: 'idle-pending',
      pauseSource: null,
      scheduledStartAt: scheduledAt,
      scheduledStartSource: 'system-rate-limit-recovery',
      updatedAt: h.clock.now()
    });

    // Act: system pause via the preserveInFlightForRestore path.
    const paused = await h.queue.pause(enq.id, 'phase-paused', true);
    expect(paused).toBe(true);

    const afterPauseQueue = h.store.getQueue('default');
    // FR-027 invariant — inFlightId is preserved.
    expect(afterPauseQueue.inFlightId).toBe(enq.id);

    const projection = projectQueue(afterPauseQueue, {
      sanitize: passSanitize,
      inFlightPhase: null,
      inFlightId: afterPauseQueue.inFlightId,
      scheduledStartSource: afterPauseQueue.scheduledStartSource ?? null,
      scheduledStartAt: afterPauseQueue.scheduledStartAt ?? null
    });

    // Projection routes the paused task to the inFlight slot — selection
    // binding stays put on the same featureId.
    expect(projection.inFlight).not.toBeNull();
    expect(projection.inFlight!.id).toBe(enq.id);
    expect(projection.inFlight!.status).toBe('paused');
    expect(projection.inFlight!.paused).toEqual({
      pauseSource: 'system-paused',
      pauseCauseCategory: 'rate-limit',
      resetsAtMs: scheduledAt
    });
    // Pending bucket does NOT also include this task (no double-listing).
    expect(projection.pending.find((t) => t.id === enq.id)).toBeUndefined();
  });

  it('resume after system pause: projection routes the row back to in-flight', async () => {
    // Arrange: enqueue + in-flight + system-pause (preserve inFlightId).
    const enq = await h.queue.enqueue('selection-stability-resume', {
      pipelineId: 'default'
    });
    await h.queue.markInFlight(enq.id, 'run-1');
    const scheduledAt = h.clock.now() + 60 * 60 * 1000;
    const beforePause = h.store.getQueue('default');
    await h.store.setQueue({
      ...beforePause,
      queueLifecycle: 'idle-pending',
      pauseSource: null,
      scheduledStartAt: scheduledAt,
      scheduledStartSource: 'system-rate-limit-recovery',
      updatedAt: h.clock.now()
    });
    await h.queue.pause(enq.id, 'phase-paused', true);

    // Pre-resume baseline — paused task in inFlight slot.
    const pausedQueue = h.store.getQueue('default');
    const pausedProjection = projectQueue(pausedQueue, {
      sanitize: passSanitize,
      inFlightPhase: null,
      inFlightId: pausedQueue.inFlightId,
      scheduledStartSource: pausedQueue.scheduledStartSource ?? null,
      scheduledStartAt: pausedQueue.scheduledStartAt ?? null
    });
    expect(pausedProjection.inFlight?.id).toBe(enq.id);
    expect(pausedProjection.inFlight?.status).toBe('paused');

    // Act: resume — lifecycle returns to running, schedule fields cleared,
    // task returns to in-flight via markInFlight (idempotent).
    h.clock.advance(scheduledAt - h.clock.now());
    await h.store.setQueue({
      ...h.store.getQueue('default'),
      queueLifecycle: 'running',
      pauseSource: null,
      scheduledStartAt: null,
      scheduledStartSource: null,
      updatedAt: h.clock.now()
    });
    await h.queue.markInFlight(enq.id, 'run-1');

    // Assert: projection routes the row back to in-flight; no paused
    // metadata on the resumed row.
    const resumedQueue = h.store.getQueue('default');
    const resumedProjection = projectQueue(resumedQueue, {
      sanitize: passSanitize,
      inFlightPhase: null,
      inFlightId: resumedQueue.inFlightId,
      scheduledStartSource: resumedQueue.scheduledStartSource ?? null,
      scheduledStartAt: resumedQueue.scheduledStartAt ?? null
    });
    expect(resumedProjection.inFlight?.id).toBe(enq.id);
    expect(resumedProjection.inFlight?.status).toBe('in-flight');
    expect(resumedProjection.inFlight?.paused).toBeUndefined();
  });

  it('paused row coexists with pending rows without dropping any task (no selection fallthrough)', async () => {
    // Arrange: two tasks — one in-flight (then paused via operator),
    // one pending. Both must remain in the projection so neither's
    // selection binding can fall through to "No selection".
    const a = await h.queue.enqueue('task-a', { pipelineId: 'default' });
    const b = await h.queue.enqueue('task-b', { pipelineId: 'default' });
    await h.queue.markInFlight(a.id, 'run-1');
    await h.queue.pause(a.id, 'manually-paused-task', false);

    const queue = h.store.getQueue('default');
    const projection = projectQueue(queue, {
      sanitize: passSanitize,
      inFlightPhase: null,
      inFlightId: queue.inFlightId,
      scheduledStartSource: queue.scheduledStartSource ?? null,
      scheduledStartAt: queue.scheduledStartAt ?? null
    });

    // Both tasks survive in the projection.
    const allIds = [
      ...(projection.inFlight ? [projection.inFlight.id] : []),
      ...projection.pending.map((t) => t.id)
    ];
    expect(allIds).toContain(a.id);
    expect(allIds).toContain(b.id);
    // Paused task is in pending (operator-paused, inFlightId cleared).
    expect(projection.pending.find((t) => t.id === a.id)?.paused).toEqual({
      pauseSource: 'operator-paused'
    });
    // Pending task carries no paused enrichment.
    expect(projection.pending.find((t) => t.id === b.id)?.paused).toBeUndefined();
  });
});
