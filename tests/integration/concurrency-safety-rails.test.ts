// Feature 092 (T046 – T047, US2) — the two safety rails that ship alongside
// concurrent execution.
//
// Concurrency here is honest rather than safe: N Runs share one working tree,
// and nothing in this feature serialises their edits. The spec's answer is not
// a mechanism but two rails — tell the operator once, and record every overlap
// so an after-the-fact conflict has a timeline.
//
//   T046 (FR-037, SC-009)  The shared-working-tree notice fires exactly once,
//                          on the first creation of a second queue, survives a
//                          reload after dismissal, and is a DIFFERENT notice
//                          from the pre-existing per-queue migration notice.
//   T047 (FR-038, FR-038a, SC-010)  Exactly one `runs-overlapped` record per
//                          overlap, carrying queue identifiers only.
//
// The two notices are the easiest thing in this feature to accidentally merge.
// `QueueState.migrationNotice` (feature 065) is per QUEUE and fires when that
// queue's persisted state was lifted into `idle-pending` by a migration. The
// notice below is per WORKSPACE and fires when the workspace first stops being
// single-queue. They have different scopes, different triggers and different
// text; sharing one persisted field would make dismissing either dismiss both.

import { describe, it, expect } from 'vitest';
import { unfencedCommit } from '../../src/state/ownership-claim';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { ExecutionLeaseManager } from '../../src/state/execution-lease';
import { AutoDrainCoordinator } from '../../src/services/auto-drain-coordinator';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { createQueue } from '../../src/queue/queue-registry';
import type { Clock, Scheduler } from '../../src/state/lock';
import type { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import type { FeatureRequest } from '../../src/queue/feature-request';
import type { AuditEntry } from '../../src/audit/audit-entry';

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

/** A store + queue over a caller-supplied memento, so a reload can reuse it. */
async function open(memento: FakeMemento): Promise<{
  store: WorkspaceStateStore;
  queue: QueueManager;
}> {
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  return { store, queue: new QueueManager(store) };
}

describe('feature 092 (T046, FR-037, SC-009) — the shared-working-tree notice', () => {
  it('is unset in a single-queue workspace', async () => {
    const { store } = await open(new FakeMemento());
    expect(store.getQueueRegistry().entries).toHaveLength(1);
    expect(store.getConcurrencyNotice()).toBeNull();
  });

  it('arms on the first creation of a second queue', async () => {
    const { store, queue } = await open(new FakeMemento());

    const created = await queue.createQueue('Docs');
    expect(created.ok).toBe(true);
    expect(store.getQueueRegistry().entries).toHaveLength(2);
    expect(store.getConcurrencyNotice()).toBe('pending');
  });

  it('does not re-arm on the third, fourth or fifth queue', async () => {
    const { store, queue } = await open(new FakeMemento());

    await queue.createQueue('Docs');
    expect(store.getConcurrencyNotice()).toBe('pending');
    await queue.dismissConcurrencyNotice();
    expect(store.getConcurrencyNotice()).toBe('dismissed');

    for (const name of ['Research', 'Refactors', 'Spikes']) {
      const result = await queue.createQueue(name);
      expect(result.ok, name).toBe(true);
      // Once answered, the question is not asked again — whatever the answer
      // was. A `'pending'` here would mean a dismissed notice came back.
      expect(store.getConcurrencyNotice(), name).toBe('dismissed');
    }
    expect(store.getQueueRegistry().entries).toHaveLength(5);
  });

  it('does not re-arm when the workspace drops to one queue and grows again', async () => {
    const { store, queue } = await open(new FakeMemento());

    const first = await queue.createQueue('Docs');
    expect(store.getConcurrencyNotice()).toBe('pending');
    await queue.dismissConcurrencyNotice();

    const deleted = await queue.deleteQueue(first.queueId!);
    expect(deleted.ok).toBe(true);
    expect(store.getQueueRegistry().entries).toHaveLength(1);

    // Crossing 1 -> 2 a second time is not "the first creation of a second
    // queue" (FR-037). The persisted answer is what makes it once-per-
    // workspace rather than once-per-crossing.
    await queue.createQueue('Docs again');
    expect(store.getQueueRegistry().entries).toHaveLength(2);
    expect(store.getConcurrencyNotice()).toBe('dismissed');
  });

  it('stays dismissed across a workspace reload', async () => {
    const memento = new FakeMemento();

    const first = await open(memento);
    await first.queue.createQueue('Docs');
    expect(first.store.getConcurrencyNotice()).toBe('pending');
    await first.queue.dismissConcurrencyNotice();

    // A fresh store over the same memento is exactly what a window reload is.
    const reloaded = await open(memento);
    expect(reloaded.store.getConcurrencyNotice()).toBe('dismissed');

    // And a creation after the reload still does not resurrect it.
    await reloaded.queue.createQueue('Research');
    expect(reloaded.store.getConcurrencyNotice()).toBe('dismissed');
  });

  it('survives a reload while still pending, so an undismissed notice is not lost', async () => {
    const memento = new FakeMemento();

    const first = await open(memento);
    await first.queue.createQueue('Docs');
    expect(first.store.getConcurrencyNotice()).toBe('pending');

    const reloaded = await open(memento);
    expect(reloaded.store.getConcurrencyNotice()).toBe('pending');
  });

  it('dismissal is idempotent', async () => {
    const { store, queue } = await open(new FakeMemento());
    await queue.createQueue('Docs');

    await queue.dismissConcurrencyNotice();
    await queue.dismissConcurrencyNotice();
    await queue.dismissConcurrencyNotice();
    expect(store.getConcurrencyNotice()).toBe('dismissed');
  });

  it('dismissing on a workspace that never armed it is a no-op, not an arm', async () => {
    const { store, queue } = await open(new FakeMemento());
    await queue.dismissConcurrencyNotice();
    // Writing `'dismissed'` here would silently suppress the notice for a
    // workspace that has not yet earned it.
    expect(store.getConcurrencyNotice()).toBeNull();
  });

  it('is a different notice from the per-queue migration notice', async () => {
    const { store, queue } = await open(new FakeMemento());

    // Feature 065's per-queue notice, armed on the default queue.
    await store.updateQueue(
      (current) => ({
        queue: { ...current, migrationNotice: 'pending' as const },
        result: undefined
      }),
      DEFAULT_QUEUE_ID,
      unfencedCommit('test-fixture')
    );

    const created = await queue.createQueue('Docs');
    expect(store.getConcurrencyNotice()).toBe('pending');
    expect(store.getQueue(DEFAULT_QUEUE_ID).migrationNotice).toBe('pending');
    // The new queue is not born carrying a migration notice — that field
    // records a migration, and this queue was authored, not migrated.
    expect(store.getQueue(created.queueId!).migrationNotice).toBeUndefined();

    // Dismissing one leaves the other exactly where it was, in both
    // directions. A shared field would fail both halves.
    await queue.dismissConcurrencyNotice();
    expect(store.getConcurrencyNotice()).toBe('dismissed');
    expect(store.getQueue(DEFAULT_QUEUE_ID).migrationNotice).toBe('pending');

    await store.updateQueue(
      (current) => ({
        queue: { ...current, migrationNotice: 'dismissed' as const },
        result: undefined
      }),
      DEFAULT_QUEUE_ID,
      unfencedCommit('test-fixture')
    );
    expect(store.getQueue(DEFAULT_QUEUE_ID).migrationNotice).toBe('dismissed');
    expect(store.getConcurrencyNotice()).toBe('dismissed');
  });

  it('the notice lives on its own memento key, not inside any queue record', async () => {
    const memento = new FakeMemento();
    const { queue } = await open(memento);
    await queue.createQueue('Docs');

    // FR-037 is per workspace. Persisting it inside a `QueueState` would make
    // it per queue by construction, and deleting that queue would erase the
    // operator's dismissal.
    const queueStates = memento.get<Record<string, Record<string, unknown>>>('schegent.queue');
    expect(queueStates).toBeDefined();
    for (const [queueId, state] of Object.entries(queueStates!)) {
      expect(state, queueId).not.toHaveProperty('concurrencyNotice');
    }
  });
});

// ---------------------------------------------------------------------------
// T047 — the overlap audit record.
// ---------------------------------------------------------------------------

const QUEUE_B = '11111111-2222-4333-8444-555555555555';
const QUEUE_C = '22222222-3333-4444-8555-666666666666';

interface OverlapHarness {
  readonly store: WorkspaceStateStore;
  readonly queue: QueueManager;
  readonly executionLease: ExecutionLeaseManager;
  readonly autoDrain: AutoDrainCoordinator;
  /** Every entry the drain wrote, in order. */
  readonly audits: AuditEntry[];
  readonly overlaps: () => AuditEntry[];
  finishRun(queueId: string): Promise<void>;
  /** Registry entry names, so a test can prove they never reach a payload. */
  readonly queueNames: readonly string[];
}

async function makeOverlapHarness(cap: number, extraQueues: readonly string[]): Promise<OverlapHarness> {
  const memento = new FakeMemento();
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);
  const clock = new MutableClock(1_700_000_000_000);
  const executionLease = new ExecutionLeaseManager(store, 'overlap-window', clock, noopScheduler);
  const audits: AuditEntry[] = [];
  const queueNames: string[] = [];
  let runSeq = 0;
  // Feature 093 (T082) — the sessions this window would own. `liveRunCount` is
  // `RunSessionRegistry.size` in production: a session exists from admission to
  // the Run's terminal transition, so the double counts starts and gives the
  // count back in `finishRun`, which is this harness's terminal transition.
  let liveRuns = 0;

  const auditWriter = {
    append: async (entry: {
      runId: string;
      phase: string;
      iteration: number;
      eventType: string;
      outcome: 'info' | 'success';
      payload: Record<string, unknown>;
    }) => {
      audits.push({ ...(entry as unknown as AuditEntry) });
      return entry;
    }
  };
  queue.setLifecycleAuditHook(auditWriter);

  // Registered through the registry helper rather than `QueueManager.
  // createQueue` so the ids are the fixed constants these assertions name.
  let registry = store.getQueueRegistry();
  for (const [i, id] of extraQueues.entries()) {
    const name = `Rocinante ${String.fromCharCode(66 + i)}`;
    queueNames.push(name);
    registry = createQueue(registry, { id, name, now: 1_700_000_000_000 });
  }
  await store.setQueueRegistry(registry);
  await store.setGlobalConcurrencyCap(cap);

  // Feature 093 (T049a) — admission ends at `markInFlight`, which is where this
  // double already ended. `completed` is the Run's execution, never driven here.
  const controller = {
    admitNew: async (request: FeatureRequest) => {
      await queue.markInFlight(request.id, `run-${++runSeq}`);
      liveRuns++;
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
      tryAcquire: (queueId: string) => executionLease.tryAcquire(queueId),
      release: (queueId: string) => executionLease.release(queueId),
      claimFor: (queueId: string) => executionLease.claimFor(queueId)
    },
    controller: controller as unknown as SchegentWorkflowController,
    auditWriter
  });

  return {
    store,
    queue,
    executionLease,
    autoDrain,
    audits,
    overlaps: () => audits.filter((e) => e.eventType === 'runs-overlapped'),
    async finishRun(queueId: string): Promise<void> {
      const inFlight = store.getQueue(queueId).requests.find((r) => r.status === 'in-flight');
      if (inFlight) await queue.finish(inFlight.id, 'completed');
      if (liveRuns > 0) liveRuns--;
      await executionLease.release(queueId);
    },
    queueNames
  };
}

