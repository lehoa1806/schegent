/**
 * FR-R7-02 — SQLite Migration 9 (`009_fr_r7_02_operational_per_entity_rows`):
 * `STRICT` per-entity operational tables (`operational_queue_meta`, `operational_tasks`,
 * `operational_runs`) and lossless transactional backfill with row-count and SHA-256 digest
 * verification.
 *
 * FR-R7-07 — Pure JSON/value helpers live in `src/lib/operational-value-helpers.ts` and
 * per-entity SQLite operational row helpers live in `src/state/sqlite-operational-rows.ts`
 * so `src/state/` does not value-import `src/services/sqlite-store/`. Both sets are
 * re-exported here unchanged for full compatibility.
 *
 * Every table is `STRICT`. Never edit migrations 1 to 8; checksum verification covers their text.
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 * Zero raw `node:fs` write primitives (docs/hard-rules.md rule 69).
 */

import type { NodeSqliteConnection } from './sqlite-driver';
import {
  computeCanonicalSha256,
  hasOwnDefinedEntries
} from '../../lib/operational-value-helpers';
import {
  deleteOperationalQueueScopeInTx,
  deleteOperationalRunScopeInTx,
  isOperationalQueueMap,
  isOperationalRunMap,
  readOperationalQueueMapFromDb,
  readOperationalRunMapFromDb,
  writeOperationalQueueMapDiffInTx,
  writeOperationalRunMapDiffInTx
} from '../../state/sqlite-operational-rows';

export {
  MAX_OPERATIONAL_JSON_DEPTH,
  canonicalJsonStringify,
  computeCanonicalSha256,
  deepFreezeValue,
  freezeSnapshotWithStructuralSharing,
  hasOwnDefinedEntries,
  isDeepEqualJsonValue,
  isDeepFrozenSnapshot,
  isPlainRecord,
  isSafeEntityKey,
  parseStrictSchemaMetaVersion,
  setOwnProp,
  toSafeIntOrDefault,
  toSafeIntOrNull,
  toStringOrNull
} from '../../lib/operational-value-helpers';

export {
  deleteOperationalQueueScopeInTx,
  deleteOperationalRunScopeInTx,
  isOperationalQueueMap,
  isOperationalRunMap,
  readOperationalQueueMapFromDb,
  readOperationalRunMapFromDb,
  writeOperationalQueueMapDiffInTx,
  writeOperationalRunMapDiffInTx,
  type QueueEntityDiffSummary,
  type ReadOperationalEntityOptions,
  type RunEntityDiffSummary
} from '../../state/sqlite-operational-rows';

export const FR_R7_02_OPERATIONAL_ENTITY_MIGRATION_VERSION = 9 as const;
export const FR_R7_02_OPERATIONAL_ENTITY_MIGRATION_NAME =
  '009_fr_r7_02_operational_per_entity_rows' as const;

export const FR_R7_02_OPERATIONAL_ENTITY_TABLE_NAMES = Object.freeze([
  'operational_queue_meta',
  'operational_tasks',
  'operational_runs'
] as const);

export const OPERATIONAL_QUEUE_DOC_KEY = 'schegent.queue' as const;
export const OPERATIONAL_RUN_DOC_KEY = 'schegent.run' as const;

export const FR_R7_02_OPERATIONAL_ENTITY_DDL: readonly string[] = Object.freeze([
  `CREATE TABLE IF NOT EXISTS operational_queue_meta (
    scope_id TEXT NOT NULL,
    queue_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    in_flight_id TEXT,
    queue_lifecycle TEXT NOT NULL,
    pause_source TEXT,
    paused_reason TEXT,
    scheduled_start_at_ms INTEGER,
    scheduled_start_source TEXT,
    failure_policy TEXT,
    updated_at_ms INTEGER NOT NULL,
    remainder_json TEXT NOT NULL,
    PRIMARY KEY (scope_id, queue_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS operational_tasks (
    scope_id TEXT NOT NULL,
    queue_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    position INTEGER NOT NULL,
    status TEXT NOT NULL,
    run_id TEXT,
    enqueued_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (scope_id, queue_id, task_id)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_operational_tasks_order ON operational_tasks (scope_id, queue_id, position ASC)`,
  `CREATE TABLE IF NOT EXISTS operational_runs (
    scope_id TEXT NOT NULL,
    queue_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    feature_id TEXT NOT NULL,
    status TEXT NOT NULL,
    current_phase TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL,
    last_transition_at_ms INTEGER NOT NULL,
    failure_cause TEXT,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (scope_id, queue_id)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_operational_runs_run_id ON operational_runs (scope_id, run_id)`
]);

/**
 * FR-005 — Transactional Migration 9 backfill: copies existing `schegent.queue` and `schegent.run`
 * documents from `operational_kv_documents` into `operational_queue_meta`, `operational_tasks`,
 * and `operational_runs`, verifies exact row counts and deterministic SHA-256 content digests
 * against the source documents, removes migrated non-empty source KV rows (retaining explicit
 * `{}` empty-map markers so `{}` remains distinct from `undefined`), and throws (rolling back the
 * entire migration transaction) on any parse error, count discrepancy, or digest mismatch.
 */
