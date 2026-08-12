// Feature 030 — Phase 3 (US1) integration test for sequential single-queue
// execution semantics (T021), rewritten by feature 092 (T038a, US2).
//
// The original file asserted "at no point are two tasks in-flight
// simultaneously" as a WORKSPACE-WIDE property, because at a cap of 1 with one
// queue the workspace and the queue were the same thing. FR-025 and FR-026 pull
// those apart, and the two halves land in different places:
//
//   - The sequential invariant SURVIVES, per queue. Three Tasks on one queue
//     still promote one at a time, in FIFO order, with the same
//     "Another request is already in flight" refusal. That is this file.
//   - The cross-queue half becomes its OPPOSITE — two queues each reaching
//     in-flight at the same time — and moves to
//     `tests/integration/concurrent-drain.test.ts` (T042).
//
// So the sampling here reads `inFlightCount(queueId)`, not `inFlightCount()`.
// Sampling the workspace would now be measuring the ceiling, which is a
// different requirement with a different bound.

import { describe, it, expect, beforeEach } from 'vitest';
import { QueueManager } from '../../src/queue/queue-manager';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { createQueue, DEFAULT_QUEUE_ID } from '../../src/queue/queue-registry';

const QUEUE_B = '11111111-2222-4333-8444-555555555555';

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

