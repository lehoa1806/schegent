// Feature 030 — Phase 3 (US1) integration test for the v5 → v6
// single-queue migration.
//
// Three sub-scenarios:
//   (a) synthetic v5 state (3 source queues, 1 in-flight + 4 pending,
//       one source queue manually-paused) → unified queue migrates with
//       expected ordering and pause inheritance; the `state-migrated`
//       audit event lands in the writer with the canonical payload.
//   (b) fresh workspace, no legacy state → unified queue is born clean;
//       NO `state-migrated` audit event is emitted (SC-005).
//   (c) historical `.schegent/audit.log` entries are NOT rewritten by
//       the migration — pre-existing audit lines are preserved
//       byte-identical (FR-016).
//
// The test exercises the persistence + audit emit path the way
// `extension.ts` activation does: `store.initialize()` returns the
// migration audit events; the caller forwards them through
// `auditWriter.append`. This isolates US1 behavior from the larger
// activation graph.

import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  KEYS,
  SCHEMA_VERSION,
  WorkspaceStateStore,
  type Memento
} from '../../src/state/workspace-state';
import {
  type QueueRegistry,
  type QueueRegistryEntry
} from '../../src/queue/queue-registry';
import type { FeatureRequest, QueueState } from '../../src/queue/feature-request';
import { STATE_SCHEMA_VERSION } from '../../src/contracts/state-schema';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../src/lib/logger';
import type { AuditEntry } from '../../src/audit/audit-entry';

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

const UUID_HIGH = '11111111-2222-4333-8444-555555555555';
const UUID_BG = '99999999-8888-4777-9666-555555555555';
const NOW = 1_700_000_000_000;