export function backfillOperationalEntitiesInTx(
  conn: NodeSqliteConnection,
  nowMs: number
): {
  readonly migratedScopes: number;
  readonly migratedQueues: number;
  readonly migratedTasks: number;
  readonly migratedRuns: number;
} {
  const sourceRows = conn.all<{
    doc_namespace: string;
    doc_key: string;
    payload_json: string;
  }>(
    `SELECT doc_namespace, doc_key, payload_json
     FROM operational_kv_documents
     WHERE doc_key IN (?, ?)
     ORDER BY doc_namespace ASC, doc_key ASC`,
    OPERATIONAL_QUEUE_DOC_KEY,
    OPERATIONAL_RUN_DOC_KEY
  );

  const scopesSeen = new Set<string>();
  let migratedQueues = 0;
  let migratedTasks = 0;
  let migratedRuns = 0;

  for (const row of sourceRows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload_json);
    } catch {
      throw new Error(
        `MIGRATION_9_INVALID_SOURCE_JSON: scope '${row.doc_namespace}' key '${row.doc_key}' contains invalid JSON payload`
      );
    }

    if (row.doc_key === OPERATIONAL_QUEUE_DOC_KEY) {
      if (!isOperationalQueueMap(parsed)) {
        continue;
      }

      if (!hasOwnDefinedEntries(parsed)) {
        deleteOperationalQueueScopeInTx(conn, row.doc_namespace);
        continue;
      }

      const sourceDigest = computeCanonicalSha256(parsed);
      const queueEntries = Object.entries(parsed);
      const expectedQueues = queueEntries.length;
      let expectedTasks = 0;
      for (const [, queueObj] of queueEntries) {
        expectedTasks += (queueObj.requests as readonly unknown[]).length;
      }

      deleteOperationalQueueScopeInTx(conn, row.doc_namespace);
      writeOperationalQueueMapDiffInTx(conn, row.doc_namespace, {}, parsed, nowMs);

      const actualQueueCount = Number(
        conn.scalar(
          `SELECT COUNT(*) FROM operational_queue_meta WHERE scope_id = ?`,
          row.doc_namespace
        ) ?? 0
      );
      const actualTaskCount = Number(
        conn.scalar(
          `SELECT COUNT(*) FROM operational_tasks WHERE scope_id = ?`,
          row.doc_namespace
        ) ?? 0
      );
      if (actualQueueCount !== expectedQueues || actualTaskCount !== expectedTasks) {
        throw new Error(
          `MIGRATION_9_COUNT_MISMATCH: scope '${row.doc_namespace}' queues=${actualQueueCount}/${expectedQueues} tasks=${actualTaskCount}/${expectedTasks}`
        );
      }

      const reconstructed = readOperationalQueueMapFromDb(conn, row.doc_namespace);
      const reconstructedDigest = computeCanonicalSha256(reconstructed.map);
      if (reconstructedDigest !== sourceDigest) {
        throw new Error(
          `MIGRATION_9_DIGEST_MISMATCH: scope '${row.doc_namespace}' key '${row.doc_key}' expected=${sourceDigest} actual=${reconstructedDigest}`
        );
      }

      conn.run(
        `DELETE FROM operational_kv_documents WHERE doc_namespace = ? AND doc_key = ?`,
        row.doc_namespace,
        row.doc_key
      );

      scopesSeen.add(row.doc_namespace);
      migratedQueues += expectedQueues;
      migratedTasks += expectedTasks;
    } else if (row.doc_key === OPERATIONAL_RUN_DOC_KEY) {
      if (!isOperationalRunMap(parsed)) {
        continue;
      }

      if (!hasOwnDefinedEntries(parsed)) {
        deleteOperationalRunScopeInTx(conn, row.doc_namespace);
        continue;
      }

      const sourceDigest = computeCanonicalSha256(parsed);
      const expectedRuns = Object.keys(parsed).length;

      deleteOperationalRunScopeInTx(conn, row.doc_namespace);
      writeOperationalRunMapDiffInTx(conn, row.doc_namespace, {}, parsed, nowMs);

      const actualRunCount = Number(
        conn.scalar(
          `SELECT COUNT(*) FROM operational_runs WHERE scope_id = ?`,
          row.doc_namespace
        ) ?? 0
      );
      if (actualRunCount !== expectedRuns) {
        throw new Error(
          `MIGRATION_9_COUNT_MISMATCH: scope '${row.doc_namespace}' runs=${actualRunCount}/${expectedRuns}`
        );
      }

      const reconstructed = readOperationalRunMapFromDb(conn, row.doc_namespace);
      const reconstructedDigest = computeCanonicalSha256(reconstructed.map);
      if (reconstructedDigest !== sourceDigest) {
        throw new Error(
          `MIGRATION_9_DIGEST_MISMATCH: scope '${row.doc_namespace}' key '${row.doc_key}' expected=${sourceDigest} actual=${reconstructedDigest}`
        );
      }

      conn.run(
        `DELETE FROM operational_kv_documents WHERE doc_namespace = ? AND doc_key = ?`,
        row.doc_namespace,
        row.doc_key
      );

      scopesSeen.add(row.doc_namespace);
      migratedRuns += expectedRuns;
    }
  }

  return {
    migratedScopes: scopesSeen.size,
    migratedQueues,
    migratedTasks,
    migratedRuns
  };
}
