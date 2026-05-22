// Feature 065 (T043) — Story 5 end-to-end: wake-up + programmatic paths.
//
// Coverage map per tasks.md T043:
//   (a) automation + `startMode: 'now'` → immediate promotion (running),
//       no chooser surface.
//   (b) automation + `startMode: 'scheduled'` valid timestamp → lands in
//       `idle-pending`; fires at scheduled time.
//   (c) automation + omitted `startMode` → lands in `idle-pending` with
//       `scheduledStartAt = null`, AND a warn-level
//       `automation-enqueue-no-start-mode` event is emitted with
//       `callerId`.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { makeHarness, type Harness } from './enqueue-start-separation.helpers';

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(() => {
  h.cleanup();
});

describe('Feature 065 (T043) — User Story 5: wake-up + programmatic paths', () => {
  it('(a) automation + startMode=now → immediate promotion to running, no chooser', async () => {
    const result = await h.service.scheduleOrEnqueue({
      description: 'wake-up task',
      scheduledAt: h.clock.now(),
      via: 'command-palette',
      startIntent: {
        startMode: 'now',
        source: 'wake-up-runner'
      },
      callerKind: 'automation',
      callerId: 'wake-up'
    });
    expect(result.outcome).toBe('enqueued');
    expect(result.lifecycleAfter).toBe('running');

    const after = h.store.getQueue();
    expect(after.queueLifecycle).toBe('running');
    expect(after.scheduledStartAt).toBeNull();
    expect(after.scheduledStartSource).toBeNull();
    // No scheduled-start-armed event (skipped on 'now' path).
    expect(h.audit.byType('scheduled-start-armed').length).toBe(0);
    // No idle-pending-entered event (queue went straight to running).
    expect(h.audit.byType('idle-pending-entered').length).toBe(0);
  });

  it('(b) automation + startMode=scheduled → lands in idle-pending; fires at scheduled time', async () => {
    const scheduledAt = h.clock.now() + 60 * 60 * 1000;
    const result = await h.service.scheduleOrEnqueue({
      description: 'scheduled automation task',
      scheduledAt: h.clock.now(),
      via: 'webview',
      startIntent: {
        startMode: 'scheduled',
        scheduledStartAt: scheduledAt,
        source: 'programmatic-scheduled'
      },
      callerKind: 'automation',
      callerId: 'cli-schedule'
    });
    expect(result.outcome).toBe('enqueued');
    expect(result.lifecycleAfter).toBe('idle-pending');

    const armed = h.store.getQueue();
    expect(armed.queueLifecycle).toBe('idle-pending');
    expect(armed.scheduledStartAt).toBe(scheduledAt);
    expect(armed.scheduledStartSource).toBe('programmatic-scheduled');
    // scheduled-start-armed emitted.
    const armedEvents = h.audit.byType('scheduled-start-armed');
    expect(armedEvents.length).toBe(1);
    expect(armedEvents[0].payload).toMatchObject({
      scheduledStartAt: scheduledAt,
      scheduledStartSource: 'programmatic-scheduled'
    });

    // Advance clock to the fire moment; trigger the fake timer to simulate
    // setTimeout firing.
    h.clock.set(scheduledAt + 1);
    h.fakeTimer.fireDue(h.clock.now());
    // Allow async fire/onFire callback to settle.
    await new Promise((r) => setImmediate(r));

    const fired = h.store.getQueue();
    expect(fired.queueLifecycle).toBe('running');
    expect(fired.scheduledStartAt).toBeNull();
    expect(fired.scheduledStartSource).toBeNull();
    expect(h.audit.byType('scheduled-start-fired').length).toBe(1);
  });

  it('(c) automation + omitted startMode → idle-pending with null schedule; emits automation-enqueue-no-start-mode with callerId', async () => {
    const callerId = 'legacy-automation-suite';
    const result = await h.service.scheduleOrEnqueue({
      description: 'automation task without startMode',
      scheduledAt: h.clock.now(),
      via: 'webview',
      callerKind: 'automation',
      callerId
    });
    expect(result.outcome).toBe('enqueued');
    expect(result.lifecycleAfter).toBe('idle-pending');

    const after = h.store.getQueue();
    expect(after.queueLifecycle).toBe('idle-pending');
    expect(after.scheduledStartAt).toBeNull();
    expect(after.scheduledStartSource).toBeNull();

    // automation-enqueue-no-start-mode warn-level event emitted with callerId.
    const warnEvents = h.audit.byType('automation-enqueue-no-start-mode');
    expect(warnEvents.length).toBe(1);
    expect(warnEvents[0].payload).toMatchObject({
      callerId,
      transitionReason: 'automation-no-start-mode'
    });
  });
});
