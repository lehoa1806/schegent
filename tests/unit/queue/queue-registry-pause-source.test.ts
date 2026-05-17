// Feature 028 — queue-registry `pauseSource` invariant + QueueManager
// operator/cascade pause precedence.
//
// Covers:
//   - Registry-level `pauseSource` is `null` iff `state !== 'manually-paused'`.
//   - `setQueuePaused()` defaults `pauseSource` to `'operator'` on the active →
//     manually-paused transition; `'cascade'` is opt-in.
//   - Manager-level `cascadedPause()` / `cascadedResume()` helpers respect
//     operator precedence: an operator pause that fires while a cascade pause
//     is active wins; the matching cascade-resume is a no-op.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_QUEUE_ID,
  findQueue,
  makeDefaultRegistry,
  setQueuePaused,
  setQueueState,
  validateQueueRegistry,
  type QueueRegistry,
  type QueueRegistryEntry
} from '../../../src/queue/queue-registry';
import { QueueManager } from '../../../src/queue/queue-manager';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';

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

const NOW = 1_700_000_000_000;

describe('queue-registry pauseSource invariants (Feature 028)', () => {
  it('default registry entry has pauseSource: null', () => {
    const r0 = makeDefaultRegistry(NOW);
    expect(findQueue(r0, DEFAULT_QUEUE_ID)?.pauseSource).toBeNull();
  });

  it('setQueuePaused(true) defaults pauseSource to "operator"', () => {
    const r0 = makeDefaultRegistry(NOW);
    const r1 = setQueuePaused(r0, { id: DEFAULT_QUEUE_ID, paused: true, now: NOW + 1 });
    const entry = findQueue(r1, DEFAULT_QUEUE_ID);
    expect(entry?.state).toBe('manually-paused');
    expect(entry?.pauseSource).toBe('operator');
  });

  it('setQueuePaused(true) accepts pauseSource: "cascade"', () => {
    const r0 = makeDefaultRegistry(NOW);
    const r1 = setQueuePaused(r0, {
      id: DEFAULT_QUEUE_ID,
      paused: true,
      pauseSource: 'cascade',
      now: NOW + 1
    });
    expect(findQueue(r1, DEFAULT_QUEUE_ID)?.pauseSource).toBe('cascade');
  });

  it('setQueuePaused(false) clears pauseSource to null', () => {
    const r0 = makeDefaultRegistry(NOW);
    const r1 = setQueuePaused(r0, {
      id: DEFAULT_QUEUE_ID,
      paused: true,
      pauseSource: 'cascade',
      now: NOW + 1
    });
    const r2 = setQueuePaused(r1, { id: DEFAULT_QUEUE_ID, paused: false, now: NOW + 2 });
    const entry = findQueue(r2, DEFAULT_QUEUE_ID);
    expect(entry?.state).toBe('active');
    expect(entry?.pauseSource).toBeNull();
  });

  it('setQueueState forces pauseSource: null when transitioning to active', () => {
    const r0 = makeDefaultRegistry(NOW);
    const r1 = setQueueState(r0, {
      id: DEFAULT_QUEUE_ID,
      state: 'manually-paused',
      pauseSource: 'cascade',
      now: NOW + 1
    });
    const r2 = setQueueState(r1, {
      id: DEFAULT_QUEUE_ID,
      state: 'active',
      now: NOW + 2
    });
    expect(findQueue(r2, DEFAULT_QUEUE_ID)?.pauseSource).toBeNull();
  });

  it('validateQueueRegistry rejects manually-paused with pauseSource: null', () => {
    const bad: QueueRegistry = {
      entries: [
        {
          id: DEFAULT_QUEUE_ID,
          name: 'Default queue',
          position: 0,
          state: 'manually-paused',
          pauseSource: null,
          schedule: null,
          createdAt: NOW,
          updatedAt: NOW
        } as QueueRegistryEntry
      ],
      updatedAt: NOW
    };
    expect(() => validateQueueRegistry(bad)).toThrow(/invalid pauseSource/);
  });

  it('validateQueueRegistry rejects active with non-null pauseSource', () => {
    const bad: QueueRegistry = {
      entries: [
        {
          id: DEFAULT_QUEUE_ID,
          name: 'Default queue',
          position: 0,
          state: 'active',
          pauseSource: 'operator',
          schedule: null,
          createdAt: NOW,
          updatedAt: NOW
        } as QueueRegistryEntry
      ],
      updatedAt: NOW
    };
    expect(() => validateQueueRegistry(bad)).toThrow(/non-null pauseSource/);
  });
});

