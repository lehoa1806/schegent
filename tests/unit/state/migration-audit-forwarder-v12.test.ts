// FR-R3-010 — the v11 → v12 history partition as the **audit log** sees it.
//
// The sibling `migration-audit-forwarder-v11.test.ts` exists because feature
// 092's v10 events were produced, returned, and never forwarded: every unit test
// passed, because every unit test asserted the migrator *returned* events. This
// file closes the same gap for v12, and spans the same two ends — a seeded
// memento at one, an `AuditLogWriter` double at the other. The migrator's own
// behaviour is `history-state-migrator.test.ts`'s subject and is not restated
// here.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  KEYS,
  SCHEMA_VERSION,
  WorkspaceStateStore,
  type Memento
} from '../../../src/state/workspace-state';
import { STATE_SCHEMA_VERSION_V11 } from '../../../src/contracts/state-schema';
import { forwardMigrationAuditEvents } from '../../../src/state/migration-audit-forwarder';
import { isKnownAuditEventType } from '../../../src/contracts/audit-events';
import { HISTORY_UNATTRIBUTED_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import type { QueueState } from '../../../src/queue/feature-request';
import type { AuditEntry } from '../../../src/audit/audit-entry';
import { buildQueueRegistry, buildV9QueueState, fixtureQueueId } from '../../fixtures/state/queue-fixtures';

const OTHER_QUEUE = fixtureQueueId(2);

function taskIdFor(queueId: string): string {
  return `${queueId}-task`;
}

/** One legacy (flat-array) history row, complete enough for the migrator. */
function legacyHistoryRow(featureId: string, runId: string): object {
  return {
    runId,
    featureId,
    descriptionPreview: 'a preview',
    originalDescription: 'the full operator-authored description',
    terminalStatus: 'completed',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:05:00.000Z',
    lastErrorSummary: null,
    pipelineId: 'speckit-default'
  };
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

/** Mirrors `AuditLogWriter.append` exactly, including its resolved value. */
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

/**
 * A workspace persisted at v11: queues in the per-queue shape, and history still
 * the flat array v11 wrote.
 */
function seedV11Workspace(memento: FakeMemento, history: unknown): void {
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
  memento.seed(KEYS.run, {});
  memento.seed(KEYS.history, history);
  memento.seed(KEYS.schemaVersion, SCHEMA_VERSION);
  memento.seed(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION_V11);
}

/** Migrate a seeded v11 workspace and forward only what the v12 step produced. */
async function migrateAndForward(
  memento: FakeMemento,
  writer: RecordingAuditWriter,
  logger: RecordingLogger
): Promise<void> {
  const result = await new WorkspaceStateStore(memento).initialize();
  await forwardMigrationAuditEvents(
    {
      // The other four families are empty for the same reason the v11 file
      // empties this one: a seeded workspace can trip more than one migration,
      // and a count assertion over a mixed set says nothing about either.
      v6MigrationEvents: [],
      v7MigrationEvents: [],
      v11MigrationEvents: [],
      v12MigrationEvents: result.v12MigrationEvents,
      runRepairEvents: []
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

describe('the v11 → v12 history partition reaches the audit writer (FR-R3-010)', () => {
  it('appends a state-migrated-v11-to-v12 entry', async () => {
    seedV11Workspace(memento, [
      legacyHistoryRow(taskIdFor(DEFAULT_QUEUE_ID), 'run-1'),
      legacyHistoryRow(taskIdFor(OTHER_QUEUE), 'run-2')
    ]);

    await migrateAndForward(memento, writer, logger);

    const reshape = writer.appended.find((e) => e.eventType === 'state-migrated-v11-to-v12');
    expect(reshape).toBeDefined();
    expect(reshape).toMatchObject({ phase: 'state-migration', iteration: 0, outcome: 'success' });
    expect(reshape?.payload).toMatchObject({ fromVersion: 11, toVersion: 12, entryCount: 2 });
    expect(reshape?.payload.queueIds).toEqual(
      expect.arrayContaining([DEFAULT_QUEUE_ID, OTHER_QUEUE])
    );
  });

  /**
   * A history entry describes a Run that has already ended, so there is no Run
   * for a correlation key to reach even in principle — not merely none reachable
   * yet, which is the v11 family's weaker reason.
   */
  it('correlates every entry on the empty runId', async () => {
    seedV11Workspace(memento, [legacyHistoryRow('task-nowhere', 'run-orphan')]);

    await migrateAndForward(memento, writer, logger);

    expect(writer.appended).toHaveLength(2);
    expect(writer.appended.map((e) => e.runId)).toEqual(['', '']);
  });

  /**
   * Entries whose Task has left every queue are a fact about the reshape, and a
   * separate event rather than a field inside it — a count buried in the reshape
   * payload cannot be filtered for. One event carries all of them.
   */
  it('appends one unattributed summary with a count, not one event per entry', async () => {
    seedV11Workspace(memento, [
      legacyHistoryRow('task-nowhere', 'run-a'),
      legacyHistoryRow('task-also-nowhere', 'run-b'),
      legacyHistoryRow(taskIdFor(OTHER_QUEUE), 'run-c')
    ]);

    await migrateAndForward(memento, writer, logger);

    const unattributed = writer.appended.filter(
      (e) => e.eventType === 'history-entries-unattributed'
    );
    expect(unattributed).toHaveLength(1);
    expect(unattributed[0].payload).toMatchObject({
      queueId: HISTORY_UNATTRIBUTED_QUEUE_ID,
      entryCount: 2,
      reason: 'task-not-in-any-queue'
    });
  });

  it('appends a repair entry when the persisted record is a shape the migrator does not know', async () => {
    seedV11Workspace(memento, { totally: 'not a history' });

    await migrateAndForward(memento, writer, logger);

    const repaired = writer.appended.find((e) => e.eventType === 'history-record-repaired');
    expect(repaired?.payload).toMatchObject({ reason: 'unrecognised-record-shape' });
  });

  /**
   * v11's repair event is `run-record-repaired` and v12's is
   * `history-record-repaired`. Distinct on purpose: one type covering both would
   * make "which record was unreadable" a question the payload cannot answer.
   */
  it('does not reuse the v11 repair event type', async () => {
    seedV11Workspace(memento, { totally: 'not a history' });

    await migrateAndForward(memento, writer, logger);

    expect(writer.appended.map((e) => e.eventType)).not.toContain('run-record-repaired');
  });

  /**
   * A migration nobody can parse is a migration nobody can debug. The parser
   * drops nothing, but an event type absent from `ALL_AUDIT_EVENT_TYPES` reads
   * back as unknown and lands in the warning path rather than the classified one.
   */
  it('emits only event types the audit contract knows', async () => {
    seedV11Workspace(memento, [legacyHistoryRow('task-nowhere', 'run-orphan')]);

    await migrateAndForward(memento, writer, logger);

    expect(writer.appended.length).toBeGreaterThan(0);
    for (const entry of writer.appended) {
      expect(isKnownAuditEventType(entry.eventType as string)).toBe(true);
    }
  });

  it('appends nothing when the record is already partitioned', async () => {
    seedV11Workspace(memento, { [DEFAULT_QUEUE_ID]: [] });

    await migrateAndForward(memento, writer, logger);

    expect(writer.appended).toEqual([]);
  });

  /**
   * Forwarding is best-effort and must never block activation: a workspace that
   * cannot write its audit log still has to open, and the state migration itself
   * already committed.
   */
  it('swallows an append failure and warns instead of failing activation', async () => {
    seedV11Workspace(memento, [legacyHistoryRow(taskIdFor(OTHER_QUEUE), 'run-1')]);
    writer.rejectWith = new Error('disk full');

    await expect(migrateAndForward(memento, writer, logger)).resolves.toBeUndefined();

    expect(logger.warnings.some((w) => w.includes('state-migrated-v11-to-v12'))).toBe(true);
  });
});

describe('the forwarded payloads carry no operator-authored text (FR-023a discipline)', () => {
  /**
   * A history entry is the richest thing any migrator in this repo reshapes: it
   * holds a task description, a preview of it, an error summary and a pipeline
   * id. The `/name/i` and `/description/i` probes are the same ones the v9 → v10
   * and v10 → v11 payload tests apply, and they matter more here because there
   * is genuinely something for a spread to reach.
   */
  it('matches neither /name/i nor /description/i', async () => {
    seedV11Workspace(memento, [
      legacyHistoryRow('task-nowhere', 'run-orphan'),
      legacyHistoryRow(taskIdFor(OTHER_QUEUE), 'run-2')
    ]);

    await migrateAndForward(memento, writer, logger);

    const serialised = JSON.stringify(writer.appended.map((e) => e.payload));
    expect(serialised).not.toMatch(/name/i);
    expect(serialised).not.toMatch(/description/i);
  });

  it('carries only the closed key set each event type declares', async () => {
    seedV11Workspace(memento, [legacyHistoryRow('task-nowhere', 'run-orphan')]);

    await migrateAndForward(memento, writer, logger);

    const keysFor = (eventType: string): string[] =>
      Object.keys(
        (writer.appended.find((e) => e.eventType === eventType)?.payload ?? {}) as object
      ).sort();

    expect(keysFor('state-migrated-v11-to-v12')).toEqual([
      'entryCount',
      'fromVersion',
      'occurredAt',
      'queueIds',
      'toVersion'
    ]);
    expect(keysFor('history-entries-unattributed')).toEqual([
      'entryCount',
      'occurredAt',
      'queueId',
      'reason'
    ]);
  });
});
