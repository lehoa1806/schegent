/**
 * FR-R6-F04 (FR-001..FR-010, FR-024, NFR-005), FR-R6-F01-B, & FR-R6-F03
 * (`finding-persisted-connected-runs-map`) — SQLite operational state backing for
 * `WorkspaceStateStore`.
 *
 * - Commits operational key updates (`operational_kv_documents`) together with relational
 *   projections (`runs`, `steps`, `attempts`, `queue_entries`, `execution_summary_revisions`,
 *   `containment_acceptance_bindings`) in a single serialized `BEGIN IMMEDIATE` transaction
 *   (Hard Rule 58).
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
  isDeepFrozenSnapshot,
  parseStrictSchemaMetaVersion,
  setOwnProp,
  toSafeIntOrDefault,
  toStringOrNull
} from '../lib/operational-value-helpers';
import {
  openReadOnlySqliteConnection,
  type DetachedSqliteWriterConfig,
  type LegacyRunRecordInputPort,
  type OperationalMigrationOutcomePort,
  type SqliteConnectionPort,
  type SqliteOperationalStorePort
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
import type { ConnectedWorkflowRun } from './connected-workflow-run';
import { isTerminalRunStatus, type WorkflowRun } from './workflow-run';
import type { MementoBatchEntry } from './memento-write-gate';
import { KEYS, type Memento } from './workspace-state';

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

const FROZEN_CONNECTED_RUN_BYTES = new WeakMap<object, number>();

function serializedConnectedRunBytes(run: ConnectedWorkflowRun): number {
  if (isDeepFrozenSnapshot(run)) {
    const cached = FROZEN_CONNECTED_RUN_BYTES.get(run);
    if (cached !== undefined) return cached;
    const bytes = Buffer.byteLength(JSON.stringify(run), 'utf8');
    FROZEN_CONNECTED_RUN_BYTES.set(run, bytes);
    return bytes;
  }
  return Buffer.byteLength(JSON.stringify(run), 'utf8');
}

function isConnectedRunTerminal(
  run: ConnectedWorkflowRun,
  activeFeatureIds: ReadonlySet<string>
): boolean {
  if (run.pendingHandoff !== undefined && run.pendingHandoff !== null) {
    return false;
  }
  if (run.invocations !== undefined) {
    const frames = Object.values(run.invocations);
    if (frames.length > 0) {
      return frames.every(
        (frame) =>
          frame.status === 'completed' ||
          frame.status === 'failed' ||
          frame.status === 'canceled'
      );
    }
  }
  for (const node of Object.values(run.nodes)) {
    for (const attempt of node.attempts) {
      if (activeFeatureIds.has(attempt.queueItemId)) {
        return false;
      }
    }
  }
  return Object.keys(run.nodes).length > 0;
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

function connectedRunLastUpdatedMs(run: ConnectedWorkflowRun): number {
  let latest = toSafeIntOrDefault(run.startedAt, 0);
  if (run.invocations !== undefined) {
    for (const frame of Object.values(run.invocations)) {
      const completed = toSafeIntOrDefault(frame.completedAt, -1);
      const started = toSafeIntOrDefault(frame.startedAt, -1);
      if (completed > latest) latest = completed;
      else if (started > latest) latest = started;
    }
  }
  for (const decision of run.decisions) {
    const decided = toSafeIntOrDefault(decision.decidedAt, -1);
    if (decided > latest) latest = decided;
  }
  return latest;
}

export function pruneConnectedRunsMap(
  rawValue: unknown,
  liveRunMap: Readonly<Record<string, WorkflowRun | undefined>>,
  nowMs: number
): Record<string, ConnectedWorkflowRun> | unknown {
  if (rawValue === null || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
    return rawValue;
  }
  const entries = Object.entries(rawValue as Record<string, unknown>);
  if (entries.length === 0) return rawValue;

  const activeFeatureIds = collectActiveFeatureIds(liveRunMap);
  const nonTerminal: Array<readonly [string, ConnectedWorkflowRun, number]> = [];
  const terminal: Array<{
    readonly id: string;
    readonly run: ConnectedWorkflowRun;
    readonly updatedAtMs: number;
    readonly bytes: number;
  }> = [];

  for (const [id, rawRun] of entries) {
    if (rawRun === null || typeof rawRun !== 'object') continue;
    const run = rawRun as ConnectedWorkflowRun;
    const bytes = serializedConnectedRunBytes(run);
    if (!isConnectedRunTerminal(run, activeFeatureIds)) {
      nonTerminal.push([id, run, bytes]);
      continue;
    }
    const updatedAtMs = connectedRunLastUpdatedMs(run);
    if (updatedAtMs > 0 && nowMs - updatedAtMs > CONNECTED_RUNS_TERMINAL_RETENTION_MS) {
      continue;
    }
    terminal.push({ id, run, updatedAtMs, bytes });
  }

  // Sort terminal runs newest-first so we keep the most recent entries within count & byte caps.
  terminal.sort((a, b) => b.updatedAtMs - a.updatedAtMs || b.id.localeCompare(a.id));

  const maxTerminalCount = Math.max(0, CONNECTED_RUNS_CACHE_MAX - nonTerminal.length);
  let totalBytes = nonTerminal.reduce((acc, item) => acc + item[2], 0);
  const kept: Record<string, ConnectedWorkflowRun> = {};
  for (const [id, run] of nonTerminal) {
    setOwnProp(kept, id, run);
  }

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
          ? pruneConnectedRunsMap(value, liveRuns, now)
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
        key === KEYS.connectedRuns ? pruneConnectedRunsMap(rawVal, liveRuns, now) : rawVal;
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
          nextCache.set(row.doc_key, deepFreezeValue(JSON.parse(row.payload_json)));
        } catch {
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
        if (rawWfRun === null || typeof rawWfRun !== 'object') continue;
        const prevEntry = prevMap && Object.hasOwn(prevMap, id) ? prevMap[id] : undefined;
        if (
          prevEntry !== undefined &&
          (prevEntry === rawWfRun || isDeepEqualJsonValue(prevEntry, rawWfRun))
        ) {
          continue;
        }
        const wfRun = rawWfRun as ConnectedWorkflowRun;
        if (typeof wfRun.connectedRunId !== 'string') continue;
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

export interface SwitchableOperationalMemento extends Memento, AcceptanceMementoPort {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
  updateBatch(entries: readonly MementoBatchEntry[]): Promise<void>;
  attachSqlite(
    store: SqliteOperationalStorePort,
    scopeId: string,
    nowMs?: () => number
  ): SqliteOperationalBacking;
  attachReadOnlySnapshotIfPresent(
    databasePath: string,
    scopeId: string,
    openReadOnlyConnection?: (databasePath: string) => SqliteConnectionPort
  ): boolean;
  configureDetachedTrustedSqliteWriter(config: DetachedSqliteWriterConfig | null): void;
  reloadSqliteCache(): void;
  detachSqlite(): void;
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

export function createSwitchableOperationalMemento(
  legacyMemento: Memento,
  logger?: SanitizedLogger
): SwitchableOperationalMemento {
  let activeSqlite: SqliteOperationalBacking | null = null;
  let readOnlyCache: Map<string, unknown> | null = null;
  let postCutoverScopeId: string | null = null;
  let detachedWriter: DetachedSqliteWriterConfig | null = null;

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
        if (detachedWriter !== null && detachedWriter.scopeId === postCutoverScopeId && detachedWriter.canWrite()) {
          const transient = detachedWriter.openStore(detachedWriter.databasePath);
          try {
            const backing = new SqliteOperationalBacking(transient, postCutoverScopeId, legacyMemento, () => Date.now(), logger);
            backing.update(key, value);
            readOnlyCache = backing.exportSnapshot();
            return;
          } finally {
            transient.close();
          }
        }
        throw new PostCutoverMementoWriteForbiddenError(key, postCutoverScopeId);
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
            if (
              detachedWriter !== null &&
              detachedWriter.scopeId === postCutoverScopeId &&
              detachedWriter.canWrite()
            ) {
              const transient = detachedWriter.openStore(detachedWriter.databasePath);
              try {
                const backing = new SqliteOperationalBacking(
                  transient,
                  postCutoverScopeId,
                  legacyMemento,
                  () => Date.now(),
                  logger
                );
                backing.updateBatch(operationalEntries);
                readOnlyCache = backing.exportSnapshot();
              } finally {
                transient.close();
              }
            } else {
              throw new PostCutoverMementoWriteForbiddenError(
                operationalEntries.map((entry) => entry.key).join('+'),
                postCutoverScopeId
              );
            }
          }
        } else {
          await applyLegacyWithRollback(operationalEntries);
        }
      }
      if (passthroughEntries.length > 0) {
        await applyLegacyWithRollback(passthroughEntries);
      }
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
      readOnlyCache = null;
      activeSqlite = backing;
      postCutoverScopeId = scopeId;
      return activeSqlite;
    },

    attachReadOnlySnapshotIfPresent(
      databasePath: string,
      scopeId: string,
      openReadOnlyConnection: (databasePath: string) => SqliteConnectionPort = openReadOnlySqliteConnection
    ): boolean {
      if (activeSqlite !== null) return true;
      let roConn: SqliteConnectionPort | null = null;
      try {
        roConn = openReadOnlyConnection(databasePath);
        roConn.exec('BEGIN');
        try {
          const minReaderRow = roConn.get<{ meta_value: string }>(
            `SELECT meta_value FROM schema_meta WHERE meta_key = 'min_reader_version'`
          );
          if (minReaderRow !== undefined) {
            const floor = parseStrictSchemaMetaVersion(minReaderRow.meta_value);
            if (floor === null || floor > SQLITE_SCHEMA_CURRENT_VERSION) return false;
          }
          const sentinel = roConn.get<{ authority: string }>(
            `SELECT authority FROM cutover_sentinel WHERE scope_id = ?`,
            scopeId
          );
          if (!sentinel || (sentinel.authority !== 'sqlite' && sentinel.authority !== 'retired_legacy')) {
            return false;
          }
          const rows = roConn.all<{ doc_key: string; payload_json: string }>(
            `SELECT doc_key, payload_json FROM operational_kv_documents WHERE doc_namespace = ?`,
            scopeId
          );
          const snapshot = new Map<string, unknown>();
          for (const row of rows) {
            try {
              snapshot.set(row.doc_key, deepFreezeValue(JSON.parse(row.payload_json)));
            } catch {
              // Skip malformed row in read-only view.
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
          readOnlyCache = snapshot;
          postCutoverScopeId = scopeId;
          return true;
        } finally {
          try {
            roConn.exec('COMMIT');
          } catch {
            // Ignore read-transaction close error.
          }
        }
      } catch {
        return false;
      } finally {
        roConn?.close();
      }
    },

    configureDetachedTrustedSqliteWriter(config): void {
      detachedWriter = config;
    },

    reloadSqliteCache(): void {
      activeSqlite?.reloadCacheFromSqlite();
    },

    detachSqlite(): void {
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
