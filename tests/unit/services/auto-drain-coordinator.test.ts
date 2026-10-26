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
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import type { QueueLifecycle } from '../../../src/queue/feature-request';

// FR-R3-011 — `paused` is gone from this fixture, not merely unset. It was the
// retired `QueueState.paused` mirror, and step 2 used to read it; a fixture that
// can still express it is a fixture that can express a queue paused one way and
// running the other, which is exactly the disagreement the collapse removed.
// Pausedness is `queueLifecycle === 'operator-paused'` here as it is on disk.
function makeStore(queueState: {
  inFlightId: string | null;
  queueLifecycle?: QueueLifecycle;
}) {
  return {
    getQueue: vi.fn(() => ({
      queueLifecycle: queueState.queueLifecycle ?? 'active-empty',
      pauseSource: null,
      // Feature 195 (T012) — no scenario in this file carries a failed row;
      // `...queueState` still lets a call site override it explicitly.
      requests: [],
      ...queueState
    })),
    // BUG-003 — step 3's second reading. `null` is "this queue holds no Run",
    // which is the state every test below was already implicitly asserting
    // against, so each keeps discriminating on the one gate it is about.
    getRun: vi.fn(() => null)
  };
}

function makeQueue(
  next: { id: string; description: string } | null,
  hasWorkspaceCapacity = true,
  hasQueueCapacity = true,
  hasExecutionCapacity = true
) {
  return {
    peekNextPending: vi.fn(() => next),
    hasQueueCapacity: vi.fn(() => hasQueueCapacity),
    // Feature 093 (T072) — step 4's second reading: the cap measured against the
    // Runs this window is driving. Open by default here so the tests below keep
    // discriminating on the gate each one is actually about.
    hasExecutionCapacity: vi.fn(() => hasExecutionCapacity),
    hasWorkspaceCapacity: vi.fn(() => hasWorkspaceCapacity)
  };
}

function makeLease(acquired: boolean) {
  return {
    tryAcquire: vi.fn(async () => ({ acquired, ownerId: 'w-1' })),
    release: vi.fn(async () => undefined)
  };
}

/**
 * Feature 093 (T049a) — the drain awaits admission, not completion, so the
 * double answers the admission pair. `completed` is the promise of the Run's
 * execution; here it is already resolved, which is the "the Run finished
 * instantly" case and keeps every gate-order assertion below unchanged.
 */
function makeController() {
  return {
    admitNew: vi.fn(async () => ({ completed: Promise.resolve() })),
    admitResume: vi.fn(async () => ({ resumed: false, completed: Promise.resolve() })),
    // A double holds no sessions, so it drives no Runs (T072).
    liveRunCount: 0
  };
}

describe('AutoDrainCoordinator (T099 / T102)', () => {
  it('promotes the next pending feature when queue is idle and the lease is available', async () => {
    const store = makeStore({ inFlightId: null });
    const queue = makeQueue({ id: 'q-2', description: 'next item' });
    const lease = makeLease(true);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never,
      failurePolicyDefault: { resolve: () => 'halt-on-failure' }
    });
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(controller.admitNew).toHaveBeenCalledWith({ id: 'q-2', description: 'next item' }, null);
  });

  it('short-circuits when the queue is paused', async () => {
    const store = makeStore({ inFlightId: null, queueLifecycle: 'operator-paused' });
    const queue = makeQueue({ id: 'q-2', description: 'next' });
    const lease = makeLease(true);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never,
      failurePolicyDefault: { resolve: () => 'halt-on-failure' }
    });
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(queue.peekNextPending).not.toHaveBeenCalled();
    expect(controller.admitNew).not.toHaveBeenCalled();
  });

  it('short-circuits when the workspace concurrency ceiling is full', async () => {
    const store = makeStore({ inFlightId: null });
    const queue = makeQueue({ id: 'q-2', description: 'next' }, false);
    const lease = makeLease(true);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never,
      failurePolicyDefault: { resolve: () => 'halt-on-failure' }
    });
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(queue.peekNextPending).not.toHaveBeenCalled();
    expect(controller.admitNew).not.toHaveBeenCalled();
  });

  it('short-circuits when THIS queue already holds an in-flight Task', async () => {
    const store = makeStore({ inFlightId: 'q-1' });
    const queue = makeQueue({ id: 'q-2', description: 'next' }, true, false);
    const lease = makeLease(true);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never,
      failurePolicyDefault: { resolve: () => 'halt-on-failure' }
    });
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(queue.hasWorkspaceCapacity).not.toHaveBeenCalled();
    expect(controller.admitNew).not.toHaveBeenCalled();
  });

  // BUG-003 — step 3's second reading. A paused Run keeps its queue's one Run
  // slot but leaves the in-flight Task count, so `hasQueueCapacity` is open and
  // every later gate is open too; before this, step 7's `admitNew` overwrote the
  // paused Run's record with the successor's and nothing reported the loss.
  it.each([['paused'], ['running']] as const)(
    'short-circuits when this queue already holds a %s Run',
    async (status) => {
      const store = makeStore({ inFlightId: null });
      store.getRun = vi.fn(() => ({ id: 'run-1', status }) as never);
      const queue = makeQueue({ id: 'q-2', description: 'next' });
      const lease = makeLease(true);
      const controller = makeController();
      const coord = new AutoDrainCoordinator({
        store: store as never,
        queue: queue as never,
        executionLease: lease as never,
        controller: controller as never,
        failurePolicyDefault: { resolve: () => 'halt-on-failure' }
      });
      await coord.drainIfIdle(DEFAULT_QUEUE_ID);
      expect(controller.admitNew).not.toHaveBeenCalled();
      // Refused before step 6, so the Run that holds this queue keeps the
      // execution lease it owns. A refusal after the acquire would reach step
      // 7's release and strip the lease from a live Run.
      expect(lease.tryAcquire).not.toHaveBeenCalled();
      expect(lease.release).not.toHaveBeenCalled();
    }
  );

  it.each([['completed'], ['failed'], ['canceled']] as const)(
    'still drains when this queue holds a %s Run',
    async (status) => {
      // The queue's Run slot is free once its Run is terminal — the successor is
      // exactly what should claim it. Guards the case above from becoming
      // "a queue never drains twice".
      const store = makeStore({ inFlightId: null });
      store.getRun = vi.fn(() => ({ id: 'run-1', status }) as never);
      const queue = makeQueue({ id: 'q-2', description: 'next' });
      const lease = makeLease(true);
      const controller = makeController();
      const coord = new AutoDrainCoordinator({
        store: store as never,
        queue: queue as never,
        executionLease: lease as never,
        controller: controller as never,
        failurePolicyDefault: { resolve: () => 'halt-on-failure' }
      });
      await coord.drainIfIdle(DEFAULT_QUEUE_ID);
      expect(controller.admitNew).toHaveBeenCalled();
    }
  );

  it('short-circuits when no pending feature exists', async () => {
    const store = makeStore({ inFlightId: null });
    const queue = makeQueue(null);
    const lease = makeLease(true);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never,
      failurePolicyDefault: { resolve: () => 'halt-on-failure' }
    });
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(lease.tryAcquire).not.toHaveBeenCalled();
    expect(controller.admitNew).not.toHaveBeenCalled();
  });

  it('short-circuits when the execution lease is held by another window', async () => {
    const store = makeStore({ inFlightId: null });
    const queue = makeQueue({ id: 'q-2', description: 'next' });
    const lease = makeLease(false);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never,
      failurePolicyDefault: { resolve: () => 'halt-on-failure' }
    });
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(controller.admitNew).not.toHaveBeenCalled();
  });

  // Feature 093 (T081/T082, FR-011, SC-011) — the two tests that stood here
  // pinned step 4b, and step 4b is gone. Feature 092 needed it because
  // `KEYS.run` held one `WorkflowRun` and one `RunDriver` served the window, so
  // a start issued past a busy engine would have overwritten the live Run's
  // record; the v10 → v11 per-queue record and the per-queue `RunSession`
  // remove the disagreement the gate absorbed.
  //
  // Replacing them with an inverted pair rather than deleting them: "a busy
  // engine no longer refuses" is the feature's acceptance signal and needs a
  // test that fails if the gate returns, and `running` needs an assertion that
  // it is not what the drain consults, or the next edit reads it again.
  it('starts a second Run while the engine is already driving one', async () => {
    const store = makeStore({ inFlightId: null });
    const queue = makeQueue({ id: 'q-2', description: 'next' });
    const lease = makeLease(true);
    let runningReads = 0;
    const controller = {
      ...makeController(),
      get running(): boolean {
        runningReads++;
        return true;
      }
    };
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never,
      failurePolicyDefault: { resolve: () => 'halt-on-failure' }
    });
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(controller.admitNew).toHaveBeenCalledTimes(1);
    expect(lease.tryAcquire).toHaveBeenCalledWith(DEFAULT_QUEUE_ID);
    // The engine's busyness is not an input to the decision at all. Asserting
    // the start alone would still pass a reintroduced gate that read `running`
    // and happened to let this case through.
    expect(runningReads).toBe(0);
  });

  it('waits on the cap, which is what bounds concurrency now that 4b is gone', async () => {
    const store = makeStore({ inFlightId: null });
    // Step 4's execution reading is closed; every other gate is open.
    const queue = makeQueue({ id: 'q-2', description: 'next' }, true, true, false);
    const lease = makeLease(true);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never,
      failurePolicyDefault: { resolve: () => 'halt-on-failure' }
    });
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(queue.hasExecutionCapacity).toHaveBeenCalledWith(0);
    // A wait, not a claim: nothing past the capacity check was consulted, so no
    // lease is left held and no pending head was removed.
    expect(controller.admitNew).not.toHaveBeenCalled();
    expect(queue.peekNextPending).not.toHaveBeenCalled();
    expect(lease.tryAcquire).not.toHaveBeenCalled();
    expect(lease.release).not.toHaveBeenCalled();
  });
});

