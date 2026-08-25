// Feature 092 (T042 – T045, US2) — concurrent per-queue drain.
//
// This is the file that receives the assertion `sequential-execution.test.ts`
// gave up: two queues reaching in-flight at the same time. Under feature 030
// that was impossible by construction — one queue, one lock, a ceiling pinned
// at 1 — so the old test could state "at no point are two tasks in-flight" as a
// workspace fact. FR-025/FR-026 split that into two predicates with different
// bounds, and the workspace half is now the ceiling rather than the number 1.
//
// The four scenarios, each a task in tasks.md:
//   T042 (SC-002)  Two queues, one pending Task each, both in-flight within
//                  5 s with zero lock-contention errors, over 100 consecutive
//                  trials. One trial cannot evidence "zero across 100".
//   T043 (SC-008)  With two Runs executing, a secondary window still reports
//                  non-primary and its mutating IPC is still refused.
//   T044 (SC-004)  Pausing queue X leaves queue Y running, and X's transition
//                  carries X's own identifier — never a name (FR-038a).
//   T045 (FR-028)  At the ceiling, a further queue WAITS. Waiting is not an
//                  error: step 4 of the drain is a capacity check, and the
//                  queue promotes as soon as capacity frees.

import { describe, it, expect } from 'vitest';
import { unfencedCommit } from '../../src/state/ownership-claim';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { WorkspaceLockManager, type Clock, type Scheduler } from '../../src/state/lock';
import { ExecutionLeaseManager } from '../../src/state/execution-lease';
import { AutoDrainCoordinator } from '../../src/services/auto-drain-coordinator';
import { createQueue, DEFAULT_QUEUE_ID } from '../../src/queue/queue-registry';
import { isMutatingCommand } from '../../src/ui/sidebar/message-router';
import { CMD_PAUSE_QUEUE, CMD_START_QUEUE } from '../../src/contracts/sidebar-ipc';
import type { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import type { FeatureRequest } from '../../src/queue/feature-request';
import type { AuditEntry } from '../../src/audit/audit-entry';

const QUEUE_B = '11111111-2222-4333-8444-555555555555';
const QUEUE_C = '22222222-3333-4444-8555-666666666666';

class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

class MutableClock implements Clock {
  private t: number;
  constructor(initial: number) {
    this.t = initial;
  }
  now(): number {
    return this.t;
  }
  advance(delta: number): void {
    this.t += delta;
  }
}

const noopScheduler: Scheduler = {
  setInterval() {
    return { clear() {} };
  }
};

interface Window {
  readonly store: WorkspaceStateStore;
  readonly queue: QueueManager;
  readonly lock: WorkspaceLockManager;
  readonly executionLease: ExecutionLeaseManager;
  readonly autoDrain: AutoDrainCoordinator;
  /** Every start the fake controller performed, in order. */
  readonly started: Array<{ queueId: string; taskId: string; runId: string }>;
  /** Every lease request that was refused. A lock-contention error, in effect. */
  readonly leaseDenials: Array<{ queueId: string; ownerId: string }>;
  readonly audits: AuditEntry[];
  /** Completes a queue's in-flight Task and drops its lease. */
  finishRun(queueId: string): Promise<void>;
  /** True when this window may issue mutating IPC, per the router's own gate. */
  isPrimary(): boolean;
}

async function makeWindow(
  memento: FakeMemento,
  ownerId: string,
  clock: MutableClock
): Promise<Window> {
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);
  const lock = new WorkspaceLockManager(store, ownerId, clock, noopScheduler);
  const executionLease = new ExecutionLeaseManager(store, ownerId, clock, noopScheduler);
  const started: Array<{ queueId: string; taskId: string; runId: string }> = [];
  const leaseDenials: Array<{ queueId: string; ownerId: string }> = [];
  const audits: AuditEntry[] = [];
  let runSeq = 0;
  // Feature 093 (T082) — the sessions this window would own. `liveRunCount` is
  // `RunSessionRegistry.size` in production: a session exists from admission to
  // the Run's terminal transition, so the double counts starts and gives the
  // count back in `finishRun`, which is this harness's terminal transition.
  let liveRuns = 0;

  queue.setLifecycleAuditHook({
    append: async (entry) => {
      audits.push({ ...(entry as AuditEntry) });
      return entry as AuditEntry;
    }
  });

  // Feature 093 (T049a) — the double already ended where admission ends: at
  // `markInFlight`. What changes is that it now says so, returning the promise
  // of the Run's execution rather than implying the Run was over. The Runs here
  // are never driven, so `completed` stays resolved and every gate assertion
  // below is unaffected.
  const controller = {
    admitNew: async (request: FeatureRequest) => {
      const runId = `run-${++runSeq}-${request.queueId}`;
      await queue.markInFlight(request.id, runId);
      liveRuns++;
      started.push({
        queueId: request.queueId ?? DEFAULT_QUEUE_ID,
        taskId: request.id,
        runId
      });
      return { completed: Promise.resolve() };
    },
    admitResume: async () => ({ resumed: false, completed: Promise.resolve() }),
    get liveRunCount(): number {
      return liveRuns;
    }
  };

  const autoDrain = new AutoDrainCoordinator({
    store,
    queue,
    executionLease: {
      tryAcquire: async (queueId: string) => {
        const result = await executionLease.tryAcquire(queueId);
        if (!result.acquired) leaseDenials.push({ queueId, ownerId: result.ownerId });
        return result;
      },
      release: (queueId: string) => executionLease.release(queueId),
      claimFor: (queueId: string) => executionLease.claimFor(queueId)
    },
    controller: controller as unknown as SchegentWorkflowController
  });

  return {
    store,
    queue,
    lock,
    executionLease,
    autoDrain,
    started,
    leaseDenials,
    audits,
    async finishRun(queueId: string): Promise<void> {
      const inFlight = store
        .getQueue(queueId)
        .requests.find((r) => r.status === 'in-flight');
      if (inFlight) await queue.finish(inFlight.id, 'completed');
      if (liveRuns > 0) liveRuns--;
      await executionLease.release(queueId);
    },
    isPrimary(): boolean {
      // The exact producer `extension.ts` wires for a secondary window.
      return !lock.isForeignLockHeld();
    }
  };
}

