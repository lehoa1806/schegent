// Feature 056 Track 4 (FR-018..FR-022, T035) — regression tests for the
// `schegent.queue.globalConcurrencyCap` knob, rewritten by feature 092
// (T039, US2, FR-026/FR-027).
//
// Feature 056 pinned the cap at exactly 1 because v1 shipped one active run and
// the lock could not have admitted a second. Feature 092 supplies the lock split
// that precondition named, so the range becomes `[1, 20]` with a default of 3.
//
// What is NOT relaxed is the shape of the guard. The cap is still pinned across
// five agreeing surfaces, and this file still pins the effective-enforcement
// one:
//   1. package.json contribution metadata: minimum=1, maximum=20, default=3.
//   2. `SETTINGS_SCHEMA` in src/config/settings-schema.ts.
//   3. Host validator (`KEY_SPECS['queue.globalConcurrencyCap']`).
//   4. `WorkspaceStateStore.setGlobalConcurrencyCap`.
//   5. `QueueManager.saveQueueSettings`.
//
// The one behavioural reversal worth stating plainly: an out-of-range persisted
// value is now REFUSED on read rather than saturated. Saturation was defensible
// when every out-of-range value was a legacy record from a wider schema; now
// that the schema is the wider one, silently returning 1 for a corrupted 21
// would run the workspace at a twentieth of the operator's stated intent and
// say so only in a log line.

import { describe, it, expect, beforeEach } from 'vitest';
import { QueueManager } from '../../../src/queue/queue-manager';
import {
  WorkspaceStateStore,
  type Memento,
  QueueMutationRejected
} from '../../../src/state/workspace-state';
import { MAX_QUEUES } from '../../../src/contracts/queue-bounds';

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

/** The ceiling's upper bound tracks `MAX_QUEUES`: no workspace runs more. */
const CAP_MAX = 20;
// Feature 098 (REL-02) — the DEFAULT moved 3 -> 1; `CAP_MAX` is untouched,
// so every range assertion below still exercises the full [1, 20] ceiling.
const CAP_DEFAULT = 1;

describe('feature 092 — global concurrency ceiling over [1, 20]', () => {
  let store: WorkspaceStateStore;
  let queue: QueueManager;

  beforeEach(async () => {
    store = new WorkspaceStateStore(new FakeMemento());
    await store.initialize();
    queue = new QueueManager(store);
  });

  it('the upper bound agrees with MAX_QUEUES rather than being a second number', () => {
    expect(CAP_MAX).toBe(MAX_QUEUES);
  });

  describe('store.setGlobalConcurrencyCap', () => {
    it('accepts the lower bound 1', async () => {
      await expect(store.setGlobalConcurrencyCap(1)).resolves.toBeUndefined();
      expect(store.getGlobalConcurrencyCap()).toBe(1);
    });

    it('accepts the upper bound 20', async () => {
      await expect(store.setGlobalConcurrencyCap(CAP_MAX)).resolves.toBeUndefined();
      expect(store.getGlobalConcurrencyCap()).toBe(CAP_MAX);
    });

    it('accepts an interior value that feature 056 refused', async () => {
      await expect(store.setGlobalConcurrencyCap(2)).resolves.toBeUndefined();
      expect(store.getGlobalConcurrencyCap()).toBe(2);
      await expect(store.setGlobalConcurrencyCap(5)).resolves.toBeUndefined();
      expect(store.getGlobalConcurrencyCap()).toBe(5);
    });

    it('refuses 0 — below the lower bound', () => {
      expect(() => store.setGlobalConcurrencyCap(0)).toThrow(QueueMutationRejected);
    });

    it('refuses 21 — one past the upper bound', () => {
      expect(() => store.setGlobalConcurrencyCap(CAP_MAX + 1)).toThrow(QueueMutationRejected);
    });

    it('refuses a non-integer', () => {
      expect(() => store.setGlobalConcurrencyCap(2.5)).toThrow(QueueMutationRejected);
    });
  });

  describe('store.getGlobalConcurrencyCap', () => {
    it('defaults to 3 when the operator has set no value', () => {
      expect(store.getGlobalConcurrencyCap()).toBe(CAP_DEFAULT);
    });

    it('returns an in-range persisted value verbatim rather than saturating it', async () => {
      const mem = new FakeMemento();
      await mem.update('schegent.queue.globalConcurrencyCap', 7);
      const wide = new WorkspaceStateStore(mem);
      await wide.initialize();
      expect(wide.getGlobalConcurrencyCap()).toBe(7);
    });

    it('refuses an out-of-range persisted value rather than clamping it to 1', async () => {
      const mem = new FakeMemento();
      await mem.update('schegent.queue.globalConcurrencyCap', 100);
      const corrupt = new WorkspaceStateStore(mem);
      await corrupt.initialize();
      expect(() => corrupt.getGlobalConcurrencyCap()).toThrow(QueueMutationRejected);
    });

    it('refuses a non-numeric persisted value rather than clamping it to 1', async () => {
      const mem = new FakeMemento();
      await mem.update('schegent.queue.globalConcurrencyCap', 'three');
      const corrupt = new WorkspaceStateStore(mem);
      await corrupt.initialize();
      expect(() => corrupt.getGlobalConcurrencyCap()).toThrow(QueueMutationRejected);
    });
  });

  describe('QueueManager.saveQueueSettings', () => {
    it('accepts the lower bound 1', async () => {
      const result = await queue.saveQueueSettings({
        globalConcurrencyCap: 1,
        defaultQueueId: 'default'
      });
      expect(result.ok).toBe(true);
      expect(store.getGlobalConcurrencyCap()).toBe(1);
    });

    it('accepts the upper bound 20', async () => {
      const result = await queue.saveQueueSettings({
        globalConcurrencyCap: CAP_MAX,
        defaultQueueId: 'default'
      });
      expect(result.ok).toBe(true);
      expect(store.getGlobalConcurrencyCap()).toBe(CAP_MAX);
    });

    it('accepts an interior value that feature 056 refused', async () => {
      const result = await queue.saveQueueSettings({
        globalConcurrencyCap: 5,
        defaultQueueId: 'default'
      });
      expect(result.ok).toBe(true);
      expect(store.getGlobalConcurrencyCap()).toBe(5);
    });

    it('refuses 0 with invalid-concurrency-cap', async () => {
      const result = await queue.saveQueueSettings({
        globalConcurrencyCap: 0,
        defaultQueueId: 'default'
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('invalid-concurrency-cap');
    });

    it('refuses 21 with invalid-concurrency-cap rather than clamping to 20', async () => {
      const result = await queue.saveQueueSettings({
        globalConcurrencyCap: CAP_MAX + 1,
        defaultQueueId: 'default'
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('invalid-concurrency-cap');
      expect(store.getGlobalConcurrencyCap()).toBe(CAP_DEFAULT);
    });
  });
});
