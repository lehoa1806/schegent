// Feature 013 — Wave 7 (US7 / T102): unit tests for AutoDrainCoordinator.
//
// Feature 092 (T038, US2) rewrote the gate chain these tests pin. Two things
// changed and both are visible below:
//
//   - `hasCapacity()` split into `hasQueueCapacity(queueId)` (this queue is
//     busy) and `hasWorkspaceCapacity()` (the workspace is at its ceiling, so
//     this queue *waits*) — two limits with two different meanings.
//   - the drain's exclusion step moved from the workspace lock to the per-queue
//     execution lease, so losing it means "another window is draining this
//     queue", not "this window is no longer primary".
//
// The ordering of the seven steps is pinned in
// `tests/unit/queue/auto-drain.test.ts`; what this file adds is the round-robin
// sweep and its starvation-freedom property (FR-028a).

import { describe, it, expect, vi } from 'vitest';
import { AutoDrainCoordinator } from '../../../src/services/auto-drain-coordinator';
import { DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';
import type { QueueLifecycle } from '../../../src/queue/feature-request';

function makeStore(queueState: {
  paused: boolean;
  inFlightId: string | null;
  queueLifecycle?: QueueLifecycle;
}) {
  return {
    getQueue: vi.fn(() => ({
      queueLifecycle: queueState.queueLifecycle ?? 'active-empty',
      ...queueState
    }))
  };
}

function makeQueue(
  next: { id: string; description: string } | null,
  hasWorkspaceCapacity = true,
  hasQueueCapacity = true
) {
  return {
    peekNextPending: vi.fn(() => next),
    hasQueueCapacity: vi.fn(() => hasQueueCapacity),
    hasWorkspaceCapacity: vi.fn(() => hasWorkspaceCapacity)
  };
}

function makeLease(acquired: boolean) {
  return {
    tryAcquire: vi.fn(async () => ({ acquired, ownerId: 'w-1' })),
    release: vi.fn(async () => undefined)
  };
}

function makeController() {
  return { startNew: vi.fn(async () => undefined), resumeExisting: vi.fn(async () => false) };
}

describe('AutoDrainCoordinator (T099 / T102)', () => {
  it('promotes the next pending feature when queue is idle and the lease is available', async () => {
    const store = makeStore({ paused: false, inFlightId: null });
    const queue = makeQueue({ id: 'q-2', description: 'next item' });
    const lease = makeLease(true);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never
    });
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(controller.startNew).toHaveBeenCalledWith({ id: 'q-2', description: 'next item' }, null);
  });

  it('short-circuits when the queue is paused', async () => {
    const store = makeStore({ paused: true, inFlightId: null });
    const queue = makeQueue({ id: 'q-2', description: 'next' });
    const lease = makeLease(true);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never
    });
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(queue.peekNextPending).not.toHaveBeenCalled();
    expect(controller.startNew).not.toHaveBeenCalled();
  });

  it('short-circuits when the workspace concurrency ceiling is full', async () => {
    const store = makeStore({ paused: false, inFlightId: null });
    const queue = makeQueue({ id: 'q-2', description: 'next' }, false);
    const lease = makeLease(true);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never
    });
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(queue.peekNextPending).not.toHaveBeenCalled();
    expect(controller.startNew).not.toHaveBeenCalled();
  });

  it('short-circuits when THIS queue already holds an in-flight Task', async () => {
    const store = makeStore({ paused: false, inFlightId: 'q-1' });
    const queue = makeQueue({ id: 'q-2', description: 'next' }, true, false);
    const lease = makeLease(true);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never
    });
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(queue.hasWorkspaceCapacity).not.toHaveBeenCalled();
    expect(controller.startNew).not.toHaveBeenCalled();
  });

  it('short-circuits when no pending feature exists', async () => {
    const store = makeStore({ paused: false, inFlightId: null });
    const queue = makeQueue(null);
    const lease = makeLease(true);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never
    });
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(lease.tryAcquire).not.toHaveBeenCalled();
    expect(controller.startNew).not.toHaveBeenCalled();
  });

  it('short-circuits when the execution lease is held by another window', async () => {
    const store = makeStore({ paused: false, inFlightId: null });
    const queue = makeQueue({ id: 'q-2', description: 'next' });
    const lease = makeLease(false);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never
    });
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(controller.startNew).not.toHaveBeenCalled();
  });

  // Feature 092 — step 4b. The queue model permits N concurrent Runs; the Run
  // engine does not yet. `KEYS.run` holds one `WorkflowRun` and the single
  // `RunDriver` ignores a second `drive()` while it is running, so a start
  // issued past a busy engine would overwrite the live Run's record and then
  // spawn nothing — one Task in flight with no process, one Run addressable
  // only through a record describing the other. The gate makes that a wait.
  it('waits when the shared Run engine is already driving a Run', async () => {
    const store = makeStore({ paused: false, inFlightId: null });
    const queue = makeQueue({ id: 'q-2', description: 'next' });
    const lease = makeLease(true);
    const controller = { ...makeController(), running: true };
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never
    });
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(controller.startNew).not.toHaveBeenCalled();
    // A wait, not a claim: nothing past step 4b was consulted, so no lease is
    // left held and no pending head was removed.
    expect(queue.peekNextPending).not.toHaveBeenCalled();
    expect(lease.tryAcquire).not.toHaveBeenCalled();
    expect(lease.release).not.toHaveBeenCalled();
  });

  it('promotes once the engine is free again', async () => {
    const store = makeStore({ paused: false, inFlightId: null });
    const queue = makeQueue({ id: 'q-2', description: 'next' });
    const lease = makeLease(true);
    const controller = { ...makeController(), running: false };
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never
    });
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(controller.startNew).toHaveBeenCalledTimes(1);
  });
});

