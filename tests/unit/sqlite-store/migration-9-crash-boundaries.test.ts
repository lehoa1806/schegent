/**
 * FR-R7-02 (FR-009, US3, SC-004) & FR-R7-11 (Task 02, FR-002) — Real child-process
 * `SIGKILL` crash tests at every statement boundary of Migration 9, the steady-state
 * per-entity upsert path, and a mixed two-queue row-upsert + row-delete + relational-
 * projection transaction.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BUILTIN_SCHEMA_MIGRATIONS,
  NodeSqliteConnection,
  SchemaBootstrapService,
  SqliteApplicationStore,
  computeCanonicalSha256,
  readOperationalQueueMapFromDb,
  readOperationalRunMapFromDb
} from '../../../src/services/sqlite-store';
import { createSwitchableOperationalMemento } from '../../../src/state/sqlite-operational-backing';
import { KEYS, type Memento } from '../../../src/state/workspace-state';
import type { FeatureRequest, QueueState } from '../../../src/queue/feature-request';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import type { Migration9CrashBoundary } from './helpers/migration-9-crash-worker';

const WORKER_SRC = resolve(__dirname, 'helpers', 'migration-9-crash-worker.ts');
const MIGRATIONS_UP_TO_8 = BUILTIN_SCHEMA_MIGRATIONS.filter((m) => m.version <= 8);
const NOW = 1_763_690_000_000;
const MUTATION_TS = 1_763_700_005_000;

function createMemoryMemento(initial: Record<string, unknown> = {}): Memento {
  const map = new Map<string, unknown>(Object.entries(initial));
  return {
    get<T>(key: string): T | undefined {
      return map.get(key) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) map.delete(key);
      else map.set(key, value);
    }
  };
}

function buildSeedPayload(): {
  readonly queues: Record<string, QueueState>;
  readonly runs: Record<string, WorkflowRun>;
} {
  const task0: FeatureRequest = {
    id: 'default-task-0000',
    description: 'Active task under crash testing',
    enqueuedAt: NOW,
    createdAt: NOW,
    startedAt: NOW + 10,
    updatedAt: NOW + 20,
    completedAt: null,
    status: 'in-flight',
    queueId: 'default',
    position: 0,
    runId: 'run-crash-1',
    retryCount: 0,
    lastError: null,
    pausedReason: null,
    pipelineId: 'wf-crash'
  };
  const task1: FeatureRequest = {
    id: 'default-task-0001',
    description: 'Sibling pending task',
    enqueuedAt: NOW + 5,
    createdAt: NOW + 5,
    startedAt: null,
    updatedAt: NOW + 5,
    completedAt: null,
    status: 'pending',
    queueId: 'default',
    position: 1,
    runId: null,
    retryCount: 0,
    lastError: null,
    pausedReason: null,
    pipelineId: 'wf-crash'
  };
  const queues: Record<string, QueueState> = {
    default: {
      requests: [task0, task1],
      inFlightId: task0.id,
      updatedAt: NOW + 20,
      queueLifecycle: 'running',
      pauseSource: null,
      pausedReason: null,
      scheduledStartAt: null,
      scheduledStartSource: null,
      failurePolicy: 'halt-on-failure'
    }
  };
  const runs: Record<string, WorkflowRun> = {
    default: {
      id: 'run-crash-1',
      featureId: task0.id,
      featureDir: 'specs/316-sqlite-per-entity-rows',
      status: 'running',
      currentPhase: 'implement',
      currentIteration: 1,
      startedAt: NOW + 10,
      lastTransitionAt: NOW + 20,
      phasesCompleted: [],
      lastError: null,
      delayedRetryCount: 0,
      pendingRetryAt: null,
      pendingRetryCause: null,
      creditPause: null,
      phaseOverrides: [],
      manualPauseAt: null,
      manualPauseCause: null,
      phaseBreakpoints: [],
      resumeTargetPhaseId: null,
      pipeline: { id: 'wf-crash', name: 'Crash WF', phases: [] },
      writtenAtFence: 3
    }
  };
  return { queues, runs };
}

function buildTwoQueueSeedPayload(): {
  readonly queues: Record<string, QueueState>;
  readonly runs: Record<string, WorkflowRun>;
} {
  const base = buildSeedPayload();
  const queueBTask0: FeatureRequest = {
    id: 'queue-b-task-0000',
    description: 'Secondary queue active task removed in mixed batch',
    enqueuedAt: NOW + 12,
    createdAt: NOW + 12,
    startedAt: NOW + 15,
    updatedAt: NOW + 25,
    completedAt: null,
    status: 'in-flight',
    queueId: 'queue-b',
    position: 0,
    runId: 'run-crash-b',
    retryCount: 0,
    lastError: null,
    pausedReason: null,
    pipelineId: 'wf-crash-b'
  };
  const queues: Record<string, QueueState> = {
    ...base.queues,
    'queue-b': {
      requests: [queueBTask0],
      inFlightId: queueBTask0.id,
      updatedAt: NOW + 25,
      queueLifecycle: 'running',
      pauseSource: null,
      pausedReason: null,
      scheduledStartAt: null,
      scheduledStartSource: null,
      failurePolicy: 'halt-on-failure'
    }
  };
  const runs: Record<string, WorkflowRun> = {
    ...base.runs,
    'queue-b': {
      id: 'run-crash-b',
      featureId: queueBTask0.id,
      featureDir: 'specs/327-round7-audit-followup',
      status: 'running',
      currentPhase: 'plan',
      currentIteration: 1,
      startedAt: NOW + 15,
      lastTransitionAt: NOW + 25,
      phasesCompleted: [],
      lastError: null,
      delayedRetryCount: 0,
      pendingRetryAt: null,
      pendingRetryCause: null,
      creditPause: null,
      phaseOverrides: [],
      manualPauseAt: null,
      manualPauseCause: null,
      phaseBreakpoints: [],
      resumeTargetPhaseId: null,
      pipeline: { id: 'wf-crash-b', name: 'Crash WF B', phases: [] },
      writtenAtFence: 4
    }
  };
  return { queues, runs };
}

function seedSchema8OnDisk(dbPath: string, scopeId: string): {
  readonly queueDigest: string;
  readonly runDigest: string;
} {
  const { queues, runs } = buildSeedPayload();
  const queueJson = JSON.stringify(queues);
  const runJson = JSON.stringify(runs);

  const conn = new NodeSqliteConnection({ databasePath: dbPath, journalMode: 'wal' });
  try {
    SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW, MIGRATIONS_UP_TO_8);
    conn.run(
      `INSERT INTO operational_kv_documents (
        doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms
      ) VALUES (?, ?, 1, 1, ?, ?, 0, ?)`,
      scopeId,
      KEYS.queue,
      queueJson,
      Buffer.byteLength(queueJson, 'utf8'),
      NOW
    );
    conn.run(
      `INSERT INTO operational_kv_documents (
        doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms
      ) VALUES (?, ?, 1, 1, ?, ?, 0, ?)`,
      scopeId,
      KEYS.run,
      runJson,
      Buffer.byteLength(runJson, 'utf8'),
      NOW
    );
  } finally {
    conn.close();
  }
  return {
    queueDigest: computeCanonicalSha256(queues),
    runDigest: computeCanonicalSha256(runs)
  };
}

function seedSchema9OnDisk(dbPath: string, scopeId: string): void {
  const { queues, runs } = buildSeedPayload();
  const store = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
  try {
    const memento = createSwitchableOperationalMemento(
      createMemoryMemento({
        [KEYS.schemaVersion]: 15,
        [KEYS.queue]: queues,
        [KEYS.run]: runs
      })
    );
    memento.attachSqlite(store, scopeId, () => NOW);
  } finally {
    store.close();
  }
}

interface RelationalRunRow {
  readonly status: string;
  readonly revision: number;
  readonly completed_at_ms: number | null;
  readonly updated_at_ms: number;
}

function readRelationalRunRow(store: SqliteApplicationStore, runId: string): RelationalRunRow | undefined {
  return store.writerConnection.get<RelationalRunRow>(
    `SELECT status, revision, completed_at_ms, updated_at_ms FROM runs WHERE run_id = ?`,
    runId
  );
}

function seedTwoQueueSchema9OnDisk(dbPath: string, scopeId: string): {
  readonly preDefaultRelationalRevision: number;
  readonly preQueueBRelationalRevision: number;
} {
  const { queues, runs } = buildTwoQueueSeedPayload();
  const store = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
  try {
    const memento = createSwitchableOperationalMemento(
      createMemoryMemento({
        [KEYS.schemaVersion]: 15,
        [KEYS.queue]: queues,
        [KEYS.run]: runs
      })
    );
    memento.attachSqlite(store, scopeId, () => NOW);
    const defaultRel = readRelationalRunRow(store, 'run-crash-1');
    const queueBRel = readRelationalRunRow(store, 'run-crash-b');
    if (!defaultRel || !queueBRel) {
      throw new Error('Expected seeded relational runs rows for both default and queue-b');
    }
    return {
      preDefaultRelationalRevision: defaultRel.revision,
      preQueueBRelationalRevision: queueBRel.revision
    };
  } finally {
    store.close();
  }
}

function assertMixedPreMutationState(
  store: SqliteApplicationStore,
  scopeId: string,
  preDefaultRelRev: number,
  preQueueBRelRev: number
): void {
  const conn = store.writerConnection;

  // operational_runs: both queues intact at revision 1, status 'running'
  const opRuns = conn.all<{ queue_id: string; run_id: string; status: string; revision: number }>(
    `SELECT queue_id, run_id, status, revision FROM operational_runs WHERE scope_id = ? ORDER BY queue_id ASC`,
    scopeId
  );
  expect(opRuns).toEqual([
    { queue_id: 'default', run_id: 'run-crash-1', status: 'running', revision: 1 },
    { queue_id: 'queue-b', run_id: 'run-crash-b', status: 'running', revision: 1 }
  ]);

  // runs (relational projection): both rows intact at pre-mutation status & revision
  expect(readRelationalRunRow(store, 'run-crash-1')).toEqual({
    status: 'running',
    revision: preDefaultRelRev,
    completed_at_ms: null,
    updated_at_ms: NOW + 20
  });
  expect(readRelationalRunRow(store, 'run-crash-b')).toEqual({
    status: 'running',
    revision: preQueueBRelRev,
    completed_at_ms: null,
    updated_at_ms: NOW + 25
  });

  // operational_queue_meta: both queues intact at revision 1
  const opMeta = conn.all<{
    queue_id: string;
    in_flight_id: string | null;
    queue_lifecycle: string;
    revision: number;
  }>(
    `SELECT queue_id, in_flight_id, queue_lifecycle, revision FROM operational_queue_meta WHERE scope_id = ? ORDER BY queue_id ASC`,
    scopeId
  );
  expect(opMeta).toEqual([
    {
      queue_id: 'default',
      in_flight_id: 'default-task-0000',
      queue_lifecycle: 'running',
      revision: 1
    },
    {
      queue_id: 'queue-b',
      in_flight_id: 'queue-b-task-0000',
      queue_lifecycle: 'running',
      revision: 1
    }
  ]);

  // operational_tasks: all 3 tasks intact at revision 1
  const opTasks = conn.all<{
    queue_id: string;
    task_id: string;
    status: string;
    revision: number;
  }>(
    `SELECT queue_id, task_id, status, revision FROM operational_tasks WHERE scope_id = ? ORDER BY queue_id ASC, position ASC`,
    scopeId
  );
  expect(opTasks).toEqual([
    { queue_id: 'default', task_id: 'default-task-0000', status: 'in-flight', revision: 1 },
    { queue_id: 'default', task_id: 'default-task-0001', status: 'pending', revision: 1 },
    { queue_id: 'queue-b', task_id: 'queue-b-task-0000', status: 'in-flight', revision: 1 }
  ]);
}

function assertMixedPostMutationState(
  store: SqliteApplicationStore,
  scopeId: string,
  preDefaultRelRev: number,
  preQueueBRelRev: number
): void {
  const conn = store.writerConnection;

  // operational_runs: queue-b removed; default completed at revision 2
  const opRuns = conn.all<{ queue_id: string; run_id: string; status: string; revision: number }>(
    `SELECT queue_id, run_id, status, revision FROM operational_runs WHERE scope_id = ? ORDER BY queue_id ASC`,
    scopeId
  );
  expect(opRuns).toEqual([
    { queue_id: 'default', run_id: 'run-crash-1', status: 'completed', revision: 2 }
  ]);

  // runs (relational projection): default run updated atomically in same transaction
  expect(readRelationalRunRow(store, 'run-crash-1')).toEqual({
    status: 'succeeded',
    revision: preDefaultRelRev + 1,
    completed_at_ms: MUTATION_TS,
    updated_at_ms: MUTATION_TS
  });
  // relational history row for queue-b remains untouched (operational delete does not drop relational runs)
  expect(readRelationalRunRow(store, 'run-crash-b')).toEqual({
    status: 'running',
    revision: preQueueBRelRev,
    completed_at_ms: null,
    updated_at_ms: NOW + 25
  });

  // operational_queue_meta: queue-b removed; default idle-pending at revision 2
  const opMeta = conn.all<{
    queue_id: string;
    in_flight_id: string | null;
    queue_lifecycle: string;
    revision: number;
  }>(
    `SELECT queue_id, in_flight_id, queue_lifecycle, revision FROM operational_queue_meta WHERE scope_id = ? ORDER BY queue_id ASC`,
    scopeId
  );
  expect(opMeta).toEqual([
    {
      queue_id: 'default',
      in_flight_id: null,
      queue_lifecycle: 'idle-pending',
      revision: 2
    }
  ]);

  // operational_tasks: queue-b task and default-task-0001 deleted; default-task-0000 completed at revision 2
  const opTasks = conn.all<{
    queue_id: string;
    task_id: string;
    status: string;
    revision: number;
  }>(
    `SELECT queue_id, task_id, status, revision FROM operational_tasks WHERE scope_id = ? ORDER BY queue_id ASC, position ASC`,
    scopeId
  );
  expect(opTasks).toEqual([
    { queue_id: 'default', task_id: 'default-task-0000', status: 'completed', revision: 2 }
  ]);
}

describe('FR-R7-02 / FR-R7-11 — Child-process SIGKILL crash boundaries for Migration 9 & per-entity writes', () => {
  let suiteDir: string;
  let workerCjs: string;

  beforeAll(() => {
    suiteDir = mkdtempSync(join(tmpdir(), 'schegent-m9-crash-'));
    workerCjs = join(suiteDir, 'migration-9-crash-worker.cjs');
    buildSync({
      entryPoints: [WORKER_SRC],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['node:sqlite'],
      outfile: workerCjs
    });
  });

  afterAll(() => {
    rmSync(suiteDir, { recursive: true, force: true });
  });

  function spawnAndExpectSigkill(
    dbPath: string,
    scopeId: string,
    boundary: Migration9CrashBoundary
  ): void {
    const res = spawnSync(process.execPath, [workerCjs, dbPath, scopeId, boundary], {
      encoding: 'utf8',
      timeout: 15_000
    });
    expect(res.signal, `expected SIGKILL at ${boundary}; status=${res.status} stderr=${res.stderr}`).toBe(
      'SIGKILL'
    );
  }

  const PRE_COMMIT_MIGRATION_BOUNDARIES: readonly Migration9CrashBoundary[] = [
    'mig9-before-begin',
    'mig9-after-ddl-queue-meta',
    'mig9-after-ddl-tasks',
    'mig9-after-ddl-tasks-index',
    'mig9-after-ddl-runs',
    'mig9-after-ddl-runs-index',
    'mig9-after-backfill-queue-meta',
    'mig9-after-backfill-tasks',
    'mig9-after-delete-source-kv-queue',
    'mig9-after-backfill-runs',
    'mig9-after-delete-source-kv-run',
    'mig9-after-insert-schema-migrations',
    'mig9-after-update-schema-version',
    'mig9-after-update-min-reader-version',
    'mig9-after-update-sqlite-version',
    'mig9-after-update-sqlite-source-id',
    'mig9-after-catalog-revisions-workspace',
    'mig9-after-catalog-revisions-global',
    'mig9-after-catalog-revisions-combined'
  ];

  for (const boundary of PRE_COMMIT_MIGRATION_BOUNDARIES) {
    it(`rolls back Migration 9 cleanly to schema 8 when child is SIGKILLed at ${boundary}, and succeeds on subsequent retry`, () => {
      const dbPath = join(suiteDir, `${boundary}.db`);
      const scopeId = `scope-${boundary}`;
      const { queueDigest, runDigest } = seedSchema8OnDisk(dbPath, scopeId);

      spawnAndExpectSigkill(dbPath, scopeId, boundary);

      // Reopen raw to inspect state BEFORE retrying migration: must be cleanly at schema 8
      const inspectConn = new NodeSqliteConnection({ databasePath: dbPath, journalMode: 'wal' });
      try {
        expect(inspectConn.runQuickCheck()).toEqual(['ok']);
        expect(
          inspectConn.get<{ meta_value: string }>(
            `SELECT meta_value FROM schema_meta WHERE meta_key = 'schema_version'`
          )?.meta_value
        ).toBe('8');
        expect(
          inspectConn.get<{ meta_value: string }>(
            `SELECT meta_value FROM schema_meta WHERE meta_key = 'min_reader_version'`
          )?.meta_value
        ).toBe('1');
        // Verify all schema_meta timestamps rolled back to the pre-migration schema 8 seed timestamp.
        const metaRows = inspectConn.all<{ meta_key: string; updated_at_ms: number }>(
          `SELECT meta_key, updated_at_ms FROM schema_meta WHERE meta_key IN ('schema_version', 'min_reader_version', 'sqlite_version', 'sqlite_source_id') ORDER BY meta_key ASC`
        );
        expect(metaRows.map((r) => r.updated_at_ms)).toEqual([NOW, NOW, NOW, NOW]);

        expect(
          Number(inspectConn.scalar(`SELECT MAX(version) FROM schema_migrations`))
        ).toBe(8);
        expect(
          inspectConn.all<{ name: string }>(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('operational_queue_meta', 'operational_tasks', 'operational_runs')`
          )
        ).toEqual([]);

        const kvRows = inspectConn.all<{ doc_key: string; payload_json: string }>(
          `SELECT doc_key, payload_json FROM operational_kv_documents WHERE doc_namespace = ? ORDER BY doc_key`,
          scopeId
        );
        expect(kvRows.map((r) => r.doc_key)).toEqual([KEYS.queue, KEYS.run]);
        expect(computeCanonicalSha256(JSON.parse(kvRows[0]!.payload_json))).toBe(queueDigest);
        expect(computeCanonicalSha256(JSON.parse(kvRows[1]!.payload_json))).toBe(runDigest);

        // Retrying Migration 9 now succeeds atomically and losslessly
        const retryResult = SchemaBootstrapService.bootstrapAndMigrate(inspectConn, () => NOW + 10_000);
        expect(retryResult.schemaVersion).toBe(9);
        expect(retryResult.appliedMigrations).toEqual([9]);
        expect(
          inspectConn.all<{ doc_key: string }>(
            `SELECT doc_key FROM operational_kv_documents WHERE doc_namespace = ? AND doc_key IN (?, ?)`,
            scopeId,
            KEYS.queue,
            KEYS.run
          )
        ).toEqual([]);
        expect(computeCanonicalSha256(readOperationalQueueMapFromDb(inspectConn, scopeId).map)).toBe(
          queueDigest
        );
        expect(computeCanonicalSha256(readOperationalRunMapFromDb(inspectConn, scopeId).map)).toBe(
          runDigest
        );
      } finally {
        inspectConn.close();
      }
    });
  }

  it('reopens cleanly at schema 9 with verified digests and idempotent retry when child is SIGKILLed at mig9-after-commit', () => {
    const dbPath = join(suiteDir, 'mig9-after-commit.db');
    const scopeId = 'scope-mig9-after-commit';
    const { queueDigest, runDigest } = seedSchema8OnDisk(dbPath, scopeId);

    spawnAndExpectSigkill(dbPath, scopeId, 'mig9-after-commit');

    const reopenConn = new NodeSqliteConnection({ databasePath: dbPath, journalMode: 'wal' });
    try {
      expect(reopenConn.runQuickCheck()).toEqual(['ok']);
      expect(
        reopenConn.get<{ meta_value: string }>(
          `SELECT meta_value FROM schema_meta WHERE meta_key = 'schema_version'`
        )?.meta_value
      ).toBe('9');
      expect(
        reopenConn.get<{ meta_value: string }>(
          `SELECT meta_value FROM schema_meta WHERE meta_key = 'min_reader_version'`
        )?.meta_value
      ).toBe('9');
      expect(
        reopenConn.all<{ doc_key: string }>(
          `SELECT doc_key FROM operational_kv_documents WHERE doc_namespace = ? AND doc_key IN (?, ?)`,
          scopeId,
          KEYS.queue,
          KEYS.run
        )
      ).toEqual([]);
      expect(computeCanonicalSha256(readOperationalQueueMapFromDb(reopenConn, scopeId).map)).toBe(
        queueDigest
      );
      expect(computeCanonicalSha256(readOperationalRunMapFromDb(reopenConn, scopeId).map)).toBe(
        runDigest
      );

      // Re-running bootstrapAndMigrate on already-migrated schema 9 is an idempotent no-op
      const rerun = SchemaBootstrapService.bootstrapAndMigrate(reopenConn, () => NOW + 20_000);
      expect(rerun.appliedMigrations).toEqual([]);
      expect(rerun.schemaVersion).toBe(9);
    } finally {
      reopenConn.close();
    }
  });

  const PRE_COMMIT_WRITE_BOUNDARIES: readonly Migration9CrashBoundary[] = [
    'write-before-begin',
    'write-after-run-upsert',
    'write-after-queue-meta-upsert',
    'write-after-task-upsert'
  ];

  for (const boundary of PRE_COMMIT_WRITE_BOUNDARIES) {
    it(`preserves complete pre-mutation Task & Run state with zero torn rows when child is SIGKILLed at ${boundary}`, () => {
      const dbPath = join(suiteDir, `${boundary}.db`);
      const scopeId = `scope-${boundary}`;
      seedSchema9OnDisk(dbPath, scopeId);

      spawnAndExpectSigkill(dbPath, scopeId, boundary);

      const store = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
      try {
        expect(store.writerConnection.runQuickCheck()).toEqual(['ok']);
        const memento = createSwitchableOperationalMemento(createMemoryMemento());
        memento.attachSqlite(store, scopeId, () => NOW + 30_000);

        const queues = memento.get<Record<string, QueueState>>(KEYS.queue)!;
        const runs = memento.get<Record<string, WorkflowRun>>(KEYS.run)!;
        expect(queues.default!.inFlightId).toBe('default-task-0000');
        expect(queues.default!.requests[0]!.status).toBe('in-flight');
        expect(runs.default!.status).toBe('running');

        // Revisions remain untouched at 1
        expect(
          Number(
            store.writerConnection.scalar(
              `SELECT revision FROM operational_runs WHERE scope_id = ? AND queue_id = 'default'`,
              scopeId
            )
          )
        ).toBe(1);
        expect(
          Number(
            store.writerConnection.scalar(
              `SELECT revision FROM operational_tasks WHERE scope_id = ? AND task_id = 'default-task-0000'`,
              scopeId
            )
          )
        ).toBe(1);
      } finally {
        store.close();
      }
    });
  }

  it('preserves complete post-mutation Task & Run state when child is SIGKILLed at write-after-commit', () => {
    const dbPath = join(suiteDir, 'write-after-commit.db');
    const scopeId = 'scope-write-after-commit';
    seedSchema9OnDisk(dbPath, scopeId);

    spawnAndExpectSigkill(dbPath, scopeId, 'write-after-commit');

    const store = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
    try {
      expect(store.writerConnection.runQuickCheck()).toEqual(['ok']);
      const memento = createSwitchableOperationalMemento(createMemoryMemento());
      memento.attachSqlite(store, scopeId, () => NOW + 40_000);

      const queues = memento.get<Record<string, QueueState>>(KEYS.queue)!;
      const runs = memento.get<Record<string, WorkflowRun>>(KEYS.run)!;
      expect(queues.default!.inFlightId).toBeNull();
      expect(queues.default!.requests[0]!.status).toBe('completed');
      expect(runs.default!.status).toBe('completed');

      // Mutated entities advanced to revision 2; sibling task stayed at revision 1
      expect(
        Number(
          store.writerConnection.scalar(
            `SELECT revision FROM operational_runs WHERE scope_id = ? AND queue_id = 'default'`,
            scopeId
          )
        )
      ).toBe(2);
      expect(
        Number(
          store.writerConnection.scalar(
            `SELECT revision FROM operational_tasks WHERE scope_id = ? AND task_id = 'default-task-0000'`,
            scopeId
          )
        )
      ).toBe(2);
      expect(
        Number(
          store.writerConnection.scalar(
            `SELECT revision FROM operational_tasks WHERE scope_id = ? AND task_id = 'default-task-0001'`,
            scopeId
          )
        )
      ).toBe(1);
    } finally {
      store.close();
    }
  });

  const PRE_COMMIT_MIXED_WRITE_BOUNDARIES: readonly Migration9CrashBoundary[] = [
    'mixed-write-before-begin',
    'mixed-write-after-run-delete',
    'mixed-write-after-run-upsert',
    'mixed-write-after-relational-run-projection',
    'mixed-write-after-queue-tasks-delete',
    'mixed-write-after-queue-meta-delete',
    'mixed-write-after-queue-meta-upsert',
    'mixed-write-after-task-upsert',
    'mixed-write-after-task-delete'
  ];

  for (const boundary of PRE_COMMIT_MIXED_WRITE_BOUNDARIES) {
    it(`rolls back mixed row-upsert, row-delete, and relational projection cleanly at ${boundary} and commits atomically on retry`, () => {
      const dbPath = join(suiteDir, `${boundary}.db`);
      const scopeId = `scope-${boundary}`;
      const { preDefaultRelationalRevision, preQueueBRelationalRevision } =
        seedTwoQueueSchema9OnDisk(dbPath, scopeId);

      spawnAndExpectSigkill(dbPath, scopeId, boundary);

      const store = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
      try {
        expect(store.writerConnection.runQuickCheck()).toEqual(['ok']);
        assertMixedPreMutationState(
          store,
          scopeId,
          preDefaultRelationalRevision,
          preQueueBRelationalRevision
        );

        const memento = createSwitchableOperationalMemento(createMemoryMemento());
        const backing = memento.attachSqlite(store, scopeId, () => MUTATION_TS);

        // Verify cached operational reads match exact pre-mutation two-queue state.
        const prevQueues = backing.get<Record<string, QueueState>>(KEYS.queue)!;
        const prevRuns = backing.get<Record<string, WorkflowRun>>(KEYS.run)!;
        expect(Object.keys(prevQueues).sort()).toEqual(['default', 'queue-b']);
        expect(prevQueues.default!.requests.map((r) => r.id)).toEqual([
          'default-task-0000',
          'default-task-0001'
        ]);
        expect(Object.keys(prevRuns).sort()).toEqual(['default', 'queue-b']);

        // Clean retry of the exact same mixed updateBatch succeeds atomically across all 4 tables.
        const updatedTask0 = {
          ...prevQueues.default!.requests[0]!,
          status: 'completed' as const,
          completedAt: MUTATION_TS,
          updatedAt: MUTATION_TS
        };
        const nextQueues: Record<string, QueueState> = {
          default: {
            ...prevQueues.default!,
            inFlightId: null,
            queueLifecycle: 'idle-pending',
            updatedAt: MUTATION_TS,
            requests: [updatedTask0]
          }
        };
        const nextRuns: Record<string, WorkflowRun> = {
          default: {
            ...prevRuns.default!,
            status: 'completed',
            lastTransitionAt: MUTATION_TS
          }
        };
        backing.updateBatch([
          { key: KEYS.run, value: nextRuns },
          { key: KEYS.queue, value: nextQueues }
        ]);

        assertMixedPostMutationState(
          store,
          scopeId,
          preDefaultRelationalRevision,
          preQueueBRelationalRevision
        );
      } finally {
        store.close();
      }
    });
  }

  it('preserves complete post-mutation state across operational rows and relational runs when child is SIGKILLed at mixed-write-after-commit', () => {
    const dbPath = join(suiteDir, 'mixed-write-after-commit.db');
    const scopeId = 'scope-mixed-write-after-commit';
    const { preDefaultRelationalRevision, preQueueBRelationalRevision } =
      seedTwoQueueSchema9OnDisk(dbPath, scopeId);

    spawnAndExpectSigkill(dbPath, scopeId, 'mixed-write-after-commit');

    const store = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
    try {
      expect(store.writerConnection.runQuickCheck()).toEqual(['ok']);
      assertMixedPostMutationState(
        store,
        scopeId,
        preDefaultRelationalRevision,
        preQueueBRelationalRevision
      );

      const memento = createSwitchableOperationalMemento(createMemoryMemento());
      memento.attachSqlite(store, scopeId, () => NOW + 50_000);
      const queues = memento.get<Record<string, QueueState>>(KEYS.queue)!;
      const runs = memento.get<Record<string, WorkflowRun>>(KEYS.run)!;
      expect(Object.keys(queues)).toEqual(['default']);
      expect(queues.default!.inFlightId).toBeNull();
      expect(queues.default!.requests.map((r) => [r.id, r.status])).toEqual([
        ['default-task-0000', 'completed']
      ]);
      expect(Object.keys(runs)).toEqual(['default']);
      expect(runs.default!.status).toBe('completed');
    } finally {
      store.close();
    }
  });
});
