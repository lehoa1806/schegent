import { describe, it, expect } from 'vitest';
import { migrateV5ToV6, type V5State } from '../../../src/state/queue-state-migrator';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import type { QueueRegistry, QueueRegistryEntry } from '../../../src/queue/queue-registry';
import type { FeatureRequest, QueueState } from '../../../src/queue/feature-request';

const NOW = 1_700_000_000_000;
const UUID_HIGH = '11111111-2222-4333-8444-555555555555';
const UUID_BG = '99999999-8888-4777-9666-555555555555';

/**
 * A v5 registry entry, which carried the pause the migration inherits.
 *
 * FR-R3-011 removed `state` and `pauseSource` from `QueueRegistryEntry`, so the
 * fixture type re-adds them: the v5 *input* still has them on disk, and reading
 * the inherited pause off them is what this migration does. The v6 *output* no
 * longer carries them — the inherited pause lands on the queue record — which
 * is why the assertions below read `result.state.queueState`.
 */
type LegacyRegistryEntry = QueueRegistryEntry & {
  readonly state?: 'active' | 'manually-paused';
  readonly pauseSource?: 'operator' | 'cascade' | 'retry-cap' | null;
};

function entry(overrides: Partial<LegacyRegistryEntry>): QueueRegistryEntry {
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

function v5(state: { registry: QueueRegistry; queue: QueueState }): V5State {
  return {
    schemaVersion: 5,
    queueRegistry: state.registry,
    queueState: state.queue
  };
}

describe('migrateV5ToV6 (030)', () => {
  it('migrates a clean 3-queue state with mixed pending/in-flight tasks', () => {
    const registry: QueueRegistry = {
      entries: [
        entry({ id: DEFAULT_QUEUE_ID, position: 0, createdAt: 100, name: 'Default queue' }),
        entry({ id: UUID_HIGH, position: 1, createdAt: 200, name: 'High priority' }),
        entry({ id: UUID_BG, position: 2, createdAt: 300, name: 'Background' })
      ],
      updatedAt: 400
    };
    const queue: QueueState = {
      requests: [
        req({ id: 'r1', queueId: UUID_HIGH, position: 0, status: 'pending' }),
        req({ id: 'r2', queueId: UUID_HIGH, position: 1, status: 'pending' }),
        req({ id: 'r3', queueId: DEFAULT_QUEUE_ID, position: 0, status: 'in-flight' }),
        req({ id: 'r4', queueId: UUID_BG, position: 0, status: 'pending' })
      ],
      inFlightId: 'r3',
      paused: false,
      pausedReason: null,
      updatedAt: 400,
      queueLifecycle: 'running',
      pauseSource: null,
      scheduledStartAt: null,
      scheduledStartSource: null
    };
    const result = migrateV5ToV6(v5({ registry, queue }), NOW);

    expect(result.migrated).toBe(true);
    expect(result.state.schemaVersion).toBe(6);
    expect(result.state.queueRegistry.entries).toHaveLength(1);
    expect(result.state.queueRegistry.entries[0].id).toBe(DEFAULT_QUEUE_ID);
    // The unified queue is born unpaused, read off the queue record: FR-R3-011
    // moved the pause there, so the output entry carries no pause at all.
    expect(result.state.queueState.paused).toBe(false);
    expect(result.state.queueState.pauseSource).toBeNull();
    expect(result.state.queueRegistry.entries[0].schedule).toBeNull();
    expect(result.state.queueRegistry.entries[0].createdAt).toBe(100);

    // Order: in-flight (r3) first, then pending sorted by source createdAt
    // ascending then within-queue position ascending.
    const ids = result.state.queueState.requests.map((r) => r.id);
    expect(ids).toEqual(['r3', 'r1', 'r2', 'r4']);
    // All queueId rewritten.
    expect(result.state.queueState.requests.every((r) => r.queueId === DEFAULT_QUEUE_ID)).toBe(true);
    // Densely packed positions.
    expect(result.state.queueState.requests.map((r) => r.position)).toEqual([0, 1, 2, 3]);
    expect(result.state.queueState.inFlightId).toBe('r3');

    // Audit event.
    expect(result.auditEvents).toHaveLength(1);
    expect(result.auditEvents[0]).toEqual({
      type: 'state-migrated',
      fromVersion: 5,
      toVersion: 6,
      sourceQueueCount: 3,
      pendingTaskCount: 3,
      inFlightTaskCount: 1,
      inheritedPausedState: false,
      coalesceRule: 'createdAt-ascending'
    });
  });

  it('inherits manually-paused with pauseSource: operator if any source queue was paused', () => {
    const registry: QueueRegistry = {
      entries: [
        entry({ id: DEFAULT_QUEUE_ID, position: 0, createdAt: 100 }),
        entry({
          id: UUID_HIGH,
          position: 1,
          createdAt: 200,
          state: 'manually-paused',
          pauseSource: 'operator'
        }),
        entry({ id: UUID_BG, position: 2, createdAt: 300 })
      ],
      updatedAt: 400
    };
    const queue: QueueState = {
      requests: [
        req({ id: 'r1', queueId: UUID_HIGH, position: 0, status: 'pending' })
      ],
      inFlightId: null,
      paused: false,
      pausedReason: null,
      updatedAt: 400,
      queueLifecycle: 'active-empty',
      pauseSource: null,
      scheduledStartAt: null,
      scheduledStartSource: null
    };
    const result = migrateV5ToV6(v5({ registry, queue }), NOW);
    expect(result.state.queueState.pauseSource).toBe('operator');
    expect(result.state.queueState.paused).toBe(true);
    expect(result.auditEvents[0].inheritedPausedState).toBe(true);
  });

  it('preserves in-flight task details (pipeline-style fields pass through)', () => {
    const registry: QueueRegistry = {
      entries: [entry({ id: DEFAULT_QUEUE_ID, createdAt: 100 })],
      updatedAt: 100
    };
    const inFlight = req({
      id: 'r-in-flight',
      queueId: DEFAULT_QUEUE_ID,
      status: 'in-flight',
      pipelineId: 'speckit',
      runId: 'run-abc',
      pauseCause: null,
      retryCount: 2
    });
    const queue: QueueState = {
      requests: [inFlight],
      inFlightId: 'r-in-flight',
      paused: false,
      pausedReason: null,
      updatedAt: 100,
      queueLifecycle: 'running',
      pauseSource: null,
      scheduledStartAt: null,
      scheduledStartSource: null
    };
    const result = migrateV5ToV6(v5({ registry, queue }), NOW);
    const moved = result.state.queueState.requests.find((r) => r.id === 'r-in-flight');
    expect(moved).toBeDefined();
    expect(moved?.pipelineId).toBe('speckit');
    expect(moved?.runId).toBe('run-abc');
    expect(moved?.retryCount).toBe(2);
    expect(moved?.status).toBe('in-flight');
  });

  it('coalesces pending tasks ordered by source createdAt then within-queue position', () => {
    const registry: QueueRegistry = {
      entries: [
        entry({ id: DEFAULT_QUEUE_ID, position: 0, createdAt: 300, name: 'Default queue' }),
        entry({ id: UUID_HIGH, position: 1, createdAt: 100, name: 'High priority' }),
        entry({ id: UUID_BG, position: 2, createdAt: 200, name: 'Background' })
      ],
      updatedAt: 400
    };
    const queue: QueueState = {
      requests: [
        req({ id: 'd-2', queueId: DEFAULT_QUEUE_ID, position: 1 }),
        req({ id: 'd-1', queueId: DEFAULT_QUEUE_ID, position: 0 }),
        req({ id: 'high-1', queueId: UUID_HIGH, position: 0 }),
        req({ id: 'bg-1', queueId: UUID_BG, position: 0 }),
        req({ id: 'high-0', queueId: UUID_HIGH, position: -1 })
      ],
      inFlightId: null,
      paused: false,
      pausedReason: null,
      updatedAt: 400,
      queueLifecycle: 'active-empty',
      pauseSource: null,
      scheduledStartAt: null,
      scheduledStartSource: null
    };
    const result = migrateV5ToV6(v5({ registry, queue }), NOW);
    // Ordering: high (createdAt 100) → bg (200) → default (300). Within each
    // group sort by position ascending.
    const ids = result.state.queueState.requests.map((r) => r.id);
    expect(ids).toEqual(['high-0', 'high-1', 'bg-1', 'd-1', 'd-2']);
  });

  it('is idempotent on already-v6 input (no audit event)', () => {
    const registry: QueueRegistry = {
      entries: [entry({ id: DEFAULT_QUEUE_ID })],
      updatedAt: NOW
    };
    const queue: QueueState = {
      requests: [],
      inFlightId: null,
      paused: false,
      pausedReason: null,
      updatedAt: NOW,
      queueLifecycle: 'active-empty',
      pauseSource: null,
      scheduledStartAt: null,
      scheduledStartSource: null
    };
    const result = migrateV5ToV6(
      { schemaVersion: 6, queueRegistry: registry, queueState: queue },
      NOW
    );
    expect(result.migrated).toBe(false);
    expect(result.auditEvents).toEqual([]);
    expect(result.state.queueRegistry).toBe(registry);
    expect(result.state.queueState).toBe(queue);
  });

  it('handles empty registry / zero tasks edge case', () => {
    const result = migrateV5ToV6(
      { schemaVersion: 5, queueRegistry: null, queueState: null },
      NOW
    );
    expect(result.migrated).toBe(true);
    expect(result.state.queueRegistry.entries).toHaveLength(1);
    expect(result.state.queueRegistry.entries[0].id).toBe(DEFAULT_QUEUE_ID);
    expect(result.state.queueState.paused).toBe(false);
    expect(result.state.queueState.requests).toEqual([]);
    expect(result.state.queueState.inFlightId).toBeNull();
    expect(result.auditEvents[0]).toMatchObject({
      sourceQueueCount: 0,
      pendingTaskCount: 0,
      inFlightTaskCount: 0,
      inheritedPausedState: false
    });
  });

  it('defensively demotes extra in-flight tasks to pending when multiple are present', () => {
    const registry: QueueRegistry = {
      entries: [
        entry({ id: DEFAULT_QUEUE_ID, position: 0, createdAt: 100 }),
        entry({ id: UUID_HIGH, position: 1, createdAt: 200 })
      ],
      updatedAt: 300
    };
    const queue: QueueState = {
      requests: [
        req({ id: 'rA', queueId: DEFAULT_QUEUE_ID, status: 'in-flight' }),
        req({ id: 'rB', queueId: UUID_HIGH, status: 'in-flight' })
      ],
      inFlightId: 'rA',
      paused: false,
      pausedReason: null,
      updatedAt: 300,
      queueLifecycle: 'running',
      pauseSource: null,
      scheduledStartAt: null,
      scheduledStartSource: null
    };
    const result = migrateV5ToV6(v5({ registry, queue }), NOW);
    const statuses = new Map(
      result.state.queueState.requests.map((r) => [r.id, r.status])
    );
    // rA stays in-flight (default queue createdAt 100 < high 200).
    expect(statuses.get('rA')).toBe('in-flight');
    expect(statuses.get('rB')).toBe('pending');
    expect(result.state.queueState.inFlightId).toBe('rA');
    expect(result.auditEvents[0].inFlightTaskCount).toBe(1);
    expect(result.auditEvents[0].pendingTaskCount).toBe(1);
  });

  it('emits the state-migrated audit event with the documented shape', () => {
    const registry: QueueRegistry = {
      entries: [
        entry({ id: DEFAULT_QUEUE_ID, position: 0, createdAt: 100 }),
        entry({ id: UUID_HIGH, position: 1, createdAt: 200 })
      ],
      updatedAt: 300
    };
    const queue: QueueState = {
      requests: [
        req({ id: 'r1', queueId: UUID_HIGH, status: 'pending', position: 0 })
      ],
      inFlightId: null,
      paused: false,
      pausedReason: null,
      updatedAt: 300,
      queueLifecycle: 'active-empty',
      pauseSource: null,
      scheduledStartAt: null,
      scheduledStartSource: null
    };
    const result = migrateV5ToV6(v5({ registry, queue }), NOW);
    expect(result.auditEvents).toHaveLength(1);
    const ev = result.auditEvents[0];
    expect(ev.type).toBe('state-migrated');
    expect(ev.fromVersion).toBe(5);
    expect(ev.toVersion).toBe(6);
    expect(ev.coalesceRule).toBe('createdAt-ascending');
    expect(typeof ev.sourceQueueCount).toBe('number');
    expect(typeof ev.pendingTaskCount).toBe('number');
    expect(typeof ev.inFlightTaskCount).toBe('number');
    expect(typeof ev.inheritedPausedState).toBe('boolean');
  });
});