// Feature 065 (T010) — the `idle-pending` gate MUST short-circuit the
// drain so a chooser-driven (or future-scheduled) start never auto-promotes
// behind the operator's back.
describe('AutoDrainCoordinator — Feature 065 idle-pending gate', () => {
  it('idle-pending lifecycle returns early before peekNextPending/tryAcquire', async () => {
    const store = makeStore({
      paused: false,
      inFlightId: null,
      queueLifecycle: 'idle-pending'
    });
    const queue = makeQueue({ id: 'q-2', description: 'next' });
    const lease = makeLease(true);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never
    });
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(queue.peekNextPending).not.toHaveBeenCalled();
    expect(queue.hasQueueCapacity).not.toHaveBeenCalled();
    expect(queue.hasWorkspaceCapacity).not.toHaveBeenCalled();
    expect(lease.tryAcquire).not.toHaveBeenCalled();
    expect(controller.startNew).not.toHaveBeenCalled();
  });

  it('running lifecycle proceeds through the existing checks (FR-005 carve-out)', async () => {
    const store = makeStore({
      paused: false,
      inFlightId: 'q-1',
      queueLifecycle: 'running'
    });
    const queue = makeQueue({ id: 'q-2', description: 'next' });
    const lease = makeLease(true);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never
    });
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(controller.startNew).toHaveBeenCalled();
  });

  it('active-empty lifecycle proceeds through the existing checks', async () => {
    const store = makeStore({
      paused: false,
      inFlightId: null,
      queueLifecycle: 'active-empty'
    });
    const queue = makeQueue({ id: 'q-2', description: 'next' });
    const lease = makeLease(true);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never
    });
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(controller.startNew).toHaveBeenCalled();
  });

  it('operator-paused short-circuits via the legacy paused gate (not the new lifecycle gate)', async () => {
    const store = makeStore({
      paused: true,
      inFlightId: null,
      queueLifecycle: 'operator-paused'
    });
    const queue = makeQueue({ id: 'q-2', description: 'next' });
    const lease = makeLease(true);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never
    });
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(controller.startNew).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Feature 092 (T038, US2, FR-028a) — the round-robin cursor.
//
// The cursor exists so ceiling contention is deterministic and starvation-free.
// Without it, `drainAll()` would always visit position 0 first and, under a
// saturated ceiling, the queue at position 0 would win every sweep while the
// tail never ran. The cursor is in memory and per session by design: it is a
// fairness aid, not persisted state, so a reload legitimately restarts at zero.
// ---------------------------------------------------------------------------

