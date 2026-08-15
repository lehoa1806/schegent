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
    expect(controller.admitNew).toHaveBeenCalledWith({ id: 'q-2', description: 'next item' }, null);
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
    expect(controller.admitNew).not.toHaveBeenCalled();
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
    expect(controller.admitNew).not.toHaveBeenCalled();
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
    expect(controller.admitNew).not.toHaveBeenCalled();
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
    expect(controller.admitNew).not.toHaveBeenCalled();
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
    const store = makeStore({ paused: false, inFlightId: null });
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
      controller: controller as never
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
    const store = makeStore({ paused: false, inFlightId: null });
    // Step 4's execution reading is closed; every other gate is open.
    const queue = makeQueue({ id: 'q-2', description: 'next' }, true, true, false);
    const lease = makeLease(true);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      executionLease: lease as never,
      controller: controller as never
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
    expect(controller.admitNew).not.toHaveBeenCalled();
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
    expect(controller.admitNew).toHaveBeenCalled();
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
    expect(controller.admitNew).toHaveBeenCalled();
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
      getQueue: () => ({
        queueLifecycle: 'active-empty' as QueueLifecycle,
        paused: false,
        inFlightId: null
      }),
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
      : null
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