// Feature 065 (T010) — the `idle-pending` gate MUST short-circuit the
// drain so a chooser-driven (or future-scheduled) start never auto-promotes
// behind the operator's back.
describe('AutoDrainCoordinator — Feature 065 idle-pending gate', () => {
  it('idle-pending lifecycle returns early before peekNextPending/tryAcquire', async () => {
    const store = makeStore({
      inFlightId: null,
      queueLifecycle: 'idle-pending'});
    const queue = makeQueue({ id: 'q-2', description: 'next' });
    const lease = makeLease(true);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never,
      failurePolicyDefault: { resolve: () => 'halt-on-failure' }
    });
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(queue.peekNextPending).not.toHaveBeenCalled();
    expect(queue.hasQueueCapacity).not.toHaveBeenCalled();
    expect(queue.hasWorkspaceCapacity).not.toHaveBeenCalled();
    expect(lease.tryAcquire).not.toHaveBeenCalled();
    expect(controller.admitNew).not.toHaveBeenCalled();
  });

  it('running lifecycle proceeds through the existing checks (FR-005 carve-out)', async () => {
    const store = makeStore({
      inFlightId: 'q-1',
      queueLifecycle: 'running'});
    const queue = makeQueue({ id: 'q-2', description: 'next' });
    const lease = makeLease(true);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never,
      failurePolicyDefault: { resolve: () => 'halt-on-failure' }
    });
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(controller.admitNew).toHaveBeenCalled();
  });

  it('active-empty lifecycle proceeds through the existing checks', async () => {
    const store = makeStore({
      inFlightId: null,
      queueLifecycle: 'active-empty'});
    const queue = makeQueue({ id: 'q-2', description: 'next' });
    const lease = makeLease(true);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never,
      failurePolicyDefault: { resolve: () => 'halt-on-failure' }
    });
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(controller.admitNew).toHaveBeenCalled();
  });

  // FR-R3-011 — this used to read "short-circuits via the legacy paused gate
  // (not the new lifecycle gate)", which was true when step 2 consulted the
  // `paused` mirror and the lifecycle value was along for the ride. The mirror
  // is retired, so the lifecycle value is now the only thing refusing here, and
  // this case is the fourth member of the enumeration above rather than a
  // different mechanism sharing a name.
  it('operator-paused short-circuits at the lifecycle gate', async () => {
    const store = makeStore({
      inFlightId: null,
      queueLifecycle: 'operator-paused'});
    const queue = makeQueue({ id: 'q-2', description: 'next' });
    const lease = makeLease(true);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never,
      failurePolicyDefault: { resolve: () => 'halt-on-failure' }
    });
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(controller.admitNew).not.toHaveBeenCalled();
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
        pauseSource: null,
        inFlightId: null,
        requests: []
      })),
      getRun: vi.fn(() => null),
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
      // Feature 093 (T072) — the same ceiling read the other way: `inFlight` is
      // both the count of persisted in-flight rows and the count of Runs this
      // window is driving, because in this harness every promotion is one Run in
      // this window. Modelling it once and answering both readings from it keeps
      // the sweep's choice — not the ceiling's spelling — the thing under test.
      hasExecutionCapacity: vi.fn((live: number) => live < options.capacity),
      hasWorkspaceCapacity: vi.fn(() => inFlight < options.capacity)
    } as never,
    executionLease: {
      tryAcquire: vi.fn(async () => ({ acquired: true, ownerId: 'w-1' })),
      release: vi.fn(async () => undefined)
    } as never,
    controller: {
      admitNew: vi.fn(async (task: { queueId: string }) => {
        promoted.push(task.queueId);
        inFlight += 1;
        return { completed: Promise.resolve() };
      }),
      admitResume: vi.fn(async () => ({ resumed: false, completed: Promise.resolve() })),
      get liveRunCount() {
        return inFlight;
      }
    } as never,
    failurePolicyDefault: { resolve: () => 'halt-on-failure' }
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

