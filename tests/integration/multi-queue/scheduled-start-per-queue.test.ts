import { describe, expect, it } from 'vitest';
import { makeScheduleHarness, settle, DEFAULT_NOW } from './schedule-harness';
import { DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';

// FR-R3-002 (T289) — a scheduled start fires on the queue that armed it.
//
// Seam 2 of FUNC-02: `extension.ts` wired the coordinator with
// `onFire: async (_queueId: string) => { await store.updateQueue(...) }`. The
// handler received the fired queue id and threw it away, so the write landed on
// whichever queue `updateQueue`'s default parameter named — always Default.
// A schedule armed on queue B therefore promoted queue A: A started work nobody
// asked it to start, and B stayed `idle-pending` with its deadline elapsed and
// no timer left to fire it.
//
// Both halves are asserted, because either alone is satisfiable by the defect:
// "B was promoted" alone passes when B *is* Default, and "A was untouched"
// alone passes when nothing fired at all.

const QUEUE_B = 'queue-b';

describe('scheduled start on a non-Default queue (FR-R3-002)', () => {
  it('promotes the queue that armed the schedule', async () => {
    const h = await makeScheduleHarness();
    await h.armSchedule(QUEUE_B, DEFAULT_NOW + 60_000);

    h.clock.advance(60_000);
    h.fakeTimer.fireDue(h.clock.now());
    await settle();

    const b = h.read(QUEUE_B);
    expect(b.queueLifecycle).toBe('active-empty');
    expect(b.scheduledStartAt).toBeNull();
    expect(b.scheduledStartSource).toBeNull();
  });

  it('leaves the Default queue untouched when a sibling fires', async () => {
    const h = await makeScheduleHarness();
    // Default carries its own armed start, further out. It is the queue the
    // discarded-id write would have landed on.
    await h.armSchedule(DEFAULT_QUEUE_ID, DEFAULT_NOW + 3_600_000);
    await h.armSchedule(QUEUE_B, DEFAULT_NOW + 60_000);

    h.clock.advance(60_000);
    h.fakeTimer.fireDue(h.clock.now());
    await settle();

    const a = h.read(DEFAULT_QUEUE_ID);
    expect(a.queueLifecycle).toBe('idle-pending');
    expect(a.scheduledStartAt).toBe(DEFAULT_NOW + 3_600_000);
    expect(a.scheduledStartSource).toBe('operator-chooser');
    // Default's timer is still armed — firing B must not disarm it either.
    expect(h.coordinator.hasActiveTimer(DEFAULT_QUEUE_ID)).toBe(true);
  });

  it('drains the queue that fired, and only that queue', async () => {
    const h = await makeScheduleHarness();
    await h.armSchedule(DEFAULT_QUEUE_ID, DEFAULT_NOW + 3_600_000);
    await h.armSchedule(QUEUE_B, DEFAULT_NOW + 60_000);

    h.clock.advance(60_000);
    h.fakeTimer.fireDue(h.clock.now());
    await settle();

    expect(h.drained).toEqual([QUEUE_B]);
  });

  it('names the firing queue in the scheduled-start-fired audit event', async () => {
    const h = await makeScheduleHarness();
    await h.armSchedule(QUEUE_B, DEFAULT_NOW + 60_000);

    h.clock.advance(60_000);
    h.fakeTimer.fireDue(h.clock.now());
    await settle();

    const fired = h.audit.byType('scheduled-start-fired');
    expect(fired).toHaveLength(1);
    // FR-023a consistent core payload.
    expect(fired[0]!.payload).toMatchObject({
      queueId: QUEUE_B,
      transitionReason: 'timer-fired'
    });
    expect(fired[0]!.payload).toHaveProperty('occurredAt');
  });

  it('fires two queues independently, each on its own deadline', async () => {
    const h = await makeScheduleHarness();
    await h.armSchedule(DEFAULT_QUEUE_ID, DEFAULT_NOW + 120_000);
    await h.armSchedule(QUEUE_B, DEFAULT_NOW + 60_000);

    h.clock.advance(60_000);
    h.fakeTimer.fireDue(h.clock.now());
    await settle();
    expect(h.drained).toEqual([QUEUE_B]);
    expect(h.read(DEFAULT_QUEUE_ID).queueLifecycle).toBe('idle-pending');

    h.clock.advance(60_000);
    h.fakeTimer.fireDue(h.clock.now());
    await settle();
    expect(h.drained).toEqual([QUEUE_B, DEFAULT_QUEUE_ID]);
    expect(h.read(DEFAULT_QUEUE_ID).queueLifecycle).toBe('active-empty');
  });

  it('still promotes Default in a single-queue workspace (behaviour unchanged)', async () => {
    // Removing the implicit fallback must not remove the Default queue: the
    // one-queue workspace is the common case and reads exactly as before.
    const h = await makeScheduleHarness();
    await h.armSchedule(DEFAULT_QUEUE_ID, DEFAULT_NOW + 60_000);

    h.clock.advance(60_000);
    h.fakeTimer.fireDue(h.clock.now());
    await settle();

    expect(h.read(DEFAULT_QUEUE_ID).queueLifecycle).toBe('active-empty');
    expect(h.drained).toEqual([DEFAULT_QUEUE_ID]);
  });
});