describe('feature 092 (T047, FR-038, SC-010) — one record per overlap', () => {
  it('records nothing while only one Run is in flight', async () => {
    const h = await makeOverlapHarness(3, []);
    await h.queue.enqueue('only task', { queueId: DEFAULT_QUEUE_ID });
    await h.autoDrain.drainAll();

    expect(h.queue.inFlightCount()).toBe(1);
    expect(h.overlaps()).toEqual([]);
  });

  it('records exactly one event when a second Run joins the first', async () => {
    const h = await makeOverlapHarness(3, [QUEUE_B]);
    await h.queue.enqueue('task on default', { queueId: DEFAULT_QUEUE_ID });
    await h.queue.enqueue('task on B', { queueId: QUEUE_B });

    await h.autoDrain.drainAll();
    expect(h.queue.inFlightCount()).toBe(2);
    expect(h.overlaps()).toHaveLength(1);
  });

  it('does not re-record while the same overlap continues', async () => {
    const h = await makeOverlapHarness(3, [QUEUE_B]);
    await h.queue.enqueue('task on default', { queueId: DEFAULT_QUEUE_ID });
    await h.queue.enqueue('task on B', { queueId: QUEUE_B });
    await h.autoDrain.drainAll();
    expect(h.overlaps()).toHaveLength(1);

    // Sweeping repeatedly is what the real coordinator does on every state
    // change. An overlap is an episode, not a sample: re-recording it here
    // would turn SC-010's "exactly one" into "one per drain tick".
    for (let i = 0; i < 5; i++) await h.autoDrain.drainAll();
    expect(h.queue.inFlightCount()).toBe(2);
    expect(h.overlaps()).toHaveLength(1);
  });

  it('does not re-record when a third Run widens the same overlap', async () => {
    const h = await makeOverlapHarness(3, [QUEUE_B, QUEUE_C]);
    await h.queue.enqueue('task on default', { queueId: DEFAULT_QUEUE_ID });
    await h.queue.enqueue('task on B', { queueId: QUEUE_B });
    await h.autoDrain.drainAll();
    expect(h.queue.inFlightCount()).toBe(2);
    expect(h.overlaps()).toHaveLength(1);

    await h.queue.enqueue('task on C', { queueId: QUEUE_C });
    await h.autoDrain.drainAll();
    expect(h.queue.inFlightCount()).toBe(3);

    // Still one overlap — the workspace never stopped overlapping.
    expect(h.overlaps()).toHaveLength(1);
  });

  it('records a second event for a second, distinct overlap', async () => {
    const h = await makeOverlapHarness(3, [QUEUE_B]);
    await h.queue.enqueue('first on default', { queueId: DEFAULT_QUEUE_ID });
    await h.queue.enqueue('second on default', { queueId: DEFAULT_QUEUE_ID, position: 1 });
    await h.queue.enqueue('first on B', { queueId: QUEUE_B });
    await h.queue.enqueue('second on B', { queueId: QUEUE_B, position: 1 });

    await h.autoDrain.drainAll();
    expect(h.queue.inFlightCount()).toBe(2);
    expect(h.overlaps()).toHaveLength(1);

    // Drop below two in flight — the episode ends.
    await h.finishRun(QUEUE_B);
    expect(h.queue.inFlightCount()).toBe(1);
    expect(h.overlaps()).toHaveLength(1);

    // ...and a fresh overlap is a fresh instance (SC-010: "every instance").
    await h.autoDrain.drainAll();
    expect(h.queue.inFlightCount()).toBe(2);
    expect(h.overlaps()).toHaveLength(2);
  });

  it('carries the core payload and queue identifiers only', async () => {
    const h = await makeOverlapHarness(3, [QUEUE_B]);
    await h.queue.enqueue('task on default', { queueId: DEFAULT_QUEUE_ID });
    await h.queue.enqueue('task on B', { queueId: QUEUE_B });
    await h.autoDrain.drainAll();

    const [record] = h.overlaps();
    expect(record).toBeDefined();
    expect(record.eventType).toBe('runs-overlapped');
    expect(record.outcome).toBe('info');

    const payload = record.payload as Record<string, unknown>;
    // FR-023a core payload.
    expect(payload.queueId).toEqual(expect.any(String));
    expect(payload.eventType).toBe('runs-overlapped');
    expect(payload.occurredAt).toEqual(expect.any(Number));
    expect(payload.transitionReason).toEqual(expect.any(String));

    // FR-038 — "the queues involved". Both, by identifier.
    const involved = payload.queueIds as string[];
    expect(Array.isArray(involved)).toBe(true);
    expect([...involved].sort()).toEqual([DEFAULT_QUEUE_ID, QUEUE_B].sort());
    // The core payload's single `queueId` is the queue whose start caused the
    // overlap, so it must be one of the queues involved. Which one is not
    // pinned: the emission order of `drainAll()` is the round-robin cursor's
    // business (FR-029), and asserting a position here would make a starvation-
    // free cursor change look like an audit defect.
    expect(involved).toContain(payload.queueId);
  });

  it('never writes an operator-authored queue name into the payload', async () => {
    const h = await makeOverlapHarness(3, [QUEUE_B, QUEUE_C]);
    await h.queue.enqueue('task on default', { queueId: DEFAULT_QUEUE_ID });
    await h.queue.enqueue('task on B', { queueId: QUEUE_B });
    await h.queue.enqueue('task on C', { queueId: QUEUE_C });
    await h.autoDrain.drainAll();
    expect(h.queue.inFlightCount()).toBe(3);

    const [record] = h.overlaps();
    const serialized = JSON.stringify(record.payload);
    for (const name of h.queueNames) {
      // FR-038a — a queue name is operator-authored content. The UI resolves
      // identifiers to names at display time; the audit log never learns them.
      expect(serialized, name).not.toContain(name);
    }
    expect(record.payload).not.toHaveProperty('queueName');
    expect(record.payload).not.toHaveProperty('queueNames');
    expect(record.payload).not.toHaveProperty('name');

    // Nor does the Task description leak in — the same rule, same reason.
    expect(serialized).not.toContain('task on');
  });
});