/** Registers `ids` as additional queues and lifts the ceiling to `cap`. */
async function withQueues(w: Window, ids: readonly string[], cap: number): Promise<void> {
  let registry = w.store.getQueueRegistry();
  for (const [i, id] of ids.entries()) {
    registry = createQueue(registry, {
      id,
      name: `Queue ${String.fromCharCode(66 + i)}`,
      now: 1_700_000_000_000
    });
  }
  await w.store.setQueueRegistry(registry);
  await w.store.setGlobalConcurrencyCap(cap);
}

describe('feature 092 (T042, SC-002) — two queues reach in-flight together', () => {
  it('promotes both queues with zero lease denials across 100 consecutive trials', async () => {
    const FIVE_SECONDS_MS = 5_000;
    const TRIALS = 100;
    const elapsedPerTrial: number[] = [];

    for (let trial = 0; trial < TRIALS; trial++) {
      const memento = new FakeMemento();
      const clock = new MutableClock(1_700_000_000_000);
      const w = await makeWindow(memento, `window-${trial}`, clock);
      await withQueues(w, [QUEUE_B], 3);

      await w.queue.enqueue('task on default', { queueId: DEFAULT_QUEUE_ID });
      await w.queue.enqueue('task on B', { queueId: QUEUE_B });

      const startedAt = Date.now();
      await w.autoDrain.drainAll();
      elapsedPerTrial.push(Date.now() - startedAt);

      expect(w.queue.inFlightCount(DEFAULT_QUEUE_ID), `trial ${trial}: default`).toBe(1);
      expect(w.queue.inFlightCount(QUEUE_B), `trial ${trial}: B`).toBe(1);
      expect(w.queue.inFlightCount(), `trial ${trial}: workspace`).toBe(2);

      // Zero lock-contention errors is the load-bearing half of SC-002. Under
      // the pre-092 workspace lock the second queue's `tryAcquire` returned
      // `{acquired: false}` and the drain silently returned.
      expect(w.leaseDenials, `trial ${trial}: lease denials`).toEqual([]);

      // One lease per queue, both held, by the same window.
      expect([...w.executionLease.heldQueueIds()].sort()).toEqual(
        [DEFAULT_QUEUE_ID, QUEUE_B].sort()
      );
      expect(w.executionLease.isHeld(DEFAULT_QUEUE_ID)).toBe(true);
      expect(w.executionLease.isHeld(QUEUE_B)).toBe(true);
    }

    const worst = Math.max(...elapsedPerTrial);
    expect(worst, `slowest trial took ${worst}ms`).toBeLessThan(FIVE_SECONDS_MS);
  });

  it('each queue records its own audit stream, keyed by its own id', async () => {
    const memento = new FakeMemento();
    const clock = new MutableClock(1_700_000_000_000);
    const w = await makeWindow(memento, 'window-audit', clock);
    await withQueues(w, [QUEUE_B], 3);

    await w.queue.enqueue('task on default', { queueId: DEFAULT_QUEUE_ID });
    await w.queue.enqueue('task on B', { queueId: QUEUE_B });
    await w.autoDrain.drainAll();

    const startEvents = w.audits.filter((e) => e.eventType === 'task-execution-started');
    expect(startEvents).toHaveLength(2);
    const byQueue = new Map(
      startEvents.map((e) => [
        (e.payload as Record<string, unknown>).queueId as string,
        e.payload as Record<string, unknown>
      ])
    );
    expect([...byQueue.keys()].sort()).toEqual([DEFAULT_QUEUE_ID, QUEUE_B].sort());

    // SC-005 in miniature: no line under a queue that did not produce it.
    const defaultTaskId = byQueue.get(DEFAULT_QUEUE_ID)!.taskId as string;
    const bTaskId = byQueue.get(QUEUE_B)!.taskId as string;
    expect(defaultTaskId).not.toBe(bTaskId);
    expect(w.store.getQueue(DEFAULT_QUEUE_ID).requests.map((r) => r.id)).toContain(defaultTaskId);
    expect(w.store.getQueue(QUEUE_B).requests.map((r) => r.id)).toContain(bTaskId);
    expect(w.store.getQueue(DEFAULT_QUEUE_ID).requests.map((r) => r.id)).not.toContain(bTaskId);
  });
});

