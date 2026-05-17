// Feature 030 — Phase 3 (US1) integration test for sequential single-queue
// execution semantics (T021).
//
// Scenario:
//   - Enqueue 3 tasks against the unified default queue.
//   - Task 1 is promoted to in-flight; tasks 2 and 3 remain pending.
//   - On task 1 terminate, task 2 is promoted; task 3 remains pending.
//   - On task 2 terminate, task 3 is promoted.
//   - Assert that at no point are two tasks in-flight simultaneously.
//
// The test exercises the QueueManager + WorkspaceStateStore pump directly
// (the AutoDrainCoordinator + WorkflowController graph is unit-tested
// separately). It samples `inFlightCount()` and `peekNextPending()` at
// every observable state transition to prove the v6 single-queue invariant
// of cap-of-1 concurrency end-to-end.

import { describe, it, expect, beforeEach } from 'vitest';
import { QueueManager } from '../../src/queue/queue-manager';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { DEFAULT_QUEUE_ID } from '../../src/queue/queue-registry';

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

describe('Feature 030 (US1, T021) — sequential single-queue execution', () => {
  let store: WorkspaceStateStore;
  let queue: QueueManager;
  let inFlightSamples: number[];

  beforeEach(async () => {
    store = new WorkspaceStateStore(new FakeMemento());
    await store.initialize();
    queue = new QueueManager(store);
    inFlightSamples = [];
  });

  function sample(): void {
    inFlightSamples.push(queue.inFlightCount());
  }

  it('enqueueing 3 tasks results in strictly sequential in-flight transitions (cap-of-1)', async () => {
    // Pre-condition: queue starts empty.
    expect(queue.list()).toHaveLength(0);
    expect(queue.inFlightCount()).toBe(0);

    // Enqueue 3 tasks. All route to DEFAULT_QUEUE_ID by default.
    const t1 = await queue.enqueue('task-one');
    sample();
    const t2 = await queue.enqueue('task-two');
    sample();
    const t3 = await queue.enqueue('task-three');
    sample();

    // None in-flight yet; all three pending on the default queue.
    expect(inFlightSamples).toEqual([0, 0, 0]);
    expect(t1.queueId).toBe(DEFAULT_QUEUE_ID);
    expect(t2.queueId).toBe(DEFAULT_QUEUE_ID);
    expect(t3.queueId).toBe(DEFAULT_QUEUE_ID);

    // peekNextPending returns the oldest pending (FIFO).
    expect(queue.peekNextPending()?.id).toBe(t1.id);

    // Capacity is available; promote task 1 to in-flight.
    expect(queue.hasCapacity()).toBe(true);
    await queue.markInFlight(t1.id, 'run-1');
    sample();
    expect(queue.inFlightCount()).toBe(1);
    expect(queue.findById(t1.id)?.status).toBe('in-flight');

    // While task 1 is in-flight, capacity is exhausted (cap-of-1).
    expect(queue.hasCapacity()).toBe(false);
    // peekNextPending still returns the next pending task (task 2). The
    // coordinator's capacity-guard is what suppresses promotion — peek
    // is order-only.
    expect(queue.peekNextPending()?.id).toBe(t2.id);

    // Tasks 2 and 3 are still pending.
    expect(queue.findById(t2.id)?.status).toBe('pending');
    expect(queue.findById(t3.id)?.status).toBe('pending');

    // Task 1 terminates (completed). Inspect intermediate state.
    await queue.finish(t1.id, 'completed');
    sample();
    expect(queue.inFlightCount()).toBe(0);
    expect(queue.findById(t1.id)?.status).toBe('completed');

    // peekNextPending now surfaces task 2.
    expect(queue.peekNextPending()?.id).toBe(t2.id);
    expect(queue.hasCapacity()).toBe(true);

    // Promote task 2.
    await queue.markInFlight(t2.id, 'run-2');
    sample();
    expect(queue.inFlightCount()).toBe(1);
    expect(queue.findById(t2.id)?.status).toBe('in-flight');
    expect(queue.findById(t3.id)?.status).toBe('pending');
    expect(queue.hasCapacity()).toBe(false);

    // Task 2 terminates (completed).
    await queue.finish(t2.id, 'completed');
    sample();
    expect(queue.inFlightCount()).toBe(0);

    // Task 3 is up next.
    expect(queue.peekNextPending()?.id).toBe(t3.id);
    await queue.markInFlight(t3.id, 'run-3');
    sample();
    expect(queue.inFlightCount()).toBe(1);
    expect(queue.findById(t3.id)?.status).toBe('in-flight');

    // Task 3 terminates.
    await queue.finish(t3.id, 'completed');
    sample();
    expect(queue.inFlightCount()).toBe(0);

    // No more pending; peek returns null.
    expect(queue.peekNextPending()).toBeNull();

    // Final invariant: across every observed transition, inFlightCount
    // was never > 1.
    for (const n of inFlightSamples) {
      expect(n).toBeLessThanOrEqual(1);
    }
    // And the sequence of in-flight counts is the expected ramp:
    // 0,0,0 (enqueues) → 1 (markInFlight t1) → 0 (finish t1) →
    // 1 (markInFlight t2) → 0 (finish t2) → 1 (markInFlight t3) → 0 (finish t3).
    expect(inFlightSamples).toEqual([0, 0, 0, 1, 0, 1, 0, 1, 0]);
  });

  it('hasCapacity() blocks promotion of task 2 while task 1 is in-flight', async () => {
    await queue.enqueue('task-one');
    const t2 = await queue.enqueue('task-two');
    const t1Picked = queue.peekNextPending();
    expect(t1Picked).not.toBeNull();
    await queue.markInFlight(t1Picked!.id, 'run-1');

    // Capacity exhausted. Attempting to promote task 2 must reject —
    // QueueManager.markInFlight throws when capacity is unavailable.
    expect(queue.hasCapacity()).toBe(false);
    await expect(queue.markInFlight(t2.id, 'run-2')).rejects.toThrow(
      /Another request is already in flight/
    );
    // Task 2 stays pending; task 1 is unaffected.
    expect(queue.findById(t2.id)?.status).toBe('pending');
    expect(queue.findById(t1Picked!.id)?.status).toBe('in-flight');
    // Still only ever 1 in flight.
    expect(queue.inFlightCount()).toBe(1);
  });

  it('all three tasks route to DEFAULT_QUEUE_ID regardless of caller intent (single-queue migration semantic)', async () => {
    // The single-queue migration guarantees every enqueue lands on the
    // default queue. Even if the caller passes a stale queueId (legacy
    // wake-up runner / programmatic), the registry has only one entry
    // and peekNextPending iterates that entry alone.
    const t1 = await queue.enqueue('task-one');
    const t2 = await queue.enqueue('task-two');
    const t3 = await queue.enqueue('task-three');

    const requests = store.getQueue().requests;
    const ids = new Set(requests.map((r) => r.queueId));
    // Every persisted request points at the default queue.
    expect(ids.size).toBe(1);
    expect(ids.has(DEFAULT_QUEUE_ID)).toBe(true);
    expect([t1.queueId, t2.queueId, t3.queueId]).toEqual([
      DEFAULT_QUEUE_ID,
      DEFAULT_QUEUE_ID,
      DEFAULT_QUEUE_ID
    ]);
  });
});