/**
 * A pre-collapse registry entry — `state` and `pauseSource` included.
 *
 * FR-R3-011 removed both fields from `QueueRegistryEntry`, but a v5 store on
 * disk still has them and the v5 → v6 migration under test reads the inherited
 * pause off exactly those fields. The fixture type keeps them writable so the
 * seed stays the shape the migration was written against; the resulting
 * `QueueRegistryEntry` cast is what hands it to the store as persisted state.
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

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-030-mig-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('Feature 030 (US1, T020) — v5 → v6 single-queue migration end-to-end', () => {
  it('migrates 3 source queues with mixed pending/in-flight tasks and emits state-migrated', async () => {
    const memento = new FakeMemento();
    // Seed a v5-shaped persisted state.
    await memento.update(KEYS.schemaVersion, SCHEMA_VERSION);
    await memento.update(KEYS.schemaVersionNumeric, 5);
    const v5Registry: QueueRegistry = {
      entries: [
        entry({ id: DEFAULT_QUEUE_ID, position: 0, createdAt: 100, name: 'Default queue' }),
        entry({
          id: UUID_HIGH,
          position: 1,
          createdAt: 200,
          name: 'High priority',
          state: 'manually-paused',
          pauseSource: 'operator'
        }),
        entry({ id: UUID_BG, position: 2, createdAt: 300, name: 'Background' })
      ],
      updatedAt: 400
    };
    const v5Queue: QueueState = {
      requests: [
        req({ id: 'r-in-flight', queueId: DEFAULT_QUEUE_ID, position: 0, status: 'in-flight', startedAt: 150 }),
        // 4 pending across 2 non-default queues. createdAt-ascending puts
        // HIGH (200) before BG (300); within-queue position determines order.
        req({ id: 'r-high-1', queueId: UUID_HIGH, position: 0, status: 'pending' }),
        req({ id: 'r-high-2', queueId: UUID_HIGH, position: 1, status: 'pending' }),
        req({ id: 'r-bg-1', queueId: UUID_BG, position: 0, status: 'pending' }),
        req({ id: 'r-bg-2', queueId: UUID_BG, position: 1, status: 'pending' })
      ],
      inFlightId: 'r-in-flight',
      paused: false,
      pausedReason: null,
      updatedAt: 400,
      queueLifecycle: 'running',
      pauseSource: null,
      scheduledStartAt: null,
      scheduledStartSource: null
    };
    await memento.update(KEYS.queueRegistry, v5Registry);
    await memento.update(KEYS.queue, v5Queue);

    const store = new WorkspaceStateStore(memento);
    const initResult = await store.initialize();

    // Migration ran and produced exactly one state-migrated event.
    expect(initResult.migrated).toBe(true);
    expect(initResult.v6MigrationEvents).toHaveLength(1);
    expect(initResult.v6MigrationEvents[0]).toMatchObject({
      type: 'state-migrated',
      fromVersion: 5,
      toVersion: 6,
      sourceQueueCount: 3,
      pendingTaskCount: 4,
      inFlightTaskCount: 1,
      inheritedPausedState: true,
      coalesceRule: 'createdAt-ascending'
    });

    // Registry has exactly one entry; id === 'default'; state inherited.
    const registry = store.getProjectedQueueRegistry();
    expect(registry.entries).toHaveLength(1);
    expect(registry.entries[0].id).toBe(DEFAULT_QUEUE_ID);
    expect(registry.entries[0].state).toBe('manually-paused');
    expect(registry.entries[0].pauseSource).toBe('operator');
    expect(registry.entries[0].schedule).toBeNull();

    // The in-flight task is preserved (status + identity).
    const queueState = store.getQueue(DEFAULT_QUEUE_ID);
    expect(queueState.inFlightId).toBe('r-in-flight');
    const inFlightRow = queueState.requests.find((r) => r.id === 'r-in-flight');
    expect(inFlightRow?.status).toBe('in-flight');
    expect(inFlightRow?.queueId).toBe(DEFAULT_QUEUE_ID);

    // Pending tasks ordered by source-queue createdAt ascending,
    // then within-queue position ascending. The in-flight row sits at
    // position 0 and the pending rows are positioned densely after it.
    const pendingIds = queueState.requests
      .filter((r) => r.status === 'pending')
      .sort((a, b) => a.position - b.position)
      .map((r) => r.id);
    expect(pendingIds).toEqual(['r-high-1', 'r-high-2', 'r-bg-1', 'r-bg-2']);

    // All requests are routed to the default queue post-migration.
    expect(queueState.requests.every((r) => r.queueId === DEFAULT_QUEUE_ID)).toBe(true);

    // Feature 092 (T017) — the chain does not stop at v6. A v5 workspace is
    // carried all the way to the shipped version, and what lands under
    // `KEYS.queue` is the v10 map keyed by queue id, not the v6 singleton.
    // Asserted against the raw memento because `store.getQueue()` resolves
    // the default key either way and would hide the shape.
    expect(memento.get<number>(KEYS.schemaVersionNumeric)).toBe(STATE_SCHEMA_VERSION);
    const persisted = memento.get<Record<string, QueueState>>(KEYS.queue);
    expect(Object.keys(persisted ?? {})).toEqual([DEFAULT_QUEUE_ID]);
    expect(persisted?.[DEFAULT_QUEUE_ID].requests.map((r) => r.id)).toEqual(
      queueState.requests.map((r) => r.id)
    );

    // Now exercise the activation-time audit emit path the way
    // extension.ts does: forward each v6MigrationEvent through
    // auditWriter.append. The writer should produce a single audit entry
    // with eventType: 'state-migrated' and a `phase: 'state-migration'`.
    const logger = new SanitizedLogger();
    const audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, logger);
    const emitted: AuditEntry[] = [];
    const sub = audit.subscribe((e) => emitted.push(e));
    for (const event of initResult.v6MigrationEvents) {
      await audit.append({
        runId: '',
        phase: 'state-migration',
        iteration: 0,
        eventType: event.type,
        payload: {
          fromVersion: event.fromVersion,
          toVersion: event.toVersion,
          sourceQueueCount: event.sourceQueueCount,
          pendingTaskCount: event.pendingTaskCount,
          inFlightTaskCount: event.inFlightTaskCount,
          inheritedPausedState: event.inheritedPausedState,
          coalesceRule: event.coalesceRule
        },
        outcome: 'success'
      });
    }
    sub.dispose();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].eventType).toBe('state-migrated');
    expect(emitted[0].phase).toBe('state-migration');
    expect(emitted[0].payload).toMatchObject({
      fromVersion: 5,
      toVersion: 6,
      sourceQueueCount: 3,
      pendingTaskCount: 4,
      inFlightTaskCount: 1,
      inheritedPausedState: true,
      coalesceRule: 'createdAt-ascending'
    });

    // The audit log file on disk also reflects the emit.
    const auditLogBody = await fs.readFile(audit.logPath, 'utf8');
    expect(auditLogBody).toContain('"state-migrated"');
    expect(auditLogBody).toContain('"sourceQueueCount":3');
    expect(auditLogBody).toContain('"inheritedPausedState":true');
  });

  it('fresh workspace (no legacy state) emits NO state-migrated audit event (SC-005)', async () => {
    const memento = new FakeMemento();
    const store = new WorkspaceStateStore(memento);
    const initResult = await store.initialize();

    // A fresh workspace lands directly on the v6 default shape — no migration runs.
    expect(initResult.v6MigrationEvents).toEqual([]);

    // The single-queue UI projection is available: registry has exactly one
    // entry with id === 'default' and the queue is active (the v6 default).
    const registry = store.getProjectedQueueRegistry();
    expect(registry.entries).toHaveLength(1);
    expect(registry.entries[0].id).toBe(DEFAULT_QUEUE_ID);
    expect(registry.entries[0].state).toBe('active');
    expect(registry.entries[0].pauseSource).toBeNull();

    // Confirm the audit writer never produces a state-migrated entry.
    const logger = new SanitizedLogger();
    const audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, logger);
    const emitted: AuditEntry[] = [];
    const sub = audit.subscribe((e) => emitted.push(e));
    for (const event of initResult.v6MigrationEvents) {
      await audit.append({
        runId: '',
        phase: 'state-migration',
        iteration: 0,
        eventType: event.type,
        payload: {
          fromVersion: event.fromVersion,
          toVersion: event.toVersion,
          sourceQueueCount: event.sourceQueueCount,
          pendingTaskCount: event.pendingTaskCount,
          inFlightTaskCount: event.inFlightTaskCount,
          inheritedPausedState: event.inheritedPausedState,
          coalesceRule: event.coalesceRule
        },
        outcome: 'success'
      });
    }
    sub.dispose();
    expect(emitted).toEqual([]);
    // No audit.log file should have been created either.
    await expect(fs.access(audit.logPath)).rejects.toThrow();
  });

  it('historical .schegent/audit.log entries are NOT rewritten by the migration (FR-016)', async () => {
    // Seed an existing audit.log with two arbitrary entries BEFORE the migration runs.
    const auditDir = path.join(tmpRoot, '.schegent');
    await fs.mkdir(auditDir, { recursive: true });
    const auditPath = path.join(auditDir, 'audit.log');
    const preMigrationBody =
      JSON.stringify({ id: 'pre-1', timestamp: '2025-01-01T00:00:00.000Z', eventType: 'task-enqueued' }) +
      '\n' +
      JSON.stringify({ id: 'pre-2', timestamp: '2025-01-01T00:01:00.000Z', eventType: 'phase-completed' }) +
      '\n';
    await fs.writeFile(auditPath, preMigrationBody, 'utf8');
    const preBytes = await fs.readFile(auditPath);

    // Seed a v5 persisted state with one source queue and one pending task.
    const memento = new FakeMemento();
    await memento.update(KEYS.schemaVersion, SCHEMA_VERSION);
    await memento.update(KEYS.schemaVersionNumeric, 5);
    const v5Registry: QueueRegistry = {
      entries: [
        entry({ id: DEFAULT_QUEUE_ID, position: 0, createdAt: 100 }),
        entry({ id: UUID_HIGH, position: 1, createdAt: 200, name: 'High priority' })
      ],
      updatedAt: 200
    };
    const v5Queue: QueueState = {
      requests: [req({ id: 'r1', queueId: UUID_HIGH, position: 0, status: 'pending' })],
      inFlightId: null,
      paused: false,
      pausedReason: null,
      updatedAt: 200,
      queueLifecycle: 'active-empty',
      pauseSource: null,
      scheduledStartAt: null,
      scheduledStartSource: null
    };
    await memento.update(KEYS.queueRegistry, v5Registry);
    await memento.update(KEYS.queue, v5Queue);

    const store = new WorkspaceStateStore(memento);
    const initResult = await store.initialize();
    expect(initResult.v6MigrationEvents).toHaveLength(1);

    // The migration MUST NOT rewrite the historical audit log file.
    // The bytes on disk before initialize() must match the bytes after
    // — the migrator never touches `.schegent/audit.log`. Only the
    // activation-time audit append (which we do NOT invoke here) would
    // append new lines; the migrator itself is fs-free.
    const postBytes = await fs.readFile(auditPath);
    expect(postBytes.equals(preBytes)).toBe(true);
  });
});
