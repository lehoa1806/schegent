/**
 * FR-R6-F04 (FR-001..FR-010, FR-024, NFR-005), FR-R6-F01-B, & FR-R6-F03
 * (`finding-persisted-connected-runs-map`) — SQLite operational state backing for
 * `WorkspaceStateStore`.
 *
 * - Commits schema-9 per-entity queue/Task and Run diffs (`operational_queue_meta`,
 *   `operational_tasks`, `operational_runs`), relational projections (`runs`,
 *   `containment_acceptance_bindings`), and non-entity operational keys
 *   (`operational_kv_documents`) in a single serialized `BEGIN IMMEDIATE ... COMMIT`
 *   transaction with monotonic `revision = revision + 1` upserts (Hard Rule 58;
 *   `steps`, `attempts`, `queue_entries`, `execution_summary_revisions`, and SQLite-level
 *   `expectedRevision` CAS belong to `AtomicTransactionUnitsService`).
 * - Imports pre-cutover `context.workspaceState` records once through `MigrationCoordinator`
 *   (`prepare-copy` .. `retain-source`) and fences post-cutover legacy Memento writes with
 *   `PostCutoverMementoWriteForbiddenError` (`post-cutover-memento-write-forbidden`).
 * - Bounds `KEYS.connectedRuns` terminal history at `CONNECTED_RUNS_CACHE_MAX = 512` entries,
 *   90-day retention, and `256 MiB` serialized payload while preserving every non-terminal run.
 * - Supports read-only SQLite snapshot inspection in untrusted or non-primary windows without
 *   creating files, opening mutating connections, or touching `.schegent/`.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 * Zero raw `node:fs` write primitives (docs/hard-rules.md rule 69).
 */

import { isBackendRunnerKind } from '../contracts/backend-kinds';
import { ACCEPTANCE_BINDINGS_KEY } from '../contracts/containment-qualification';
import type { AcceptanceMementoPort } from '../services/containment-qualification/acceptance-bindings';
import type { SanitizedLogger } from '../lib/logger';
import {
  deepFreezeValue,
  freezeSnapshotWithStructuralSharing,
  hasOwnDefinedEntries,
  isDeepEqualJsonValue,
  isPlainRecord,
  parseStrictSchemaMetaVersion,
  setOwnProp,
  toSafeIntOrDefault,
  toStringOrNull
} from '../lib/operational-value-helpers';
import {
  openReadOnlySqliteConnection,
  withZeroMutationReadOnlySqliteConnection,
  type DetachedSqliteWriterConfig,
  type LegacyRunRecordInputPort,
  type OperationalMigrationOutcomePort,
  type SqliteConnectionPort,
  type SqliteOperationalStorePort,
  type StrictReadOnlyContainment
} from './sqlite-operational-port';
import {
  deleteOperationalQueueScopeInTx,
  deleteOperationalRunScopeInTx,
  isOperationalQueueMap,
  isOperationalRunMap,
  readOperationalQueueMapFromDb,
  readOperationalRunMapFromDb,
  writeOperationalQueueMapDiffInTx,
  writeOperationalRunMapDiffInTx
} from './sqlite-operational-rows';
import {
  SQLITE_SCHEMA_CURRENT_VERSION,
  type RunStatus
} from '../contracts/sqlite-store/schema-types';
import {
  CONNECTED_RUNS_REFUSED_MAX_BYTES,
  CONNECTED_RUNS_REFUSED_MAX_COUNT,
  classifyConnectedRunEntry,
  connectedRunLastUpdatedMs,
  deepFreezeConnectedRunsDocument,
  isConnectedRunTerminal,
  migrateConnectedRuns,
  selectPreservedRefusedEntries,
  serializedConnectedRunBytes
} from './connected-run-migrator';
export { CONNECTED_RUNS_REFUSED_MAX_BYTES, CONNECTED_RUNS_REFUSED_MAX_COUNT };
import type { ConnectedWorkflowRun } from './connected-workflow-run';
import { isTerminalRunStatus, type WorkflowRun } from './workflow-run';
import type { MementoBatchEntry } from './memento-write-gate';
import { KEYS, QueueMutationRejected, type Memento } from './workspace-state';

/** F03 authority bound for `finding-persisted-connected-runs-map` (`target-sqlite-run-step-attempt-history`). */
export const CONNECTED_RUNS_CACHE_MAX = 512;
export const CONNECTED_RUNS_TERMINAL_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
export const CONNECTED_RUNS_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

const EXTRA_IMPORTED_MEMENTO_KEYS: readonly string[] = Object.freeze([
  ACCEPTANCE_BINDINGS_KEY
]);

/**
 * FR-R6-F04 (§Scope & policy, L80) — cross-window ownership/fencing leases and per-window
 * operator attribution remain on the existing ownership/Memento mechanism outside SQLite
 * operational migration so primacy election (`lock.tryAcquire()`), non-primary attribution,
 * and post-disposable lock teardown (`executionLeases.releaseAll()` / `lock.release()`)
 * operate across windows without circular SQLite writer authority.
 */
const PASSTHROUGH_OWNERSHIP_KEYS: ReadonlySet<string> = new Set([
  KEYS.lock,
  KEYS.executionLeases,
  KEYS.operatorPseudonym
]);

export class PostCutoverMementoWriteForbiddenError extends Error {
  public readonly code = 'post-cutover-memento-write-forbidden' as const;

  public constructor(key: string, scopeId: string) {
    super(
      `Refused legacy Memento write for '${key}' in scope '${scopeId}': SQLite store is authoritative (post-cutover-memento-write-forbidden).`
    );
    this.name = 'PostCutoverMementoWriteForbiddenError';
  }
}

