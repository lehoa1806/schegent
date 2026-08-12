import { describe, it, expect, beforeEach } from 'vitest';
import { QueueManager } from '../../../src/queue/queue-manager';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';

class InMemoryMemento implements Memento {
  private store = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.store.delete(key);
    else this.store.set(key, value);
    return Promise.resolve();
  }
}

describe('queue auto-drain prerequisites (US1 / T028)', () => {
  let store: WorkspaceStateStore;
  let queue: QueueManager;
  beforeEach(() => {
    store = new WorkspaceStateStore(new InMemoryMemento());
    queue = new QueueManager(store);
  });

  it('peekNextPending returns the oldest pending item when queue not paused', async () => {
    await queue.enqueue('first');
    await queue.enqueue('second');
    const next = queue.peekNextPending();
    expect(next?.description).toBe('first');
  });

  it('peekNextPending returns null when only terminal items remain', async () => {
    const a = await queue.enqueue('alpha');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, 'completed');
    expect(queue.peekNextPending()).toBeNull();
  });

  it('finish() preserves sanitized failure metadata on lastError (T029)', async () => {
    const a = await queue.enqueue('alpha');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, 'failed', {
      code: 'invocation-failed',
      message: 'phase plan crashed',
      phase: 'speckit-plan',
      correlationId: 'run-1'
    });
    const after = queue.findById(a.id);
    expect(after?.status).toBe('failed');
    expect(typeof after?.lastError === 'object' && after?.lastError !== null).toBe(true);
    if (after?.lastError && typeof after.lastError === 'object') {
      expect(after.lastError.message).toBe('phase plan crashed');
      expect(after.lastError.correlationId).toBe('run-1');
    }
  });

  it('queue exposes pausedReason in pause state (T030)', async () => {
    await queue.setQueuePausedState(true, undefined, 'rate-limit cooldown', 'operator');
    const state = store.getQueue();
    expect(state.paused).toBe(true);
    expect(state.pausedReason).toBe('rate-limit cooldown');
  });

  it('queue uses canonical in-flight status (T031)', async () => {
    const a = await queue.enqueue('alpha');
    await queue.markInFlight(a.id, 'run-1');
    expect(queue.findById(a.id)?.status).toBe('in-flight');
  });
});

// ---------------------------------------------------------------------------
// Feature 092 (T036, T037, US2) — the seven ordered drain steps.
//
// contracts/concurrent-drain-and-leases.md §1 fixes both the checks and their
// order. The order is load-bearing, not cosmetic: step 3 ("this queue is busy")
// and step 4 ("the workspace is at its ceiling") mean different things to the
// operator, and a drain that consulted the ceiling first would report the wrong
// one. So each test below drives the coordinator to fail at exactly one step
// and asserts that every later step's collaborator was never consulted.
// ---------------------------------------------------------------------------