// ---------------------------------------------------------------------------
// Feature 093 (T049 / T049a) — the sweep guard, and the admission seam it needs.
//
// `drainAll()` is triggered fire-and-forget once per terminating Run, so with N
// Runs in flight N sweeps can be asked for at once. Every test below suspends a
// sweep at a real await point — the admission of a queue's Run — and then acts
// while it is suspended, which is the window the guard exists to close. Nothing
// here sleeps or races a timer: admissions are explicit deferreds and the
// interleaving is chosen by the test (research R10).
// ---------------------------------------------------------------------------

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = () => r();
  });
  return { promise, resolve };
}

/** Flush the microtask queue far enough for every suspended sweep to settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 32; i += 1) await Promise.resolve();
}

function interleavingHarness(
  options: { pendingFor?: readonly string[]; audit?: boolean; capacity?: number } = {}
) {
  /**
   * Unbounded unless a test asks for a ceiling. Most tests here are about the
   * sweep guard, where a capacity refusal would end a sweep early for a reason
   * that has nothing to do with interleaving.
   */
  const capacity = options.capacity ?? Number.POSITIVE_INFINITY;
  const pending = new Set(options.pendingFor ?? QUEUE_IDS);
  /** Every queue `admitNew`/`admitResume` was called for, in call order. */
  const offered: string[] = [];
  const inFlight = new Set<string>();
  const admissionGates = new Map<string, Deferred>();
  const runGates = new Map<string, Deferred>();
  const appends: Array<Record<string, unknown>> = [];
  let gateAdmissions = true;

  async function admit(queueId: string) {
    offered.push(queueId);
    if (gateAdmissions) {
      const gate = deferred();
      admissionGates.set(queueId, gate);
      await gate.promise;
    }
    inFlight.add(queueId);
    const run = deferred();
    runGates.set(queueId, run);
    return { completed: run.promise };
  }

  const coord = new AutoDrainCoordinator({
    store: {
      getQueue: (_queueId: string) => ({
        queueLifecycle: 'active-empty' as QueueLifecycle,
        pauseSource: null,
        inFlightId: null,
        requests: []
      }),
      getRun: (_queueId: string) => null,
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
      peekNextPending: (queueId: string) =>
        pending.has(queueId) ? { id: `task-${queueId}`, description: 'next', queueId } : null,
      hasQueueCapacity: (queueId: string) => !inFlight.has(queueId),
      // Both readings answered from the one `inFlight` set: in this harness
      // every promotion is one Run in this window, so the persisted-row count
      // and the driven-Run count coincide. What a test varies is the ceiling,
      // never which of the two spellings enforces it.
      hasExecutionCapacity: (live: number) => live < capacity,
      hasWorkspaceCapacity: () => inFlight.size < capacity,
      inFlightCount: (queueId?: string) =>
        queueId === undefined ? inFlight.size : inFlight.has(queueId) ? 1 : 0
    } as never,
    executionLease: {
      tryAcquire: async () => ({ acquired: true, ownerId: 'w-1' }),
      release: async () => undefined
    } as never,
    controller: {
      admitNew: (task: { queueId: string }) => admit(task.queueId),
      admitResume: async () => ({ resumed: false, completed: Promise.resolve() }),
      get liveRunCount() {
        return inFlight.size;
      }
    } as never,
    auditWriter: options.audit
      ? {
          append: async (entry: { payload: Record<string, unknown> }) => {
            appends.push(entry.payload);
            return undefined;
          }
        }
      : null,
      failurePolicyDefault: { resolve: () => 'halt-on-failure' }
  } as never);

  return {
    coord,
    offered,
    appends,
    inFlight,
    /** Make this queue's pending head appear mid-sweep. */
    addPending: (queueId: string) => pending.add(queueId),
    /** Let every admission so far — and every later one — through. */
    openAllAdmissions: () => {
      gateAdmissions = false;
      for (const gate of admissionGates.values()) gate.resolve();
    },
    /** End a Run that has been admitted. */
    finishRun: (queueId: string) => {
      inFlight.delete(queueId);
      runGates.get(queueId)?.resolve();
    }
  };
}

describe('AutoDrainCoordinator sweep guard (Feature 093 T049)', () => {
  it('a second sweep joins the one in flight instead of walking alongside it', async () => {
    const h = interleavingHarness();

    const first = h.coord.drainAll();
    await settle();
    // Suspended inside q-a's admission: the Task is not in flight yet, so an
    // interleaved sweep would find q-a eligible and offer it a second time.
    expect(h.offered).toEqual(['q-a']);

    const second = h.coord.drainAll();
    await settle();
    expect(h.offered).toEqual(['q-a']);

    h.openAllAdmissions();
    await Promise.all([first, second]);
    expect(h.offered).toEqual(['q-a', 'q-b', 'q-c', 'q-d']);
  });

  it('a request arriving during a sweep is coalesced, not dropped', async () => {
    // Only q-a has work when the sweep starts.
    const h = interleavingHarness({ pendingFor: ['q-a'] });

    const first = h.coord.drainAll();
    await settle();
    expect(h.offered).toEqual(['q-a']);

    // A Run elsewhere terminates and enqueues work the current sweep has
    // already walked past. Its trigger must survive the sweep it arrived during.
    const second = h.coord.drainAll();
    h.addPending('q-b');
    h.openAllAdmissions();
    await Promise.all([first, second]);

    expect(h.offered).toEqual(['q-a', 'q-b']);
  });

  it('the overlap episode is opened once across two overlapping triggers', async () => {
    const h = interleavingHarness({ audit: true });

    const first = h.coord.drainAll();
    await settle();
    const second = h.coord.drainAll();
    h.openAllAdmissions();
    await Promise.all([first, second]);

    // Four Runs in flight, one episode. The latch is read-modify-written inside
    // one sweep at a time, so the second trigger cannot re-open what the first
    // already recorded.
    expect(h.inFlight.size).toBe(4);
    expect(h.appends).toHaveLength(1);
    expect(h.appends[0]).toMatchObject({ eventType: 'runs-overlapped' });
  });

  it('an addressed drain does not double-start a queue a sweep is admitting', async () => {
    const h = interleavingHarness();

    const sweep = h.coord.drainAll();
    await settle();
    expect(h.offered).toEqual(['q-a']);

    // `drainIfIdle` stays concurrent with the sweep by design — it must not join
    // it — so the per-queue half of the guard is what refuses this one.
    const addressed = h.coord.drainIfIdle('q-a');
    await settle();
    expect(h.offered).toEqual(['q-a']);

    h.openAllAdmissions();
    await Promise.all([sweep, addressed]);
    expect(h.offered.filter((id) => id === 'q-a')).toEqual(['q-a']);
  });
});