/**
 * The cutover migration stopped before SQLite authority was published (F04-FR-15). The legacy
 * Memento stays authoritative; attaching SQLite over a partial store is refused.
 */
export class SqliteCutoverMigrationIncompleteError extends Error {
  public readonly code = 'sqlite-cutover-migration-incomplete' as const;

  public constructor(scopeId: string, stage: string) {
    super(
      `Refused to attach SQLite for scope '${scopeId}': cutover migration stopped at stage '${stage}' (sqlite-cutover-migration-incomplete).`
    );
    this.name = 'SqliteCutoverMigrationIncompleteError';
  }
}

function mapWorkflowStatusToSqlite(status: string | undefined): RunStatus {
  switch (status) {
    case 'running':
      return 'running';
    case 'paused':
      return 'paused';
    case 'completed':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'cancelled';
    default:
      return 'queued';
  }
}

function collectActiveFeatureIds(
  liveRunMap: Readonly<Record<string, WorkflowRun | undefined>> | unknown
): ReadonlySet<string> {
  const activeFeatureIds = new Set<string>();
  if (liveRunMap === null || typeof liveRunMap !== 'object' || Array.isArray(liveRunMap)) return activeFeatureIds;
  const rec = liveRunMap as Record<string, unknown>;
  if (Object.hasOwn(rec, 'id') && typeof rec.id === 'string' && typeof rec.status === 'string' && typeof rec.featureId === 'string') {
    if (!isTerminalRunStatus(rec.status as WorkflowRun['status'])) activeFeatureIds.add(rec.featureId);
    return activeFeatureIds;
  }
  for (const live of Object.values(rec)) {
    if (live === null || typeof live !== 'object' || Array.isArray(live)) continue;
    const entry = live as Record<string, unknown>;
    if (typeof entry.featureId === 'string' && typeof entry.status === 'string' && !isTerminalRunStatus(entry.status as WorkflowRun['status'])) {
      activeFeatureIds.add(entry.featureId);
    }
  }
  return activeFeatureIds;
}

export function pruneConnectedRunsMap(
  rawValue: unknown,
  liveRunMap: Readonly<Record<string, WorkflowRun | undefined>>,
  nowMs: number,
  logger?: SanitizedLogger
): Record<string, unknown> | unknown {
  if (!isPlainRecord(rawValue) || Object.keys(rawValue).length === 0) return rawValue;

  const migrated = migrateConnectedRuns(rawValue);
  const activeFeatureIds = collectActiveFeatureIds(liveRunMap);
  const nonTerminal: Array<readonly [string, ConnectedWorkflowRun, number]> = [];
  const terminal: Array<{
    readonly id: string;
    readonly run: ConnectedWorkflowRun;
    readonly updatedAtMs: number;
    readonly bytes: number;
  }> = [];

  for (const [id, run] of Object.entries(migrated.runs)) {
    const bytes = serializedConnectedRunBytes(run);
    if (!isConnectedRunTerminal(run, activeFeatureIds)) {
      nonTerminal.push([id, run, bytes]);
      continue;
    }
    const updatedAtMs = connectedRunLastUpdatedMs(run);
    if (updatedAtMs > 0 && nowMs - updatedAtMs > CONNECTED_RUNS_TERMINAL_RETENTION_MS) continue;
    terminal.push({ id, run, updatedAtMs, bytes });
  }

  // Sort terminal runs newest-first so we keep the most recent valid entries within count & byte caps.
  terminal.sort((a, b) => b.updatedAtMs - a.updatedAtMs || b.id.localeCompare(a.id));

  const maxTerminalCount = Math.max(0, CONNECTED_RUNS_CACHE_MAX - nonTerminal.length);
  let totalBytes = nonTerminal.reduce((acc, item) => acc + item[2], 0);
  const kept: Record<string, unknown> = {};
  const refusedSelection = selectPreservedRefusedEntries(
    migrated.refused,
    Math.max(0, CONNECTED_RUNS_MAX_TOTAL_BYTES - totalBytes)
  );
  for (const [id, rawRefused] of refusedSelection.entries) setOwnProp(kept, id, rawRefused);
  totalBytes += refusedSelection.totalBytes;
  if (refusedSelection.quarantinedUnsafeCount + refusedSelection.quarantinedBudgetCount > 0) {
    logger?.warn('quarantined refused connectedRuns entries during prune', {
      unsafeCount: refusedSelection.quarantinedUnsafeCount,
      budgetCount: refusedSelection.quarantinedBudgetCount,
      keys: refusedSelection.quarantinedKeys
    });
  }
  for (const [id, run] of nonTerminal) setOwnProp(kept, id, run);

  let keptTerminal = 0;
  for (const candidate of terminal) {
    if (keptTerminal >= maxTerminalCount) break;
    if (totalBytes + candidate.bytes > CONNECTED_RUNS_MAX_TOTAL_BYTES) continue;
    setOwnProp(kept, candidate.id, candidate.run);
    totalBytes += candidate.bytes;
    keptTerminal += 1;
  }

  return kept;
}

export class SqliteOperationalBacking {
  private readonly cache = new Map<string, unknown>();
  private readonly kvDocKeysPresent = new Set<string>();
  public readonly migrationOutcome: OperationalMigrationOutcomePort | null;

  public constructor(
    public readonly store: SqliteOperationalStorePort,
    public readonly scopeId: string,
    legacyMemento: Memento,
    private readonly nowMs: () => number = () => Date.now(),
    private readonly logger?: SanitizedLogger
  ) {
    this.migrationOutcome = this.importIfNeeded(legacyMemento);
    this.reloadCacheFromSqlite();
  }

