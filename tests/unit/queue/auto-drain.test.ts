import { describe, it, expect, beforeEach } from 'vitest';
import { QueueManager } from '../../../src/queue/queue-manager';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';

class InMemoryMemento implements Memento {
  private store = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.store.delete(key);
    else this.store.set(key, value);
    return Promise.resolve();
  }
}

describe('queue auto-drain prerequisites (US1 / T028)', () => {
  let store: WorkspaceStateStore;
  let queue: QueueManager;
  beforeEach(() => {
    store = new WorkspaceStateStore(new InMemoryMemento());
    queue = new QueueManager(store);
  });

  it('peekNextPending returns the oldest pending item when queue not paused', async () => {
    await queue.enqueue('first');
    await queue.enqueue('second');
    const next = queue.peekNextPending();
    expect(next?.description).toBe('first');
  });

  it('peekNextPending returns null when only terminal items remain', async () => {
    const a = await queue.enqueue('alpha');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, 'completed');
    expect(queue.peekNextPending()).toBeNull();
  });

  it('finish() preserves sanitized failure metadata on lastError (T029)', async () => {
    const a = await queue.enqueue('alpha');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, 'failed', {
      code: 'invocation-failed',
      message: 'phase plan crashed',
      phase: 'speckit-plan',
      correlationId: 'run-1'
    });
    const after = queue.findById(a.id);
    expect(after?.status).toBe('failed');
    expect(typeof after?.lastError === 'object' && after?.lastError !== null).toBe(true);
    if (after?.lastError && typeof after.lastError === 'object') {
      expect(after.lastError.message).toBe('phase plan crashed');
      expect(after.lastError.correlationId).toBe('run-1');
    }
  });

  it('queue exposes pausedReason in pause state (T030)', async () => {
    await queue.setPaused(true, 'rate-limit cooldown');
    const state = store.getQueue();
    expect(state.paused).toBe(true);
    expect(state.pausedReason).toBe('rate-limit cooldown');
  });

  it('queue uses canonical in-flight status (T031)', async () => {
    const a = await queue.enqueue('alpha');
    await queue.markInFlight(a.id, 'run-1');
    expect(queue.findById(a.id)?.status).toBe('in-flight');
  });
});