// ---------------------------------------------------------------------------
// Feature 093 — the ceiling across the admission window (bulk review finding).
//
// Step 4's capacity gate is read synchronously, but the admission it guards is
// several awaits away: the lease acquire, then `admitNew`'s own factory / store
// / `markInFlight` writes before `sessions.size` grows. Every count the gate
// consults — driven Runs and persisted in-flight rows alike — is therefore
// stale for the whole of that window.
//
// Within one sweep that is harmless: the loop awaits each queue's drain before
// the next. But `drainIfIdle` is concurrent with a sweep *by design* (it must
// not join it, or an operator's Start Queue would block behind an unrelated
// sweep), so two drains of two different queues can both pass the gate before
// either admits, and the cap is exceeded by one per interleaving.
//
// Step 4b masked this while it existed — it refused every second concurrent
// start outright, for an unrelated reason — so the window opened when T081
// deleted it. The reservation the gate now takes is what closes it.
// ---------------------------------------------------------------------------

describe('AutoDrainCoordinator ceiling across the admission window', () => {
  it('an addressed drain cannot pass a full ceiling while a sweep is mid-admission', async () => {
    const h = interleavingHarness({ capacity: 1 });

    const sweep = h.coord.drainAll();
    await settle();
    // Suspended inside q-a's admission. The Run exists as far as the drain is
    // concerned, but nothing observable has been written yet: `inFlight` is
    // empty, so both capacity readings still report a free slot.
    expect(h.offered).toEqual(['q-a']);
    expect(h.inFlight.size).toBe(0);

    // An operator presses Start Queue on a different queue, or a scheduled
    // start fires, while the sweep is suspended.
    const addressed = h.coord.drainIfIdle('q-b');
    await settle();

    // The ceiling is 1 and q-a has already claimed it.
    expect(h.offered).toEqual(['q-a']);

    h.openAllAdmissions();
    await Promise.all([sweep, addressed]);
    expect(h.inFlight.size).toBe(1);
  });

  it('the reserved slot is given back when the drain that took it starts nothing', async () => {
    // q-b has no pending head, so its drain passes the gate and then bails at
    // step 5. A reservation that leaked there would permanently shrink the
    // ceiling by one — the failure mode a bare counter invites, and the reason
    // it is released in a `finally` rather than on the success path.
    const h = interleavingHarness({ pendingFor: ['q-a'], capacity: 1 });

    await h.coord.drainIfIdle('q-b');
    expect(h.offered).toEqual([]);

    h.openAllAdmissions();
    await h.coord.drainIfIdle('q-a');
    expect(h.offered).toEqual(['q-a']);
    expect(h.inFlight.size).toBe(1);
  });

  it('a sweep still fills every slot the ceiling allows', async () => {
    // The guard against over-admitting must not under-admit: three queues, cap
    // three, one sweep, all three promoted.
    const h = interleavingHarness({ capacity: 3 });
    h.openAllAdmissions();

    await h.coord.drainAll();

    expect(h.offered).toEqual(['q-a', 'q-b', 'q-c']);
    expect(h.inFlight.size).toBe(3);
  });
});

describe('AutoDrainCoordinator admission seam (Feature 093 T049a)', () => {
  it('a sweep offers every queue without waiting for the Runs it started', async () => {
    const h = interleavingHarness();
    h.openAllAdmissions();

    // No Run ever completes: `finishRun` is not called, so every `completed`
    // promise stays pending for the whole test. A drain that awaited completion
    // rather than admission would never reach q-b.
    await h.coord.drainAll();

    expect(h.offered).toEqual(['q-a', 'q-b', 'q-c', 'q-d']);
    expect(h.inFlight.size).toBe(4);
  });

  it('a queue whose Run is still executing is not offered again', async () => {
    const h = interleavingHarness();
    h.openAllAdmissions();

    await h.coord.drainAll();
    await h.coord.drainAll();

    // The second sweep saw the counts the first sweep's admissions produced,
    // which is the whole reason the seam is `markInFlight` and not the spawn.
    expect(h.offered).toEqual(['q-a', 'q-b', 'q-c', 'q-d']);
  });
});

describe('AutoDrainCoordinator — the diagnostic a failed start leaves behind', () => {
  // Nothing re-asks within the session after step 7 throws, so this warning is
  // the whole record of why a queue stopped. These pin what it has to say.
  function failingSetup(next: { id: string; description: string; runId?: string }) {
    const store = makeStore({ inFlightId: null });
    const queue = makeQueue(next);
    const lease = makeLease(true);
    const controller = makeController();
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never,
      logger: logger as never,
      failurePolicyDefault: { resolve: () => 'halt-on-failure' }
    });
    return { coord, lease, controller, logger };
  }

  it('names the admission it actually called, not one the port forbids it', async () => {
    const s = failingSetup({ id: 'q-7', description: 'ship the thing' });
    s.controller.admitNew = vi.fn(async () => {
      throw new Error('spawn refused');
    });

    await s.coord.drainIfIdle('q-7');

    const message = String(s.logger.warn.mock.calls[0]?.[0]);
    expect(message).toContain('admitNew');
    expect(message).not.toContain('startNew');
    expect(message).toContain('spawn refused');
  });

  it('names the queue, because a sweep visits several', async () => {
    const s = failingSetup({ id: 'q-7', description: 'ship the thing' });
    s.controller.admitNew = vi.fn(async () => {
      throw new Error('spawn refused');
    });

    await s.coord.drainIfIdle('q-7');

    expect(String(s.logger.warn.mock.calls[0]?.[0])).toContain('q-7');
  });

  it('names admitResume when the resume path is the one that threw', async () => {
    const s = failingSetup({ id: 'q-7', description: 'ship the thing', runId: 'run-3' });
    s.controller.admitResume = vi.fn(async () => {
      throw new Error('journal unreadable');
    });

    await s.coord.drainIfIdle('q-7');

    const message = String(s.logger.warn.mock.calls[0]?.[0]);
    expect(message).toContain('admitResume');
    expect(message).not.toContain('admitNew');
  });

  it('does not put the Task description in the log', async () => {
    // Operator-authored content, on the same terms as FR-038a keeps a queue name
    // out of the audit log.
    const s = failingSetup({ id: 'q-7', description: 'migrate acme-corp billing' });
    s.controller.admitNew = vi.fn(async () => {
      throw new Error('spawn refused');
    });

    await s.coord.drainIfIdle('q-7');

    expect(String(s.logger.warn.mock.calls[0]?.[0])).not.toContain('acme-corp');
  });

  it('gives the execution lease back so the queue is not claimed for 15s', async () => {
    const s = failingSetup({ id: 'q-7', description: 'ship the thing' });
    s.controller.admitNew = vi.fn(async () => {
      throw new Error('spawn refused');
    });

    await s.coord.drainIfIdle('q-7');

    expect(s.lease.release).toHaveBeenCalledWith('q-7');
  });
});