describe('feature 092 (T038a) — sequential execution survives per queue', () => {
  let store: WorkspaceStateStore;
  let queue: QueueManager;
  let inFlightSamples: number[];

  beforeEach(async () => {
    store = new WorkspaceStateStore(new FakeMemento());
    await store.initialize();
    queue = new QueueManager(store);
    inFlightSamples = [];
  });

  /** The invariant is now per queue, so the sample is addressed. */
  function sample(queueId: string = DEFAULT_QUEUE_ID): void {
    inFlightSamples.push(queue.inFlightCount(queueId));
  }

  it('three Tasks on ONE queue still promote strictly one at a time', async () => {
    expect(queue.list()).toHaveLength(0);
    expect(queue.inFlightCount(DEFAULT_QUEUE_ID)).toBe(0);

    const t1 = await queue.enqueue('task-one');
    sample();
    const t2 = await queue.enqueue('task-two');
    sample();
    const t3 = await queue.enqueue('task-three');
    sample();

    expect(inFlightSamples).toEqual([0, 0, 0]);
    expect([t1.queueId, t2.queueId, t3.queueId]).toEqual([
      DEFAULT_QUEUE_ID,
      DEFAULT_QUEUE_ID,
      DEFAULT_QUEUE_ID
    ]);

    // peekNextPending returns the oldest pending (FIFO), addressed by queue.
    expect(queue.peekNextPending(DEFAULT_QUEUE_ID)?.id).toBe(t1.id);

    expect(queue.hasQueueCapacity(DEFAULT_QUEUE_ID)).toBe(true);
    await queue.markInFlight(t1.id, 'run-1');
    sample();
    expect(queue.inFlightCount(DEFAULT_QUEUE_ID)).toBe(1);
    expect(queue.findById(t1.id)?.status).toBe('in-flight');

    // This queue is now busy. `peekNextPending` is order-only; the drain's
    // step 3 is what suppresses the promotion.
    expect(queue.hasQueueCapacity(DEFAULT_QUEUE_ID)).toBe(false);
    expect(queue.peekNextPending(DEFAULT_QUEUE_ID)?.id).toBe(t2.id);
    expect(queue.findById(t2.id)?.status).toBe('pending');
    expect(queue.findById(t3.id)?.status).toBe('pending');

    await queue.finish(t1.id, 'completed');
    sample();
    expect(queue.inFlightCount(DEFAULT_QUEUE_ID)).toBe(0);
    expect(queue.findById(t1.id)?.status).toBe('completed');

    expect(queue.peekNextPending(DEFAULT_QUEUE_ID)?.id).toBe(t2.id);
    expect(queue.hasQueueCapacity(DEFAULT_QUEUE_ID)).toBe(true);

    await queue.markInFlight(t2.id, 'run-2');
    sample();
    expect(queue.inFlightCount(DEFAULT_QUEUE_ID)).toBe(1);
    expect(queue.findById(t3.id)?.status).toBe('pending');
    expect(queue.hasQueueCapacity(DEFAULT_QUEUE_ID)).toBe(false);

    await queue.finish(t2.id, 'completed');
    sample();
    expect(queue.inFlightCount(DEFAULT_QUEUE_ID)).toBe(0);

    expect(queue.peekNextPending(DEFAULT_QUEUE_ID)?.id).toBe(t3.id);
    await queue.markInFlight(t3.id, 'run-3');
    sample();
    expect(queue.inFlightCount(DEFAULT_QUEUE_ID)).toBe(1);

    await queue.finish(t3.id, 'completed');
    sample();
    expect(queue.inFlightCount(DEFAULT_QUEUE_ID)).toBe(0);
    expect(queue.peekNextPending(DEFAULT_QUEUE_ID)).toBeNull();

    for (const n of inFlightSamples) {
      expect(n).toBeLessThanOrEqual(1);
    }
    expect(inFlightSamples).toEqual([0, 0, 0, 1, 0, 1, 0, 1, 0]);
  });

  it('hasQueueCapacity blocks the second Task on the SAME queue', async () => {
    await queue.enqueue('task-one');
    const t2 = await queue.enqueue('task-two');
    const t1Picked = queue.peekNextPending(DEFAULT_QUEUE_ID);
    expect(t1Picked).not.toBeNull();
    await queue.markInFlight(t1Picked!.id, 'run-1');

    expect(queue.hasQueueCapacity(DEFAULT_QUEUE_ID)).toBe(false);
    await expect(queue.markInFlight(t2.id, 'run-2')).rejects.toThrow(
      /Another request is already in flight/
    );
    expect(queue.findById(t2.id)?.status).toBe('pending');
    expect(queue.findById(t1Picked!.id)?.status).toBe('in-flight');
    expect(queue.inFlightCount(DEFAULT_QUEUE_ID)).toBe(1);
  });

  it('a busy queue does not gate its sibling — the invariant is per queue, not per workspace', async () => {
    await store.setQueueRegistry(
      createQueue(store.getQueueRegistry(), { id: QUEUE_B, name: 'Second', now: Date.now() })
    );
    await store.setGlobalConcurrencyCap(3);

    const onDefault = await queue.enqueue('default work');
    const onB = await queue.enqueue('b work', { queueId: QUEUE_B });

    await queue.markInFlight(onDefault.id, 'run-1');
    expect(queue.hasQueueCapacity(DEFAULT_QUEUE_ID)).toBe(false);
    // The sibling is untouched by the default queue's in-flight Task.
    expect(queue.hasQueueCapacity(QUEUE_B)).toBe(true);

    await expect(queue.markInFlight(onB.id, 'run-2')).resolves.toBeUndefined();
    expect(queue.inFlightCount(DEFAULT_QUEUE_ID)).toBe(1);
    expect(queue.inFlightCount(QUEUE_B)).toBe(1);
    expect(queue.inFlightCount()).toBe(2);
  });

  it('an enqueue with no explicit queue still lands on the default queue', async () => {
    const t1 = await queue.enqueue('task-one');
    const t2 = await queue.enqueue('task-two');
    const t3 = await queue.enqueue('task-three');

    const requests = store.getQueue().requests;
    const ids = new Set(requests.map((r) => r.queueId));
    expect(ids.size).toBe(1);
    expect(ids.has(DEFAULT_QUEUE_ID)).toBe(true);
    expect([t1.queueId, t2.queueId, t3.queueId]).toEqual([
      DEFAULT_QUEUE_ID,
      DEFAULT_QUEUE_ID,
      DEFAULT_QUEUE_ID
    ]);
  });
});
