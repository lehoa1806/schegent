import { describe, it, expect, beforeEach } from 'vitest';
import { QueueManager } from '../../../src/queue/queue-manager';
import { DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import type { Memento } from '../../../src/state/workspace-state';

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

let store: WorkspaceStateStore;
let queue: QueueManager;

beforeEach(async () => {
  const memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  queue = new QueueManager(store);
});

describe('QueueManager.enqueue', () => {
  it('appends a pending request and assigns position', async () => {
    const a = await queue.enqueue('feature A');
    const b = await queue.enqueue('feature B');
    expect(a.position).toBe(0);
    expect(b.position).toBe(1);
    expect(queue.list()).toHaveLength(2);
    expect(a.status).toBe('pending');
  });

  it('rejects empty descriptions', async () => {
    await expect(queue.enqueue('   ')).rejects.toThrow(/non-empty/);
  });

  it('rejects descriptions exceeding the cap', async () => {
    const huge = 'x'.repeat(33_000);
    await expect(queue.enqueue(huge)).rejects.toThrow(/exceeds/);
  });

  it('persists pipelineId when supplied via options (T033, T040, US2)', async () => {
    const a = await queue.enqueue('feature A', { pipelineId: 'security' });
    expect(a.pipelineId).toBe('security');
    expect(queue.findById(a.id)?.pipelineId).toBe('security');
  });

  it('omits pipelineId when no options are provided (T033, US2)', async () => {
    const a = await queue.enqueue('feature A');
    expect(a.pipelineId).toBeUndefined();
    expect(queue.findById(a.id)?.pipelineId).toBeUndefined();
  });

  it('omits pipelineId when options.pipelineId is undefined (T033, US2)', async () => {
    const a = await queue.enqueue('feature A', { pipelineId: undefined });
    expect(a.pipelineId).toBeUndefined();
  });
});

describe('QueueManager.peekNextPending', () => {
  it('returns the first pending request', async () => {
    const a = await queue.enqueue('A');
    await queue.enqueue('B');
    expect(queue.peekNextPending()?.id).toBe(a.id);
  });

  it('skips in-flight and completed requests', async () => {
    const a = await queue.enqueue('A');
    const b = await queue.enqueue('B');
    await queue.markInFlight(a.id, 'run-1');
    expect(queue.peekNextPending()?.id).toBe(b.id);
  });

  it('returns null when nothing is pending', async () => {
    expect(queue.peekNextPending()).toBeNull();
  });
});

describe('QueueManager.markInFlight', () => {
  it('sets request status to in-flight and records runId', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    const found = queue.findById(a.id)!;
    expect(found.status).toBe('in-flight');
    expect(found.runId).toBe('run-1');
    expect(queue.hasInFlight()).toBe(true);
  });

  it('throws when another request is already in-flight', async () => {
    const a = await queue.enqueue('A');
    const b = await queue.enqueue('B');
    await queue.markInFlight(a.id, 'run-1');
    await expect(queue.markInFlight(b.id, 'run-2')).rejects.toThrow(/already in flight/);
  });

  it('is idempotent for the same featureId', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    await expect(queue.markInFlight(a.id, 'run-1')).resolves.toBeUndefined();
  });
});

describe('QueueManager.finish', () => {
  it('clears in-flight when finishing the active request', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, 'completed');
    expect(queue.hasInFlight()).toBe(false);
    expect(queue.findById(a.id)?.status).toBe('completed');
  });

  it('preserves in-flight when finishing a non-active request', async () => {
    const a = await queue.enqueue('A');
    const b = await queue.enqueue('B');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(b.id, 'canceled');
    expect(queue.hasInFlight()).toBe(true);
  });
});

describe('QueueManager.cancel', () => {
  it('cancels a pending request and returns true', async () => {
    const a = await queue.enqueue('A');
    expect(await queue.cancel(a.id)).toBe(true);
    expect(queue.findById(a.id)?.status).toBe('canceled');
  });

  it('refuses to cancel an in-flight request', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    expect(await queue.cancel(a.id)).toBe(false);
    expect(queue.findById(a.id)?.status).toBe('in-flight');
  });

  it('returns false for unknown id', async () => {
    expect(await queue.cancel('unknown')).toBe(false);
  });
});

describe('QueueManager.setPaused', () => {
  it('toggles the paused flag', async () => {
    await queue.setPaused(true);
    expect(store.getQueue().paused).toBe(true);
    await queue.setPaused(false);
    expect(store.getQueue().paused).toBe(false);
  });

  it('is a no-op when state already matches', async () => {
    await queue.enqueue('feature A');
    await queue.setPaused(true);
    const before = store.getQueue().updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await queue.setPaused(true);
    expect(store.getQueue().updatedAt).toBe(before);
  });
});

describe('QueueManager.findById', () => {
  it('returns the matching request', async () => {
    const a = await queue.enqueue('A');
    expect(queue.findById(a.id)?.id).toBe(a.id);
  });

  it('returns null for unknown id', () => {
    expect(queue.findById('missing')).toBeNull();
  });
});

