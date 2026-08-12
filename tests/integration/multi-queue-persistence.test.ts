// Feature 092 (T016, US1) — multi-queue persistence across a reload.
//
// The v10 shape files each queue's `QueueState` under its own key in one
// memento record, so the property that matters is not "the map exists" but
// "a second activation reads back exactly what the first one wrote" — per
// queue, for every field an operator can see. A single shared memento is
// handed to two successive `WorkspaceStateStore` instances, which is what a
// window reload actually does.

import { describe, expect, it } from 'vitest';
import { KEYS, WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { DEFAULT_QUEUE_ID } from '../../src/queue/queue-registry';
import { STATE_SCHEMA_VERSION } from '../../src/contracts/state-schema';
import type { QueueState } from '../../src/queue/feature-request';

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

/** A fresh store over the same memento — what a window reload produces. */
async function reload(memento: Memento): Promise<{ store: WorkspaceStateStore; queue: QueueManager }> {
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  return { store, queue: new QueueManager(store) };
}

describe('multi-queue persistence survives a reload (T016, US1)', () => {
  it('reads back both queues, their registry entries and their pending work', async () => {
    const memento = new MockMemento();
    const first = await reload(memento);

    const created = await first.queue.createQueue('Docs');
    expect(created.ok).toBe(true);
    const docs = created.queueId!;

    const a = await first.queue.enqueue('feature A — on the default queue');
    const b = await first.queue.enqueue('feature B — on Docs', { queueId: docs });
    const c = await first.queue.enqueue('feature C — on Docs', { queueId: docs, position: 1 });
    // The default queue is paused and Docs is not, so the reload has two
    // distinct per-queue states to keep apart rather than one repeated value.
    expect((await first.queue.setQueuePausedState(true, DEFAULT_QUEUE_ID, 'operator pause')).ok).toBe(
      true
    );

    const second = await reload(memento);

    expect(second.store.getQueueRegistry().entries.map((entry) => entry.id)).toEqual([
      DEFAULT_QUEUE_ID,
      docs
    ]);
    expect(second.store.getQueueRegistry().entries.map((entry) => entry.name)).toEqual([
      'Default queue',
      'Docs'
    ]);
    expect(second.store.getQueueStateIds().slice().sort()).toEqual([DEFAULT_QUEUE_ID, docs].sort());

    expect(second.store.getRequestsForQueue(DEFAULT_QUEUE_ID).map((r) => r.id)).toEqual([a.id]);
    expect(
      second.store
        .getRequestsForQueue(docs)
        .slice()
        .sort((x, y) => x.position - y.position)
        .map((r) => r.description)
    ).toEqual(['feature B — on Docs', 'feature C — on Docs']);
    void b;
    void c;

    // Per-queue pause state is per queue, not a workspace-wide flag.
    expect(second.store.getQueue(DEFAULT_QUEUE_ID).paused).toBe(true);
    expect(second.store.getQueue(docs).paused).toBe(false);

    // The `list()` default parameter still addresses the default queue, and
    // `listAll()` spans both.
    expect(second.queue.list().map((r) => r.id)).toEqual([a.id]);
    expect(second.queue.listAll()).toHaveLength(3);
  });

  it("keeps a queue write out of every other queue's record", async () => {
    const memento = new MockMemento();
    const first = await reload(memento);
    const docs = (await first.queue.createQueue('Docs')).queueId!;
    const research = (await first.queue.createQueue('Research')).queueId!;
    await first.queue.enqueue('feature A', { queueId: docs });
    await first.queue.enqueue('feature B', { queueId: research });

    const before = JSON.stringify(first.store.getQueue(research));
    await first.queue.enqueue('feature C', { queueId: docs });
    expect(JSON.stringify(first.store.getQueue(research))).toBe(before);

    const second = await reload(memento);
    expect(second.store.getRequestsForQueue(docs)).toHaveLength(2);
    expect(second.store.getRequestsForQueue(research)).toHaveLength(1);
  });

  it('persists the queue map under a single key at the shipped schema version', async () => {
    const memento = new MockMemento();
    const first = await reload(memento);
    const docs = (await first.queue.createQueue('Docs')).queueId!;
    await first.queue.enqueue('feature A', { queueId: docs });

    // The atomicity claim of the v10 shape is that one memento key holds
    // every queue's state — asserted against the raw record, because a store
    // accessor would hide a second key.
    const persisted = memento.get<Record<string, QueueState>>(KEYS.queue);
    expect(persisted).toBeTruthy();
    expect(Object.keys(persisted!).slice().sort()).toEqual([DEFAULT_QUEUE_ID, docs].sort());
    expect(Array.isArray(persisted![docs].requests)).toBe(true);
    expect(memento.get<number>(KEYS.schemaVersionNumeric)).toBe(STATE_SCHEMA_VERSION);
  });
});
