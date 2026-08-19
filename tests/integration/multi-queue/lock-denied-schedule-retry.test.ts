import { describe, expect, it } from 'vitest';
import { makeScheduleHarness, settle, DEFAULT_NOW } from './schedule-harness';
import { DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';

// FR-R3-002 (T291) — a schedule denied by a foreign lock is retried.
//
// Seam 4 of FUNC-02: `QueueScheduleWatchdog.tick()` returned `[]` unconditionally
// — a feature-030 no-op left behind when the deadline moved from
// `QueueRegistryEntry.schedule` to `QueueState.scheduledStartAt`. Nothing swept
// for a queue whose start had been refused, so the recovery path the
// lock-unavailable branch promised did not exist.
//
// The other half of the same defect was in the coordinator: on `lock-unavailable`
// it cleared `scheduledStartAt` "so auto-drain takes over". Auto-drain refuses an
// `idle-pending` queue by design, and once the deadline was gone the entry was
// indistinguishable from one an operator had dismissed — so even a working
// watchdog would have had nothing to recognise. The two fixes are one behaviour:
// retain the deadline so the shape is durable, and sweep for exactly that shape.
//
// Both halves are asserted here, in the order they occur.

const QUEUE_B = 'queue-b';

describe('lock-denied schedule retry (FR-R3-002)', () => {
  it('retains the deadline when a foreign lock denies the fire', async () => {
    const h = await makeScheduleHarness();
    await h.armSchedule(QUEUE_B, DEFAULT_NOW + 60_000);
    h.foreignLockHeld = true;

    h.clock.advance(60_000);
    h.fakeTimer.fireDue(h.clock.now());
    await settle();

    const denied = h.read(QUEUE_B);
    expect(denied.queueLifecycle).toBe('idle-pending');
    expect(denied.scheduledStartAt).toBe(DEFAULT_NOW + 60_000);
    expect(denied.scheduledStartSource).toBe('operator-chooser');
    // Nothing ran, and the in-process timer is gone — this is the state that
    // used to be unreachable by any promoter.
    expect(h.drained).toEqual([]);
    expect(h.coordinator.hasActiveTimer(QUEUE_B)).toBe(false);
  });

  it('reports the denial as lock-unavailable rather than as a fire', async () => {
    const h = await makeScheduleHarness();
    await h.armSchedule(QUEUE_B, DEFAULT_NOW + 60_000);
    h.foreignLockHeld = true;

    h.clock.advance(60_000);
    h.fakeTimer.fireDue(h.clock.now());
    await settle();

    expect(h.audit.byType('scheduled-start-fired')).toHaveLength(0);
    const superseded = h.audit.byType('scheduled-start-superseded');
    expect(superseded).toHaveLength(1);
    expect(superseded[0]!.payload).toMatchObject({
      queueId: QUEUE_B,
      superseder: 'lock-unavailable'
    });
  });

  it('promotes the denied queue on the next tick once the lock frees', async () => {
    const h = await makeScheduleHarness();
    await h.armSchedule(QUEUE_B, DEFAULT_NOW + 60_000);
    h.foreignLockHeld = true;

    h.clock.advance(60_000);
    h.fakeTimer.fireDue(h.clock.now());
    await settle();
    expect(h.drained).toEqual([]);

    // The rival window exits; this one is primary and sweeps.
    h.foreignLockHeld = false;
    h.clock.advance(30_000);
    await expect(h.watchdog.tick()).resolves.toEqual([QUEUE_B]);

    const recovered = h.read(QUEUE_B);
    expect(recovered.queueLifecycle).toBe('active-empty');
    expect(recovered.scheduledStartAt).toBeNull();
    expect(recovered.scheduledStartSource).toBeNull();
    expect(h.drained).toEqual([QUEUE_B]);
  });

  it('records the recovery as watchdog-recovered with the FR-023a core payload', async () => {
    const h = await makeScheduleHarness();
    await h.armSchedule(QUEUE_B, DEFAULT_NOW + 60_000);
    h.foreignLockHeld = true;
    h.clock.advance(60_000);
    h.fakeTimer.fireDue(h.clock.now());
    await settle();

    h.foreignLockHeld = false;
    h.clock.advance(30_000);
    await h.watchdog.tick();

    const fired = h.audit.byType('scheduled-start-fired');
    expect(fired).toHaveLength(1);
    expect(fired[0]!.payload).toMatchObject({
      queueId: QUEUE_B,
      occurredAt: DEFAULT_NOW + 90_000,
      transitionReason: 'watchdog-recovered',
      scheduledStartAt: DEFAULT_NOW + 60_000,
      lateByMs: 30_000
    });
    // No task description or other operator-authored content.
    expect(JSON.stringify(fired[0]!.payload)).not.toMatch(/description|featureDir|prompt/i);
  });

  it('does not promote while this window is still not primary', async () => {
    const h = await makeScheduleHarness();
    await h.armSchedule(QUEUE_B, DEFAULT_NOW + 60_000);
    h.foreignLockHeld = true;
    h.clock.advance(60_000);
    h.fakeTimer.fireDue(h.clock.now());
    await settle();

    h.primary = false;
    h.clock.advance(30_000);
    await expect(h.watchdog.tick()).resolves.toEqual([]);
    expect(h.read(QUEUE_B).queueLifecycle).toBe('idle-pending');
    expect(h.drained).toEqual([]);
  });

  it('leaves a sibling queue whose timer is still armed to its own timer', async () => {
    // The watchdog is a recovery sweep, not a second scheduler: a queue the
    // coordinator still holds a live handle for is not its to promote, or the
    // start fires twice.
    const h = await makeScheduleHarness();
    await h.armSchedule(QUEUE_B, DEFAULT_NOW + 60_000);
    await h.armSchedule(DEFAULT_QUEUE_ID, DEFAULT_NOW + 60_000);
    h.foreignLockHeld = true;
    h.clock.advance(60_000);
    // Only queue B's timer is allowed to elapse; Default's stays armed.
    const bTimer = h.fakeTimer.timers.find((t) => !t.cleared);
    bTimer!.fn();
    bTimer!.cleared = true;
    await settle();

    h.foreignLockHeld = false;
    await expect(h.watchdog.tick()).resolves.toEqual([QUEUE_B]);
    expect(h.coordinator.hasActiveTimer(DEFAULT_QUEUE_ID)).toBe(true);
    expect(h.read(DEFAULT_QUEUE_ID).queueLifecycle).toBe('idle-pending');
  });

  it('is a no-op tick when no queue is due (the ordinary case)', async () => {
    const h = await makeScheduleHarness();
    await h.armSchedule(QUEUE_B, DEFAULT_NOW + 3_600_000);

    await expect(h.watchdog.tick()).resolves.toEqual([]);
    expect(h.drained).toEqual([]);
    expect(h.audit.byType('scheduled-start-fired')).toHaveLength(0);
  });
});