describe('QueueManager.remove', () => {
  it('removes a pending request entirely and renumbers positions', async () => {
    const a = await queue.enqueue('A');
    const b = await queue.enqueue('B');
    const c = await queue.enqueue('C');
    expect(await queue.remove(b.id)).toBe(true);
    const remaining = queue.list();
    expect(remaining.map((r) => r.id)).toEqual([a.id, c.id]);
    expect(remaining[0].position).toBe(0);
    expect(remaining[1].position).toBe(1);
  });

  it('returns false and is a no-op for in-flight items', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    expect(await queue.remove(a.id)).toBe(false);
    expect(queue.findById(a.id)?.status).toBe('in-flight');
  });

  it('returns false for unknown id', async () => {
    expect(await queue.remove('missing')).toBe(false);
  });

  it('returns false for completed or canceled items', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, 'completed');
    expect(await queue.remove(a.id)).toBe(false);
    expect(queue.findById(a.id)?.status).toBe('completed');
  });
});

// BUG-002 (T118) — `removeTask` is the audit-aware sibling of `remove`.
// Returns the canonical `{ ok, reason?, queueId? }` mutation detail so
// the router can audit `task-removed` with `queueId` and differentiate
// rejection causes between `unknown-task-id` and `task-not-in-pending-state`.
describe('QueueManager.removeTask (BUG-002 T118)', () => {
  it('returns ok with queueId and compacts positions for a pending task', async () => {
    const a = await queue.enqueue('A');
    const b = await queue.enqueue('B');
    const c = await queue.enqueue('C');
    const result = await queue.removeTask(b.id);
    expect(result.ok).toBe(true);
    expect(result.queueId).toBe(DEFAULT_QUEUE_ID);
    const remaining = queue.list();
    expect(remaining.map((r) => r.id)).toEqual([a.id, c.id]);
    expect(remaining[0].position).toBe(0);
    expect(remaining[1].position).toBe(1);
  });

  it('returns unknown-task-id for a missing id', async () => {
    const result = await queue.removeTask('missing');
    expect(result).toEqual({ ok: false, reason: 'unknown-task-id' });
  });

  it('removes an in-flight task and reports prior status', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    const result = await queue.removeTask(a.id);
    expect(result).toMatchObject({ ok: true, priorStatus: 'in-flight', runId: 'run-1' });
    expect(queue.findById(a.id)).toBeNull();
  });

  it('removes a completed task and reports prior status', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, 'completed');
    const result = await queue.removeTask(a.id);
    expect(result).toMatchObject({ ok: true, priorStatus: 'completed', runId: 'run-1' });
    expect(queue.findById(a.id)).toBeNull();
  });

  // Feature 030 (US3, T046) — the "resolves queueId from the task before
  // removal" case was deleted. It relied on `queue.createNamedQueue()` to
  // build a secondary queue and then asserted the removal payload carried
  // that non-default queueId. With the v5 → v6 migration the registry is
  // constrained to exactly one entry (`id === 'default'`) and the
  // multi-queue management surface is gone, so the audit path always
  // resolves `queueId: 'default'` and there is no second queue to test.
});

describe('QueueManager.markInFlight extended fields', () => {
  it('sets startedAt and updatedAt', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    const found = queue.findById(a.id)!;
    expect(found.startedAt).not.toBeNull();
    expect(found.updatedAt).toBeGreaterThanOrEqual(found.enqueuedAt);
  });
});

describe('QueueManager.finish extended fields', () => {
  it('records lastError on failure', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, 'failed', 'boom');
    expect(queue.findById(a.id)?.lastError).toBe('boom');
    expect(queue.findById(a.id)?.completedAt).not.toBeNull();
  });

  it('does not record lastError on completed', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, 'completed');
    expect(queue.findById(a.id)?.lastError).toBeNull();
  });
});

describe('QueueManager.setPaused extended', () => {
  it('records pausedReason', async () => {
    await queue.setPaused(true, 'credit-recovery');
    expect(store.getQueue().pausedReason).toBe('credit-recovery');
    await queue.setPaused(false, null);
    expect(store.getQueue().pausedReason).toBeNull();
  });
});

