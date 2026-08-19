import { describe, expect, it } from 'vitest';
import { makeScheduleHarness, settle, DEFAULT_NOW } from './schedule-harness';

// Feature 098 (FR-031a) — the empty-catalog refusal survives the recovery sweep.
//
// `ScheduledStartCoordinator.refuseOnEmptyCatalog()` refuses a due start when no
// Pipeline is importable: it drops the in-process timer, tells the operator, and
// deliberately leaves `queueLifecycle: 'idle-pending'` with `scheduledStartAt`
// still persisted (the coordinator writes no state of its own). That is, bit for
// bit, the state `QueueScheduleWatchdog.tick()` was built to recognise as "due
// and unowned" for the lock-unavailable case — same lifecycle, same retained
// deadline, same absent timer.
//
// So the two features composed into a defect that neither one contains: the
// refusal held for a tick interval and was then undone, and the operator who had
// just been told the catalog was empty got a run started for them within a
// minute. Nothing failed loudly; the audit trail even recorded it as a recovery.
//
// This file is the composition test. The unit tests on either side cannot see
// this — the coordinator's pass and the watchdog's pass are both green with the
// bug present, because each is correct about its own half.

const QUEUE_B = 'queue-b';

describe('an empty Process catalog holds a due schedule (FR-031a)', () => {
  it('refuses the fire and leaves the deadline persisted', async () => {
    const h = await makeScheduleHarness();
    await h.armSchedule(QUEUE_B, DEFAULT_NOW + 60_000);
    h.catalogEmpty = true;

    h.clock.advance(60_000);
    h.fakeTimer.fireDue(h.clock.now());
    await settle();

    expect(h.refusals).toHaveLength(1);
    expect(h.refusals[0]!.queueId).toBe(QUEUE_B);
    expect(h.drained).toEqual([]);
    const held = h.read(QUEUE_B);
    expect(held.queueLifecycle).toBe('idle-pending');
    expect(held.scheduledStartAt).toBe(DEFAULT_NOW + 60_000);
    expect(h.coordinator.hasActiveTimer(QUEUE_B)).toBe(false);
  });

  it('does not let the watchdog undo the refusal on the next sweep', async () => {
    const h = await makeScheduleHarness();
    await h.armSchedule(QUEUE_B, DEFAULT_NOW + 60_000);
    h.catalogEmpty = true;
    h.clock.advance(60_000);
    h.fakeTimer.fireDue(h.clock.now());
    await settle();

    // One tick interval later, with the catalog still empty.
    h.clock.advance(60_000);
    await expect(h.watchdog.tick()).resolves.toEqual([]);

    expect(h.drained).toEqual([]);
    expect(h.read(QUEUE_B).queueLifecycle).toBe('idle-pending');
    // And no second refusal, no `watchdog-recovered` row: the operator was told
    // once, at fire time, and the sweep adds nothing to that.
    expect(h.refusals).toHaveLength(1);
    expect(h.audit.byType('scheduled-start-fired')).toHaveLength(0);
  });

  it('stays held across repeated sweeps rather than firing on a later one', async () => {
    const h = await makeScheduleHarness();
    await h.armSchedule(QUEUE_B, DEFAULT_NOW + 60_000);
    h.catalogEmpty = true;
    h.clock.advance(60_000);
    h.fakeTimer.fireDue(h.clock.now());
    await settle();

    for (let i = 0; i < 5; i++) {
      h.clock.advance(60_000);
      await expect(h.watchdog.tick()).resolves.toEqual([]);
    }
    expect(h.drained).toEqual([]);
    expect(h.refusals).toHaveLength(1);
  });

  it('promotes the held queue on the first sweep after an import', async () => {
    // The hold is on the catalog being empty, not on the queue being refused —
    // so it lifts the moment the operator imports a Pipeline, with no re-arm
    // and no operator action on the queue itself. The retained deadline is what
    // makes that possible.
    const h = await makeScheduleHarness();
    await h.armSchedule(QUEUE_B, DEFAULT_NOW + 60_000);
    h.catalogEmpty = true;
    h.clock.advance(60_000);
    h.fakeTimer.fireDue(h.clock.now());
    await settle();

    h.catalogEmpty = false;
    h.clock.advance(60_000);
    await expect(h.watchdog.tick()).resolves.toEqual([QUEUE_B]);

    expect(h.drained).toEqual([QUEUE_B]);
    const promoted = h.read(QUEUE_B);
    expect(promoted.queueLifecycle).toBe('active-empty');
    expect(promoted.scheduledStartAt).toBeNull();
    const fired = h.audit.byType('scheduled-start-fired');
    expect(fired).toHaveLength(1);
    expect(fired[0]!.payload).toMatchObject({
      queueId: QUEUE_B,
      transitionReason: 'watchdog-recovered'
    });
  });

  it('holds the whole sweep, not just the queue that was refused', async () => {
    // An empty catalog is a property of the host, not of a queue. A sibling
    // whose deadline elapsed while this window was closed has never met the
    // gate at all — `reArm` is what would have shown it the refusal — so
    // per-queue bookkeeping would have let it through.
    const h = await makeScheduleHarness();
    await h.armSchedule(QUEUE_B, DEFAULT_NOW + 60_000);
    h.catalogEmpty = true;
    h.clock.advance(60_000);
    h.fakeTimer.fireDue(h.clock.now());
    await settle();

    // A second queue arrives already due, with no timer ever armed for it.
    await h.putQueue('queue-c', {
      queueLifecycle: 'idle-pending',
      pauseSource: null,
      scheduledStartAt: h.clock.now() - 1,
      scheduledStartSource: 'operator-chooser'
    });

    await expect(h.watchdog.tick()).resolves.toEqual([]);
    expect(h.drained).toEqual([]);
    expect(h.read('queue-c').queueLifecycle).toBe('idle-pending');
  });
});
