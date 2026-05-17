// Feature 056 Track 4 (FR-018..FR-022, T035) — Regression tests pinning
// the single-active-run invariant.
//
// v1 supports exactly one active workflow run. The
// `schegent.queue.globalConcurrencyCap` knob is pinned at 1 across three
// surfaces:
//   1. package.json contribution metadata: minimum=maximum=1.
//   2. Host validator (`KEY_SPECS['queue.globalConcurrencyCap'].max`).
//   3. Effective enforcement: `QueueManager.saveQueueSettings` and
//      `WorkspaceStateStore.setGlobalConcurrencyCap` both reject any
//      value outside [1, 1].
//
// These tests pin the third surface — relaxing the limit requires
// re-validating multi-active-run lock semantics in the controller and
// the watchdog, which is explicitly out of scope for v1.

import { describe, it, expect, beforeEach } from 'vitest';
import { QueueManager } from '../../../src/queue/queue-manager';
import {
  WorkspaceStateStore,
  type Memento,
  QueueMutationRejected
} from '../../../src/state/workspace-state';

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

describe('Feature 056 Track 4 — global concurrency cap pinned at 1', () => {
  let store: WorkspaceStateStore;
  let queue: QueueManager;

  beforeEach(async () => {
    store = new WorkspaceStateStore(new FakeMemento());
    await store.initialize();
    queue = new QueueManager(store);
  });

  it('store.setGlobalConcurrencyCap(1) is accepted (FR-021)', async () => {
    await expect(store.setGlobalConcurrencyCap(1)).resolves.toBeUndefined();
    expect(store.getGlobalConcurrencyCap()).toBe(1);
  });

  it('store.setGlobalConcurrencyCap(2) is rejected (FR-021)', () => {
    expect(() => store.setGlobalConcurrencyCap(2)).toThrow(QueueMutationRejected);
  });

  it('store.setGlobalConcurrencyCap(5) is rejected — legacy cap is no longer accepted (FR-021)', () => {
    expect(() => store.setGlobalConcurrencyCap(5)).toThrow(QueueMutationRejected);
  });

  it('store.setGlobalConcurrencyCap(0) is rejected (FR-021)', () => {
    expect(() => store.setGlobalConcurrencyCap(0)).toThrow(QueueMutationRejected);
  });

  it('legacy persisted value (e.g. 100) saturates to 1 on read (FR-022)', async () => {
    // Simulate a workspace memento populated by an older extension
    // version that wrote a value above the new cap.
    const mem = new FakeMemento();
    await mem.update('schegent.queue.globalConcurrencyCap', 100);
    const legacyStore = new WorkspaceStateStore(mem);
    await legacyStore.initialize();
    // The reader clamps anything outside [1, 1] to the default (1).
    expect(legacyStore.getGlobalConcurrencyCap()).toBe(1);
  });

  it('QueueManager.saveQueueSettings({ cap: 1 }) is accepted (FR-021)', async () => {
    const result = await queue.saveQueueSettings({
      globalConcurrencyCap: 1,
      defaultQueueId: 'default'
    });
    expect(result.ok).toBe(true);
    expect(store.getGlobalConcurrencyCap()).toBe(1);
  });

  it('QueueManager.saveQueueSettings({ cap: 2 }) is rejected with invalid-concurrency-cap (FR-021)', async () => {
    const result = await queue.saveQueueSettings({
      globalConcurrencyCap: 2,
      defaultQueueId: 'default'
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-concurrency-cap');
  });

  it('QueueManager.saveQueueSettings({ cap: 5 }) is rejected — legacy max is no longer accepted (FR-021)', async () => {
    const result = await queue.saveQueueSettings({
      globalConcurrencyCap: 5,
      defaultQueueId: 'default'
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-concurrency-cap');
  });
});