  /**
   * FR-R7-02 (FR-007) — returns a deeply frozen snapshot view directly from cache without
   * whole-document `structuredClone`, while preventing callers from mutating internal cache state.
   */
  public get<T>(key: string): T | undefined {
    if (!this.cache.has(key)) return undefined;
    return this.cache.get(key) as T | undefined;
  }

  public exportSnapshot(): Map<string, unknown> {
    return new Map<string, unknown>(this.cache);
  }

  public update(key: string, value: unknown): void {
    this.updateBatch([{ key, value }]);
  }

  /**
   * FR-R7-01 & FR-R7-02 — commit operational keys atomically in one `BEGIN IMMEDIATE ... COMMIT`
   * SQLite transaction (Hard Rule 58). Queue/Task (`KEYS.queue`) and Run (`KEYS.run`) maps write
   * only changed per-entity rows (`operational_queue_meta`, `operational_tasks`, `operational_runs`)
   * plus changed relational projections. Updates `this.cache` with frozen structurally-shared views
   * only after `COMMIT` succeeds; any failure rolls back all SQL writes and leaves `this.cache` unchanged.
   */
  public updateBatch(entries: readonly MementoBatchEntry[]): void {
    if (entries.length === 0) return;
    const conn = this.store.writerConnection;
    const now = this.nowMs();
    let runEntry: MementoBatchEntry | undefined;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i]!.key === KEYS.run) {
        runEntry = entries[i];
        break;
      }
    }
    const liveRuns =
      ((runEntry !== undefined ? runEntry.value : this.cache.get(KEYS.run)) as
        | Readonly<Record<string, WorkflowRun | undefined>>
        | undefined) ?? {};

    // Pre-freeze snapshots before BEGIN IMMEDIATE so depth/cycle/clone validation fails
    // cleanly before SQLite commits and post-commit cache publication is infallible.
    const prepared = entries.map(({ key, value }) => {
      const effectiveValue =
        key === KEYS.connectedRuns && value !== undefined
          ? pruneConnectedRunsMap(value, liveRuns, now, this.logger)
          : value;
      return {
        key,
        value:
          effectiveValue === undefined
            ? undefined
            : freezeSnapshotWithStructuralSharing(effectiveValue)
      };
    });

    const txCache = new Map<string, unknown>(this.cache);
    const txKvKeys = new Set<string>(this.kvDocKeysPresent);

    conn.exec('BEGIN IMMEDIATE');
    try {
      for (const { key, value: effectiveValue } of prepared) {
        const prevValue = txCache.get(key);
        if ((key === KEYS.controlLedger || key === KEYS.connectedRuns) &&
            prevValue !== undefined && !isPlainRecord(prevValue) && effectiveValue !== undefined) {
          throw new Error(key === KEYS.controlLedger ? 'control-ledger-corrupt' : 'connected-run-refused');
        }
        if (effectiveValue === undefined) {
          if (key === KEYS.queue) deleteOperationalQueueScopeInTx(conn, this.scopeId);
          else if (key === KEYS.run) deleteOperationalRunScopeInTx(conn, this.scopeId);
          this.deleteKvDocInTx(conn, key);
          txKvKeys.delete(key);
          txCache.delete(key);
        } else if (
          key === KEYS.queue &&
          isOperationalQueueMap(effectiveValue) &&
          hasOwnDefinedEntries(effectiveValue)
        ) {
          const fromKv = txKvKeys.has(key);
          const prevValid = !fromKv && isOperationalQueueMap(prevValue);
          if (!prevValid) deleteOperationalQueueScopeInTx(conn, this.scopeId);
          writeOperationalQueueMapDiffInTx(conn, this.scopeId, prevValid ? prevValue : {}, effectiveValue, now);
          if (fromKv) {
            this.deleteKvDocInTx(conn, key);
            txKvKeys.delete(key);
          }
          txCache.set(key, effectiveValue);
        } else if (
          key === KEYS.run &&
          isOperationalRunMap(effectiveValue) &&
          hasOwnDefinedEntries(effectiveValue)
        ) {
          const fromKv = txKvKeys.has(key);
          const prevValid = !fromKv && isOperationalRunMap(prevValue);
          if (!prevValid) deleteOperationalRunScopeInTx(conn, this.scopeId);
          const diff = writeOperationalRunMapDiffInTx(conn, this.scopeId, prevValid ? prevValue : {}, effectiveValue, now);
          if (fromKv) {
            this.deleteKvDocInTx(conn, key);
            txKvKeys.delete(key);
          }
          this.projectRunEntriesInTx(conn, diff.changedRuns, now);
          txCache.set(key, effectiveValue);
        } else {
          if (key === KEYS.queue) deleteOperationalQueueScopeInTx(conn, this.scopeId);
          else if (key === KEYS.run) deleteOperationalRunScopeInTx(conn, this.scopeId);
          this.upsertKvDocInTx(conn, key, effectiveValue, now);
          txKvKeys.add(key);
          this.projectRelationalStateInTx(conn, key, effectiveValue, prevValue, now);
          txCache.set(key, effectiveValue);
        }
      }
      conn.exec('COMMIT');
    } catch (error) {
      try {
        conn.exec('ROLLBACK');
      } catch {
        // Ignore rollback failure.
      }
      throw error;
    }

    this.kvDocKeysPresent.clear();
    for (const k of txKvKeys) this.kvDocKeysPresent.add(k);
    for (const { key, value: frozenValue } of prepared) {
      if (frozenValue === undefined) this.cache.delete(key);
      else this.cache.set(key, frozenValue);
    }
    this.store.writerCoordinator.afterCommit();
  }

  private importIfNeeded(legacyMemento: Memento): OperationalMigrationOutcomePort | null {
    const sentinel = this.store.cutoverGuard.getSentinel(this.scopeId);
    if (sentinel && (sentinel.authority === 'sqlite' || sentinel.authority === 'retired_legacy')) {
      return null;
    }

    const legacyRunRecords: LegacyRunRecordInputPort[] = [];
    const runMapRaw = legacyMemento.get<unknown>(KEYS.run);
    if (runMapRaw !== null && typeof runMapRaw === 'object' && !Array.isArray(runMapRaw)) {
      for (const [queueId, rawRun] of Object.entries(runMapRaw as Record<string, unknown>)) {
        if (rawRun === null || typeof rawRun !== 'object') continue;
        const run = rawRun as Partial<WorkflowRun>;
        if (typeof run.id === 'string' && run.id.length > 0) {
          legacyRunRecords.push({
            recordKey: `run:${queueId}:${run.id}`,
            rawJson: JSON.stringify({
              schemaVersion: 1,
              runId: run.id,
              workspaceId: this.scopeId,
              workflowId: run.pipeline?.id ?? 'default-pipeline',
              status: mapWorkflowStatusToSqlite(run.status),
              revision: 1,
              createdAtMs: typeof run.startedAt === 'number' ? run.startedAt : this.nowMs(),
              updatedAtMs: typeof run.lastTransitionAt === 'number' ? run.lastTransitionAt : this.nowMs()
            })
          });
        }
      }
    }

    const allKeys = [...Object.values(KEYS), ...EXTRA_IMPORTED_MEMENTO_KEYS].filter(
      (k) => !PASSTHROUGH_OWNERSHIP_KEYS.has(k)
    );
    const liveRuns =
      runMapRaw !== null && typeof runMapRaw === 'object' && !Array.isArray(runMapRaw)
        ? (runMapRaw as Readonly<Record<string, WorkflowRun | undefined>>)
        : {};

    const migrationId = `f04-cutover-${this.scopeId}`;
    const outcome = this.store.migration.runMigrationThroughRetainSource({
      migrationId,
      scopeId: this.scopeId,
      runRecords: legacyRunRecords,
      importOperationalDocuments: (conn) => {
        this.copyLegacyDocumentsInTx(conn, legacyMemento, allKeys, liveRuns, this.nowMs());
      }
    });

    if (!outcome.completed) {
      this.logger?.warn('sqlite cutover migration incomplete', {
        stage: outcome.currentStage,
        quarantined: outcome.quarantinedRecords
      });
    }
    return outcome;
  }

  /**
   * Copies every non-run legacy key into SQLite inside the migration's `import` stage transaction.
   * Queue/Task and Run maps write directly to schema-9 per-entity tables; remaining keys write to
   * `operational_kv_documents`. Legacy is still authoritative here, so a retried import replaces
   * an earlier committed copy and removes keys the legacy source no longer holds.
   */
  private copyLegacyDocumentsInTx(
    conn: SqliteConnectionPort,
    legacyMemento: Memento,
    keys: readonly string[],
    liveRuns: Readonly<Record<string, WorkflowRun | undefined>>,
    now: number
  ): void {
    for (const key of keys) {
      const rawVal = legacyMemento.get<unknown>(key);
      if (rawVal === undefined) {
        if (key === KEYS.queue) deleteOperationalQueueScopeInTx(conn, this.scopeId);
        else if (key === KEYS.run) deleteOperationalRunScopeInTx(conn, this.scopeId);
        this.deleteKvDocInTx(conn, key);
        continue;
      }
      const effectiveVal =
        key === KEYS.connectedRuns ? pruneConnectedRunsMap(rawVal, liveRuns, now, this.logger) : rawVal;
      if (key === KEYS.queue && isOperationalQueueMap(effectiveVal) && hasOwnDefinedEntries(effectiveVal)) {
        deleteOperationalQueueScopeInTx(conn, this.scopeId);
        writeOperationalQueueMapDiffInTx(conn, this.scopeId, {}, effectiveVal, now);
        this.deleteKvDocInTx(conn, key);
        continue;
      }
      if (key === KEYS.run && isOperationalRunMap(effectiveVal) && hasOwnDefinedEntries(effectiveVal)) {
        deleteOperationalRunScopeInTx(conn, this.scopeId);
        const diff = writeOperationalRunMapDiffInTx(conn, this.scopeId, {}, effectiveVal, now);
        this.deleteKvDocInTx(conn, key);
        this.projectRunEntriesInTx(conn, diff.changedRuns, now);
        continue;
      }
      if (key === KEYS.queue) deleteOperationalQueueScopeInTx(conn, this.scopeId);
      else if (key === KEYS.run) deleteOperationalRunScopeInTx(conn, this.scopeId);
      this.upsertKvDocInTx(conn, key, effectiveVal, now);
      this.projectRelationalStateInTx(conn, key, effectiveVal, undefined, now);
    }
  }

  private deleteKvDocInTx(conn: SqliteConnectionPort, key: string): void {
    conn.run(`DELETE FROM operational_kv_documents WHERE doc_namespace = ? AND doc_key = ?`, this.scopeId, key);
  }

  private upsertKvDocInTx(conn: SqliteConnectionPort, key: string, value: unknown, now: number): void {
    const json = JSON.stringify(value);
    conn.run(
      `INSERT INTO operational_kv_documents (
        doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms
      ) VALUES (?, ?, 1, 1, ?, ?, 0, ?)
      ON CONFLICT(doc_namespace, doc_key) DO UPDATE SET
        revision = operational_kv_documents.revision + 1,
        payload_json = excluded.payload_json,
        payload_bytes = excluded.payload_bytes,
        updated_at_ms = excluded.updated_at_ms`,
      this.scopeId,
      key,
      json,
      Buffer.byteLength(json, 'utf8'),
      now
    );
  }

  public reloadCacheFromSqlite(): void {
    const conn = this.store.writerConnection;
    const nextCache = new Map<string, unknown>();
    const nextKvKeys = new Set<string>();
    const onCorruptRow = ({ table, queueId }: { readonly table: string; readonly queueId: string }): void => {
      this.logger?.warn('corrupt operational entity row skipped', { table, queueId });
    };
    conn.exec('BEGIN');
    try {
      const rows = conn.all<{ doc_key: string; payload_json: string }>(
        `SELECT doc_key, payload_json FROM operational_kv_documents WHERE doc_namespace = ?`,
        this.scopeId
      );
      for (const row of rows) {
        nextKvKeys.add(row.doc_key);
        try {
          const parsed: unknown = JSON.parse(row.payload_json);
          if (row.doc_key === KEYS.connectedRuns) {
            const frozen = deepFreezeConnectedRunsDocument(parsed);
            nextCache.set(row.doc_key, frozen.value);
            if (frozen.quarantinedCount > 0) {
              this.logger?.warn('quarantined unfreezable connectedRuns entries on reload', {
                count: frozen.quarantinedCount,
                keys: frozen.quarantinedKeys
              });
            }
          } else {
            nextCache.set(row.doc_key, deepFreezeValue(parsed));
          }
        } catch {
          // Keep presence distinct from absence without copying corrupt bytes into another sink.
          if (row.doc_key === KEYS.connectedRuns || row.doc_key === KEYS.controlLedger) nextCache.set(row.doc_key, null);
          this.logger?.warn('corrupt operational_kv_documents payload skipped', { key: row.doc_key });
        }
      }
      const queueRes = readOperationalQueueMapFromDb(conn, this.scopeId, { onCorruptRow });
      if (queueRes.present) nextCache.set(KEYS.queue, deepFreezeValue(queueRes.map));
      const runRes = readOperationalRunMapFromDb(conn, this.scopeId, { onCorruptRow });
      if (runRes.present) nextCache.set(KEYS.run, deepFreezeValue(runRes.map));
    } finally {
      try {
        conn.exec('COMMIT');
      } catch {
        // Ignore read-transaction close error.
      }
    }
    this.cache.clear();
    for (const [k, v] of nextCache) this.cache.set(k, v);
    this.kvDocKeysPresent.clear();
    for (const k of nextKvKeys) this.kvDocKeysPresent.add(k);
  }

  private projectRunEntriesInTx(
    conn: SqliteConnectionPort,
    entries: readonly (readonly [string, Record<string, unknown>])[],
    now: number
  ): void {
    for (const [queueId, rawCandidate] of entries) {
      const candidate = rawCandidate as unknown as WorkflowRun | undefined;
      if (!candidate || typeof candidate.id !== 'string') continue;
      const sqlStatus = mapWorkflowStatusToSqlite(candidate.status);
      const workflowId = toStringOrNull(candidate.pipeline?.id) ?? 'default-pipeline';
      const createdAt = toSafeIntOrDefault(candidate.startedAt, now);
      const updatedAt = toSafeIntOrDefault(candidate.lastTransitionAt, now);
      const completedAt = isTerminalRunStatus(candidate.status) ? updatedAt : null;
      const invocationCount = Array.isArray(candidate.phasesCompleted) ? candidate.phasesCompleted.length : 0;

      conn.run(
        `INSERT INTO runs (
          run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
          current_step_id, started_at_ms, completed_at_ms, terminal_reason, created_at_ms, updated_at_ms,
          queue_id, invocation_count
        ) VALUES (?, ?, ?, NULL, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          status = excluded.status,
          revision = runs.revision + 1,
          current_step_id = excluded.current_step_id,
          completed_at_ms = excluded.completed_at_ms,
          terminal_reason = excluded.terminal_reason,
          updated_at_ms = excluded.updated_at_ms,
          queue_id = excluded.queue_id,
          invocation_count = excluded.invocation_count`,
        candidate.id,
        this.scopeId,
        workflowId,
        sqlStatus,
        toStringOrNull(candidate.currentPhase),
        createdAt,
        completedAt,
        toStringOrNull(candidate.failureCause),
        createdAt,
        updatedAt,
        queueId,
        invocationCount
      );
    }
  }

  private projectRelationalStateInTx(
    conn: SqliteConnectionPort,
    key: string,
    value: unknown,
    previousValue: unknown,
    now: number
  ): void {
    if (key === KEYS.run && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const rec = value as Record<string, unknown>;
      if (
        Object.hasOwn(rec, 'id') &&
        Object.hasOwn(rec, 'status') &&
        Object.hasOwn(rec, 'currentPhase') &&
        typeof rec.id === 'string' &&
        typeof rec.status === 'string' &&
        typeof rec.currentPhase === 'string'
      ) {
        this.projectRunEntriesInTx(conn, [['default', rec]], now);
      } else if (isOperationalRunMap(value)) {
        const entries = Object.entries(value).filter(
          (pair): pair is [string, Record<string, unknown>] => (pair[1] as unknown) !== undefined
        );
        this.projectRunEntriesInTx(conn, entries, now);
      }
    } else if (
      key === KEYS.connectedRuns &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      const prevMap =
        previousValue !== null && typeof previousValue === 'object' && !Array.isArray(previousValue)
          ? (previousValue as Record<string, unknown>)
          : undefined;
      const emptyActive = new Set<string>();
      for (const [id, rawWfRun] of Object.entries(value as Record<string, unknown>)) {
        const prevEntry = prevMap && Object.hasOwn(prevMap, id) ? prevMap[id] : undefined;
        if (
          prevEntry !== undefined &&
          (prevEntry === rawWfRun || isDeepEqualJsonValue(prevEntry, rawWfRun))
        ) {
          continue;
        }
        const classified = classifyConnectedRunEntry(id, rawWfRun);
        if (!classified.ok) continue;
        const wfRun = classified.run;
        const isTerm = isConnectedRunTerminal(wfRun, emptyActive);
        let wfStatus: RunStatus = isTerm ? 'succeeded' : 'running';
        if (wfRun.invocations !== undefined) {
          const rootFrame = Object.values(wfRun.invocations).find((f) => f.parentInvocationId === null);
          if (rootFrame !== undefined) {
            if (rootFrame.status === 'failed') wfStatus = 'failed';
            else if (rootFrame.status === 'canceled') wfStatus = 'cancelled';
            else if (rootFrame.status === 'paused' || rootFrame.status === 'waiting-for-handoff') wfStatus = 'paused';
            else if (rootFrame.status === 'completed') wfStatus = 'succeeded';
          }
        }
        const createdAt = toSafeIntOrDefault(wfRun.startedAt, now);
        const updatedAt = Math.max(createdAt, connectedRunLastUpdatedMs(wfRun));
        conn.run(
          `INSERT INTO runs (
            run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
            current_step_id, started_at_ms, completed_at_ms, terminal_reason, created_at_ms, updated_at_ms,
            queue_id
          ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)
          ON CONFLICT(run_id) DO UPDATE SET
            status = excluded.status,
            revision = MAX(runs.revision, excluded.revision),
            completed_at_ms = excluded.completed_at_ms,
            updated_at_ms = excluded.updated_at_ms,
            queue_id = COALESCE(excluded.queue_id, runs.queue_id)`,
          wfRun.connectedRunId,
          this.scopeId,
          toStringOrNull(wfRun.workflowId) ?? 'default-workflow',
          wfStatus,
          Math.max(1, toSafeIntOrDefault(wfRun.revision, 1)),
          createdAt,
          isTerm ? updatedAt : null,
          createdAt,
          updatedAt,
          toStringOrNull(wfRun.queueId)
        );
      }
    } else if (
      key === ACCEPTANCE_BINDINGS_KEY &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      const record = value as { bindings?: Record<string, unknown> };
      if (record.bindings && typeof record.bindings === 'object') {
        for (const [backendKind, entry] of Object.entries(record.bindings)) {
          if (!isBackendRunnerKind(backendKind)) continue;
          if (!entry || typeof entry !== 'object') continue;
          const typed = entry as {
            boundAt?: string;
            origin?: string;
            fingerprint?: { digest?: string };
          };
          const digest = typed.fingerprint?.digest;
          if (typeof digest !== 'string' || digest.length !== 64) continue;
          const origin = typed.origin === 'legacy-first-use' ? 'legacy-first-use' : 'consent';
          conn.run(
            `INSERT INTO containment_acceptance_bindings (
              backend_kind, fingerprint_sha256, origin, fingerprint_json, bound_at_utc, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(backend_kind) DO UPDATE SET
              fingerprint_sha256 = excluded.fingerprint_sha256,
              origin = excluded.origin,
              fingerprint_json = excluded.fingerprint_json,
              bound_at_utc = excluded.bound_at_utc,
              updated_at_ms = excluded.updated_at_ms`,
            backendKind,
            digest,
            origin,
            JSON.stringify(typed.fingerprint),
            typeof typed.boundAt === 'string' ? typed.boundAt : new Date(now).toISOString(),
            now
          );
        }
      }
    }
  }
}

