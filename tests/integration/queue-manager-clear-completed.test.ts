// FR-R3-150 (T1621) — integration fixture for `QueueManager.clearCompleted()`,
// the queue-addressed Clear Done fix.
//
// Pins specs/188-queue-cleanup-scope/spec.md §2 "Selected-queue Clear Done":
// clearing Queue B's completed Tasks must never touch Default's, and an
// unknown/missing queue id must be refused rather than silently defaulted.

import { describe, it, expect } from 'vitest';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';

class MockMemento implements Memento {
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

async function buildTwoQueueSystem(): Promise<{
  store: WorkspaceStateStore;
  queue: QueueManager;
  queueBId: string;
}> {
  const memento = new MockMemento();
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);

  const created = await queue.createQueue('Queue B');
  if (!created.ok || !created.queueId) throw new Error('fixture: createQueue failed');
  const queueBId = created.queueId;

  // Default: a pending Task and a completed one.
  await queue.enqueue('default pending');
  const defaultDone = await queue.enqueue('default completed');
  await queue.markInFlight(defaultDone.id, 'run-default-done');
  await queue.finish(defaultDone.id, 'completed');

  // Queue B: a pending Task and a completed one.
  await queue.enqueue('b pending', { queueId: queueBId });
  const bDone = await queue.enqueue('b completed', { queueId: queueBId });
  await queue.markInFlight(bDone.id, 'run-b-done');
  await queue.finish(bDone.id, 'completed');

  return { store, queue, queueBId };
}

describe('QueueManager.clearCompleted() — integration (FR-R3-150, T1621)', () => {
  it('clears only the addressed queue\'s completed Tasks; Default is untouched', async () => {
    const { queue, queueBId } = await buildTwoQueueSystem();

    const result = await queue.clearCompleted(queueBId);

    expect(result.ok).toBe(true);
    expect(result.removed).toBe(1);

    const bIds = queue.list(queueBId).map((r) => r.id);
    expect(bIds).toHaveLength(1);
    expect(queue.list(queueBId).every((r) => r.status !== 'completed')).toBe(true);

    // Default's completed Task survives untouched.
    const defaultIds = queue.list(DEFAULT_QUEUE_ID);
    expect(defaultIds.some((r) => r.status === 'completed')).toBe(true);
    expect(defaultIds).toHaveLength(2);
  });

  it('refuses an unknown queue id rather than defaulting to Default (FR-011)', async () => {
    const { queue } = await buildTwoQueueSystem();
    const defaultBefore = queue.list(DEFAULT_QUEUE_ID);

    const result = await queue.clearCompleted('no-such-queue');

    expect(result).toEqual({ ok: false, reason: 'unknown-queue-id', removed: 0 });
    // Default is untouched — the call must not have silently fallen back to it.
    expect(queue.list(DEFAULT_QUEUE_ID)).toEqual(defaultBefore);
  });
});