describe('QueueManager.retry', () => {
  it('rejects unknown id', async () => {
    expect(await queue.retry('missing')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('rejects pending', async () => {
    const a = await queue.enqueue('A');
    expect(await queue.retry(a.id)).toEqual({ ok: false, reason: 'illegal-state' });
  });

  it('rejects in-flight', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    expect(await queue.retry(a.id)).toEqual({ ok: false, reason: 'illegal-state' });
  });

  it('accepts failed and resets to pending with retryCount++', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, 'failed', 'boom');
    expect(queue.findById(a.id)?.retryCount).toBe(0);
    const result = await queue.retry(a.id);
    expect(result.ok).toBe(true);
    const reset = queue.findById(a.id)!;
    expect(reset.status).toBe('pending');
    expect(reset.retryCount).toBe(1);
    expect(reset.lastError).toBeNull();
    expect(reset.completedAt).toBeNull();
    expect(reset.runId).toBeNull();
  });

  it('accepts canceled', async () => {
    const a = await queue.enqueue('A');
    await queue.cancel(a.id);
    expect((await queue.retry(a.id)).ok).toBe(true);
    expect(queue.findById(a.id)?.status).toBe('pending');
  });

  it('places retried item at head of pending region (after in-flight)', async () => {
    const a = await queue.enqueue('A');
    const b = await queue.enqueue('B');
    const c = await queue.enqueue('C');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, 'failed', 'boom');
    await queue.retry(a.id);
    const positions = queue.list().map((r) => ({ id: r.id, position: r.position }));
    expect(positions.find((p) => p.id === a.id)!.position).toBe(0);
    expect(positions.find((p) => p.id === b.id)!.position).toBe(1);
    expect(positions.find((p) => p.id === c.id)!.position).toBe(2);
  });
});

describe('QueueManager.moveUp / moveDown', () => {
  it('rejects unknown id', async () => {
    expect(await queue.moveUp('missing')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('rejects non-pending', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    expect(await queue.moveUp(a.id)).toEqual({ ok: false, reason: 'illegal-state' });
  });

  it('rejects when no peer pending exists', async () => {
    const a = await queue.enqueue('A');
    expect(await queue.moveUp(a.id)).toEqual({ ok: false, reason: 'no-peer' });
  });

  it('rejects at top edge for moveUp', async () => {
    const a = await queue.enqueue('A');
    await queue.enqueue('B');
    expect(await queue.moveUp(a.id)).toEqual({ ok: false, reason: 'at-edge' });
  });

  it('rejects at bottom edge for moveDown', async () => {
    await queue.enqueue('A');
    const b = await queue.enqueue('B');
    expect(await queue.moveDown(b.id)).toEqual({ ok: false, reason: 'at-edge' });
  });

  it('reorders only pending items, preserving in-flight in place', async () => {
    const a = await queue.enqueue('A');
    const b = await queue.enqueue('B');
    const c = await queue.enqueue('C');
    await queue.markInFlight(a.id, 'run-1');
    expect((await queue.moveDown(b.id)).ok).toBe(true);
    const ids = queue.list().map((r) => r.id);
    expect(ids).toEqual([a.id, c.id, b.id]);
    const positions = queue.list().map((r) => r.position);
    expect(positions).toEqual([0, 1, 2]);
  });
});

describe('QueueManager.clearCompleted / clearFailed', () => {
  it('clearCompleted removes only completed', async () => {
    const a = await queue.enqueue('A');
    const b = await queue.enqueue('B');
    const c = await queue.enqueue('C');
    await queue.markInFlight(a.id, 'r-a');
    await queue.finish(a.id, 'completed');
    await queue.markInFlight(b.id, 'r-b');
    await queue.finish(b.id, 'failed', 'boom');
    const result = await queue.clearCompleted();
    expect(result.removed).toBe(1);
    const ids = queue.list().map((r) => r.id);
    expect(ids).toContain(b.id);
    expect(ids).toContain(c.id);
    expect(ids).not.toContain(a.id);
  });

  it('clearFailed removes only failed', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'r-a');
    await queue.finish(a.id, 'failed', 'boom');
    const result = await queue.clearFailed();
    expect(result.removed).toBe(1);
    expect(queue.list()).toHaveLength(0);
  });

  it('protects in-flight', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'r-a');
    // markInFlight does not change status to completed/failed; protection check is structural.
    const result = await queue.clearCompleted();
    expect(result.removed).toBe(0);
    expect(queue.findById(a.id)?.status).toBe('in-flight');
  });

  it('renumbers positions after clear', async () => {
    const a = await queue.enqueue('A');
    const b = await queue.enqueue('B');
    const c = await queue.enqueue('C');
    await queue.markInFlight(a.id, 'r-a');
    await queue.finish(a.id, 'completed');
    await queue.clearCompleted();
    const positions = queue.list().map((r) => ({ id: r.id, position: r.position }));
    expect(positions.find((p) => p.id === b.id)!.position).toBe(0);
    expect(positions.find((p) => p.id === c.id)!.position).toBe(1);
  });
});

// Feature 030 (US3, T046) — the `QueueManager multi-queue support`
// describe block was deleted as part of the v5 → v6 single-queue
// migration. It exercised methods that no longer exist:
// `createNamedQueue`, `renameNamedQueue`, `deleteNamedQueue`,
// `saveQueueSettings`, `setQueuePausedState(true, queueId)` with a
// non-default queueId, and the global-concurrency-cap accessor
// (`setGlobalConcurrencyCap`) that backed the multi-queue dequeue
// fairness contract. The single unified queue has `MAX_QUEUES = 1`,
// the registry is constrained to exactly one entry with
// `id === 'default'`, and concurrency is implicitly capped at 1.
// Single-queue behavior is exercised by
// `tests/unit/queue/queue-manager-single-queue.test.ts` and
// `tests/unit/queue/queue-registry-single-queue.test.ts`.
