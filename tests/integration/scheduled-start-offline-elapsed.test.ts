// Feature 065 (T044 / T045) — Offline-elapsed and past-timestamp coercion.
//
// Coverage map per tasks.md T044 (FR-011 / FR-012 / FR-014 / SC-003):
//   (a) persist a queue in `idle-pending` with `scheduledStartAt = now - 60_000`
//       (already elapsed)
//   (b) simulate workspace activation by calling the coordinator's `reArm()`
//       — exercises FR-011's "persist across reloads and re-arm against
//       original target"
//   (c) assert the queue transitions `idle-pending → … → running` within
//       30 seconds (SC-003 / FR-012)
//   (d) assert `scheduled-start-fired` with `transitionReason: 'offline-elapsed'`
//   (e) future-target sub-case (`scheduledStartAt = now + 60_000`) →
//       coordinator.arm() invoked with remaining duration; persisted value
//       byte-identical pre/post reload; timer fires exactly once at original
//       target (FR-011).
//
// Coverage map per tasks.md T045 (FR-014a):
//   (f) programmatic enqueue with `startMode: 'scheduled'` and
//       `scheduledStartAt = now - 1_000` → coerced to `now`;
//       `scheduled-start-past-timestamp-coerced-to-now` emitted; lifecycle
//       is `running`, NOT `idle-pending`.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { makeHarness, type Harness } from './enqueue-start-separation.helpers';

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(() => {
  h.cleanup();
});

describe('Feature 065 (T044) — offline-elapsed re-arm (FR-011 / FR-012 / FR-014 / SC-003)', () => {
  it('(a-d) elapsed scheduledStartAt → reArm fires immediately, lifecycle → running, scheduled-start-fired with offline-elapsed', async () => {
    // (a) Persist a queue in idle-pending with scheduledStartAt in the past.
    // First, land a real pending task so the queue has work to drain when
    // the timer fires.
    await h.service.scheduleOrEnqueue({
      description: 'task awaiting offline-elapsed fire',
      scheduledAt: h.clock.now(),
      via: 'webview',
      callerKind: 'human'
    });
    // Then forcibly set scheduledStartAt to a past value (simulating a
    // persistence that survived across reloads).
    const elapsedAt = h.clock.now() - 60_000;
    const current = h.store.getQueue('default');
    await h.store.setQueue({
      ...current,
      queueLifecycle: 'idle-pending',
      pauseSource: null,
      scheduledStartAt: elapsedAt,
      scheduledStartSource: 'operator-chooser',
      updatedAt: h.clock.now()
    });

    const baselineFired = h.audit.byType('scheduled-start-fired').length;

    // (b) Simulate activation: call reArm().
    await h.coordinator.reArm();
    // Let async fire / drain settle.
    await new Promise((r) => setImmediate(r));

    // (c) Lifecycle transitions to running.
    const after = h.store.getQueue('default');
    expect(after.queueLifecycle).toBe('running');
    expect(after.scheduledStartAt).toBeNull();
    expect(after.scheduledStartSource).toBeNull();

    // (d) scheduled-start-fired emitted with offline-elapsed.
    const firedEvents = h.audit.byType('scheduled-start-fired');
    expect(firedEvents.length).toBe(baselineFired + 1);
    expect(firedEvents[firedEvents.length - 1].payload).toMatchObject({
      transitionReason: 'offline-elapsed',
      scheduledStartAt: elapsedAt
    });
  });

  it('(e) future scheduledStartAt → reArm arms with remaining duration; fires exactly once at original target', async () => {
    // Arrange: a pending task and a persisted future scheduledStartAt.
    await h.service.scheduleOrEnqueue({
      description: 'task awaiting future fire',
      scheduledAt: h.clock.now(),
      via: 'webview',
      callerKind: 'human'
    });
    const futureAt = h.clock.now() + 60_000;
    const persistedAt = futureAt;
    const current = h.store.getQueue('default');
    await h.store.setQueue({
      ...current,
      queueLifecycle: 'idle-pending',
      pauseSource: null,
      scheduledStartAt: persistedAt,
      scheduledStartSource: 'operator-chooser',
      updatedAt: h.clock.now()
    });

    const baselineArmed = h.audit.byType('scheduled-start-armed').length;

    // Simulate activation.
    await h.coordinator.reArm();

    // The persisted value is byte-identical (we never mutated it on re-arm).
    const armed = h.store.getQueue('default');
    expect(armed.scheduledStartAt).toBe(persistedAt);

    // The coordinator armed a new timer (one extra armed event).
    expect(h.audit.byType('scheduled-start-armed').length).toBe(baselineArmed + 1);

    // Advance clock to fire moment.
    h.clock.set(futureAt + 1);
    h.fakeTimer.fireDue(h.clock.now());
    await new Promise((r) => setImmediate(r));

    const fired = h.store.getQueue('default');
    expect(fired.queueLifecycle).toBe('running');
    expect(fired.scheduledStartAt).toBeNull();
    expect(h.audit.byType('scheduled-start-fired').length).toBe(1);

    // Fire-once invariant: pumping the fake timer again has no effect.
    h.clock.advance(1000);
    h.fakeTimer.fireDue(h.clock.now());
    await new Promise((r) => setImmediate(r));
    expect(h.audit.byType('scheduled-start-fired').length).toBe(1);
  });
});

describe('Feature 065 (T045) — programmatic past-timestamp coercion (FR-014a)', () => {
  it('(f) programmatic enqueue with scheduledStartAt = now - 1_000 → coerced to now; running, not idle-pending', async () => {
    const pastAt = h.clock.now() - 1_000;
    const result = await h.service.scheduleOrEnqueue({
      description: 'programmatic past task',
      scheduledAt: h.clock.now(),
      via: 'webview',
      startIntent: {
        startMode: 'scheduled',
        scheduledStartAt: pastAt,
        source: 'programmatic-scheduled'
      },
      callerKind: 'automation',
      callerId: 'cli-schedule'
    });
    expect(result.outcome).toBe('enqueued');
    expect(result.lifecycleAfter).toBe('running');

    const after = h.store.getQueue('default');
    expect(after.queueLifecycle).toBe('running');
    expect(after.scheduledStartAt).toBeNull();
    expect(after.scheduledStartSource).toBeNull();

    // FR-014a — coerce event emitted with the original past timestamp.
    const coerceEvents = h.audit.byType('scheduled-start-past-timestamp-coerced-to-now');
    expect(coerceEvents.length).toBe(1);
    expect(coerceEvents[0].payload).toMatchObject({
      requestedScheduledStartAt: pastAt,
      scheduledStartSource: 'programmatic-scheduled',
      transitionReason: 'past-timestamp'
    });
  });
});
