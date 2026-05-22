// Feature 063 — T008 — unit coverage for the confirmation-suppression
// memento accessors. Validates the FR-021 contract (per-action upsert)
// and the FR-022a invariant (Reset Workspace clears the suppression).
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIRM_SUPPRESSION_VERSION,
  KEYS,
  WorkspaceStateStore,
  type ConfirmSuppressionState,
  type Memento
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
  // Test helper to seed the memento with a malformed state.
  seedRaw(key: string, value: unknown): void {
    this.map.set(key, value);
  }
}

let memento: FakeMemento;
let store: WorkspaceStateStore;

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
});

describe('WorkspaceStateStore — confirmation suppression accessors (FR-021)', () => {
  it('returns an empty state when the memento is unset', () => {
    const state = store.getConfirmSuppression();
    expect(state.version).toBe(CONFIRM_SUPPRESSION_VERSION);
    expect(state.suppressedActionKeys).toEqual([]);
  });

  it('returns an empty state when the memento is malformed (non-object)', () => {
    memento.seedRaw(KEYS.confirmSuppression, 'not an object');
    expect(store.getConfirmSuppression().suppressedActionKeys).toEqual([]);
  });

  it('returns an empty state when the memento has wrong version', () => {
    memento.seedRaw(KEYS.confirmSuppression, {
      version: 999,
      suppressedActionKeys: ['queue.clean-all']
    });
    expect(store.getConfirmSuppression().suppressedActionKeys).toEqual([]);
  });

  it('returns an empty state when suppressedActionKeys is not an array', () => {
    memento.seedRaw(KEYS.confirmSuppression, {
      version: CONFIRM_SUPPRESSION_VERSION,
      suppressedActionKeys: 'queue.clean-all'
    });
    expect(store.getConfirmSuppression().suppressedActionKeys).toEqual([]);
  });

  it('filters out non-string and empty entries from a tampered memento', () => {
    memento.seedRaw(KEYS.confirmSuppression, {
      version: CONFIRM_SUPPRESSION_VERSION,
      suppressedActionKeys: ['queue.clean-all', '', 42, null, 'task.remove']
    });
    expect(store.getConfirmSuppression().suppressedActionKeys).toEqual([
      'queue.clean-all',
      'task.remove'
    ]);
  });

  it('upserts a single action key as suppressed', async () => {
    await store.setConfirmSuppression('queue.clean-all', true);
    expect(store.getConfirmSuppression().suppressedActionKeys).toEqual([
      'queue.clean-all'
    ]);
  });

  it('deduplicates when the same key is suppressed twice', async () => {
    await store.setConfirmSuppression('queue.clean-all', true);
    await store.setConfirmSuppression('queue.clean-all', true);
    expect(store.getConfirmSuppression().suppressedActionKeys).toEqual([
      'queue.clean-all'
    ]);
  });

  it('removes a key when suppressed=false', async () => {
    await store.setConfirmSuppression('queue.clean-all', true);
    await store.setConfirmSuppression('task.remove', true);
    await store.setConfirmSuppression('queue.clean-all', false);
    expect(store.getConfirmSuppression().suppressedActionKeys).toEqual([
      'task.remove'
    ]);
  });

  it('is idempotent when removing an absent key', async () => {
    await store.setConfirmSuppression('queue.clean-all', true);
    await store.setConfirmSuppression('task.never-added', false);
    expect(store.getConfirmSuppression().suppressedActionKeys).toEqual([
      'queue.clean-all'
    ]);
  });

  it('persists the version field on every write', async () => {
    await store.setConfirmSuppression('queue.clean-all', true);
    const persisted = memento.get<ConfirmSuppressionState>(KEYS.confirmSuppression);
    expect(persisted?.version).toBe(CONFIRM_SUPPRESSION_VERSION);
  });
});

describe('WorkspaceStateStore — Reset Workspace clears suppression (FR-022a)', () => {
  it('reset() removes the suppression memento entry', async () => {
    await store.setConfirmSuppression('queue.clean-all', true);
    await store.setConfirmSuppression('task.remove', true);
    expect(store.getConfirmSuppression().suppressedActionKeys).toHaveLength(2);

    await store.reset();

    // After reset, the memento entry is gone and the accessor returns the
    // empty state — the operator sees confirmation prompts again.
    expect(memento.get(KEYS.confirmSuppression)).toBeUndefined();
    expect(store.getConfirmSuppression().suppressedActionKeys).toEqual([]);
  });
});
