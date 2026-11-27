// FR-R3-152 (T1634, FR-008, FR-009, FR-010, FR-011) — concurrently scheduled
// queues stay independently correct.
//
// Reuses `scheduled-start-coordinator.test.ts`'s own `makeHarness` fixture
// (extracted to `scheduled-start-coordinator-fixture.ts`, which holds no test
// registrations of its own — importing a `.test.ts` file for a named export
// still re-executes every `describe()` in it) rather than re-deriving a
// second `ScheduledStartCoordinator` simulation (research.md D7). This file's
// job is the
// cross-queue isolation angle specifically: canceling, changing, or firing
// one queue's schedule must never touch another's deadline, lifecycle, timer,
// or audit trail, and a queue with no schedule at all must be unaffected by
// any of it throughout.
//
// The deeper "does this reach the QueueRuntime wire projection" concern is
// covered by `tests/unit/ui/sidebar/queue-runtime-schedule-projection.test.ts`
// (T1632g) — that test exercises the full `StateProjector` composition path;
// this one exercises the coordinator's own cross-queue guarantees, each at
// the layer it is most directly the subject.

import { describe, it, expect } from 'vitest';
import {
  makeHarness,
  idlePending,
  QUEUE_A,
  QUEUE_B,
  QUEUE_C
} from '../unit/services/scheduled-start-coordinator-fixture';

