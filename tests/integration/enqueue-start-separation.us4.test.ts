// Feature 065 (T039) — Story 4 end-to-end: cancel / change / convert-to-now.
//
// Coverage map per tasks.md T039 (FR-015):
//   (a) cancel → `scheduledStartAt = null`, lifecycle stays `idle-pending`,
//       `scheduled-start-canceled` event (FR-015 cancel branch).
//   (b) change → `scheduled-start-canceled` (old) followed by
//       `scheduled-start-armed` (new); `scheduledStartAt` updated; lifecycle
//       stays `idle-pending` (FR-015 change branch).
//   (c) convert-to-now → `scheduled-start-canceled` followed by
//       `idle-pending-exited { exitReason: 'operator-start-now' }` and
//       lifecycle transitions to `running` (FR-015 convert-to-now branch).
//
// The operator-restart paths are invoked directly via the service method
// `applyStartQueueIntent` — the same method the `schegent.startQueue` host
// command delegates to when its payload carries a `startIntent`.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { makeHarness, type Harness } from './enqueue-start-separation.helpers';

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(() => {
  h.cleanup();
});

describe('Feature 065 (T039) — User Story 4: cancel / change / convert-to-now (FR-015)', () => {
  async function armSchedule(scheduledAt: number) {
    const result = await h.service.scheduleOrEnqueue({
      description: 'task',
      scheduledAt: h.clock.now(),
      via: 'webview',
      startIntent: {
        startMode: 'scheduled',
        scheduledStartAt: scheduledAt,
        source: 'operator-chooser'
      },
      callerKind: 'human'
    });
    expect(result.outcome).toBe('enqueued');
    expect(h.store.getQueue('default').queueLifecycle).toBe('idle-pending');
    expect(h.store.getQueue('default').scheduledStartAt).toBe(scheduledAt);
  }

  it('(a) cancel → scheduledStartAt = null, lifecycle stays idle-pending, scheduled-start-canceled emitted', async () => {
    const scheduledAt = h.clock.now() + 60 * 60 * 1000;
    await armSchedule(scheduledAt);
    const baselineCanceled = h.audit.byType('scheduled-start-canceled').length;
    const baselineExited = h.audit.byType('idle-pending-exited').length;

    const out = await h.service.applyStartQueueIntent({
      startMode: 'cancel-schedule',
      source: 'operator-restart'
    });
    expect(out.outcome).toBe('applied');
    expect(out.lifecycleAfter).toBe('idle-pending');

    const after = h.store.getQueue('default');
    expect(after.queueLifecycle).toBe('idle-pending');
    expect(after.scheduledStartAt).toBeNull();
    expect(after.scheduledStartSource).toBeNull();
    // Task is preserved (not removed by cancel-schedule).
    expect(after.requests.filter((r) => r.status === 'pending').length).toBe(1);

    // scheduled-start-canceled emitted with operator-cancel reason.
    const canceledEvents = h.audit.byType('scheduled-start-canceled');
    expect(canceledEvents.length).toBe(baselineCanceled + 1);
    expect(canceledEvents[canceledEvents.length - 1].payload).toMatchObject({
      transitionReason: 'operator-cancel'
    });
    // No idle-pending-exited event (lifecycle stays idle-pending).
    expect(h.audit.byType('idle-pending-exited').length).toBe(baselineExited);
  });

  it('(b) change → scheduled-start-canceled (old) followed by scheduled-start-armed (new); scheduledStartAt updated', async () => {
    const oldAt = h.clock.now() + 60 * 60 * 1000;
    const newAt = h.clock.now() + 2 * 60 * 60 * 1000;
    await armSchedule(oldAt);
    const baselineCanceled = h.audit.byType('scheduled-start-canceled').length;
    const baselineArmed = h.audit.byType('scheduled-start-armed').length;

    const out = await h.service.applyStartQueueIntent({
      startMode: 'scheduled',
      scheduledStartAt: newAt,
      source: 'operator-restart'
    });
    expect(out.outcome).toBe('applied');
    expect(out.lifecycleAfter).toBe('idle-pending');

    const after = h.store.getQueue('default');
    expect(after.queueLifecycle).toBe('idle-pending');
    expect(after.scheduledStartAt).toBe(newAt);
    expect(after.scheduledStartSource).toBe('operator-restart');

    // Canceled (old) then armed (new) — both emitted, in order.
    const canceledEvents = h.audit.byType('scheduled-start-canceled');
    const armedEvents = h.audit.byType('scheduled-start-armed');
    expect(canceledEvents.length).toBe(baselineCanceled + 1);
    expect(armedEvents.length).toBe(baselineArmed + 1);
    const cancelEvent = canceledEvents[canceledEvents.length - 1];
    const armEvent = armedEvents[armedEvents.length - 1];
    expect(cancelEvent.payload).toMatchObject({ transitionReason: 'change-schedule' });
    expect(armEvent.payload).toMatchObject({
      scheduledStartAt: newAt,
      scheduledStartSource: 'operator-restart'
    });
    // Ordering invariant: cancel before arm.
    const cancelIdx = h.audit.entries.indexOf(cancelEvent);
    const armIdx = h.audit.entries.indexOf(armEvent);
    expect(cancelIdx).toBeLessThan(armIdx);
  });

  it('(c) convert-to-now → scheduled-start-canceled then idle-pending-exited { operator-start-now }, lifecycle → running', async () => {
    const scheduledAt = h.clock.now() + 60 * 60 * 1000;
    await armSchedule(scheduledAt);
    const baselineCanceled = h.audit.byType('scheduled-start-canceled').length;
    const baselineExited = h.audit.byType('idle-pending-exited').length;

    const out = await h.service.applyStartQueueIntent({
      startMode: 'now',
      source: 'operator-restart'
    });
    expect(out.outcome).toBe('applied');
    expect(out.lifecycleAfter).toBe('running');

    const after = h.store.getQueue('default');
    expect(after.queueLifecycle).toBe('running');
    expect(after.scheduledStartAt).toBeNull();
    expect(after.scheduledStartSource).toBeNull();

    // scheduled-start-canceled then idle-pending-exited (in order).
    const canceledEvents = h.audit.byType('scheduled-start-canceled');
    const exitedEvents = h.audit.byType('idle-pending-exited');
    expect(canceledEvents.length).toBe(baselineCanceled + 1);
    expect(exitedEvents.length).toBe(baselineExited + 1);
    const cancelEvent = canceledEvents[canceledEvents.length - 1];
    const exitEvent = exitedEvents[exitedEvents.length - 1];
    expect(cancelEvent.payload).toMatchObject({ transitionReason: 'operator-cancel' });
    expect(exitEvent.payload).toMatchObject({
      exitReason: 'operator-start-now',
      transitionReason: 'operator-start-now'
    });
    const cancelIdx = h.audit.entries.indexOf(cancelEvent);
    const exitIdx = h.audit.entries.indexOf(exitEvent);
    expect(cancelIdx).toBeLessThan(exitIdx);
  });
});