const QUEUE_IDS = ['q-a', 'q-b', 'q-c', 'q-d'];

/**
 * A workspace of four always-eligible queues where only `capacity` promotions
 * are allowed per sweep, so every sweep is forced to choose and the choice is
 * the thing under test.
 */
function roundRobinHarness(options: { capacity: number }) {
  const promoted: string[] = [];
  let inFlight = 0;
  const coord = new AutoDrainCoordinator({
    store: {
      getQueue: vi.fn(() => ({
        queueLifecycle: 'active-empty' as QueueLifecycle,
        paused: false,
        inFlightId: null
      })),
      getQueueRegistry: () => ({
        entries: QUEUE_IDS.map((id, position) => ({
          id,
          name: id,
          position,
          state: 'active' as const,
          pauseSource: null,
          schedule: null,
          createdAt: 0,
          updatedAt: 0
        })),
        updatedAt: 0
      })
    } as never,
    queue: {
      peekNextPending: vi.fn((queueId: string) => ({
        id: `task-${queueId}`,
        description: 'next',
        queueId
      })),
      hasQueueCapacity: vi.fn(() => true),
      hasWorkspaceCapacity: vi.fn(() => inFlight < options.capacity)
    } as never,
    executionLease: {
      tryAcquire: vi.fn(async () => ({ acquired: true, ownerId: 'w-1' })),
      release: vi.fn(async () => undefined)
    } as never,
    controller: {
      startNew: vi.fn(async (task: { queueId: string }) => {
        promoted.push(task.queueId);
        inFlight += 1;
      }),
      resumeExisting: vi.fn(async () => false)
    } as never
  });

  return {
    coord,
    promoted,
    /** One sweep at the given capacity, then every Run terminates. */
    async sweep(): Promise<void> {
      await coord.drainAll();
      inFlight = 0;
    }
  };
}

describe('AutoDrainCoordinator — round-robin cursor (T038, FR-028a)', () => {
  it('starts the scan at position zero before any promotion in the session', async () => {
    const h = roundRobinHarness({ capacity: 1 });
    await h.sweep();
    expect(h.promoted).toEqual(['q-a']);
  });

  it('resumes after the most recently promoted queue', async () => {
    const h = roundRobinHarness({ capacity: 1 });
    await h.sweep();
    await h.sweep();
    await h.sweep();
    expect(h.promoted).toEqual(['q-a', 'q-b', 'q-c']);
  });

  it('wraps around the end of the registry', async () => {
    const h = roundRobinHarness({ capacity: 1 });
    for (let i = 0; i < 5; i += 1) await h.sweep();
    expect(h.promoted).toEqual(['q-a', 'q-b', 'q-c', 'q-d', 'q-a']);
  });

  it('no waiting queue starves under a saturated ceiling', async () => {
    const h = roundRobinHarness({ capacity: 1 });
    for (let i = 0; i < QUEUE_IDS.length; i += 1) await h.sweep();
    expect(new Set(h.promoted)).toEqual(new Set(QUEUE_IDS));
  });

  it('a sweep with room for two promotes two adjacent queues and resumes after the second', async () => {
    const h = roundRobinHarness({ capacity: 2 });
    await h.sweep();
    expect(h.promoted).toEqual(['q-a', 'q-b']);
    await h.sweep();
    expect(h.promoted).toEqual(['q-a', 'q-b', 'q-c', 'q-d']);
  });

  it('the cursor is in memory only — a fresh coordinator restarts at position zero', async () => {
    const first = roundRobinHarness({ capacity: 1 });
    await first.sweep();
    await first.sweep();
    expect(first.promoted).toEqual(['q-a', 'q-b']);

    const fresh = roundRobinHarness({ capacity: 1 });
    await fresh.sweep();
    expect(fresh.promoted).toEqual(['q-a']);
  });
});
