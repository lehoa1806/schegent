// Feature 195 (T010, FR-012, FR-013, SC-006) — a halted queue affects only
// itself: no other queue's drain, lease, or the workspace ceiling.

import { describe, it, expect } from 'vitest';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { makeHaltHarness, withQueues } from './queue-halt-fixture';

const QUEUE_B = '11111111-2222-4333-8444-555555555555';

describe('feature 195 (T010, FR-012, FR-013, SC-006) — one queue halted, another unaffected', () => {
  it('queue B starts its next task while queue A stays halted with its running task untouched', async () => {
    const h = await makeHaltHarness('halt-on-failure');
    await withQueues(h, [{ id: QUEUE_B, name: 'Queue B' }]);
    await h.store.setGlobalConcurrencyCap(4);

    // Queue A: one task already running.
    const aRunning = await h.queue.enqueue('a-running', { queueId: DEFAULT_QUEUE_ID });
    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(h.started).toEqual([aRunning.id]);

    // Queue A also carries a failed row — not the running one — so the next
    // pass on A is refused by the halt gate rather than by "busy".
    const aFailed = await h.queue.enqueue('a-failed', { queueId: DEFAULT_QUEUE_ID });
    await h.queue.finish(aFailed.id, 'failed');

    // Queue B: pending work, no failure of its own.
    const bPending = await h.queue.enqueue('b-pending', { queueId: QUEUE_B });

    h.leaseAcquisitions.length = 0;
    await h.autoDrain.drainAll();

    // B started its own next task on this very pass.
    expect(h.started).toContain(bPending.id);
    // A's running task was not interrupted, cancelled or altered.
    const aState = h.store.getQueue(DEFAULT_QUEUE_ID);
    expect(aState.requests.find((r) => r.id === aRunning.id)?.status).toBe('in-flight');
    // A's execution lease was never acquired during this refused pass — only
    // B's queue id appears among the leases taken.
    expect(h.leaseAcquisitions).not.toContain(DEFAULT_QUEUE_ID);
    expect(h.leaseAcquisitions).toContain(QUEUE_B);
    // The workspace concurrency accounting reflects exactly the two in-flight
    // rows this scenario created (A's running task, B's newly-started one) —
    // A's halt added no phantom occupant.
    expect(h.queue.inFlightCount()).toBe(2);
  });
});