import { AutoDrainCoordinator } from '../../../src/services/auto-drain-coordinator';
import { DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';
import type { QueueLifecycle } from '../../../src/queue/feature-request';
import { vi } from 'vitest';

const QUEUE_B = '11111111-2222-4333-8444-555555555555';

interface StepSpies {
  readonly getQueue: ReturnType<typeof vi.fn>;
  readonly hasQueueCapacity: ReturnType<typeof vi.fn>;
  readonly hasWorkspaceCapacity: ReturnType<typeof vi.fn>;
  readonly peekNextPending: ReturnType<typeof vi.fn>;
  readonly tryAcquire: ReturnType<typeof vi.fn>;
  readonly startNew: ReturnType<typeof vi.fn>;
}

/**
 * A coordinator whose every step is a spy, so a test can assert both what was
 * consulted and what was not. Each `stopAt` value fails exactly one step.
 */
function makeCoordinator(
  stopAt: 'none' | 'lifecycle' | 'paused' | 'queue-capacity' | 'workspace-capacity' | 'pending' | 'lease',
  queueId: string = DEFAULT_QUEUE_ID
): { coord: AutoDrainCoordinator; spies: StepSpies } {
  const lifecycle: QueueLifecycle = stopAt === 'lifecycle' ? 'idle-pending' : 'active-empty';
  const spies: StepSpies = {
    getQueue: vi.fn(() => ({
      queueLifecycle: lifecycle,
      paused: stopAt === 'paused',
      inFlightId: null
    })),
    hasQueueCapacity: vi.fn(() => stopAt !== 'queue-capacity'),
    hasWorkspaceCapacity: vi.fn(() => stopAt !== 'workspace-capacity'),
    peekNextPending: vi.fn(() =>
      stopAt === 'pending' ? null : { id: 'task-1', description: 'next', queueId }
    ),
    tryAcquire: vi.fn(async () => ({
      acquired: stopAt !== 'lease',
      ownerId: stopAt === 'lease' ? 'other-window' : 'this-window'
    })),
    startNew: vi.fn(async () => undefined)
  };
  const coord = new AutoDrainCoordinator({
    store: { getQueue: spies.getQueue } as never,
    queue: {
      peekNextPending: spies.peekNextPending,
      hasQueueCapacity: spies.hasQueueCapacity,
      hasWorkspaceCapacity: spies.hasWorkspaceCapacity
    } as never,
    executionLease: { tryAcquire: spies.tryAcquire, release: vi.fn(async () => undefined) } as never,
    controller: { startNew: spies.startNew, resumeExisting: vi.fn(async () => false) } as never
  });
  return { coord, spies };
}

describe('drainIfIdle(queueId) — the seven ordered steps (T036, FR-023 – FR-028)', () => {
  it('step 1: an idle-pending queue returns before every later step', async () => {
    const { coord, spies } = makeCoordinator('lifecycle');
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(spies.hasQueueCapacity).not.toHaveBeenCalled();
    expect(spies.hasWorkspaceCapacity).not.toHaveBeenCalled();
    expect(spies.peekNextPending).not.toHaveBeenCalled();
    expect(spies.tryAcquire).not.toHaveBeenCalled();
    expect(spies.startNew).not.toHaveBeenCalled();
  });

  it('step 2: a paused queue returns before capacity is consulted', async () => {
    const { coord, spies } = makeCoordinator('paused');
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(spies.hasQueueCapacity).not.toHaveBeenCalled();
    expect(spies.hasWorkspaceCapacity).not.toHaveBeenCalled();
    expect(spies.startNew).not.toHaveBeenCalled();
  });

  it('step 3 precedes step 4: a busy queue never consults the workspace ceiling', async () => {
    const { coord, spies } = makeCoordinator('queue-capacity');
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(spies.hasQueueCapacity).toHaveBeenCalledWith(DEFAULT_QUEUE_ID);
    expect(spies.hasWorkspaceCapacity).not.toHaveBeenCalled();
    expect(spies.peekNextPending).not.toHaveBeenCalled();
    expect(spies.startNew).not.toHaveBeenCalled();
  });

  it('step 4 is a wait, not an error: no throw, no lifecycle write, nothing started', async () => {
    const { coord, spies } = makeCoordinator('workspace-capacity');
    await expect(coord.drainIfIdle(DEFAULT_QUEUE_ID)).resolves.toBeUndefined();
    expect(spies.hasWorkspaceCapacity).toHaveBeenCalled();
    expect(spies.peekNextPending).not.toHaveBeenCalled();
    expect(spies.tryAcquire).not.toHaveBeenCalled();
    expect(spies.startNew).not.toHaveBeenCalled();
  });

  it('step 5: nothing pending on this queue returns before the lease is claimed', async () => {
    const { coord, spies } = makeCoordinator('pending');
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(spies.peekNextPending).toHaveBeenCalledWith(DEFAULT_QUEUE_ID);
    expect(spies.tryAcquire).not.toHaveBeenCalled();
    expect(spies.startNew).not.toHaveBeenCalled();
  });

  it('step 6: another window holding this queue lease returns without starting', async () => {
    const { coord, spies } = makeCoordinator('lease');
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(spies.tryAcquire).toHaveBeenCalledWith(DEFAULT_QUEUE_ID);
    expect(spies.startNew).not.toHaveBeenCalled();
  });

  it('step 7: all six gates open promotes this queue Task and claims this queue lease', async () => {
    const { coord, spies } = makeCoordinator('none', QUEUE_B);
    await coord.drainIfIdle(QUEUE_B);
    expect(spies.hasQueueCapacity).toHaveBeenCalledWith(QUEUE_B);
    expect(spies.peekNextPending).toHaveBeenCalledWith(QUEUE_B);
    expect(spies.tryAcquire).toHaveBeenCalledWith(QUEUE_B);
    expect(spies.startNew).toHaveBeenCalledWith(
      { id: 'task-1', description: 'next', queueId: QUEUE_B },
      null
    );
  });

  it('reads the addressed queue, never the workspace singleton', async () => {
    const { coord, spies } = makeCoordinator('none', QUEUE_B);
    await coord.drainIfIdle(QUEUE_B);
    expect(spies.getQueue).toHaveBeenCalledWith(QUEUE_B);
  });
});

describe('drainAll() keeps the idle-pending gate a single enforcement site (T037, FR-024)', () => {
  /**
   * A lifecycle pre-filter in `drainAll()` would be a second enforcement site
   * wearing different clothes. The evidence is behavioural, not structural: an
   * `idle-pending` queue must still be *visited* — `drainIfIdle` is entered and
   * returns at its own step 1 — so the sweep observes the same short-circuit a
   * direct call would.
   */
  function sweepHarness(lifecycles: Record<string, QueueLifecycle>) {
    const ids = Object.keys(lifecycles);
    const getQueue = vi.fn((queueId: string) => ({
      queueLifecycle: lifecycles[queueId],
      paused: false,
      inFlightId: null
    }));
    const hasQueueCapacity = vi.fn(() => true);
    const peekNextPending = vi.fn((queueId: string) => ({
      id: `task-${queueId}`,
      description: 'next',
      queueId
    }));
    const startNew = vi.fn(async (_request: { queueId?: string }) => undefined);
    const coord = new AutoDrainCoordinator({
      store: {
        getQueue,
        getQueueRegistry: () => ({
          entries: ids.map((id, position) => ({
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
        peekNextPending,
        hasQueueCapacity,
        hasWorkspaceCapacity: vi.fn(() => true)
      } as never,
      executionLease: {
        tryAcquire: vi.fn(async () => ({ acquired: true, ownerId: 'this-window' })),
        release: vi.fn(async () => undefined)
      } as never,
      controller: { startNew, resumeExisting: vi.fn(async () => false) } as never
    });
    return { coord, getQueue, startNew, hasQueueCapacity };
  }

  it('visits every queue including an idle-pending one, and starts only the eligible ones', async () => {
    const { coord, getQueue, startNew } = sweepHarness({
      [DEFAULT_QUEUE_ID]: 'idle-pending',
      [QUEUE_B]: 'active-empty'
    });
    await coord.drainAll();
    // Visited: the gate was consulted for BOTH queues, inside drainIfIdle.
    expect(getQueue).toHaveBeenCalledWith(DEFAULT_QUEUE_ID);
    expect(getQueue).toHaveBeenCalledWith(QUEUE_B);
    // Enforced: only the eligible queue promoted.
    expect(startNew).toHaveBeenCalledTimes(1);
    expect(startNew.mock.calls[0][0]).toMatchObject({ queueId: QUEUE_B });
  });

  it('applies no lifecycle pre-filter: an all-idle-pending workspace is still swept', async () => {
    const { coord, getQueue, startNew, hasQueueCapacity } = sweepHarness({
      [DEFAULT_QUEUE_ID]: 'idle-pending',
      [QUEUE_B]: 'idle-pending'
    });
    await coord.drainAll();
    expect(getQueue).toHaveBeenCalledTimes(2);
    // Every one short-circuited at step 1, so no later step ran for any queue.
    expect(hasQueueCapacity).not.toHaveBeenCalled();
    expect(startNew).not.toHaveBeenCalled();
  });

  it('calls drainIfIdle exactly once per queue', async () => {
    const { coord, getQueue } = sweepHarness({
      [DEFAULT_QUEUE_ID]: 'active-empty',
      [QUEUE_B]: 'active-empty'
    });
    await coord.drainAll();
    expect(getQueue.mock.calls.map((c) => c[0])).toEqual([DEFAULT_QUEUE_ID, QUEUE_B]);
  });
});