export interface SwitchableOperationalMementoOptions {
  readonly requireDurableBatch?: boolean | undefined;
}

export interface SwitchableOperationalMemento extends Memento, AcceptanceMementoPort {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
  updateBatch(entries: readonly MementoBatchEntry[]): Promise<void>;
  requireDurableBatch(reason?: string): void;
  setDurableBatchUnavailableReason(reason: string | null): void;
  attachSqlite(
    store: SqliteOperationalStorePort,
    scopeId: string,
    nowMs?: () => number
  ): SqliteOperationalBacking;
  attachReadOnlySnapshotIfPresent(
    databasePath: string,
    scopeId: string,
    openReadOnlyConnectionOrContainment?:
      | ((databasePath: string) => SqliteConnectionPort)
      | StrictReadOnlyContainment
  ): boolean;
  attachReadOnlySnapshotIfPresentAsync(
    rootDir: string,
    relativeDirSegments: readonly string[],
    dbFileName: string,
    scopeId: string,
    shouldCommit?: () => boolean
  ): Promise<boolean>;
  configureDetachedTrustedSqliteWriter(config: DetachedSqliteWriterConfig | null): void;
  reloadSqliteCache(): void;
  detachSqlite(expectedStore?: SqliteOperationalStorePort): void;
  isSqliteAttached(): boolean;
  isPostCutoverAuthorityActive(): boolean;
}

