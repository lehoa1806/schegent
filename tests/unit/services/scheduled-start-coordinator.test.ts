// Feature 092 (T041, US2) — the scheduled-start coordinator's timer becomes a
// `Map<queueId, NodeJS.Timeout>` (FR-029, FR-030).
//
// Feature 065 shipped the coordinator with a single `NodeJS.Timeout | null` and
// a header comment saying so deliberately: one queue existed, so one timer was
// the whole truth, and `arm()` cleared whatever was outstanding without looking
// at which queue it belonged to. That clearing is the behaviour this file
// reverses. With `MAX_QUEUES = 20`, arming queue B must not silently disarm
// queue A's start — the operator scheduled two things and would be told about
// neither.
//
// What is asserted here, per contracts/concurrent-drain-and-leases.md §3:
//   - Up to `MAX_QUEUES` timers armed at once, each independently addressable.
//   - Firing one leaves every other armed AND unaltered — same handle, same
//     `scheduledStartAt`, same source. "Still armed" is not enough; a re-armed
//     timer would also read as armed while having lost its original deadline.
//   - Cancelling one — the deletion path's disarm (FR-030, T059) — disarms that
//     queue's timer and only that one.
//
// The queue *state* reads are addressed too: `fire(queueId)` must consult that
// queue's `QueueState`, not the workspace singleton, or a sibling's lifecycle
// would decide whether this queue's timer was superseded.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ScheduledStartCoordinator,
  type ScheduledStartCoordinatorDeps
} from '../../../src/services/scheduled-start-coordinator';
import { MAX_QUEUES, DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';
import type { QueueState } from '../../../src/queue/feature-request';

const QUEUE_A = DEFAULT_QUEUE_ID;
const QUEUE_B = '11111111-2222-4333-8444-555555555555';
const QUEUE_C = '22222222-3333-4444-8555-666666666666';

/** A fake timer handle that records nothing but its own identity. */
type FakeHandle = { readonly id: number } & NodeJS.Timeout;

interface Harness {
  readonly coord: ScheduledStartCoordinator;
  /** Handles handed out by `setTimer`, in creation order. */
  readonly created: FakeHandle[];
  /** Handles passed to `clearTimer`, in call order. */
  readonly cleared: FakeHandle[];
  /** Runs the callback registered for `handle`, as the event loop would. */
  runTimer(handle: FakeHandle): Promise<void>;
  /** Sets one queue's persisted state. */
  setQueueState(queueId: string, patch: Partial<QueueState>): void;
  readonly audits: Array<{ eventType: string; payload: Record<string, unknown> }>;
  readonly fired: string[];
  now(): number;
  advance(ms: number): void;
}

const NOW_BASE = 1_700_000_000_000;

function idlePending(scheduledStartAt: number): QueueState {
  return {
    requests: [],
    inFlightId: null,
    paused: false,
    pausedReason: null,
    updatedAt: NOW_BASE,
    queueLifecycle: 'idle-pending',
    pauseSource: null,
    scheduledStartAt,
    scheduledStartSource: 'operator-chooser',
    migrationNotice: null
  } as unknown as QueueState;
}

function makeHarness(): Harness {
  let clock = NOW_BASE;
  const created: FakeHandle[] = [];
  const cleared: FakeHandle[] = [];
  const callbacks = new Map<FakeHandle, () => void>();
  const states = new Map<string, QueueState>();
  const audits: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const fired: string[] = [];
  let nextId = 1;

  const deps: ScheduledStartCoordinatorDeps = {
    store: {
      // Feature 092 — addressed. A coordinator that ignored `queueId` here
      // would let queue A's lifecycle decide queue B's supersession.
      getQueue: ((queueId: string = DEFAULT_QUEUE_ID) =>
        states.get(queueId) ??
        ({
          requests: [],
          inFlightId: null,
          paused: false,
          pausedReason: null,
          updatedAt: clock,
          queueLifecycle: 'active-empty',
          pauseSource: null,
          scheduledStartAt: null,
          scheduledStartSource: null,
          migrationNotice: null
        } as unknown as QueueState)) as never,
      // Feature 092 — `reArm()` can no longer hardcode `'default'`; it has to
      // ask which queues carry persisted execution state.
      getQueueStates: (() => Object.fromEntries(states.entries())) as never
      // FR-R3-002 (T284) — no `updateQueue` double. The coordinator's store
      // Pick is read-only now that the lock-unavailable branch retains the
      // persisted deadline instead of erasing it, so a writer here would be a
      // seam the subject cannot reach.
    },
    auditWriter: {
      append: async (entry: { eventType: string; payload: Record<string, unknown> }) => {
        audits.push({ eventType: entry.eventType, payload: entry.payload });
      }
    } as never,
    logger: { warn: vi.fn() } as never,
    onFire: (queueId: string) => {
      fired.push(queueId);
    },
    now: () => clock,
    setTimer: (fn: () => void, _ms: number) => {
      const handle = { id: nextId++ } as FakeHandle;
      created.push(handle);
      callbacks.set(handle, fn);
      return handle;
    },
    clearTimer: (handle: NodeJS.Timeout) => {
      cleared.push(handle as FakeHandle);
      callbacks.delete(handle as FakeHandle);
    }
  };

  const coord = new ScheduledStartCoordinator(deps);

  return {
    coord,
    created,
    cleared,
    async runTimer(handle: FakeHandle): Promise<void> {
      const cb = callbacks.get(handle);
      expect(cb, `no callback registered for handle ${handle.id}`).toBeDefined();
      cb!();
      // `fire()` is dispatched with `void`; let its microtasks settle.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    setQueueState(queueId: string, patch: Partial<QueueState>): void {
      const base = states.get(queueId) ?? idlePending(NOW_BASE + 60_000);
      states.set(queueId, { ...base, ...patch } as QueueState);
    },
    audits,
    fired,
    now: () => clock,
    advance(ms: number): void {
      clock += ms;
    }
  };
}

describe('feature 092 (T041) — one timer per queue, not one timer per workspace', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  it('arming a second queue leaves the first armed (arm no longer clears blindly)', async () => {
    const atA = NOW_BASE + 60_000;
    const atB = NOW_BASE + 120_000;
    h.setQueueState(QUEUE_A, { scheduledStartAt: atA });
    h.setQueueState(QUEUE_B, { scheduledStartAt: atB });

    await h.coord.arm(QUEUE_A, atA, 'operator-chooser');
    await h.coord.arm(QUEUE_B, atB, 'operator-chooser');

    expect(h.created).toHaveLength(2);
    // The pre-092 body called `clearTimer` on A's handle here. Nothing was
    // cancelled, so nothing may have been cleared.
    expect(h.cleared).toEqual([]);
    expect(h.coord.hasActiveTimer(QUEUE_A)).toBe(true);
    expect(h.coord.hasActiveTimer(QUEUE_B)).toBe(true);
    expect([...h.coord.armedQueueIds()].sort()).toEqual([QUEUE_A, QUEUE_B].sort());
  });

  it('holds up to MAX_QUEUES timers armed at once (FR-030)', async () => {
    const ids = Array.from({ length: MAX_QUEUES }, (_, i) =>
      i === 0 ? QUEUE_A : `queue-${String(i).padStart(2, '0')}`
    );
    for (const [i, id] of ids.entries()) {
      const at = NOW_BASE + (i + 1) * 60_000;
      h.setQueueState(id, { scheduledStartAt: at });
      await h.coord.arm(id, at, 'operator-chooser');
    }

    expect(MAX_QUEUES).toBe(20);
    expect(h.created).toHaveLength(MAX_QUEUES);
    expect(h.cleared).toEqual([]);
    expect(h.coord.armedQueueIds()).toHaveLength(MAX_QUEUES);
    for (const id of ids) {
      expect(h.coord.hasActiveTimer(id), `${id} should still be armed`).toBe(true);
    }
  });

  it('firing one queue leaves the others armed AND unaltered', async () => {
    const atA = NOW_BASE + 60_000;
    const atB = NOW_BASE + 120_000;
    const atC = NOW_BASE + 180_000;
    h.setQueueState(QUEUE_A, { scheduledStartAt: atA });
    h.setQueueState(QUEUE_B, { scheduledStartAt: atB });
    h.setQueueState(QUEUE_C, { scheduledStartAt: atC });

    await h.coord.arm(QUEUE_A, atA, 'operator-chooser');
    await h.coord.arm(QUEUE_B, atB, 'operator-chooser');
    await h.coord.arm(QUEUE_C, atC, 'operator-chooser');
    const [handleA, handleB, handleC] = h.created;

    h.advance(60_000);
    await h.runTimer(handleA);

    expect(h.fired).toEqual([QUEUE_A]);
    expect(h.coord.hasActiveTimer(QUEUE_A)).toBe(false);

    // Unaltered, not merely still-armed: same handle, same deadline, same
    // source. A re-armed sibling would pass a bare `hasActiveTimer` check.
    expect(h.coord.hasActiveTimer(QUEUE_B)).toBe(true);
    expect(h.coord.hasActiveTimer(QUEUE_C)).toBe(true);
    expect(h.created).toHaveLength(3);
    expect(h.cleared).toEqual([]);
    expect(h.coord.armedTimer(QUEUE_B)).toMatchObject({
      queueId: QUEUE_B,
      scheduledStartAt: atB,
      source: 'operator-chooser',
      handle: handleB
    });
    expect(h.coord.armedTimer(QUEUE_C)).toMatchObject({
      queueId: QUEUE_C,
      scheduledStartAt: atC,
      source: 'operator-chooser',
      handle: handleC
    });

    const firedEvents = h.audits.filter((a) => a.eventType === 'scheduled-start-fired');
    expect(firedEvents).toHaveLength(1);
    expect(firedEvents[0].payload.queueId).toBe(QUEUE_A);
  });

  it("a sibling's lifecycle does not supersede this queue's timer", async () => {
    const atA = NOW_BASE + 60_000;
    const atB = NOW_BASE + 60_000;
    h.setQueueState(QUEUE_A, { scheduledStartAt: atA });
    h.setQueueState(QUEUE_B, { scheduledStartAt: atB });

    await h.coord.arm(QUEUE_A, atA, 'operator-chooser');
    await h.coord.arm(QUEUE_B, atB, 'operator-chooser');
    const [, handleB] = h.created;

    // Queue A gets paused. Pre-092 `fire()` read the singleton, so B's timer
    // would classify itself superseded by A's pause.
    h.setQueueState(QUEUE_A, {
      queueLifecycle: 'operator-paused',
      pauseSource: null,
      scheduledStartAt: null
    } as Partial<QueueState>);

    h.advance(60_000);
    await h.runTimer(handleB);

    expect(h.fired).toEqual([QUEUE_B]);
    expect(h.audits.filter((a) => a.eventType === 'scheduled-start-superseded')).toEqual([]);
  });

  it('cancelling one queue disarms that timer and only that one (FR-030)', async () => {
    const atA = NOW_BASE + 60_000;
    const atB = NOW_BASE + 120_000;
    const atC = NOW_BASE + 180_000;
    h.setQueueState(QUEUE_A, { scheduledStartAt: atA });
    h.setQueueState(QUEUE_B, { scheduledStartAt: atB });
    h.setQueueState(QUEUE_C, { scheduledStartAt: atC });

    await h.coord.arm(QUEUE_A, atA, 'operator-chooser');
    await h.coord.arm(QUEUE_B, atB, 'operator-chooser');
    await h.coord.arm(QUEUE_C, atC, 'operator-chooser');
    const [handleA, handleB, handleC] = h.created;

    await h.coord.cancel(QUEUE_B, 'operator-cancel');

    expect(h.cleared).toEqual([handleB]);
    expect(h.coord.hasActiveTimer(QUEUE_B)).toBe(false);
    expect(h.coord.hasActiveTimer(QUEUE_A)).toBe(true);
    expect(h.coord.hasActiveTimer(QUEUE_C)).toBe(true);
    expect(h.coord.armedTimer(QUEUE_A)?.handle).toBe(handleA);
    expect(h.coord.armedTimer(QUEUE_C)?.handle).toBe(handleC);

    const canceled = h.audits.filter((a) => a.eventType === 'scheduled-start-canceled');
    expect(canceled).toHaveLength(1);
    expect(canceled[0].payload.queueId).toBe(QUEUE_B);
    // FR-038a — queue ids, never operator-authored names.
    expect(canceled[0].payload).not.toHaveProperty('queueName');
  });

  it('cancelling a queue that holds no timer disarms nothing', async () => {
    const atA = NOW_BASE + 60_000;
    h.setQueueState(QUEUE_A, { scheduledStartAt: atA });
    await h.coord.arm(QUEUE_A, atA, 'operator-chooser');

    await h.coord.cancel(QUEUE_B, 'operator-cancel');

    expect(h.cleared).toEqual([]);
    expect(h.coord.hasActiveTimer(QUEUE_A)).toBe(true);
    expect(h.audits.filter((a) => a.eventType === 'scheduled-start-canceled')).toEqual([]);
  });

  it('re-arming the SAME queue clears only its own outstanding handle', async () => {
    const first = NOW_BASE + 60_000;
    const second = NOW_BASE + 300_000;
    h.setQueueState(QUEUE_A, { scheduledStartAt: first });
    h.setQueueState(QUEUE_B, { scheduledStartAt: NOW_BASE + 120_000 });

    await h.coord.arm(QUEUE_A, first, 'operator-chooser');
    await h.coord.arm(QUEUE_B, NOW_BASE + 120_000, 'operator-chooser');
    const [handleA, handleB] = h.created;

    await h.coord.arm(QUEUE_A, second, 'operator-chooser');

    expect(h.cleared).toEqual([handleA]);
    expect(h.coord.armedTimer(QUEUE_A)?.scheduledStartAt).toBe(second);
    expect(h.coord.armedTimer(QUEUE_A)?.handle).not.toBe(handleA);
    expect(h.coord.armedTimer(QUEUE_B)?.handle).toBe(handleB);
  });

  it('dispose clears every armed timer', async () => {
    const ids = [QUEUE_A, QUEUE_B, QUEUE_C];
    for (const [i, id] of ids.entries()) {
      const at = NOW_BASE + (i + 1) * 60_000;
      h.setQueueState(id, { scheduledStartAt: at });
      await h.coord.arm(id, at, 'operator-chooser');
    }

    h.coord.dispose();

    expect(h.cleared).toHaveLength(3);
    expect(h.coord.armedQueueIds()).toEqual([]);
    expect(h.coord.hasActiveTimer()).toBe(false);
  });

  it('hasActiveTimer() with no argument still answers for the workspace', async () => {
    expect(h.coord.hasActiveTimer()).toBe(false);
    const atB = NOW_BASE + 60_000;
    h.setQueueState(QUEUE_B, { scheduledStartAt: atB });
    await h.coord.arm(QUEUE_B, atB, 'operator-chooser');
    expect(h.coord.hasActiveTimer()).toBe(true);
    await h.coord.cancel(QUEUE_B, 'operator-cancel');
    expect(h.coord.hasActiveTimer()).toBe(false);
  });

  it('reArm sweeps every queue with a persisted schedule, not just the default', async () => {
    const past = NOW_BASE - 5_000;
    const future = NOW_BASE + 60_000;
    h.setQueueState(QUEUE_A, { scheduledStartAt: future });
    h.setQueueState(QUEUE_B, { scheduledStartAt: past });
    h.setQueueState(QUEUE_C, {
      queueLifecycle: 'active-empty',
      pauseSource: null,
      scheduledStartAt: null
    } as Partial<QueueState>);

    await h.coord.reArm();

    // B's deadline already elapsed while the window was closed: fired now.
    expect(h.fired).toEqual([QUEUE_B]);
    // A is still in the future: armed, not fired.
    expect(h.coord.hasActiveTimer(QUEUE_A)).toBe(true);
    expect(h.coord.armedTimer(QUEUE_A)?.scheduledStartAt).toBe(future);
    // C carries no schedule: nothing armed for it.
    expect(h.coord.hasActiveTimer(QUEUE_C)).toBe(false);
  });
});
