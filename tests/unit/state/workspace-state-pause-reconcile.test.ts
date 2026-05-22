// Feature 030 BUG-001 follow-on — startup reconciliation for divergent v6
// pause state. Once a user persisted the BUG-001 stuck state to disk
// (legacy `QueueState.paused === true` while
// `QueueRegistry.entries[0].state === 'active'`), no automatic
// reconciliation existed. The submit gate reads the legacy boolean and
// refuses tasks; the Resume button is a no-op against the already-active
// registry. The store self-heals at activation by adopting the registry
// as authoritative.

import { describe, it, expect } from 'vitest';
import {
  KEYS,
  SCHEMA_VERSION,
  WorkspaceStateStore,
  type Memento
} from '../../../src/state/workspace-state';
import { STATE_SCHEMA_VERSION } from '../../../src/contracts/state-schema';
import {
  DEFAULT_QUEUE_ID,
  type QueueRegistry,
  type QueueRegistryEntry
} from '../../../src/queue/queue-registry';
import type { QueueState } from '../../../src/queue/feature-request';

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

function entry(overrides: Partial<QueueRegistryEntry>): QueueRegistryEntry {
  return {
    id: DEFAULT_QUEUE_ID,
    name: 'Default queue',
    position: 0,
    state: 'active',
    pauseSource: null,
    schedule: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  } as QueueRegistryEntry;
}

function makeQueueState(paused: boolean, pausedReason: string | null = null): QueueState {
  return {
    requests: [],
    inFlightId: null,
    paused,
    pausedReason,
    updatedAt: NOW,
    queueLifecycle: paused ? 'operator-paused' : 'active-empty',
    scheduledStartAt: null,
    scheduledStartSource: null
  };
}

function seedV6(memento: FakeMemento, queue: QueueState, registry: QueueRegistry): void {
  // Persist as already-v6 so no migration runs at activation.
  void memento.update(KEYS.schemaVersion, SCHEMA_VERSION);
  void memento.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION);
  void memento.update(KEYS.queue, queue);
  void memento.update(KEYS.queueRegistry, registry);
  void memento.update(KEYS.queueDefaultId, DEFAULT_QUEUE_ID);
}

describe('WorkspaceStateStore — BUG-001 startup pause-state reconciliation', () => {
  it('reconciles divergent v6 state: legacy paused=true + registry=active → both cleared', async () => {
    const memento = new FakeMemento();
    seedV6(
      memento,
      makeQueueState(true, 'retry-cap-exhausted:r-old'),
      { entries: [entry({ state: 'active', pauseSource: null })], updatedAt: NOW }
    );
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    expect(store.getQueue().paused).toBe(false);
    expect(store.getQueue().pausedReason).toBeNull();
    expect(store.getQueueRegistry().entries[0]?.state).toBe('active');
    expect(store.getQueueRegistry().entries[0]?.pauseSource).toBeNull();
  });

  it('reconciles inverse divergence: legacy paused=false + registry=manually-paused → legacy set to true', async () => {
    const memento = new FakeMemento();
    seedV6(
      memento,
      makeQueueState(false, null),
      {
        entries: [entry({ state: 'manually-paused', pauseSource: 'operator' })],
        updatedAt: NOW
      }
    );
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    expect(store.getQueue().paused).toBe(true);
    expect(store.getQueueRegistry().entries[0]?.state).toBe('manually-paused');
    expect(store.getQueueRegistry().entries[0]?.pauseSource).toBe('operator');
  });

  it('leaves consistent paused state untouched (both true)', async () => {
    const memento = new FakeMemento();
    const consistentPaused = makeQueueState(true, 'operator-paused');
    seedV6(
      memento,
      consistentPaused,
      {
        entries: [entry({ state: 'manually-paused', pauseSource: 'operator' })],
        updatedAt: NOW
      }
    );
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    expect(store.getQueue().paused).toBe(true);
    expect(store.getQueue().pausedReason).toBe('operator-paused');
    expect(store.getQueueRegistry().entries[0]?.state).toBe('manually-paused');
  });

  it('leaves consistent active state untouched (both false)', async () => {
    const memento = new FakeMemento();
    seedV6(
      memento,
      makeQueueState(false, null),
      { entries: [entry({ state: 'active', pauseSource: null })], updatedAt: NOW }
    );
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    expect(store.getQueue().paused).toBe(false);
    expect(store.getQueueRegistry().entries[0]?.state).toBe('active');
  });

  it('is idempotent — second initialize() does not re-reconcile a now-consistent state', async () => {
    const memento = new FakeMemento();
    seedV6(
      memento,
      makeQueueState(true, 'retry-cap-exhausted:r-old'),
      { entries: [entry({ state: 'active', pauseSource: null })], updatedAt: NOW }
    );
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    expect(store.getQueue().paused).toBe(false);
    const result2 = await store.initialize();
    expect(store.getQueue().paused).toBe(false);
    // Second pass: no migration, no reconciliation needed.
    expect(result2.migrated).toBe(false);
  });
});
