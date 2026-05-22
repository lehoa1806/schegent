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
import type { FeatureRequest, QueueState } from '../../../src/queue/feature-request';

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
  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.map.entries());
  }
}

const NOW = 1_700_000_000_000;
const UUID_A = '11111111-2222-4333-8444-555555555555';
const UUID_B = '99999999-8888-4777-9666-555555555555';

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

function req(overrides: Partial<FeatureRequest>): FeatureRequest {
  return {
    id: 'r-default',
    description: 'sample',
    enqueuedAt: NOW,
    createdAt: NOW,
    startedAt: null,
    updatedAt: NOW,
    completedAt: null,
    status: 'pending',
    queueId: DEFAULT_QUEUE_ID,
    position: 0,
    pauseCause: null,
    runId: null,
    retryCount: 0,
    lastError: null,
    pausedReason: null,
    ...overrides
  } as FeatureRequest;
}

describe('WorkspaceStateStore — v6 roundtrip (030 T008/T009)', () => {
  it('migrates a synthetic v5 state to v6 on activation', async () => {
    const memento = new FakeMemento();
    // Seed a v5-shaped persisted state: schemaVersion strings present, two
    // source queues with pending tasks, no in-flight task.
    await memento.update(KEYS.schemaVersion, SCHEMA_VERSION);
    await memento.update(KEYS.schemaVersionNumeric, 5);
    const v5Registry: QueueRegistry = {
      entries: [
        entry({ id: DEFAULT_QUEUE_ID, position: 0, createdAt: 100 }),
        entry({
          id: UUID_A,
          position: 1,
          createdAt: 200,
          name: 'High priority',
          state: 'manually-paused',
          pauseSource: 'operator'
        }),
        entry({ id: UUID_B, position: 2, createdAt: 300, name: 'Background' })
      ],
      updatedAt: 400
    };
    const v5Queue: QueueState = {
      requests: [
        req({ id: 'r1', queueId: UUID_A, position: 0 }),
        req({ id: 'r2', queueId: UUID_A, position: 1 }),
        req({ id: 'r3', queueId: UUID_B, position: 0 })
      ],
      inFlightId: null,
      paused: false,
      pausedReason: null,
      updatedAt: 400,
      queueLifecycle: 'active-empty',
      scheduledStartAt: null,
      scheduledStartSource: null
    };
    await memento.update(KEYS.queueRegistry, v5Registry);
    await memento.update(KEYS.queue, v5Queue);

    const store = new WorkspaceStateStore(memento);
    const result = await store.initialize();

    expect(result.v6MigrationEvents).toHaveLength(1);
    expect(result.v6MigrationEvents[0]).toMatchObject({
      type: 'state-migrated',
      fromVersion: 5,
      toVersion: 6,
      sourceQueueCount: 3,
      pendingTaskCount: 3,
      inFlightTaskCount: 0,
      inheritedPausedState: true,
      coalesceRule: 'createdAt-ascending'
    });
    // Persisted registry shape is the v6 single-entry shape.
    const persistedRegistry = memento.get<QueueRegistry>(KEYS.queueRegistry);
    expect(persistedRegistry?.entries).toHaveLength(1);
    expect(persistedRegistry?.entries[0].id).toBe(DEFAULT_QUEUE_ID);
    expect(persistedRegistry?.entries[0].state).toBe('manually-paused');
    expect(persistedRegistry?.entries[0].pauseSource).toBe('operator');
    expect(persistedRegistry?.entries[0].schedule).toBeNull();
    // The persisted queue state's requests are all on the unified queue.
    const persistedQueue = memento.get<QueueState>(KEYS.queue);
    expect(persistedQueue?.requests.every((r) => r.queueId === DEFAULT_QUEUE_ID)).toBe(true);
    expect(persistedQueue?.requests.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
    // Numeric schema version is now 6.
    expect(memento.get<number>(KEYS.schemaVersionNumeric)).toBe(STATE_SCHEMA_VERSION);
  });

  it('is idempotent on a second activation', async () => {
    const memento = new FakeMemento();
    await memento.update(KEYS.schemaVersion, SCHEMA_VERSION);
    await memento.update(KEYS.schemaVersionNumeric, 5);
    const v5Registry: QueueRegistry = {
      entries: [
        entry({ id: DEFAULT_QUEUE_ID, position: 0, createdAt: 100 }),
        entry({ id: UUID_A, position: 1, createdAt: 200, name: 'Other' })
      ],
      updatedAt: 100
    };
    const v5Queue: QueueState = {
      requests: [req({ id: 'r1', queueId: UUID_A, position: 0 })],
      inFlightId: null,
      paused: false,
      pausedReason: null,
      updatedAt: 100,
      queueLifecycle: 'active-empty',
      scheduledStartAt: null,
      scheduledStartSource: null
    };
    await memento.update(KEYS.queueRegistry, v5Registry);
    await memento.update(KEYS.queue, v5Queue);

    const store1 = new WorkspaceStateStore(memento);
    const result1 = await store1.initialize();
    expect(result1.v6MigrationEvents).toHaveLength(1);

    // Second activation on the now-v6 state: must not re-emit.
    const store2 = new WorkspaceStateStore(memento);
    const result2 = await store2.initialize();
    expect(result2.v6MigrationEvents).toEqual([]);
    expect(result2.migrated).toBe(false);
  });

  it('rewrites WorkflowRun.queueId to default when present', async () => {
    const memento = new FakeMemento();
    await memento.update(KEYS.schemaVersion, SCHEMA_VERSION);
    await memento.update(KEYS.schemaVersionNumeric, 5);
    const v5Registry: QueueRegistry = {
      entries: [
        entry({ id: DEFAULT_QUEUE_ID, createdAt: 100 }),
        entry({ id: UUID_A, position: 1, createdAt: 200, name: 'X' })
      ],
      updatedAt: 200
    };
    await memento.update(KEYS.queueRegistry, v5Registry);
    await memento.update(KEYS.queue, {
      requests: [],
      inFlightId: null,
      paused: false,
      pausedReason: null,
      updatedAt: 200,
      queueLifecycle: 'active-empty',
      scheduledStartAt: null,
      scheduledStartSource: null
    } satisfies QueueState);
    // Synthetic run with a non-default queueId; only that field is asserted.
    await memento.update(KEYS.run, {
      id: 'run-1',
      featureId: 'feat-1',
      queueId: UUID_A,
      delayedRetryCount: 0,
      pendingRetryAt: null,
      pendingRetryCause: null,
      phaseOverrides: [],
      manualPauseAt: null,
      manualPauseCause: null,
      phaseBreakpoints: [],
      resumeTargetPhaseId: null
    });
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    const persistedRun = memento.get<{ queueId?: string }>(KEYS.run);
    expect(persistedRun?.queueId).toBe(DEFAULT_QUEUE_ID);
  });

  it('emits no migration event on a fresh workspace (no prior state)', async () => {
    const memento = new FakeMemento();
    const store = new WorkspaceStateStore(memento);
    const result = await store.initialize();
    // Fresh workspaces never produce a state-migrated v6 event — the v6
    // shape is the default for new persisted registries.
    expect(result.v6MigrationEvents).toEqual([]);
  });
});
