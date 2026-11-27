/**
 * FR-R7-02 (FR-009, SC-004, US3) & FR-R7-11 (Task 02, FR-002) — Child-process
 * crash worker that arms a real `process.kill(process.pid, 'SIGKILL')` at every
 * individual statement boundary of Migration 9, the steady-state per-entity
 * upsert path, and the mixed row-upsert + row-delete + relational-projection
 * transaction path.
 */

import {
  NodeSqliteConnection,
  SchemaBootstrapService,
  SqliteApplicationStore
} from '../../../../src/services/sqlite-store';
import { createSwitchableOperationalMemento } from '../../../../src/state/sqlite-operational-backing';
import { KEYS, type Memento } from '../../../../src/state/workspace-state';
import type { QueueState } from '../../../../src/queue/feature-request';
import type { WorkflowRun } from '../../../../src/state/workflow-run';

export type Migration9CrashBoundary =
  | 'mig9-before-begin'
  | 'mig9-after-ddl-queue-meta'
  | 'mig9-after-ddl-tasks'
  | 'mig9-after-ddl-tasks-index'
  | 'mig9-after-ddl-runs'
  | 'mig9-after-ddl-runs-index'
  | 'mig9-after-backfill-queue-meta'
  | 'mig9-after-backfill-tasks'
  | 'mig9-after-backfill-runs'
  | 'mig9-after-delete-source-kv'
  | 'mig9-after-delete-source-kv-queue'
  | 'mig9-after-delete-source-kv-run'
  | 'mig9-after-insert-schema-migrations'
  | 'mig9-after-update-schema-version'
  | 'mig9-after-update-min-reader-version'
  | 'mig9-after-update-schema-meta'
  | 'mig9-after-update-sqlite-version'
  | 'mig9-after-update-sqlite-source-id'
  | 'mig9-after-catalog-revisions-workspace'
  | 'mig9-after-catalog-revisions-global'
  | 'mig9-after-catalog-revisions-combined'
  | 'mig9-after-commit'
  | 'write-before-begin'
  | 'write-after-run-upsert'
  | 'write-after-queue-meta-upsert'
  | 'write-after-task-upsert'
  | 'write-after-commit'
  | 'mixed-write-before-begin'
  | 'mixed-write-after-run-delete'
  | 'mixed-write-after-run-upsert'
  | 'mixed-write-after-relational-run-projection'
  | 'mixed-write-after-queue-tasks-delete'
  | 'mixed-write-after-queue-meta-delete'
  | 'mixed-write-after-queue-meta-upsert'
  | 'mixed-write-after-task-upsert'
  | 'mixed-write-after-task-delete'
  | 'mixed-write-after-commit';

