// Feature 028 — queue-registry pause attribution + QueueManager operator/cascade
// pause precedence.
//
// FR-R3-011 rewrote the first half of this file and left the second alone, which
// is the honest split. `state` and `pauseSource` are no longer persisted on a
// registry entry, so the writers this used to exercise — `setQueuePaused()` and
// `setQueueState()` — are deleted and their invariant is now established by
// construction in `projectQueueRegistry()` rather than asserted afterwards by
// `validateQueueRegistry()`. What has *not* changed is the precedence the
// manager enforces: an operator pause outranks a cascade pause, is never demoted
// to one, and survives a cascade resume. Those assertions read the projection
// instead of the stored entry and otherwise stand as written.
//
// Covers:
//   - The projected `state`/`pauseSource` pair is derived from `QueueState` and
//     is `null` iff the queue is not paused.
//   - Manager-level `cascadedPause()` / `cascadedResume()` respect operator
//     precedence: an operator pause that fires while a cascade pause is active
//     wins; the matching cascade-resume is a no-op.

import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  makeDefaultRegistry,
  projectQueueRegistry,
  type QueuePauseView
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

function projectWith(view: QueuePauseView | undefined) {
  const registry = makeDefaultRegistry(NOW);
  const pauses = new Map<string, QueuePauseView>();
  if (view) pauses.set(DEFAULT_QUEUE_ID, view);
  return projectQueueRegistry(registry, pauses).entries[0]!;
}

describe('queue-registry pause projection (Feature 028 invariant, FR-R3-011 shape)', () => {
  it('a queue with no pause view projects as active with no source', () => {
    const entry = projectWith(undefined);
    expect(entry.state).toBe('active');
    expect(entry.pauseSource).toBeNull();
  });

  it('an unpaused queue projects as active and drops any stale source', () => {
    // A source without a pause is the half-state the old two-key write could
    // leave behind. The projection cannot express it: `state` and `pauseSource`
    // come from the same expression, so they cannot disagree.
    const entry = projectWith({ paused: false, pauseSource: 'cascade' });
    expect(entry.state).toBe('active');
    expect(entry.pauseSource).toBeNull();
  });

  it('a paused queue projects its recorded source', () => {
    expect(projectWith({ paused: true, pauseSource: 'cascade' }).pauseSource).toBe('cascade');
    expect(projectWith({ paused: true, pauseSource: 'retry-cap' }).pauseSource).toBe('retry-cap');
  });

  it('a paused queue with no recorded source is attributed to the operator', () => {
    // Conservative on purpose, and the same defaulting the v12 -> v13 collapse
    // applies: an operator pause outranks a cascade one, so guessing `cascade`
    // would let the next cascade resume undo a pause the operator asked for.
    const entry = projectWith({ paused: true, pauseSource: null });
    expect(entry.state).toBe('manually-paused');
    expect(entry.pauseSource).toBe('operator');
  });

  it('carries the entry\'s own fields through unchanged', () => {
    const entry = projectWith({ paused: true, pauseSource: 'operator' });
    expect(entry.id).toBe(DEFAULT_QUEUE_ID);
    expect(entry.position).toBe(0);
    expect(entry.schedule).toBeNull();
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
    const entry = store.getProjectedQueueRegistry().entries.find((e) => e.id === DEFAULT_QUEUE_ID);
    expect(entry?.state).toBe('manually-paused');
    expect(entry?.pauseSource).toBe('cascade');
  });

  it('cascadedResume clears cascade pause back to active', async () => {
    await queue.cascadedPause(DEFAULT_QUEUE_ID);
    const result = await queue.cascadedResume(DEFAULT_QUEUE_ID);
    expect(result.ok).toBe(true);
    const entry = store.getProjectedQueueRegistry().entries.find((e) => e.id === DEFAULT_QUEUE_ID);
    expect(entry?.state).toBe('active');
    expect(entry?.pauseSource).toBeNull();
  });

  it('cascadedResume is a no-op when pauseSource is "operator"', async () => {
    await queue.setQueuePausedState(true, DEFAULT_QUEUE_ID);
    const result = await queue.cascadedResume(DEFAULT_QUEUE_ID);
    expect(result.ok).toBe(true);
    const entry = store.getProjectedQueueRegistry().entries.find((e) => e.id === DEFAULT_QUEUE_ID);
    // Operator pause survives the cascade-resume signal.
    expect(entry?.state).toBe('manually-paused');
    expect(entry?.pauseSource).toBe('operator');
  });

  it('cascadedResume is a no-op when the queue is already active', async () => {
    const result = await queue.cascadedResume(DEFAULT_QUEUE_ID);
    expect(result.ok).toBe(true);
    expect(store.getProjectedQueueRegistry().entries.find((e) => e.id === DEFAULT_QUEUE_ID)?.state).toBe('active');
  });

  it('cascadedPause on an operator-paused queue is a no-op (operator wins)', async () => {
    await queue.setQueuePausedState(true, DEFAULT_QUEUE_ID);
    const result = await queue.cascadedPause(DEFAULT_QUEUE_ID);
    expect(result.ok).toBe(true);
    const entry = store.getProjectedQueueRegistry().entries.find((e) => e.id === DEFAULT_QUEUE_ID);
    // pauseSource MUST remain "operator" — never demoted to "cascade".
    expect(entry?.pauseSource).toBe('operator');
  });

  it('cascadedPause is idempotent on an already cascade-paused queue', async () => {
    await queue.cascadedPause(DEFAULT_QUEUE_ID);
    const result = await queue.cascadedPause(DEFAULT_QUEUE_ID);
    expect(result.ok).toBe(true);
    expect(store.getProjectedQueueRegistry().entries.find((e) => e.id === DEFAULT_QUEUE_ID)?.pauseSource).toBe('cascade');
  });

  it('operator pause while cascade-paused promotes pauseSource to "operator"', async () => {
    await queue.cascadedPause(DEFAULT_QUEUE_ID);
    const result = await queue.setQueuePausedState(true, DEFAULT_QUEUE_ID);
    expect(result.ok).toBe(true);
    const entry = store.getProjectedQueueRegistry().entries.find((e) => e.id === DEFAULT_QUEUE_ID);
    expect(entry?.pauseSource).toBe('operator');
    // A subsequent cascadedResume MUST NOT clear the operator pause.
    await queue.cascadedResume(DEFAULT_QUEUE_ID);
    const after = store.getProjectedQueueRegistry().entries.find((e) => e.id === DEFAULT_QUEUE_ID);
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
