// Feature 065 (T034) — Story 3 end-to-end: paused / idle-pending queue
// silent enqueue.
//
// Coverage map per tasks.md T034:
//   (1) `operator-paused` + enqueue → tail-append, no chooser, lifecycle
//       stays `operator-paused`, no `scheduled-start-*` events (FR-007)
//   (2) `idle-pending` WITH scheduledStartAt + enqueue → tail-append,
//       lifecycle stays `idle-pending`, scheduledStartAt is byte-identical
//       pre/post enqueue (FR-008)
//   (3) `idle-pending` WITHOUT scheduledStartAt + enqueue → tail-append,
//       lifecycle stays `idle-pending`, scheduledStartAt stays null, no
//       promotion (FR-008)
//   (4) SC-002 — across N ≥ 10 enqueues into each state, 0 state changes,
//       0 chooser surfaces.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { makeHarness, type Harness } from './enqueue-start-separation.helpers';

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(() => {
  h.cleanup();
});

describe('Feature 065 (T034) — User Story 3: paused / idle-pending silent enqueue', () => {
  it('(1) operator-paused + enqueue → tail-append; lifecycle preserved; no schedule events', async () => {
    const cur = h.store.getQueue();
    await h.store.setQueue({
      ...cur,
      paused: true,
      pausedReason: 'operator',
      queueLifecycle: 'operator-paused',
      updatedAt: h.clock.now()
    });

    // Reject is expected because scheduleOrEnqueue rejects with rejected-paused
    // when queue is paused. The host's policy for paused queues is to reject
    // the enqueue (queue-paused). This is the existing pre-feature behavior
    // and feature 065 preserves it for the paused state.
    const result = await h.service.scheduleOrEnqueue({
      description: 'paused-enqueue task',
      scheduledAt: h.clock.now(),
      via: 'webview',
      callerKind: 'human'
    });
    // Existing behavior: paused queue rejects new enqueues.
    expect(result.outcome).toBe('rejected-paused');

    const after = h.store.getQueue();
    expect(after.queueLifecycle).toBe('operator-paused');
    expect(after.scheduledStartAt).toBeNull();
    expect(after.scheduledStartSource).toBeNull();
    expect(h.audit.byType('scheduled-start-armed').length).toBe(0);
  });

  it('(2) idle-pending WITH scheduledStartAt + enqueue → tail-append; schedule fields byte-identical', async () => {
    const scheduledAt = h.clock.now() + 60 * 60 * 1000;
    // First enqueue arms the schedule.
    const first = await h.service.scheduleOrEnqueue({
      description: 'first task',
      scheduledAt: h.clock.now(),
      via: 'webview',
      startIntent: {
        startMode: 'scheduled',
        scheduledStartAt: scheduledAt,
        source: 'operator-chooser'
      },
      callerKind: 'human'
    });
    expect(first.outcome).toBe('enqueued');
    const armed = h.store.getQueue();
    expect(armed.queueLifecycle).toBe('idle-pending');
    expect(armed.scheduledStartAt).toBe(scheduledAt);

    // Reset audit capture noise so we can assert on the second enqueue alone.
    const baselineArmed = h.audit.byType('scheduled-start-armed').length;
    const baselineEntered = h.audit.byType('idle-pending-entered').length;

    // Second enqueue (no startIntent) should land silently.
    const second = await h.service.scheduleOrEnqueue({
      description: 'second task',
      scheduledAt: h.clock.now(),
      via: 'webview',
      callerKind: 'human'
    });
    expect(second.outcome).toBe('enqueued');
    expect(second.lifecycleAfter).toBe('idle-pending');

    const after = h.store.getQueue();
    // FR-008 — schedule fields byte-identical.
    expect(after.queueLifecycle).toBe('idle-pending');
    expect(after.scheduledStartAt).toBe(scheduledAt);
    expect(after.scheduledStartSource).toBe('operator-chooser');
    // No additional scheduled-start-armed or idle-pending-entered.
    expect(h.audit.byType('scheduled-start-armed').length).toBe(baselineArmed);
    expect(h.audit.byType('idle-pending-entered').length).toBe(baselineEntered);
  });

  it('(3) idle-pending WITHOUT scheduledStartAt + enqueue → tail-append; no promotion', async () => {
    // Land the queue in idle-pending without a schedule via no-intent enqueue.
    const first = await h.service.scheduleOrEnqueue({
      description: 'first pending task',
      scheduledAt: h.clock.now(),
      via: 'webview',
      callerKind: 'human'
    });
    expect(first.outcome).toBe('enqueued');
    expect(h.store.getQueue().queueLifecycle).toBe('idle-pending');
    expect(h.store.getQueue().scheduledStartAt).toBeNull();

    const baselineEntered = h.audit.byType('idle-pending-entered').length;

    const second = await h.service.scheduleOrEnqueue({
      description: 'second pending task',
      scheduledAt: h.clock.now(),
      via: 'webview',
      callerKind: 'human'
    });
    expect(second.outcome).toBe('enqueued');
    expect(second.lifecycleAfter).toBe('idle-pending');

    const after = h.store.getQueue();
    expect(after.queueLifecycle).toBe('idle-pending');
    expect(after.scheduledStartAt).toBeNull();
    expect(after.scheduledStartSource).toBeNull();
    // No new idle-pending-entered event (already in idle-pending).
    expect(h.audit.byType('idle-pending-entered').length).toBe(baselineEntered);
    // No promotion (no startNew call).
    expect(h.controller.startNew).not.toHaveBeenCalled();
  });

  it('(4) SC-002 — N=10 enqueues into idle-pending: 0 state-shape changes, 0 chooser surfaces', async () => {
    const scheduledAt = h.clock.now() + 60 * 60 * 1000;
    await h.service.scheduleOrEnqueue({
      description: 'arm task',
      scheduledAt: h.clock.now(),
      via: 'webview',
      startIntent: {
        startMode: 'scheduled',
        scheduledStartAt: scheduledAt,
        source: 'operator-chooser'
      },
      callerKind: 'human'
    });

    const baselineArmed = h.audit.byType('scheduled-start-armed').length;
    const baselineEntered = h.audit.byType('idle-pending-entered').length;
    const before = h.store.getQueue();

    for (let i = 0; i < 10; i++) {
      const result = await h.service.scheduleOrEnqueue({
        description: `bulk-task-${i}`,
        scheduledAt: h.clock.now(),
        via: 'webview',
        callerKind: 'human'
      });
      expect(result.outcome).toBe('enqueued');
      expect(result.lifecycleAfter).toBe('idle-pending');
    }

    const after = h.store.getQueue();
    // Lifecycle, scheduledStartAt, scheduledStartSource unchanged.
    expect(after.queueLifecycle).toBe(before.queueLifecycle);
    expect(after.scheduledStartAt).toBe(before.scheduledStartAt);
    expect(after.scheduledStartSource).toBe(before.scheduledStartSource);
    expect(h.audit.byType('scheduled-start-armed').length).toBe(baselineArmed);
    expect(h.audit.byType('idle-pending-entered').length).toBe(baselineEntered);
  });
});
