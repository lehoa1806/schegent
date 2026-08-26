// Feature 093 (T013) — the v10 → v11 migration as the **audit log** sees it.
//
// Defect D2 is the reason this file exists. Feature 092's migrator produces
// `v10MigrationEvents`, `initialize()` returns them from all four branches, and
// nothing ever consumes them: `extension.ts` destructures three of the four
// fields and `migration-audit-forwarder.ts` has no v10 case. Every unit test
// passed, because every unit test asserted the migrator *returned* events. The
// gap was between the return and the writer, and only a test that spans both
// ends can see it.
//
// So these tests start at the store and end at an `AuditLogWriter` double. A
// migrator-level assertion is not a substitute and is deliberately not repeated
// here — `run-state-migrator-v10-to-v11.test.ts` already owns that.

import { describe, it, expect, beforeEach } from 'vitest';
import { KEYS, SCHEMA_VERSION, WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import { STATE_SCHEMA_VERSION_V10 } from '../../../src/contracts/state-schema';
import { forwardMigrationAuditEvents } from '../../../src/state/migration-audit-forwarder';
import { isKnownAuditEventType } from '../../../src/contracts/audit-events';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import type { QueueState } from '../../../src/queue/feature-request';
import type { AuditEntry } from '../../../src/audit/audit-entry';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import {
  buildQueueRegistry,
  buildV9QueueState,
  buildWorkflowRun,
  fixtureQueueId
} from '../../fixtures/state/queue-fixtures';

const OTHER_QUEUE = fixtureQueueId(2);

function taskIdFor(queueId: string): string {
  return `${queueId}-task`;
}

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

  seed(key: string, value: unknown): void {
    this.map.set(key, value);
  }
}

/**
 * Records what reached the writer, and can be told to reject.
 *
 * The signature mirrors `AuditLogWriter.append` exactly — including the
 * `AuditEntry` it resolves with — rather than the looser
 * `(Record<string, unknown>) => Promise<void>` a double is tempted into. The
 * forwarder's parameter is `Pick<AuditLogWriter, 'append'>`, so a double that
 * narrows the return type is not the thing production calls, and the test would
 * be asserting against a contract nothing implements.
 */
class RecordingAuditWriter {
  public readonly appended: Omit<AuditEntry, 'id' | 'timestamp'>[] = [];
  public rejectWith: Error | null = null;

  append(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> {
    if (this.rejectWith) return Promise.reject(this.rejectWith);
    this.appended.push(entry);
    return Promise.resolve({
      ...entry,
      id: `audit-${this.appended.length}`,
      timestamp: new Date(0).toISOString()
    });
  }
}

class RecordingLogger {
  public readonly warnings: string[] = [];