describe('feature 092 (T043, FR-032, SC-008) — a secondary window stays read-only', () => {
  it('reports non-primary and refuses mutating IPC while two Runs execute', async () => {
    const memento = new FakeMemento();
    const clock = new MutableClock(1_700_000_000_000);

    const primary = await makeWindow(memento, 'primary-window', clock);
    await withQueues(primary, [QUEUE_B], 3);
    const primaryLock = await primary.lock.tryAcquire();
    expect(primaryLock.acquired).toBe(true);

    await primary.queue.enqueue('task on default', { queueId: DEFAULT_QUEUE_ID });
    await primary.queue.enqueue('task on B', { queueId: QUEUE_B });
    await primary.autoDrain.drainAll();
    expect(primary.queue.inFlightCount()).toBe(2);

    const secondary = await makeWindow(memento, 'secondary-window', clock);

    // The window-primacy lease is unchanged by the split (FR-032): exactly one
    // holder per workspace, and holding N execution leases did not make the
    // primary "more" primary nor the secondary any less read-only.
    expect(primary.isPrimary()).toBe(true);
    expect(secondary.isPrimary()).toBe(false);
    expect(secondary.lock.isForeignLockHeld()).toBe(true);
    expect((await secondary.lock.tryAcquire()).acquired).toBe(false);

    // Both mutating commands are still gated, and the secondary's gate is the
    // one that answers false.
    for (const cmd of [CMD_START_QUEUE, CMD_PAUSE_QUEUE]) {
      expect(isMutatingCommand(cmd)).toBe(true);
    }

    // The secondary cannot take either queue's execution lease either, so
    // "read-only" holds at the drain as well as at the router.
    await secondary.autoDrain.drainAll();
    expect(secondary.started).toEqual([]);
    expect(secondary.executionLease.heldQueueIds()).toEqual([]);
    expect(secondary.executionLease.isForeignLeaseHeld(DEFAULT_QUEUE_ID)).toBe(true);
    expect(secondary.executionLease.isForeignLeaseHeld(QUEUE_B)).toBe(true);
  });
});

describe('feature 092 (T044, FR-039/FR-040, SC-004) — independent queue lifecycles', () => {
  it('pausing one running queue leaves the other running in 100% of trials', async () => {
    const TRIALS = 25;
    for (let trial = 0; trial < TRIALS; trial++) {
      const memento = new FakeMemento();
      const clock = new MutableClock(1_700_000_000_000);
      const w = await makeWindow(memento, `window-${trial}`, clock);
      await withQueues(w, [QUEUE_B], 3);

      await w.queue.enqueue('task on default', { queueId: DEFAULT_QUEUE_ID });
      await w.queue.enqueue('task on B', { queueId: QUEUE_B });
      await w.autoDrain.drainAll();
      expect(w.queue.inFlightCount()).toBe(2);

      const paused = await w.queue.setQueuePausedState(true, DEFAULT_QUEUE_ID, 'operator pause');
      expect(paused.ok, `trial ${trial}`).toBe(true);

      expect(w.store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle === 'operator-paused', `trial ${trial}`).toBe(true);
      expect(w.store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle).toBe('operator-paused');

      // The sibling is untouched — same lifecycle, same in-flight Task, same
      // lease. A workspace-wide pause would have taken it down too.
      expect(w.store.getQueue(QUEUE_B).queueLifecycle === 'operator-paused', `trial ${trial}`).toBe(false);
      expect(w.store.getQueue(QUEUE_B).queueLifecycle).not.toBe('operator-paused');
      expect(w.queue.inFlightCount(QUEUE_B), `trial ${trial}`).toBe(1);
      expect(w.executionLease.isHeld(QUEUE_B), `trial ${trial}`).toBe(true);
    }
  });

  it("the paused queue's transition names its own id and carries no queue name", async () => {
    const memento = new FakeMemento();
    const clock = new MutableClock(1_700_000_000_000);
    const w = await makeWindow(memento, 'window-audit', clock);
    await withQueues(w, [QUEUE_B], 3);

    // Put queue B into `idle-pending` so pausing it emits the lifecycle event.
    await w.queue.enqueue('task on B', { queueId: QUEUE_B });
    await w.store.updateQueue(
      (current) => ({ queue: { ...current, queueLifecycle: 'idle-pending'}, result: undefined }),
      QUEUE_B,
      unfencedCommit('test-fixture')
    );

    w.audits.length = 0;
    const paused = await w.queue.setQueuePausedState(true, QUEUE_B, 'operator pause');
    expect(paused.ok).toBe(true);

    const exits = w.audits.filter((e) => e.eventType === 'idle-pending-exited');
    expect(exits).toHaveLength(1);
    const payload = exits[0].payload as Record<string, unknown>;
    // FR-023a core payload, carried through unchanged.
    expect(payload.queueId).toBe(QUEUE_B);
    expect(payload.transitionReason).toBe('pause');
    expect(payload.occurredAt).toEqual(expect.any(Number));
    // FR-038a — identifiers only. The registry entry is named "Queue B"; the
    // audit record must not know that.
    expect(JSON.stringify(payload)).not.toContain('Queue B');
    expect(payload).not.toHaveProperty('queueName');
    expect(payload).not.toHaveProperty('name');
  });
});