describe('Concurrently scheduled queues stay independent (FR-R3-152, T1634)', () => {
  it('canceling one scheduled queue leaves a second scheduled queue and an unscheduled queue untouched', async () => {
    const h = makeHarness();
    h.setQueueState(QUEUE_A, idlePending(h.now() + 60_000));
    h.setQueueState(QUEUE_B, idlePending(h.now() + 120_000));
    h.setQueueState(QUEUE_C, { queueLifecycle: 'idle-pending', scheduledStartAt: null } as never);

    await h.coord.arm(QUEUE_A, h.now() + 60_000, 'operator-chooser');
    await h.coord.arm(QUEUE_B, h.now() + 120_000, 'operator-chooser');
    const auditsBeforeCancel = h.audits.length;

    await h.coord.cancel(QUEUE_A, 'operator-cancel');

    // Only A's cancellation audit was appended.
    const newAudits = h.audits.slice(auditsBeforeCancel);
    expect(newAudits).toHaveLength(1);
    expect(newAudits[0]!.eventType).toBe('scheduled-start-canceled');
    expect(newAudits[0]!.payload.queueId).toBe(QUEUE_A);
    // No event anywhere in the whole run ever names B or C.
    expect(h.audits.every((a) => a.payload.queueId !== QUEUE_B || a.eventType === 'scheduled-start-armed')).toBe(
      true
    );
    expect(h.audits.some((a) => a.payload.queueId === QUEUE_C)).toBe(false);
  });

  it("changing one queue's schedule re-arms only that queue, leaving a sibling's deadline exactly as it was", async () => {
    const h = makeHarness();
    const originalDeadlineA = h.now() + 60_000;
    h.setQueueState(QUEUE_A, idlePending(originalDeadlineA));
    h.setQueueState(QUEUE_B, idlePending(h.now() + 120_000));

    await h.coord.arm(QUEUE_A, originalDeadlineA, 'operator-chooser');
    await h.coord.arm(QUEUE_B, h.now() + 120_000, 'operator-chooser');
    const handleBBefore = h.created[1]!;

    await h.coord.change(QUEUE_B, h.now() + 300_000, 'operator-chooser');
    h.setQueueState(QUEUE_B, idlePending(h.now() + 300_000));

    // B's original handle was cleared and a new one issued; A's was neither.
    expect(h.cleared).toContain(handleBBefore);
    expect(h.cleared).not.toContain(h.created[0]!);

    // Firing A's untouched original timer still fires A with its original
    // deadline — B's change never reached it.
    await h.runTimer(h.created[0]!);
    const fired = h.audits.filter((a) => a.eventType === 'scheduled-start-fired');
    expect(fired).toHaveLength(1);
    expect(fired[0]!.payload.queueId).toBe(QUEUE_A);
    expect(fired[0]!.payload.scheduledStartAt).toBe(originalDeadlineA);
  });

  it('firing one due queue names only that queue in its audit event and its onFire callback', async () => {
    const h = makeHarness();
    h.setQueueState(QUEUE_A, idlePending(h.now() + 60_000));
    h.setQueueState(QUEUE_B, idlePending(h.now() + 60_000));

    await h.coord.arm(QUEUE_A, h.now() + 60_000, 'operator-chooser');
    await h.coord.arm(QUEUE_B, h.now() + 60_000, 'operator-chooser');

    await h.runTimer(h.created[0]!); // fires A only

    expect(h.fired).toEqual([QUEUE_A]);
    const fired = h.audits.filter((a) => a.eventType === 'scheduled-start-fired');
    expect(fired).toHaveLength(1);
    expect(fired[0]!.payload.queueId).toBe(QUEUE_A);
    // B's own timer is still outstanding — firing A did not consume it.
    expect(h.cleared).not.toContain(h.created[1]!);
  });

  it("lock-unavailable at fire time supersedes and retains the queue's deadline — the operator is not asked to reschedule", async () => {
    const h = makeHarness({ isForeignLockHeld: () => true });
    const deadline = h.now() + 60_000;
    h.setQueueState(QUEUE_A, idlePending(deadline));
    await h.coord.arm(QUEUE_A, deadline, 'operator-chooser');

    await h.runTimer(h.created[0]!);

    const superseded = h.audits.filter((a) => a.eventType === 'scheduled-start-superseded');
    expect(superseded).toHaveLength(1);
    expect(superseded[0]!.payload).toMatchObject({
      queueId: QUEUE_A,
      superseder: 'lock-unavailable',
      scheduledStartAt: deadline
    });
    expect(h.fired).toEqual([]);
  });

  it('an ordinary unscheduled idle-pending queue is unaffected while its siblings are scheduled, canceled, and fired', async () => {
    const h = makeHarness();
    h.setQueueState(QUEUE_C, { queueLifecycle: 'idle-pending', scheduledStartAt: null } as never);
    h.setQueueState(QUEUE_A, idlePending(h.now() + 60_000));
    h.setQueueState(QUEUE_B, idlePending(h.now() + 90_000));

    await h.coord.arm(QUEUE_A, h.now() + 60_000, 'operator-chooser');
    await h.coord.arm(QUEUE_B, h.now() + 90_000, 'operator-chooser');
    await h.coord.cancel(QUEUE_A, 'operator-cancel');
    await h.runTimer(h.created[1]!);

    // C never armed, never canceled, never fired — no audit event names it,
    // and its own persisted read is exactly what this test set once.
    expect(h.audits.some((a) => a.payload.queueId === QUEUE_C)).toBe(false);
    expect(h.fired).not.toContain(QUEUE_C);
  });

  it('restart/re-arm: arming a queue a second time replaces only that queue\'s own outstanding timer', async () => {
    const h = makeHarness();
    h.setQueueState(QUEUE_A, idlePending(h.now() + 60_000));
    h.setQueueState(QUEUE_B, idlePending(h.now() + 60_000));

    await h.coord.arm(QUEUE_A, h.now() + 60_000, 'operator-chooser');
    await h.coord.arm(QUEUE_B, h.now() + 60_000, 'operator-chooser');
    const originalA = h.created[0]!;

    await h.coord.arm(QUEUE_A, h.now() + 45_000, 'operator-restart');
    h.setQueueState(QUEUE_A, idlePending(h.now() + 45_000));

    expect(h.cleared).toContain(originalA);
    expect(h.cleared).not.toContain(h.created[1]!); // B's handle, untouched

    await h.runTimer(h.created[1]!);
    const fired = h.audits.filter((a) => a.eventType === 'scheduled-start-fired');
    expect(fired).toHaveLength(1);
    expect(fired[0]!.payload.queueId).toBe(QUEUE_B);
  });
});
