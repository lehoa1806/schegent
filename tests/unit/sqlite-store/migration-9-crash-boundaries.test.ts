/**
 * FR-R7-02 (FR-009, US3, SC-004) — Real child-process `SIGKILL` crash tests at
 * every statement boundary of Migration 9 and at every boundary of the steady-state
 * per-entity operational write path.
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

describe('FR-R7-02 — Child-process SIGKILL crash boundaries for Migration 9 & per-entity writes', () => {
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
    'mig9-after-backfill-runs',
    'mig9-after-delete-source-kv',
    'mig9-after-insert-schema-migrations',
    'mig9-after-update-schema-meta'
  ];

  for (const boundary of PRE_COMMIT_MIGRATION_BOUNDARIES) {
    it(`rolls back Migration 9 cleanly to schema 8 when child is SIGKILLed at ${boundary}, and succeeds on subsequent retry`, () => {
      const dbPath = join(suiteDir, `${boundary}.db`);
      const scopeId = `scope-${boundary}`;
      const { queueDigest, runDigest } = seedSchema8OnDisk(dbPath, scopeId);

      spawnAndExpectSigkill(dbPath, scopeId, boundary);

      // Reopen read-only/raw to inspect state BEFORE retrying migration: must be cleanly at schema 8
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
        expect(
          inspectConn.get<{ name: string }>(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operational_tasks'`
          )
        ).toBeUndefined();

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
});