describe('QueueManager cascadedPause / cascadedResume precedence (Feature 028)', () => {
  let store: WorkspaceStateStore;
  let queue: QueueManager;

  beforeEach(async () => {
    const memento = new FakeMemento();
    store = new WorkspaceStateStore(memento);
    await store.initialize();
    queue = new QueueManager(store);
  });

  it('cascadedPause on active queue records pauseSource="cascade"', async () => {
    const result = await queue.cascadedPause(DEFAULT_QUEUE_ID);
    expect(result.ok).toBe(true);
    const entry = findQueue(store.getQueueRegistry(), DEFAULT_QUEUE_ID);
    expect(entry?.state).toBe('manually-paused');
    expect(entry?.pauseSource).toBe('cascade');
  });

  it('cascadedResume clears cascade pause back to active', async () => {
    await queue.cascadedPause(DEFAULT_QUEUE_ID);
    const result = await queue.cascadedResume(DEFAULT_QUEUE_ID);
    expect(result.ok).toBe(true);
    const entry = findQueue(store.getQueueRegistry(), DEFAULT_QUEUE_ID);
    expect(entry?.state).toBe('active');
    expect(entry?.pauseSource).toBeNull();
  });

  it('cascadedResume is a no-op when pauseSource is "operator"', async () => {
    await queue.setQueuePausedState(true, DEFAULT_QUEUE_ID);
    const result = await queue.cascadedResume(DEFAULT_QUEUE_ID);
    expect(result.ok).toBe(true);
    const entry = findQueue(store.getQueueRegistry(), DEFAULT_QUEUE_ID);
    // Operator pause survives the cascade-resume signal.
    expect(entry?.state).toBe('manually-paused');
    expect(entry?.pauseSource).toBe('operator');
  });

  it('cascadedResume is a no-op when the queue is already active', async () => {
    const result = await queue.cascadedResume(DEFAULT_QUEUE_ID);
    expect(result.ok).toBe(true);
    expect(findQueue(store.getQueueRegistry(), DEFAULT_QUEUE_ID)?.state).toBe('active');
  });

  it('cascadedPause on an operator-paused queue is a no-op (operator wins)', async () => {
    await queue.setQueuePausedState(true, DEFAULT_QUEUE_ID);
    const result = await queue.cascadedPause(DEFAULT_QUEUE_ID);
    expect(result.ok).toBe(true);
    const entry = findQueue(store.getQueueRegistry(), DEFAULT_QUEUE_ID);
    // pauseSource MUST remain "operator" — never demoted to "cascade".
    expect(entry?.pauseSource).toBe('operator');
  });

  it('cascadedPause is idempotent on an already cascade-paused queue', async () => {
    await queue.cascadedPause(DEFAULT_QUEUE_ID);
    const result = await queue.cascadedPause(DEFAULT_QUEUE_ID);
    expect(result.ok).toBe(true);
    expect(findQueue(store.getQueueRegistry(), DEFAULT_QUEUE_ID)?.pauseSource).toBe('cascade');
  });

  it('operator pause while cascade-paused promotes pauseSource to "operator"', async () => {
    await queue.cascadedPause(DEFAULT_QUEUE_ID);
    const result = await queue.setQueuePausedState(true, DEFAULT_QUEUE_ID);
    expect(result.ok).toBe(true);
    const entry = findQueue(store.getQueueRegistry(), DEFAULT_QUEUE_ID);
    expect(entry?.pauseSource).toBe('operator');
    // A subsequent cascadedResume MUST NOT clear the operator pause.
    await queue.cascadedResume(DEFAULT_QUEUE_ID);
    const after = findQueue(store.getQueueRegistry(), DEFAULT_QUEUE_ID);
    expect(after?.state).toBe('manually-paused');
    expect(after?.pauseSource).toBe('operator');
  });

  it('operator pause while operator-paused still returns already-paused', async () => {
    await queue.setQueuePausedState(true, DEFAULT_QUEUE_ID);
    const result = await queue.setQueuePausedState(true, DEFAULT_QUEUE_ID);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('already-paused');
  });

  it('cascadedResume on an active queue is a no-op', async () => {
    const result = await queue.cascadedResume(DEFAULT_QUEUE_ID);
    expect(result.ok).toBe(true);
  });

  it('cascadedPause on an unknown queue returns unknown-queue-id', async () => {
    const result = await queue.cascadedPause('00000000-0000-4000-8000-000000000000');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unknown-queue-id');
  });

  it('cascadedResume on an unknown queue returns unknown-queue-id', async () => {
    const result = await queue.cascadedResume('00000000-0000-4000-8000-000000000000');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unknown-queue-id');
  });
});