function isSameSerializedState(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return isDeepEqualJsonValue(a, b);
  } catch {
    return false;
  }
}

function readOperationalSnapshotFromConnection(
  roConn: SqliteConnectionPort,
  scopeId: string
): Map<string, unknown> | null {
  roConn.exec('BEGIN');
  try {
    const minReaderRow = roConn.get<{ meta_value: string }>(
      `SELECT meta_value FROM schema_meta WHERE meta_key = 'min_reader_version'`
    );
    if (minReaderRow !== undefined) {
      const floor = parseStrictSchemaMetaVersion(minReaderRow.meta_value);
      if (floor === null || floor > SQLITE_SCHEMA_CURRENT_VERSION) return null;
    }
    const sentinel = roConn.get<{ authority: string }>(
      `SELECT authority FROM cutover_sentinel WHERE scope_id = ?`,
      scopeId
    );
    if (!sentinel || (sentinel.authority !== 'sqlite' && sentinel.authority !== 'retired_legacy')) {
      return null;
    }
    const rows = roConn.all<{ doc_key: string; payload_json: string }>(
      `SELECT doc_key, payload_json FROM operational_kv_documents WHERE doc_namespace = ?`,
      scopeId
    );
    const snapshot = new Map<string, unknown>();
    for (const row of rows) {
      try {
        const parsed: unknown = JSON.parse(row.payload_json);
        const frozen =
          row.doc_key === KEYS.connectedRuns
            ? deepFreezeConnectedRunsDocument(parsed).value
            : deepFreezeValue(parsed);
        snapshot.set(row.doc_key, frozen);
      } catch {
        if (row.doc_key === KEYS.connectedRuns || row.doc_key === KEYS.controlLedger) snapshot.set(row.doc_key, null);
      }
    }
    const hasEntityTables =
      roConn.get<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operational_queue_meta'`
      ) !== undefined;
    if (hasEntityTables) {
      const ignoreCorrupt = { onCorruptRow: () => undefined };
      const queueRes = readOperationalQueueMapFromDb(roConn, scopeId, ignoreCorrupt);
      if (queueRes.present) snapshot.set(KEYS.queue, deepFreezeValue(queueRes.map));
      const runRes = readOperationalRunMapFromDb(roConn, scopeId, ignoreCorrupt);
      if (runRes.present) snapshot.set(KEYS.run, deepFreezeValue(runRes.map));
    }
    return snapshot;
  } finally {
    try {
      roConn.exec('COMMIT');
    } catch {
      // Ignore read-transaction close error.
    }
  }
}