// Feature 187 (T005-T007, US1/US2) — FR-001..FR-006.
//
// The log line the block above pins is a record for whoever opens a log. This
// block pins the record for whoever does not: one report per queue, cleared by a
// success, replaced by a later failure, and written at step 7 only.
describe('AutoDrainCoordinator — the report a failed start leaves on its queue', () => {
  function reportingSetup(
    next: { id: string; description: string; runId?: string } | null,
    queueState: { inFlightId: string | null; queueLifecycle?: QueueLifecycle } = {
      inFlightId: null
    },
    capacity: { workspace?: boolean; queue?: boolean; execution?: boolean } = {}
  ) {
    const store = makeStore(queueState);
    const queue = makeQueue(
      next,
      capacity.workspace ?? true,
      capacity.queue ?? true,
      capacity.execution ?? true
    );
    const lease = makeLease(true);
    const controller = makeController();
    const startFailures = { recordFailure: vi.fn(), clear: vi.fn() };
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never,
      startFailures,
      logger: logger as never,
      failurePolicyDefault: { resolve: () => 'halt-on-failure' }
    });
    return { coord, controller, startFailures, logger };
  }

  it('records the fresh-start admission that threw, against the queue that attempted it', async () => {
    const s = reportingSetup({ id: 'q-7', description: 'ship the thing' });
    s.controller.admitNew = vi.fn(async () => {
      throw new Error('spawn refused');
    });

    await s.coord.drainIfIdle('q-7');

    expect(s.startFailures.recordFailure).toHaveBeenCalledWith('q-7', {
      kind: 'admission',
      admission: 'admitNew',
      message: 'spawn refused'
    });
  });

  it('records admitResume when the resume path is the one that threw', async () => {
    // Not interchangeable with the case above: a resume failure and a spawn
    // failure send an operator to different places (US2).
    const s = reportingSetup({ id: 'q-7', description: 'ship the thing', runId: 'run-3' });
    s.controller.admitResume = vi.fn(async () => {
      throw new Error('journal unreadable');
    });

    await s.coord.drainIfIdle('q-7');

    expect(s.startFailures.recordFailure).toHaveBeenCalledWith('q-7', {
      kind: 'admission',
      admission: 'admitResume',
      message: 'journal unreadable'
    });
  });

  it('names the fresh start when a declining resume falls through to one that throws', async () => {
    // `admitResume` returning `resumed: false` is the documented fall-through,
    // not a failure. The attempt that failed is the fresh start, and that is what
    // the report has to say (spec.md Edge Cases).
    const s = reportingSetup({ id: 'q-7', description: 'ship the thing', runId: 'run-3' });
    s.controller.admitNew = vi.fn(async () => {
      throw new Error('spawn refused');
    });

    await s.coord.drainIfIdle('q-7');

    expect(s.startFailures.recordFailure).toHaveBeenCalledWith(
      'q-7',
      expect.objectContaining({ admission: 'admitNew' })
    );
  });

  it('clears the report when a fresh start succeeds', async () => {
    const s = reportingSetup({ id: 'q-7', description: 'ship the thing' });

    await s.coord.drainIfIdle('q-7');

    expect(s.startFailures.clear).toHaveBeenCalledWith('q-7');
    expect(s.startFailures.recordFailure).not.toHaveBeenCalled();
  });

  it('clears the report when a resume succeeds', async () => {
    const s = reportingSetup({ id: 'q-7', description: 'ship the thing', runId: 'run-3' });
    s.controller.admitResume = vi.fn(async () => ({
      resumed: true,
      completed: Promise.resolve()
    }));

    await s.coord.drainIfIdle('q-7');

    expect(s.startFailures.clear).toHaveBeenCalledWith('q-7');
    expect(s.controller.admitNew).not.toHaveBeenCalled();
  });

  it('does not record and does not clear when step 1 refuses an idle-pending queue', async () => {
    // The gate-order property, and the reason `startFailures` is optional: the
    // report is written inside step 7's own try/catch, so a queue refused before
    // step 7 is neither reported on nor cleared. This one passes on the pre-change
    // tree; it is here to fail if a later edit hoists either call into
    // `drainQueue`, where it would run for all seven refusals.
    const s = reportingSetup({ id: 'q-7', description: 'ship the thing' }, {
      inFlightId: null,
      queueLifecycle: 'idle-pending'
    });

    await s.coord.drainIfIdle('q-7');

    expect(s.startFailures.recordFailure).not.toHaveBeenCalled();
    expect(s.startFailures.clear).not.toHaveBeenCalled();
  });

  it('does not record and does not clear when step 4 refuses at the workspace ceiling', async () => {
    const s = reportingSetup(
      { id: 'q-7', description: 'ship the thing' },
      { inFlightId: null },
      { workspace: false }
    );

    await s.coord.drainIfIdle('q-7');

    expect(s.startFailures.recordFailure).not.toHaveBeenCalled();
    expect(s.startFailures.clear).not.toHaveBeenCalled();
  });

  it('still logs the failure — the report supplements the line, it does not replace it', async () => {
    const s = reportingSetup({ id: 'q-7', description: 'ship the thing' });
    s.controller.admitNew = vi.fn(async () => {
      throw new Error('spawn refused');
    });

    await s.coord.drainIfIdle('q-7');

    expect(String(s.logger.warn.mock.calls[0]?.[0])).toContain('admitNew');
  });

  it('reports nothing at all when no port is wired', async () => {
    // Absent, a failed start behaves exactly as it did before this feature: it
    // logs and returns false. Every existing coordinator double relies on this.
    const store = makeStore({ inFlightId: null });
    const queue = makeQueue({ id: 'q-7', description: 'ship the thing' });
    const lease = makeLease(true);
    const controller = makeController();
    controller.admitNew = vi.fn(async () => {
      throw new Error('spawn refused');
    });
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never,
      failurePolicyDefault: { resolve: () => 'halt-on-failure' }
    });

    await expect(coord.drainIfIdle('q-7')).resolves.toBeUndefined();
    expect(controller.admitNew).toHaveBeenCalled();
    expect(lease.release).toHaveBeenCalledWith('q-7');
  });

  it('reports one queue and still offers the rest of the sweep', async () => {
    // Feature 187 (T009, US3 scenario 3) — a failure is one queue's, and a sweep
    // visits every queue in the registry. The report must not be the reason the
    // queues after it never get asked.
    const ids = ['q-a', 'q-b'];
    const offered: string[] = [];
    const startFailures = { recordFailure: vi.fn(), clear: vi.fn() };
    const coord = new AutoDrainCoordinator({
      store: {
        getQueue: vi.fn(() => ({
          queueLifecycle: 'active-empty' as QueueLifecycle,
          pauseSource: null,
          inFlightId: null,
          requests: []
        })),
        getRun: vi.fn(() => null),
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
        peekNextPending: vi.fn((queueId: string) => ({
          id: `task-${queueId}`,
          description: 'next',
          queueId
        })),
        hasQueueCapacity: vi.fn(() => true),
        hasExecutionCapacity: vi.fn(() => true),
        hasWorkspaceCapacity: vi.fn(() => true)
      } as never,
      executionLease: {
        tryAcquire: vi.fn(async () => ({ acquired: true, ownerId: 'w-1' })),
        release: vi.fn(async () => undefined)
      } as never,
      controller: {
        admitNew: vi.fn(async (task: { queueId: string }) => {
          offered.push(task.queueId);
          if (task.queueId === 'q-a') throw new Error('spawn refused');
          return { completed: Promise.resolve() };
        }),
        admitResume: vi.fn(async () => ({ resumed: false, completed: Promise.resolve() })),
        liveRunCount: 0
      } as never,
      startFailures,
      failurePolicyDefault: { resolve: () => 'halt-on-failure' }
    });

    await coord.drainAll();

    expect(offered).toEqual(['q-a', 'q-b']);
    expect(startFailures.recordFailure).toHaveBeenCalledTimes(1);
    expect(startFailures.recordFailure).toHaveBeenCalledWith('q-a', {
      kind: 'admission',
      admission: 'admitNew',
      message: 'spawn refused'
    });
    expect(startFailures.clear).toHaveBeenCalledTimes(1);
    expect(startFailures.clear).toHaveBeenCalledWith('q-b');
  });
});