describe('feature 092 (T045, FR-028) — the ceiling makes a queue wait, not fail', () => {
  it('a third queue waits at the ceiling and promotes as soon as capacity frees', async () => {
    const memento = new FakeMemento();
    const clock = new MutableClock(1_700_000_000_000);
    const w = await makeWindow(memento, 'window-ceiling', clock);
    // Ceiling of 2 with three queues holding work: one queue must wait.
    await withQueues(w, [QUEUE_B, QUEUE_C], 2);

    await w.queue.enqueue('task on default', { queueId: DEFAULT_QUEUE_ID });
    await w.queue.enqueue('task on B', { queueId: QUEUE_B });
    await w.queue.enqueue('task on C', { queueId: QUEUE_C });

    await w.autoDrain.drainAll();

    expect(w.queue.inFlightCount()).toBe(2);
    expect(w.started).toHaveLength(2);

    // Waiting is step 4 of the drain, and step 4 is a capacity check — it is
    // not a refusal. Nothing was denied a lease, nothing errored, and the
    // waiting queue kept its pending Task and its own lifecycle.
    expect(w.leaseDenials).toEqual([]);
    const waiting = [DEFAULT_QUEUE_ID, QUEUE_B, QUEUE_C].find(
      (id) => w.queue.inFlightCount(id) === 0
    );
    expect(waiting).toBeDefined();
    expect(w.queue.peekNextPending(waiting!)).not.toBeNull();
    expect(w.store.getQueue(waiting!).queueLifecycle).not.toBe('operator-paused');
    expect(w.executionLease.isHeld(waiting!)).toBe(false);

    // Free one slot; the waiting queue promotes on the next sweep with no
    // operator action.
    const running = [DEFAULT_QUEUE_ID, QUEUE_B, QUEUE_C].filter((id) => id !== waiting)[0];
    await w.finishRun(running);
    expect(w.queue.inFlightCount()).toBe(1);

    await w.autoDrain.drainAll();
    expect(w.queue.inFlightCount(waiting!)).toBe(1);
    expect(w.queue.inFlightCount()).toBe(2);
    expect(w.leaseDenials).toEqual([]);
  });

  it('a queue that is merely busy is a different refusal from a workspace at its ceiling', async () => {
    const memento = new FakeMemento();
    const clock = new MutableClock(1_700_000_000_000);
    const w = await makeWindow(memento, 'window-predicates', clock);
    await withQueues(w, [QUEUE_B], 5);

    await w.queue.enqueue('first on default', { queueId: DEFAULT_QUEUE_ID });
    await w.queue.enqueue('second on default', { queueId: DEFAULT_QUEUE_ID, position: 1 });
    await w.autoDrain.drainAll();
    expect(w.queue.inFlightCount(DEFAULT_QUEUE_ID)).toBe(1);

    // The default queue is busy (step 3 refuses) while the workspace has room
    // (step 4 admits). The two predicates disagree, and the disagreement is
    // exactly what FR-025/FR-026 introduced.
    expect(w.queue.hasQueueCapacity(DEFAULT_QUEUE_ID)).toBe(false);
    expect(w.queue.hasWorkspaceCapacity()).toBe(true);

    // A second sweep promotes nothing on the busy queue and errors on nothing.
    const startsBefore = w.started.length;
    await w.autoDrain.drainAll();
    expect(w.started).toHaveLength(startsBefore);
    expect(w.leaseDenials).toEqual([]);
  });
});