function createMemoryMemento(): Memento {
  const map = new Map<string, unknown>();
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

function killSelf(): never {
  process.kill(process.pid, 'SIGKILL');
  // Unreachable after SIGKILL; satisfies TypeScript `never`.
  process.exit(137);
}

function runMigration9WithCrash(dbPath: string, boundary: Migration9CrashBoundary): void {
  const conn = new NodeSqliteConnection({ databasePath: dbPath, journalMode: 'wal' });
  const origExec = conn.exec.bind(conn);
  const origRun = conn.run.bind(conn);

  conn.exec = ((sql: string) => {
    if (boundary === 'mig9-before-begin' && sql === 'BEGIN IMMEDIATE') {
      killSelf();
    }
    const res = origExec(sql);
    if (
      boundary === 'mig9-after-ddl-queue-meta' &&
      sql.includes('CREATE TABLE IF NOT EXISTS operational_queue_meta')
    ) {
      killSelf();
    }
    if (
      boundary === 'mig9-after-ddl-tasks' &&
      sql.includes('CREATE TABLE IF NOT EXISTS operational_tasks')
    ) {
      killSelf();
    }
    if (
      boundary === 'mig9-after-ddl-tasks-index' &&
      sql.includes('CREATE INDEX IF NOT EXISTS idx_operational_tasks_order')
    ) {
      killSelf();
    }
    if (
      boundary === 'mig9-after-ddl-runs' &&
      sql.includes('CREATE TABLE IF NOT EXISTS operational_runs')
    ) {
      killSelf();
    }
    if (
      boundary === 'mig9-after-ddl-runs-index' &&
      sql.includes('CREATE INDEX IF NOT EXISTS idx_operational_runs_run_id')
    ) {
      killSelf();
    }
    if (boundary === 'mig9-after-commit' && sql === 'COMMIT') {
      killSelf();
    }
    return res;
  }) as typeof conn.exec;

  conn.run = ((...args: Parameters<typeof conn.run>) => {
    const [sql, ...params] = args;
    const res = origRun(...args);
    if (
      boundary === 'mig9-after-backfill-queue-meta' &&
      sql.includes('INSERT INTO operational_queue_meta')
    ) {
      killSelf();
    }
    if (
      boundary === 'mig9-after-backfill-tasks' &&
      sql.includes('INSERT INTO operational_tasks')
    ) {
      killSelf();
    }
    if (
      boundary === 'mig9-after-backfill-runs' &&
      sql.includes('INSERT INTO operational_runs')
    ) {
      killSelf();
    }
    if (
      boundary === 'mig9-after-delete-source-kv' &&
      sql.includes('DELETE FROM operational_kv_documents')
    ) {
      killSelf();
    }
    if (
      boundary === 'mig9-after-delete-source-kv-queue' &&
      sql.includes('DELETE FROM operational_kv_documents') &&
      params[1] === KEYS.queue
    ) {
      killSelf();
    }
    if (
      boundary === 'mig9-after-delete-source-kv-run' &&
      sql.includes('DELETE FROM operational_kv_documents') &&
      params[1] === KEYS.run
    ) {
      killSelf();
    }
    if (
      boundary === 'mig9-after-insert-schema-migrations' &&
      sql.includes('INSERT INTO schema_migrations') &&
      params[0] === 9
    ) {
      killSelf();
    }
    if (
      boundary === 'mig9-after-update-schema-version' &&
      sql.includes('INSERT INTO schema_meta') &&
      params[0] === 'schema_version'
    ) {
      killSelf();
    }
    if (
      (boundary === 'mig9-after-update-min-reader-version' ||
        boundary === 'mig9-after-update-schema-meta') &&
      sql.includes('INSERT INTO schema_meta') &&
      params[0] === 'min_reader_version'
    ) {
      killSelf();
    }
    if (
      boundary === 'mig9-after-update-sqlite-version' &&
      sql.includes('INSERT INTO schema_meta') &&
      params[0] === 'sqlite_version'
    ) {
      killSelf();
    }
    if (
      boundary === 'mig9-after-update-sqlite-source-id' &&
      sql.includes('INSERT INTO schema_meta') &&
      params[0] === 'sqlite_source_id'
    ) {
      killSelf();
    }
    if (
      boundary === 'mig9-after-catalog-revisions-workspace' &&
      sql.includes('INSERT OR IGNORE INTO catalog_revisions') &&
      params[0] === 'workspace'
    ) {
      killSelf();
    }
    if (
      boundary === 'mig9-after-catalog-revisions-global' &&
      sql.includes('INSERT OR IGNORE INTO catalog_revisions') &&
      params[0] === 'global'
    ) {
      killSelf();
    }
    if (
      boundary === 'mig9-after-catalog-revisions-combined' &&
      sql.includes('INSERT OR IGNORE INTO catalog_revisions') &&
      params[0] === 'combined'
    ) {
      killSelf();
    }
    return res;
  }) as typeof conn.run;

  SchemaBootstrapService.bootstrapAndMigrate(conn, () => 1_763_700_000_000);
  conn.close();
}

function runEntityWriteWithCrash(
  dbPath: string,
  scopeId: string,
  boundary: Migration9CrashBoundary
): void {
  const store = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
  const memento = createSwitchableOperationalMemento(createMemoryMemento());
  const backing = memento.attachSqlite(store, scopeId, () => 1_763_700_005_000);

  const prevQueues = backing.get<Record<string, QueueState>>(KEYS.queue)!;
  const prevRuns = backing.get<Record<string, WorkflowRun>>(KEYS.run)!;
  const nextRequests = prevQueues.default!.requests.slice();
  nextRequests[0] = {
    ...nextRequests[0]!,
    status: 'completed',
    completedAt: 1_763_700_005_000,
    updatedAt: 1_763_700_005_000
  };
  const nextQueues: Record<string, QueueState> = {
    ...prevQueues,
    default: {
      ...prevQueues.default!,
      inFlightId: null,
      queueLifecycle: 'idle-pending',
      updatedAt: 1_763_700_005_000,
      requests: nextRequests
    }
  };
  const nextRuns: Record<string, WorkflowRun> = {
    ...prevRuns,
    default: {
      ...prevRuns.default!,
      status: 'completed',
      lastTransitionAt: 1_763_700_005_000
    }
  };

  const conn = store.writerConnection;
  const origExec = conn.exec.bind(conn);
  const origRun = conn.run.bind(conn);

  conn.exec = ((sql: string) => {
    if (boundary === 'write-before-begin' && sql === 'BEGIN IMMEDIATE') {
      killSelf();
    }
    const res = origExec(sql);
    if (boundary === 'write-after-commit' && sql === 'COMMIT') {
      killSelf();
    }
    return res;
  }) as typeof conn.exec;

  conn.run = ((...args: Parameters<typeof conn.run>) => {
    const [sql] = args;
    const res = origRun(...args);
    if (boundary === 'write-after-run-upsert' && sql.includes('INSERT INTO operational_runs')) {
      killSelf();
    }
    if (
      boundary === 'write-after-queue-meta-upsert' &&
      sql.includes('INSERT INTO operational_queue_meta')
    ) {
      killSelf();
    }
    if (boundary === 'write-after-task-upsert' && sql.includes('INSERT INTO operational_tasks')) {
      killSelf();
    }
    return res;
  }) as typeof conn.run;

  backing.updateBatch([
    { key: KEYS.run, value: nextRuns },
    { key: KEYS.queue, value: nextQueues }
  ]);
  store.close();
}

function runMixedEntityWriteWithCrash(
  dbPath: string,
  scopeId: string,
  boundary: Migration9CrashBoundary
): void {
  const store = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
  const memento = createSwitchableOperationalMemento(createMemoryMemento());
  const backing = memento.attachSqlite(store, scopeId, () => 1_763_700_005_000);

  const prevQueues = backing.get<Record<string, QueueState>>(KEYS.queue)!;
  const prevRuns = backing.get<Record<string, WorkflowRun>>(KEYS.run)!;

  // Drops `queue-b` (run + tasks + meta), updates `default` (run + relational projection +
  // queue meta + `default-task-0000`), and deletes `default-task-0001` from `default`.
  const updatedTask0 = {
    ...prevQueues.default!.requests[0]!,
    status: 'completed' as const,
    completedAt: 1_763_700_005_000,
    updatedAt: 1_763_700_005_000
  };
  const nextQueues: Record<string, QueueState> = {
    default: {
      ...prevQueues.default!,
      inFlightId: null,
      queueLifecycle: 'idle-pending',
      updatedAt: 1_763_700_005_000,
      requests: [updatedTask0]
    }
  };
  const nextRuns: Record<string, WorkflowRun> = {
    default: {
      ...prevRuns.default!,
      status: 'completed',
      lastTransitionAt: 1_763_700_005_000
    }
  };

  const conn = store.writerConnection;
  const origExec = conn.exec.bind(conn);
  const origRun = conn.run.bind(conn);

  conn.exec = ((sql: string) => {
    if (boundary === 'mixed-write-before-begin' && sql === 'BEGIN IMMEDIATE') {
      killSelf();
    }
    const res = origExec(sql);
    if (boundary === 'mixed-write-after-commit' && sql === 'COMMIT') {
      killSelf();
    }
    return res;
  }) as typeof conn.exec;

  conn.run = ((...args: Parameters<typeof conn.run>) => {
    const [sql, ...params] = args;
    const res = origRun(...args);
    if (
      boundary === 'mixed-write-after-run-delete' &&
      sql.includes('DELETE FROM operational_runs') &&
      params[1] === 'queue-b'
    ) {
      killSelf();
    }
    if (
      boundary === 'mixed-write-after-run-upsert' &&
      sql.includes('INSERT INTO operational_runs') &&
      params[1] === 'default'
    ) {
      killSelf();
    }
    if (
      boundary === 'mixed-write-after-relational-run-projection' &&
      sql.includes('INSERT INTO runs (') &&
      params[0] === 'run-crash-1'
    ) {
      killSelf();
    }
    if (
      boundary === 'mixed-write-after-queue-tasks-delete' &&
      sql.includes('DELETE FROM operational_tasks') &&
      !sql.includes('task_id = ?') &&
      params[1] === 'queue-b'
    ) {
      killSelf();
    }
    if (
      boundary === 'mixed-write-after-queue-meta-delete' &&
      sql.includes('DELETE FROM operational_queue_meta') &&
      params[1] === 'queue-b'
    ) {
      killSelf();
    }
    if (
      boundary === 'mixed-write-after-queue-meta-upsert' &&
      sql.includes('INSERT INTO operational_queue_meta') &&
      params[1] === 'default'
    ) {
      killSelf();
    }
    if (
      boundary === 'mixed-write-after-task-upsert' &&
      sql.includes('INSERT INTO operational_tasks') &&
      params[1] === 'default' &&
      params[2] === 'default-task-0000'
    ) {
      killSelf();
    }
    if (
      boundary === 'mixed-write-after-task-delete' &&
      sql.includes('DELETE FROM operational_tasks') &&
      sql.includes('task_id = ?') &&
      params[1] === 'default' &&
      params[2] === 'default-task-0001'
    ) {
      killSelf();
    }
    return res;
  }) as typeof conn.run;

  backing.updateBatch([
    { key: KEYS.run, value: nextRuns },
    { key: KEYS.queue, value: nextQueues }
  ]);
  store.close();
}

function main(): void {
  const [, , dbPath, scopeId, boundaryRaw] = process.argv;
  if (!dbPath || !scopeId || !boundaryRaw) {
    throw new Error('Usage: worker <dbPath> <scopeId> <boundary>');
  }
  const boundary = boundaryRaw as Migration9CrashBoundary;
  if (boundary.startsWith('mig9-')) {
    runMigration9WithCrash(dbPath, boundary);
  } else if (boundary.startsWith('mixed-write-')) {
    runMixedEntityWriteWithCrash(dbPath, scopeId, boundary);
  } else {
    runEntityWriteWithCrash(dbPath, scopeId, boundary);
  }
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(2);
}