// BUG-004 — step 3's occupant refusal, and the one shape of it that never
// re-asks itself.
//
// A queue held by a live Run is the ordinary case: that Run reaches a terminal
// status, its termination sweeps the whole registry, and this refusal is asked
// again. A queue held by a Run whose Task row was deleted is not — every route
// that could end that Run (cancel by id, the palette's sole-run cancel, resume,
// retry) resolves the row first and refuses when there is none, so nothing ends
// it and nothing re-asks. Before this block, both read identically from outside:
// `drainQueue` returned `false` and said nothing.
//
// What these pin is the separation. Reporting every non-terminal occupant would
// put a failure notice on every busy queue, which is how a surface stops being
// read.
describe('AutoDrainCoordinator — the Run that holds a queue and cannot be reached', () => {
  const HELD = 'q-held';
  const OTHER = 'q-other';

  interface Occupant {
    readonly id: string;
    readonly featureId: string;
    readonly status: string;
    readonly currentPhase: string;
  }

  function strandedSetup(options: {
    /** Read fresh on every drain, so a test can free the queue between two. */
    readonly occupant: () => Occupant | null;
    /** Task rows per queue id. A queue absent from the map holds none. */
    readonly rows?: ReadonlyMap<string, readonly { readonly id: string }[]>;
    /** Whether a pending head exists — `false` stops the drain at step 5, before
     *  step 7's own `clear`, so a `clear` assertion can only be step 3's. */
    readonly pending?: boolean;
    readonly withPort?: boolean;
  }) {
    const rows = options.rows ?? new Map<string, readonly { readonly id: string }[]>();
    const ids = rows.size > 0 ? [...rows.keys()] : [HELD];
    const startFailures = { recordFailure: vi.fn(), clear: vi.fn() };
    const getQueueRegistry = vi.fn(() => ({
      entries: ids.map((id, position) => ({ id, position })),
      updatedAt: 0
    }));
    const admitNew = vi.fn(async () => ({ completed: Promise.resolve() }));
    const coord = new AutoDrainCoordinator({
      store: {
        getQueue: vi.fn((queueId: string) => ({
          queueLifecycle: 'active-empty' as QueueLifecycle,
          pauseSource: null,
          inFlightId: null,
          requests: rows.get(queueId) ?? []
        })),
        getRun: vi.fn(() => options.occupant()),
        getQueueRegistry
      } as never,
      queue: {
        peekNextPending: vi.fn(() =>
          options.pending === false ? null : { id: 'task-next', description: 'next' }
        ),
        hasQueueCapacity: vi.fn(() => true),
        hasExecutionCapacity: vi.fn(() => true),
        hasWorkspaceCapacity: vi.fn(() => true)
      } as never,
      executionLease: {
        tryAcquire: vi.fn(async () => ({ acquired: true, ownerId: 'w-1' })),
        release: vi.fn(async () => undefined)
      } as never,
      controller: {
        admitNew,
        admitResume: vi.fn(async () => ({ resumed: false, completed: Promise.resolve() })),
        liveRunCount: 0
      } as never,
      startFailures: options.withPort === false ? null : startFailures,
      failurePolicyDefault: { resolve: () => 'halt-on-failure' as const }
    });
    return { coord, startFailures, getQueueRegistry, admitNew };
  }

  const stranded: Occupant = {
    id: 'run-stranded',
    featureId: 'task-deleted',
    status: 'paused',
    currentPhase: 'implement'
  };

  it('records the Run holding the queue when no Task row anywhere addresses it', async () => {
    const s = strandedSetup({ occupant: () => stranded });

    await s.coord.drainIfIdle(HELD);

    expect(s.startFailures.recordFailure).toHaveBeenCalledWith(HELD, {
      kind: 'stranded-run',
      runId: 'run-stranded',
      phase: 'implement'
    });
  });

  it('reports nothing for the ordinary held queue — its Task row is right there', async () => {
    // The distinction the whole block exists for. This Run is reachable: the
    // operator can cancel or resume it, and when it ends its own sweep re-asks.
    const s = strandedSetup({
      occupant: () => stranded,
      rows: new Map([[HELD, [{ id: 'task-deleted' }]]])
    });

    await s.coord.drainIfIdle(HELD);

    expect(s.startFailures.recordFailure).not.toHaveBeenCalled();
  });

  it('reports nothing when the Task row moved to another queue', async () => {
    // The row is not on the Run's own queue, and the Run is still addressable —
    // the same reason `reconcileOrphanedRuns` asks across every queue rather
    // than the one the Run is parked on.
    const s = strandedSetup({
      occupant: () => stranded,
      rows: new Map([
        [HELD, []],
        [OTHER, [{ id: 'task-deleted' }]]
      ])
    });

    await s.coord.drainIfIdle(HELD);

    expect(s.startFailures.recordFailure).not.toHaveBeenCalled();
  });

  it('refuses the queue either way — the report is not a second gate', async () => {
    const reported = strandedSetup({ occupant: () => stranded });
    const ordinary = strandedSetup({
      occupant: () => stranded,
      rows: new Map([[HELD, [{ id: 'task-deleted' }]]])
    });

    await reported.coord.drainIfIdle(HELD);
    await ordinary.coord.drainIfIdle(HELD);

    expect(reported.admitNew).not.toHaveBeenCalled();
    expect(ordinary.admitNew).not.toHaveBeenCalled();
  });

  it('clears the report once the queue is no longer held', async () => {
    let occupant: Occupant | null = stranded;
    const s = strandedSetup({ occupant: () => occupant, pending: false });

    await s.coord.drainIfIdle(HELD);
    expect(s.startFailures.recordFailure).toHaveBeenCalledTimes(1);

    occupant = null;
    await s.coord.drainIfIdle(HELD);

    // `pending: false` stops this drain at step 5, so step 7's own `clear`
    // cannot be what answered here.
    expect(s.startFailures.clear).toHaveBeenCalledWith(HELD);
  });

  it('clears the report once the Run becomes addressable again', async () => {
    // Still held, but by a Run the operator can now reach. A report left
    // standing here would tell them to reload a window for a Run they can
    // simply cancel.
    const rows = new Map<string, readonly { readonly id: string }[]>([[HELD, []]]);
    const s = strandedSetup({ occupant: () => stranded, rows, pending: false });

    await s.coord.drainIfIdle(HELD);
    expect(s.startFailures.recordFailure).toHaveBeenCalledTimes(1);

    rows.set(HELD, [{ id: 'task-deleted' }]);
    await s.coord.drainIfIdle(HELD);

    expect(s.startFailures.clear).toHaveBeenCalledWith(HELD);
  });

  it('does not clear a report it did not write', async () => {
    // `clear` on this path drops exactly what step 3 recorded. An admission
    // report from a previous attempt belongs to step 7 and is not step 3's to
    // erase — the queue below was never reported as held.
    const s = strandedSetup({ occupant: () => null, pending: false });

    await s.coord.drainIfIdle(HELD);

    expect(s.startFailures.clear).not.toHaveBeenCalled();
  });

  it('does not even look for the Task row when no port is wired', async () => {
    // The reason `startFailures` is optional, restated for this step: the
    // gate-order tests assert which collaborators a refusal consulted, and a
    // registry scan that ran without a reader would change that answer for a
    // reason unrelated to the gate under test.
    const s = strandedSetup({ occupant: () => stranded, withPort: false });

    await s.coord.drainIfIdle(HELD);

    expect(s.getQueueRegistry).not.toHaveBeenCalled();
    expect(s.admitNew).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// FR-R3-205 — a closed drain starts nothing, so teardown leaves a pending task
// pending.
//
// Stage 2's teardown stops the in-flight Run, and that Run's terminal funnel
// schedules a drain. `close()` is what makes that drain a wait. Every
// "admits nothing" case below runs the same fixture open first, in the same
// `it`, and shows it admitting: a fixture that could never admit would pass
// the closed half for no reason of its own.
// ---------------------------------------------------------------------------

describe('AutoDrainCoordinator — FR-R3-205: a closed drain starts nothing', () => {
  const QUEUE = DEFAULT_QUEUE_ID;
  const OWNER = { acquired: true, ownerId: 'w-1' };

  function openLease() {
    return {
      tryAcquire: vi.fn(async () => OWNER),
      release: vi.fn(async () => undefined)
    };
  }

  /** `tryAcquire` stays pending until the gate opens; the re-check then answers true. */
  function claimGatedLease(gate: Deferred) {
    return {
      tryAcquire: vi.fn(async () => {
        await gate.promise;
        return OWNER;
      }),
      release: vi.fn(async () => undefined),
      hasLease: vi.fn(async () => true)
    };
  }

  /** The same claim, on a lease port that offers no re-check at all. */
  function claimGatedLeaseWithoutRecheck(gate: Deferred) {
    return {
      tryAcquire: vi.fn(async () => {
        await gate.promise;
        return OWNER;
      }),
      release: vi.fn(async () => undefined)
    };
  }

  /** The claim resolves at once; the FR-R3-003 re-check stays pending until the gate opens. */
  function recheckGatedLease(gate: Deferred) {
    return {
      tryAcquire: vi.fn(async () => OWNER),
      release: vi.fn(async () => undefined),
      hasLease: vi.fn(async () => {
        await gate.promise;
        return true;
      })
    };
  }

  function build<L extends object = ReturnType<typeof openLease>>(
    options: {
      readonly queueIds?: readonly string[];
      readonly requests?: readonly unknown[];
      readonly policy?: 'halt-on-failure' | 'continue';
      readonly peek?: (queueId: string) => { id: string; description: string } | null;
      readonly lease?: L;
      readonly admitNew?: () => Promise<{ completed: Promise<void> }>;
    } = {}
  ) {
    const queueIds = options.queueIds ?? [QUEUE];
    const lease = (options.lease ?? openLease()) as L;
    const startFailures = { recordFailure: vi.fn(), clear: vi.fn() };
    const auditWriter = { append: vi.fn(async () => undefined) };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const admitNew = vi.fn(options.admitNew ?? (async () => ({ completed: Promise.resolve() })));
    const admitResume = vi.fn(async () => ({ resumed: false, completed: Promise.resolve() }));
    const deps = {
      store: {
        getQueue: vi.fn(() => ({
          queueLifecycle: 'active-empty' as QueueLifecycle,
          pauseSource: null,
          inFlightId: null,
          requests: options.requests ?? []
        })),
        getRun: vi.fn(() => null),
        getQueueRegistry: () => ({
          entries: queueIds.map((id, position) => ({ id, position })),
          updatedAt: 0
        })
      } as never,
      queue: {
        peekNextPending: vi.fn(
          options.peek ?? ((queueId: string) => ({ id: `task-${queueId}`, description: 'next' }))
        ),
        hasQueueCapacity: vi.fn(() => true),
        hasExecutionCapacity: vi.fn(() => true),
        hasWorkspaceCapacity: vi.fn(() => true),
        inFlightCount: vi.fn(() => 0)
      } as never,
      executionLease: lease as never,
      controller: { admitNew, admitResume, liveRunCount: 0 } as never,
      startFailures,
      auditWriter,
      logger: logger as never,
      failurePolicyDefault: { resolve: () => options.policy ?? ('halt-on-failure' as const) }
    };
    return {
      coord: new AutoDrainCoordinator(deps),
      deps,
      lease,
      admitNew,
      admitResume,
      startFailures,
      auditWriter,
      logger
    };
  }

  type Built = ReturnType<typeof build>;

  function expectNothingWritten(f: Built) {
    expect(f.admitNew).not.toHaveBeenCalled();
    expect(f.admitResume).not.toHaveBeenCalled();
    expect(f.startFailures.recordFailure).not.toHaveBeenCalled();
    expect(f.startFailures.clear).not.toHaveBeenCalled();
    expect(f.auditWriter.append).not.toHaveBeenCalled();
    expect(f.logger.warn).not.toHaveBeenCalled();
    expect(f.logger.error).not.toHaveBeenCalled();
  }

  /** Start a drain, let it reach the await the case is about, optionally close, then release it. */
  async function drainClosingWhileWaiting<L extends object>(
    makeLease: (gate: Deferred) => L,
    waitingOn: (lease: L) => unknown,
    closeWhileWaiting: boolean
  ) {
    const gate = deferred();
    const f = build({ lease: makeLease(gate) });
    const drain = f.coord.drainIfIdle(QUEUE);
    await settle();
    expect(waitingOn(f.lease)).toHaveBeenCalledTimes(1);
    if (closeWhileWaiting) f.coord.close();
    gate.resolve();
    await drain;
    return f;
  }

  it('US1.1 — a closed drainIfIdle claims no lease and admits nothing', async () => {
    const open = build();
    await open.coord.drainIfIdle(QUEUE);
    expect(open.admitNew).toHaveBeenCalledTimes(1);

    const closed = build();
    closed.coord.close();
    await closed.coord.drainIfIdle(QUEUE);
    expect(closed.lease.tryAcquire).not.toHaveBeenCalled();
    expect(closed.admitNew).not.toHaveBeenCalled();
  });

  it('US1.2 — a closed drainAll over three queues claims no lease and admits none', async () => {
    const queueIds = ['q-1', 'q-2', 'q-3'];
    const open = build({ queueIds });
    await open.coord.drainAll();
    expect(open.admitNew).toHaveBeenCalledTimes(3);

    const closed = build({ queueIds });
    closed.coord.close();
    await closed.coord.drainAll();
    expect(closed.lease.tryAcquire).not.toHaveBeenCalled();
    expect(closed.admitNew).not.toHaveBeenCalled();
  });

  it('US1.3 — under `continue`, a closed drainAll admits neither pending task behind a failed row', async () => {
    const firstPending = { id: 't-1', description: 'first pending' };
    const requests = [
      { id: 't-0', description: 'failed', status: 'failed', position: 0 },
      { ...firstPending, status: 'pending', position: 1 },
      { id: 't-2', description: 'second pending', status: 'pending', position: 2 }
    ];
    const options = { requests, policy: 'continue' as const, peek: () => firstPending };

    const open = build(options);
    await open.coord.drainAll();
    expect(open.admitNew).toHaveBeenCalledTimes(1);
    expect(open.admitNew).toHaveBeenCalledWith(firstPending, null);

    const closed = build(options);
    closed.coord.close();
    await closed.coord.drainAll();
    expect(closed.lease.tryAcquire).not.toHaveBeenCalled();
    expect(closed.admitNew).not.toHaveBeenCalled();
  });

  it('US1.4 — close() is idempotent, on a coordinator that never drained and on one that did', async () => {
    const fresh = build();
    expect(() => fresh.coord.close()).not.toThrow();
    expect(() => fresh.coord.close()).not.toThrow();

    const used = build();
    await used.coord.drainIfIdle(QUEUE);
    expect(used.admitNew).toHaveBeenCalledTimes(1);
    expect(() => used.coord.close()).not.toThrow();
    expect(() => used.coord.close()).not.toThrow();
  });

  it('US1.5 — a closed refusal records no failure, writes no audit event and logs nothing', async () => {
    // The open half makes the spies live: a start that throws reaches all of them.
    const open = build({
      admitNew: async () => {
        throw new Error('refused');
      }
    });
    await open.coord.drainIfIdle(QUEUE);
    expect(open.startFailures.recordFailure).toHaveBeenCalledTimes(1);
    expect(open.logger.warn).toHaveBeenCalledTimes(1);

    const closed = build({
      admitNew: async () => {
        throw new Error('refused');
      }
    });
    closed.coord.close();
    await closed.coord.drainIfIdle(QUEUE);
    expectNothingWritten(closed);
  });

  it('US2.1 — a close while the claim is pending releases the lease once and admits nothing', async () => {
    const open = await drainClosingWhileWaiting(claimGatedLease, (l) => l.tryAcquire, false);
    expect(open.admitNew).toHaveBeenCalledTimes(1);
    expect(open.lease.release).not.toHaveBeenCalled();

    const closed = await drainClosingWhileWaiting(claimGatedLease, (l) => l.tryAcquire, true);
    expect(closed.lease.release).toHaveBeenCalledTimes(1);
    expect(closed.lease.release).toHaveBeenCalledWith(QUEUE);
    expectNothingWritten(closed);
  });

  it('US2.1b — a close while the FR-R3-003 re-check is pending releases the lease once and admits nothing', async () => {
    const open = await drainClosingWhileWaiting(recheckGatedLease, (l) => l.hasLease, false);
    expect(open.admitNew).toHaveBeenCalledTimes(1);
    expect(open.lease.release).not.toHaveBeenCalled();

    const closed = await drainClosingWhileWaiting(recheckGatedLease, (l) => l.hasLease, true);
    expect(closed.lease.release).toHaveBeenCalledTimes(1);
    expect(closed.lease.release).toHaveBeenCalledWith(QUEUE);
    expectNothingWritten(closed);
  });

  it('US2.2 — with no re-check on the lease port, a close during the claim still releases once and admits nothing', async () => {
    const open = await drainClosingWhileWaiting(
      claimGatedLeaseWithoutRecheck,
      (l) => l.tryAcquire,
      false
    );
    expect(open.admitNew).toHaveBeenCalledTimes(1);
    expect(open.lease.release).not.toHaveBeenCalled();

    const closed = await drainClosingWhileWaiting(
      claimGatedLeaseWithoutRecheck,
      (l) => l.tryAcquire,
      true
    );
    expect(closed.lease.release).toHaveBeenCalledTimes(1);
    expect(closed.lease.release).toHaveBeenCalledWith(QUEUE);
    expectNothingWritten(closed);
  });

  it('US4.1 — a coordinator built after another is closed admits as before', async () => {
    const first = build();
    first.coord.close();
    await first.coord.drainIfIdle(QUEUE);
    expect(first.admitNew).not.toHaveBeenCalled();

    const second = new AutoDrainCoordinator(first.deps);
    await second.drainIfIdle(QUEUE);
    expect(first.admitNew).toHaveBeenCalledTimes(1);
  });
});