  warn(message: string): void {
    this.warnings.push(message);
  }
}

function seedV10Workspace(memento: FakeMemento, run: WorkflowRun): void {
  const registry = buildQueueRegistry({ count: 2, defaultAtPosition: 0 });
  const queueMap: Record<string, QueueState> = {};
  for (const entry of registry.entries) {
    const state = buildV9QueueState({ pendingCount: 1 });
    queueMap[entry.id] = {
      ...state,
      queueLifecycle: 'idle-pending',
      pauseSource: null,
      requests: state.requests.map((request) => ({
        ...request,
        id: taskIdFor(entry.id),
        queueId: entry.id
      }))
    };
  }
  memento.seed(KEYS.queueRegistry, registry);
  memento.seed(KEYS.queueDefaultId, DEFAULT_QUEUE_ID);
  memento.seed(KEYS.queue, queueMap);
  memento.seed(KEYS.run, run);
  memento.seed(KEYS.schemaVersion, SCHEMA_VERSION);
  memento.seed(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION_V10);
}

/** Migrate a seeded v10 workspace and forward whatever it produced. */
async function migrateAndForward(
  memento: FakeMemento,
  writer: RecordingAuditWriter,
  logger: RecordingLogger
): Promise<void> {
  const result = await new WorkspaceStateStore(memento).initialize();
  await forwardMigrationAuditEvents(
    {
      v6MigrationEvents: result.v6MigrationEvents,
      v7MigrationEvents: result.v7MigrationEvents,
      v11MigrationEvents: result.v11MigrationEvents,
      // Deliberately empty rather than `result.v12MigrationEvents`. Seeding a v10
      // workspace also trips the v11 → v12 history partition, and forwarding both
      // would make every count assertion below a statement about two migrations
      // at once. The v12 half has its own end-to-end file
      // (`migration-audit-forwarder-v12.test.ts`) so neither is asserted through
      // the other.
      v12MigrationEvents: [],
      runRepairEvents: result.runRepairEvents
    },
    writer,
    logger
  );
}

let memento: FakeMemento;
let writer: RecordingAuditWriter;
let logger: RecordingLogger;

beforeEach(() => {
  memento = new FakeMemento();
  writer = new RecordingAuditWriter();
  logger = new RecordingLogger();
});

describe('the v10 → v11 reshape reaches the audit writer (T013, defect D2)', () => {
  it('appends a state-migrated-v10-to-v11 entry', async () => {
    seedV10Workspace(memento, buildWorkflowRun({ featureId: taskIdFor(OTHER_QUEUE) }));

    await migrateAndForward(memento, writer, logger);

    const reshape = writer.appended.find((e) => e.eventType === 'state-migrated-v10-to-v11');
    expect(reshape).toBeDefined();
    expect(reshape).toMatchObject({ phase: 'state-migration', iteration: 0, outcome: 'success' });
    expect(reshape?.payload).toMatchObject({ fromVersion: 10, toVersion: 11, runCount: 1 });
  });

  /**
   * The migration belongs to no Run — it runs before any Run is driven — so
   * every entry correlates on the empty `runId`, including the reassign event
   * that names a Run in its payload. Splitting the correlation key across the
   * three shapes would split one migration across two views of the log.
   */
  it('correlates every entry on the empty runId', async () => {
    seedV10Workspace(memento, buildWorkflowRun({ id: 'run-orphan', featureId: 'task-nowhere' }));

    await migrateAndForward(memento, writer, logger);

    expect(writer.appended).toHaveLength(2);
    expect(writer.appended.map((e) => e.runId)).toEqual(['', '']);
  });

  it('appends the reassignment alongside the reshape, with its reason code', async () => {
    seedV10Workspace(memento, buildWorkflowRun({ id: 'run-orphan', featureId: 'task-nowhere' }));

    await migrateAndForward(memento, writer, logger);

    const reassign = writer.appended.find((e) => e.eventType === 'run-reassigned-to-default-queue');
    expect(reassign?.payload).toMatchObject({
      runId: 'run-orphan',
      queueId: DEFAULT_QUEUE_ID,
      reason: 'task-not-in-any-queue'
    });
  });

  it('appends a repair entry when the persisted record is a shape the migrator does not know', async () => {
    seedV10Workspace(memento, buildWorkflowRun({ featureId: taskIdFor(OTHER_QUEUE) }));
    memento.seed(KEYS.run, { totally: 'not a run' });

    await migrateAndForward(memento, writer, logger);

    const repaired = writer.appended.find((e) => e.eventType === 'run-record-repaired');
    expect(repaired?.payload).toMatchObject({ reason: 'unrecognised-record-shape' });
  });

  /**
   * A migration nobody can parse is a migration nobody can debug. The parser
   * drops nothing (warn-and-preserve), but an event type absent from
   * `ALL_AUDIT_EVENT_TYPES` reads back as unknown and lands in the warning path
   * rather than the classified one.
   */
  it('emits only event types the audit contract knows', async () => {
    seedV10Workspace(memento, buildWorkflowRun({ id: 'run-orphan', featureId: 'task-nowhere' }));

    await migrateAndForward(memento, writer, logger);

    expect(writer.appended.length).toBeGreaterThan(0);
    for (const entry of writer.appended) {
      expect(isKnownAuditEventType(entry.eventType as string)).toBe(true);
    }
  });

  it('appends nothing when there was nothing to migrate', async () => {
    seedV10Workspace(memento, buildWorkflowRun({ featureId: taskIdFor(OTHER_QUEUE) }));
    await new WorkspaceStateStore(memento).initialize();

    await migrateAndForward(memento, writer, logger);

    expect(writer.appended).toEqual([]);
  });

  /**
   * Forwarding is best-effort and must never block activation: a workspace that
   * cannot write its audit log still has to open. The append failure is logged
   * and swallowed, and the state migration itself already committed.
   */
  it('swallows an append failure and warns instead of failing activation', async () => {
    seedV10Workspace(memento, buildWorkflowRun({ featureId: taskIdFor(OTHER_QUEUE) }));
    writer.rejectWith = new Error('disk full');

    await expect(migrateAndForward(memento, writer, logger)).resolves.toBeUndefined();

    expect(logger.warnings.some((w) => w.includes('state-migrated-v10-to-v11'))).toBe(true);
  });
});

describe('the forwarded payloads carry no operator-authored text (T013, FR-023a discipline)', () => {
  // Queue names, task descriptions and pipeline names are operator-authored.
  // The `/name/i` and `/description/i` probes are the same ones
  // `queue-state-migrator-v9-to-v10.test.ts:238-251` applies to the v9 → v10
  // payloads; the shape rule does not change because the key being reshaped did.
  it('matches neither /name/i nor /description/i', async () => {
    seedV10Workspace(memento, buildWorkflowRun({ id: 'run-orphan', featureId: 'task-nowhere' }));

    await migrateAndForward(memento, writer, logger);

    const serialised = JSON.stringify(writer.appended.map((e) => e.payload));
    expect(serialised).not.toMatch(/name/i);
    expect(serialised).not.toMatch(/description/i);
  });

  /**
   * The payload is built per event type rather than by spreading the event, so
   * a field added to a migrator event does not silently become an audit field.
   * This pins the closed key sets that decision produces.
   */
  it('carries only the closed key set each event type declares', async () => {
    seedV10Workspace(memento, buildWorkflowRun({ id: 'run-orphan', featureId: 'task-nowhere' }));

    await migrateAndForward(memento, writer, logger);

    const keysFor = (eventType: string): string[] =>
      Object.keys(
        (writer.appended.find((e) => e.eventType === eventType)?.payload ?? {}) as object
      ).sort();

    expect(keysFor('state-migrated-v10-to-v11')).toEqual([
      'fromVersion',
      'occurredAt',
      'queueIds',
      'runCount',
      'toVersion'
    ]);
    expect(keysFor('run-reassigned-to-default-queue')).toEqual([
      'occurredAt',
      'queueId',
      'reason',
      'runId'
    ]);
  });
});
