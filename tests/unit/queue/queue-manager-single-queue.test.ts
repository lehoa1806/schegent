// Feature 030 — Phase 3 (US1) unit test for the simplified single-queue
// QueueManager behavior (T022).
//
// Covers:
//   - peekNextPending() returns the oldest pending request when the single
//     default registry entry is active.
//   - peekNextPending() respects the paused state: when the only registry
//     entry is `manually-paused`, peek returns null regardless of the
//     pauseSource ('operator' or 'cascade').
//   - cascade pause/resume invariants on the single entry:
//       - cascadedPause flips active → manually-paused with pauseSource 'cascade'.
//       - cascadedResume('cascade') flips manually-paused/cascade → active.
//       - cascadedResume is a strict no-op when pauseSource === 'operator'.
//       - cascadedResume is a strict no-op when state === 'active'.
//   - The `pauseSource === null iff state !== 'manually-paused'` invariant
//     is preserved at every observable registry mutation.

import { describe, it, expect, beforeEach } from 'vitest';
import { QueueManager } from '../../../src/queue/queue-manager';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import { DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';

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

describe('queue-manager — feature 030 single-queue behavior (T022)', () => {
  let store: WorkspaceStateStore;
  let queue: QueueManager;

  beforeEach(async () => {
    store = new WorkspaceStateStore(new FakeMemento());
    await store.initialize();
    queue = new QueueManager(store);
  });

  describe('peekNextPending()', () => {
    it('returns the oldest pending request when the default entry is active', async () => {
      const a = await queue.enqueue('alpha');
      const b = await queue.enqueue('beta');
      // FIFO: alpha is older (created first), so it's next.
      const next = queue.peekNextPending();
      expect(next).not.toBeNull();
      expect(next!.id).toBe(a.id);
      // Sanity: beta is the second pending.
      const allPending = store.getQueue().requests.filter((r) => r.status === 'pending');
      expect(allPending.map((r) => r.id)).toEqual([a.id, b.id]);
    });

    it('returns null when the default entry is manually-paused by operator', async () => {
      await queue.enqueue('alpha');
      await queue.setQueuePausedState(true, DEFAULT_QUEUE_ID);
      const registry = store.getQueueRegistry();
      expect(registry.entries[0].state).toBe('manually-paused');
      expect(registry.entries[0].pauseSource).toBe('operator');
      expect(queue.peekNextPending()).toBeNull();
    });

    it('returns null when the default entry is cascade-paused', async () => {
      await queue.enqueue('alpha');
      await queue.cascadedPause(DEFAULT_QUEUE_ID);
      const registry = store.getQueueRegistry();
      expect(registry.entries[0].state).toBe('manually-paused');
      expect(registry.entries[0].pauseSource).toBe('cascade');
      // Cascade-paused entries also gate peekNextPending — the AutoDrain
      // coordinator's queueState.paused guard catches it too, but
      // peekNextPending itself walks only `active` entries.
      expect(queue.peekNextPending()).toBeNull();
    });

    it('returns null when there are no pending requests', () => {
      expect(queue.peekNextPending()).toBeNull();
    });

    it('skips in-flight and terminal requests', async () => {
      const a = await queue.enqueue('alpha');
      const b = await queue.enqueue('beta');
      await queue.markInFlight(a.id, 'run-1');
      // Even though alpha is older, it's in-flight; beta is the next pending.
      expect(queue.peekNextPending()?.id).toBe(b.id);
      await queue.finish(a.id, 'completed');
      expect(queue.peekNextPending()?.id).toBe(b.id);
    });
  });

  describe('cascade pause/resume invariants', () => {
    it('cascadedPause flips active → manually-paused with pauseSource: cascade', async () => {
      const before = store.getQueueRegistry().entries[0];
      expect(before.state).toBe('active');
      expect(before.pauseSource).toBeNull();

      const result = await queue.cascadedPause(DEFAULT_QUEUE_ID);
      expect(result.ok).toBe(true);

      const after = store.getQueueRegistry().entries[0];
      expect(after.state).toBe('manually-paused');
      expect(after.pauseSource).toBe('cascade');
    });

    it('cascadedResume restores manually-paused/cascade → active', async () => {
      await queue.cascadedPause(DEFAULT_QUEUE_ID);
      const result = await queue.cascadedResume(DEFAULT_QUEUE_ID);
      expect(result.ok).toBe(true);

      const after = store.getQueueRegistry().entries[0];
      expect(after.state).toBe('active');
      expect(after.pauseSource).toBeNull();
    });

    it('cascadedResume is a strict NO-OP when pauseSource === operator', async () => {
      // Operator-pause first.
      await queue.setQueuePausedState(true, DEFAULT_QUEUE_ID);
      const beforeRegistry = store.getQueueRegistry();
      const beforeEntry = beforeRegistry.entries[0];
      expect(beforeEntry.state).toBe('manually-paused');
      expect(beforeEntry.pauseSource).toBe('operator');

      // cascadedResume must NOT clear the operator pause (FR-004 of feature 028
      // — preserved in feature 030's single-queue model).
      const result = await queue.cascadedResume(DEFAULT_QUEUE_ID);
      expect(result.ok).toBe(true);

      const afterEntry = store.getQueueRegistry().entries[0];
      expect(afterEntry.state).toBe('manually-paused');
      expect(afterEntry.pauseSource).toBe('operator');
    });

    it('cascadedResume is a strict NO-OP when the entry is already active', async () => {
      const before = store.getQueueRegistry().entries[0];
      expect(before.state).toBe('active');
      expect(before.pauseSource).toBeNull();

      const result = await queue.cascadedResume(DEFAULT_QUEUE_ID);
      expect(result.ok).toBe(true);

      const after = store.getQueueRegistry().entries[0];
      expect(after.state).toBe('active');
      expect(after.pauseSource).toBeNull();
    });

    it('cascadedPause is idempotent when the entry is already manually-paused (operator or cascade)', async () => {
      await queue.cascadedPause(DEFAULT_QUEUE_ID);
      const first = store.getQueueRegistry().entries[0];
      expect(first.state).toBe('manually-paused');
      expect(first.pauseSource).toBe('cascade');

      // Calling again should not flip pauseSource away from cascade.
      const result = await queue.cascadedPause(DEFAULT_QUEUE_ID);
      expect(result.ok).toBe(true);
      const second = store.getQueueRegistry().entries[0];
      expect(second.state).toBe('manually-paused');
      expect(second.pauseSource).toBe('cascade');
    });

    it('cascadedPause when operator already paused leaves pauseSource as operator', async () => {
      // Operator-pause first.
      await queue.setQueuePausedState(true, DEFAULT_QUEUE_ID);
      // Cascade-pause on top should be a no-op for pauseSource (operator wins).
      const result = await queue.cascadedPause(DEFAULT_QUEUE_ID);
      expect(result.ok).toBe(true);
      const after = store.getQueueRegistry().entries[0];
      expect(after.state).toBe('manually-paused');
      // Operator pause must NOT be downgraded to cascade.
      expect(after.pauseSource).toBe('operator');
    });
  });

  describe('pauseSource invariant (state !== manually-paused → pauseSource === null)', () => {
    it('holds across cascade pause then resume', async () => {
      let entry = store.getQueueRegistry().entries[0];
      expect(entry.state === 'manually-paused' || entry.pauseSource === null).toBe(true);

      await queue.cascadedPause(DEFAULT_QUEUE_ID);
      entry = store.getQueueRegistry().entries[0];
      expect(entry.state).toBe('manually-paused');
      expect(entry.pauseSource).not.toBeNull();

      await queue.cascadedResume(DEFAULT_QUEUE_ID);
      entry = store.getQueueRegistry().entries[0];
      expect(entry.state).toBe('active');
      expect(entry.pauseSource).toBeNull();
    });

    it('holds across operator pause then resume', async () => {
      await queue.setQueuePausedState(true, DEFAULT_QUEUE_ID);
      let entry = store.getQueueRegistry().entries[0];
      expect(entry.state).toBe('manually-paused');
      expect(entry.pauseSource).toBe('operator');

      await queue.setQueuePausedState(false, DEFAULT_QUEUE_ID);
      entry = store.getQueueRegistry().entries[0];
      expect(entry.state).toBe('active');
      expect(entry.pauseSource).toBeNull();
    });
  });
});
