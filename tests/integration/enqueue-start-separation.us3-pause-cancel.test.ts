// Feature 065 (T035) — Story 3 regression test: pause cancels scheduled start.
//
// Coverage map per tasks.md T035 (FR-019):
//   (A) `idle-pending` queue WITH `scheduledStartAt` + operator pause →
//       • lifecycle transitions to `operator-paused`
//       • `scheduledStartAt` is **cleared** (null)
//       • `scheduledStartSource` is **cleared** (null)
//       • `scheduled-start-canceled` audit event emitted with
//         `transitionReason: 'pause-cancel'`
//       • `idle-pending-exited { exitReason: 'pause' }` audit event
//         emitted AFTER the cancel
//   (B) Subsequent resume with pending tasks →
//       • lifecycle returns to `idle-pending`
//       • `scheduledStartAt === null` (operator must reschedule)
//       • `idle-pending-entered { transitionReason: 'resume-from-pause' }`
//   (C) Resume with no pending tasks → `active-empty` (no
//       `idle-pending-entered` event).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { makeHarness, type Harness } from './enqueue-start-separation.helpers';

let h: Harness;

function pendingCount(): number {
  return h.store.getQueue('default').requests.filter((r) => r.status === 'pending').length;
}

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(() => {
  h.cleanup();
});

describe('Feature 065 (T035) — User Story 3 regression: pause cancels scheduled start (FR-019)', () => {
  it('(A) idle-pending + scheduledStartAt + pause → clears schedule, emits scheduled-start-canceled then idle-pending-exited', async () => {
    const scheduledAt = h.clock.now() + 60 * 60 * 1000;
    const first = await h.service.scheduleOrEnqueue({
      description: 'pending-task',
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

    const armed = h.store.getQueue('default');
    expect(armed.queueLifecycle).toBe('idle-pending');
    expect(armed.scheduledStartAt).toBe(scheduledAt);
    expect(armed.scheduledStartSource).toBe('operator-chooser');
    expect(pendingCount()).toBe(1);

    // Pre-pause baseline.
    const baselineCanceled = h.audit.byType('scheduled-start-canceled').length;
    const baselineExited = h.audit.byType('idle-pending-exited').length;

    // Operator pauses (positional signature: paused, queueId, pausedReason, pauseSource).
    await h.queue.setQueuePausedState(true, undefined, 'operator', 'operator');

    const paused = h.store.getQueue('default');
    expect(paused.queueLifecycle).toBe('operator-paused');
    expect(paused.pausedReason).toBe('operator');
    // Schedule fields are cleared.
    expect(paused.scheduledStartAt).toBeNull();
    expect(paused.scheduledStartSource).toBeNull();

    // scheduled-start-canceled was emitted with pause-cancel transitionReason.
    const canceledEvents = h.audit.byType('scheduled-start-canceled');
    expect(canceledEvents.length).toBe(baselineCanceled + 1);
    const cancelEvent = canceledEvents[canceledEvents.length - 1];
    expect(cancelEvent.payload).toMatchObject({
      transitionReason: 'pause-cancel'
    });

    // idle-pending-exited followed AFTER the cancel (per task ordering rule).
    const exitedEvents = h.audit.byType('idle-pending-exited');
    expect(exitedEvents.length).toBe(baselineExited + 1);
    const exitEvent = exitedEvents[exitedEvents.length - 1];
    expect(exitEvent.payload).toMatchObject({
      exitReason: 'pause'
    });

    // Ordering invariant: cancel before exit.
    const cancelIdx = h.audit.entries.indexOf(cancelEvent);
    const exitIdx = h.audit.entries.indexOf(exitEvent);
    expect(cancelIdx).toBeLessThan(exitIdx);
  });

  it('(B) resume with pending tasks → idle-pending with scheduledStartAt === null, emits idle-pending-entered { resume-from-pause }', async () => {
    // Arrange: arm a schedule, then pause.
    const scheduledAt = h.clock.now() + 60 * 60 * 1000;
    await h.service.scheduleOrEnqueue({
      description: 'pending-task',
      scheduledAt: h.clock.now(),
      via: 'webview',
      startIntent: {
        startMode: 'scheduled',
        scheduledStartAt: scheduledAt,
        source: 'operator-chooser'
      },
      callerKind: 'human'
    });
    await h.queue.setQueuePausedState(true, undefined, 'operator', 'operator');

    // Pre-resume baseline.
    expect(h.store.getQueue('default').queueLifecycle).toBe('operator-paused');
    expect(pendingCount()).toBe(1);
    const baselineEntered = h.audit.byType('idle-pending-entered').length;

    // Operator resumes.
    await h.queue.setQueuePausedState(false, undefined, null, 'operator');

    const resumed = h.store.getQueue('default');
    // Lifecycle returns to idle-pending (pending.length > 0, no inFlight).
    expect(resumed.queueLifecycle).toBe('idle-pending');
    expect(resumed.pausedReason).toBeNull();
    // scheduledStartAt is still null — operator must reschedule.
    expect(resumed.scheduledStartAt).toBeNull();
    expect(resumed.scheduledStartSource).toBeNull();

    // idle-pending-entered emitted with resume-from-pause.
    const enteredEvents = h.audit.byType('idle-pending-entered');
    expect(enteredEvents.length).toBe(baselineEntered + 1);
    const enterEvent = enteredEvents[enteredEvents.length - 1];
    expect(enterEvent.payload).toMatchObject({
      transitionReason: 'resume-from-pause'
    });
  });

  it('(C) resume with no pending tasks → active-empty, no idle-pending-entered event', async () => {
    // Arrange: arm a schedule, pause, then manually drain pending so resume
    // path lands in active-empty branch.
    const scheduledAt = h.clock.now() + 60 * 60 * 1000;
    await h.service.scheduleOrEnqueue({
      description: 'pending-task',
      scheduledAt: h.clock.now(),
      via: 'webview',
      startIntent: {
        startMode: 'scheduled',
        scheduledStartAt: scheduledAt,
        source: 'operator-chooser'
      },
      callerKind: 'human'
    });
    await h.queue.setQueuePausedState(true, undefined, 'operator', 'operator');

    // Clear pending tasks while paused (simulate operator discard).
    const paused = h.store.getQueue('default');
    await h.store.setQueue({
      ...paused,
      requests: paused.requests.filter((r) => r.status !== 'pending'),
      updatedAt: h.clock.now()
    });
    expect(pendingCount()).toBe(0);

    const baselineEntered = h.audit.byType('idle-pending-entered').length;

    // Operator resumes with no pending tasks.
    await h.queue.setQueuePausedState(false, undefined, null, 'operator');

    const resumed = h.store.getQueue('default');
    // Lifecycle goes to active-empty (no pending, no inFlight).
    expect(resumed.queueLifecycle).toBe('active-empty');
    expect(resumed.scheduledStartAt).toBeNull();
    expect(resumed.scheduledStartSource).toBeNull();

    // No idle-pending-entered event was emitted on this branch.
    expect(h.audit.byType('idle-pending-entered').length).toBe(baselineEntered);
  });
});