export function createSwitchableOperationalMemento(
  legacyMemento: Memento,
  logger?: SanitizedLogger,
  options?: SwitchableOperationalMementoOptions
): SwitchableOperationalMemento {
  let activeSqlite: SqliteOperationalBacking | null = null;
  let readOnlyCache: Map<string, unknown> | null = null;
  let postCutoverScopeId: string | null = null;
  let detachedWriter: DetachedSqliteWriterConfig | null = null;
  let durableBatchRequired = options?.requireDurableBatch === true;
  let durableBatchUnavailableReason: string | null = null;
  let stateEpoch = 0;

  const currentActiveSqlite = (): SqliteOperationalBacking | null => activeSqlite;
  const canUseDetachedWriter = async (writer: DetachedSqliteWriterConfig): Promise<boolean> => {
    try {
      return (await writer.canWrite()) === true;
    } catch {
      return false;
    }
  };
  const writeViaDetachedOrThrow = async (
    scope: string,
    keyLabel: string,
    apply: (backing: SqliteOperationalBacking) => void
  ): Promise<void> => {
    const writer = detachedWriter;
    if (writer === null || writer.scopeId !== scope || !(await canUseDetachedWriter(writer))) {
      throw new PostCutoverMementoWriteForbiddenError(keyLabel, scope);
    }
    const live = currentActiveSqlite();
    if (live !== null && postCutoverScopeId === scope) {
      apply(live);
      return;
    }
    if (detachedWriter !== writer || postCutoverScopeId !== scope) {
      throw new PostCutoverMementoWriteForbiddenError(keyLabel, scope);
    }
    const transient = writer.openStore(writer.databasePath);
    try {
      const backing = new SqliteOperationalBacking(transient, scope, legacyMemento, () => Date.now(), logger);
      apply(backing);
      stateEpoch += 1;
      readOnlyCache = backing.exportSnapshot();
    } finally {
      transient.close();
    }
  };

  return {
    get<T>(key: string): T | undefined {
      if (PASSTHROUGH_OWNERSHIP_KEYS.has(key)) {
        return legacyMemento.get<T>(key);
      }
      if (activeSqlite !== null) {
        return activeSqlite.get<T>(key);
      }
      if (readOnlyCache !== null) {
        return readOnlyCache.get(key) as T | undefined;
      }
      return legacyMemento.get<T>(key);
    },

    async update(key: string, value: unknown): Promise<void> {
      if (PASSTHROUGH_OWNERSHIP_KEYS.has(key)) {
        await legacyMemento.update(key, value);
        return;
      }
      if (activeSqlite !== null) {
        activeSqlite.update(key, value);
        return;
      }
      if (postCutoverScopeId !== null) {
        if (readOnlyCache !== null && isSameSerializedState(readOnlyCache.get(key), value)) {
          return;
        }
        await writeViaDetachedOrThrow(postCutoverScopeId, key, (b) => b.update(key, value));
        return;
      }
      if (durableBatchRequired && key === KEYS.controlLedger) {
        const detail = durableBatchUnavailableReason ? ` (${durableBatchUnavailableReason})` : '';
        throw new QueueMutationRejected(
          'durable-store-unavailable',
          `Refused operational write for ${key}: durable SQLite store is unavailable${detail}.`
        );
      }
      await legacyMemento.update(key, value);
    },

    async updateBatch(entries: readonly MementoBatchEntry[]): Promise<void> {
      if (entries.length === 0) return;
      const passthroughEntries = entries.filter((entry) => PASSTHROUGH_OWNERSHIP_KEYS.has(entry.key));
      const operationalEntries = entries.filter((entry) => !PASSTHROUGH_OWNERSHIP_KEYS.has(entry.key));
      const appliedLegacy: Array<{ readonly key: string; readonly previous: unknown }> = [];
      const applyLegacyWithRollback = async (batch: readonly MementoBatchEntry[]): Promise<void> => {
        for (const entry of batch) {
          const previous = legacyMemento.get<unknown>(entry.key);
          try {
            await legacyMemento.update(entry.key, entry.value);
            appliedLegacy.push({ key: entry.key, previous });
          } catch (error) {
            for (let i = appliedLegacy.length - 1; i >= 0; i -= 1) {
              const prior = appliedLegacy[i]!;
              try {
                await legacyMemento.update(prior.key, prior.previous);
              } catch {
                // Best-effort compensating rollback on pre-cutover legacy Memento.
              }
            }
            throw error;
          }
        }
      };
      if (operationalEntries.length > 0) {
        if (activeSqlite !== null) {
          activeSqlite.updateBatch(operationalEntries);
        } else if (postCutoverScopeId !== null) {
          const allUnchanged =
            readOnlyCache !== null &&
            operationalEntries.every((entry) =>
              isSameSerializedState(readOnlyCache?.get(entry.key), entry.value)
            );
          if (!allUnchanged) {
            await writeViaDetachedOrThrow(
              postCutoverScopeId,
              operationalEntries.map((entry) => entry.key).join('+'),
              (b) => b.updateBatch(operationalEntries)
            );
          }
        } else if (durableBatchRequired) {
          const detail = durableBatchUnavailableReason ? ` (${durableBatchUnavailableReason})` : '';
          throw new QueueMutationRejected(
            'durable-store-unavailable',
            `Refused atomic operational batch write for ${operationalEntries.map((entry) => entry.key).join('+')}: durable SQLite store is unavailable${detail}.`
          );
        } else {
          await applyLegacyWithRollback(operationalEntries);
        }
      }
      if (passthroughEntries.length > 0) {
        await applyLegacyWithRollback(passthroughEntries);
      }
    },

    requireDurableBatch(reason?: string): void {
      durableBatchRequired = true;
      if (reason !== undefined) {
        durableBatchUnavailableReason = reason;
      }
    },

    setDurableBatchUnavailableReason(reason: string | null): void {
      durableBatchUnavailableReason = reason;
    },

    attachSqlite(
      store: SqliteOperationalStorePort,
      scopeId: string,
      nowMs: () => number = () => Date.now()
    ): SqliteOperationalBacking {
      if (activeSqlite !== null && activeSqlite.store === store && activeSqlite.scopeId === scopeId) {
        return activeSqlite;
      }
      const backing = new SqliteOperationalBacking(store, scopeId, legacyMemento, nowMs, logger);
      const outcome = backing.migrationOutcome;
      if (outcome !== null && !outcome.completed) {
        throw new SqliteCutoverMigrationIncompleteError(scopeId, outcome.currentStage);
      }
      stateEpoch += 1;
      readOnlyCache = null;
      activeSqlite = backing;
      postCutoverScopeId = scopeId;
      durableBatchUnavailableReason = null;
      return activeSqlite;
    },

    attachReadOnlySnapshotIfPresent(
      databasePath: string,
      scopeId: string,
      openReadOnlyConnectionOrContainment?:
        | ((databasePath: string) => SqliteConnectionPort)
        | StrictReadOnlyContainment
    ): boolean {
      if (activeSqlite !== null) return true;
      let roConn: SqliteConnectionPort | null = null;
      try {
        roConn =
          typeof openReadOnlyConnectionOrContainment === 'function'
            ? openReadOnlyConnectionOrContainment(databasePath)
            : openReadOnlySqliteConnection(databasePath, openReadOnlyConnectionOrContainment);
        const snapshot = readOperationalSnapshotFromConnection(roConn, scopeId);
        if (snapshot === null) return false;
        stateEpoch += 1;
        readOnlyCache = snapshot;
        postCutoverScopeId = scopeId;
        return true;
      } catch {
        return false;
      } finally {
        roConn?.close();
      }
    },

    async attachReadOnlySnapshotIfPresentAsync(
      rootDir: string,
      relativeDirSegments: readonly string[],
      dbFileName: string,
      scopeId: string,
      shouldCommit?: () => boolean
    ): Promise<boolean> {
      if (activeSqlite !== null) return false;
      const startEpoch = stateEpoch;
      const result = await withZeroMutationReadOnlySqliteConnection(
        rootDir,
        relativeDirSegments,
        dbFileName,
        (roConn) => {
          try {
            return readOperationalSnapshotFromConnection(roConn, scopeId);
          } catch {
            return null;
          }
        }
      );
      if (result.outcome !== 'ok' || result.value === null) return false;
      if (this.isSqliteAttached() || stateEpoch !== startEpoch || shouldCommit?.() === false) return false;
      stateEpoch += 1;
      readOnlyCache = result.value;
      postCutoverScopeId = scopeId;
      return true;
    },

    configureDetachedTrustedSqliteWriter(config): void {
      detachedWriter = config;
    },

    reloadSqliteCache(): void {
      activeSqlite?.reloadCacheFromSqlite();
    },

    detachSqlite(expectedStore?: SqliteOperationalStorePort): void {
      if (expectedStore !== undefined && activeSqlite?.store !== expectedStore) return;
      stateEpoch += 1;
      if (activeSqlite !== null) {
        readOnlyCache = activeSqlite.exportSnapshot();
        activeSqlite = null;
      }
    },

    isSqliteAttached(): boolean {
      return activeSqlite !== null;
    },

    isPostCutoverAuthorityActive(): boolean {
      return activeSqlite !== null || postCutoverScopeId !== null;
    }
  };
}
