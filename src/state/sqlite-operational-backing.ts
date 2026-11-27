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

import { ACCEPTANCE_BINDINGS_KEY } from '../contracts/containment-qualification';
import type { AcceptanceMementoPort } from '../services/containment-qualification/acceptance-bindings';
import type { SanitizedLogger } from '../lib/logger';
import {
  deepFreezeValue,
  freezeSnapshotWithStructuralSharing,
  hasOwnDefinedEntries,
  isPlainRecord
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
  CONNECTED_RUNS_REFUSED_MAX_BYTES,
  CONNECTED_RUNS_REFUSED_MAX_COUNT
} from './connected-run-migrator';
export { CONNECTED_RUNS_REFUSED_MAX_BYTES, CONNECTED_RUNS_REFUSED_MAX_COUNT };
import {
  CONNECTED_RUNS_CACHE_MAX,
  CONNECTED_RUNS_MAX_TOTAL_BYTES,
  CONNECTED_RUNS_TERMINAL_RETENTION_MS,
  projectRelationalStateInTx,
  projectRunEntriesInTx,
  pruneConnectedRunsMap,
  type SqliteStatusProjectors
} from './sqlite-operational-projections';
import type { RunStatus } from '../contracts/sqlite-store/schema-types';
import type { ConnectedWorkflowRun } from './connected-workflow-run';
export {
  CONNECTED_RUNS_CACHE_MAX,
  CONNECTED_RUNS_MAX_TOTAL_BYTES,
  CONNECTED_RUNS_TERMINAL_RETENTION_MS,
  pruneConnectedRunsMap
};
import {
  MixedOperationalBatchError,
  buildDurableStoreUnavailableError,
  isSameSerializedState,
  parseAndFreezeKvDocument,
  persistCutoverAuthorityTombstone,
  readCutoverAuthorityTombstone,
  readOperationalSnapshotFromConnection,
  type CutoverAuthorityMode,
  type CutoverAuthorityStatus,
  type SqliteCutoverAuthorityTombstone
} from './sqlite-cutover-authority';
export {
  MixedOperationalBatchError,
  readCutoverAuthorityTombstone,
  type CutoverAuthorityMode,
  type CutoverAuthorityStatus,
  type SqliteCutoverAuthorityTombstone
};
import { decodeTerminalTransitionJournal } from './terminal-transition-journal';
import type { WorkflowRun } from './workflow-run';
import type { MementoBatchEntry } from './memento-write-gate';
import { KEYS, QueueMutationRejected, type Memento } from './workspace-state';

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

function resolveConnectedRunSqliteStatus(wfRun: ConnectedWorkflowRun, isTerm: boolean): RunStatus {
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
  return wfStatus;
}

const SQLITE_STATUS_PROJECTORS: SqliteStatusProjectors = Object.freeze({
  mapWorkflowStatus: mapWorkflowStatusToSqlite,
  resolveConnectedRunStatus: resolveConnectedRunSqliteStatus
});

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
        if (
          prevValue !== undefined &&
          effectiveValue !== undefined &&
          (((key === KEYS.controlLedger || key === KEYS.connectedRuns) && !isPlainRecord(prevValue)) ||
            (key === KEYS.terminalTransitionIntent &&
              decodeTerminalTransitionJournal(prevValue).status === 'unreadable-envelope'))
        ) {
          throw new Error(
            key === KEYS.controlLedger ? 'control-ledger-corrupt' : key === KEYS.connectedRuns ? 'connected-run-refused' : 'terminal-journal-corrupt'
          );
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
          projectRunEntriesInTx(conn, this.scopeId, diff.changedRuns, now, mapWorkflowStatusToSqlite);
          txCache.set(key, effectiveValue);
        } else {
          if (key === KEYS.queue) deleteOperationalQueueScopeInTx(conn, this.scopeId);
          else if (key === KEYS.run) deleteOperationalRunScopeInTx(conn, this.scopeId);
          this.upsertKvDocInTx(conn, key, effectiveValue, now);
          txKvKeys.add(key);
          projectRelationalStateInTx(conn, this.scopeId, key, effectiveValue, prevValue, now, SQLITE_STATUS_PROJECTORS);
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

    const tombstone = readCutoverAuthorityTombstone(legacyMemento);
    if (tombstone !== null && tombstone.scopeId === this.scopeId) {
      this.logger?.warn('sqlite cutover sentinel missing despite durable cutover tombstone; refusing legacy re-import', {
        scopeId: this.scopeId
      });
      throw buildDurableStoreUnavailableError(
        'sqlite-cutover-import',
        this.scopeId,
        'sqlite-sentinel-missing-after-cutover'
      );
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
      (k) => !PASSTHROUGH_OWNERSHIP_KEYS.has(k) && k !== KEYS.sqliteCutoverAuthority
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
        projectRunEntriesInTx(conn, this.scopeId, diff.changedRuns, now, mapWorkflowStatusToSqlite);
        continue;
      }
      if (key === KEYS.queue) deleteOperationalQueueScopeInTx(conn, this.scopeId);
      else if (key === KEYS.run) deleteOperationalRunScopeInTx(conn, this.scopeId);
      this.upsertKvDocInTx(conn, key, effectiveVal, now);
      projectRelationalStateInTx(conn, this.scopeId, key, effectiveVal, undefined, now, SQLITE_STATUS_PROJECTORS);
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
        const loaded = parseAndFreezeKvDocument(row.doc_key, row.payload_json, this.logger);
        if (loaded.present) nextCache.set(row.doc_key, loaded.value);
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
  flushCutoverAuthority(): Promise<void>;
  attachReadOnlySnapshotIfPresent(
    databasePath: string,
    scopeId: string,
    openReadOnlyConnectionOrContainment?:
      | ((databasePath: string) => SqliteConnectionPort)
      | StrictReadOnlyContainment
  ): boolean;
  /** True when the last `attachReadOnlySnapshotIfPresent` call saw a live `-wal` requiring async snapshot copy. */
  lastSyncReadOnlyProbeNeededAsync(): boolean;
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
  isReadOnlySnapshotAttached(): boolean;
  isPostCutoverAuthorityActive(): boolean;
  hasCutoverAuthorityForScope(scopeId: string): boolean;
  /**
   * Aligns the switchable memento to the active workspace folder scope when Stage 2
   * wires or rewires on folder change, dropping any detached snapshot cached from a
   * different workspace scope so a new folder neither inherits a prior folder's cache
   * nor mistakes that folder's tombstone for its own.
   */
  setActiveScope(scopeId: string): void;
  getCutoverAuthorityStatus(): CutoverAuthorityStatus;
}

export function createSwitchableOperationalMemento(
  legacyMemento: Memento,
  logger?: SanitizedLogger,
  options?: SwitchableOperationalMementoOptions
): SwitchableOperationalMemento {
  let activeSqlite: SqliteOperationalBacking | null = null;
  let readOnlyCache: Map<string, unknown> | null = null;
  let postCutoverScopeId: string | null = null;
  let expectedScopeId: string | null = null;
  let detachedWriter: DetachedSqliteWriterConfig | null = null;
  let durableBatchRequired = options?.requireDurableBatch === true;
  let durableBatchUnavailableReason: string | null = null;
  let cutoverUnavailableWarned = false;
  let lastSyncProbeNeededAsync = false;
  let pendingTombstoneWrite: Promise<void> | null = null;
  let stateEpoch = 0;

  const currentActiveSqlite = (): SqliteOperationalBacking | null => activeSqlite;
  const activeTombstone = (): SqliteCutoverAuthorityTombstone | null => {
    const tombstone = readCutoverAuthorityTombstone(legacyMemento);
    if (tombstone !== null && expectedScopeId !== null && tombstone.scopeId !== expectedScopeId) {
      return null;
    }
    return tombstone;
  };
  const warnUnavailablePostCutoverOnce = (
    tombstone: SqliteCutoverAuthorityTombstone,
    keyLabel: string
  ): void => {
    if (cutoverUnavailableWarned) return;
    cutoverUnavailableWarned = true;
    logger?.warn(
      'sqlite cutover authority active but durable store is unavailable; refusing legacy memento fallback',
      {
        scopeId: tombstone.scopeId,
        key: keyLabel,
        reason: durableBatchUnavailableReason ?? 'sqlite-unavailable'
      }
    );
  };
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
      if (key === KEYS.sqliteCutoverAuthority || PASSTHROUGH_OWNERSHIP_KEYS.has(key)) {
        return legacyMemento.get<T>(key);
      }
      if (activeSqlite !== null) {
        return activeSqlite.get<T>(key);
      }
      if (readOnlyCache !== null) {
        return readOnlyCache.get(key) as T | undefined;
      }
      const tombstone = activeTombstone();
      if (tombstone !== null) {
        warnUnavailablePostCutoverOnce(tombstone, key);
        return undefined;
      }
      return legacyMemento.get<T>(key);
    },

    async update(key: string, value: unknown): Promise<void> {
      if (key === KEYS.sqliteCutoverAuthority) {
        throw new PostCutoverMementoWriteForbiddenError(
          key,
          postCutoverScopeId ?? activeTombstone()?.scopeId ?? 'cutover-authority'
        );
      }
      if (PASSTHROUGH_OWNERSHIP_KEYS.has(key)) {
        await legacyMemento.update(key, value);
        return;
      }
      if (activeSqlite !== null) {
        activeSqlite.update(key, value);
        return;
      }
      if (postCutoverScopeId !== null) {
        // Pure read-only followers (no detached writer) allow identical no-op writes from
        // idempotent load-time normalizers. Detached writers NEVER skip on stale readOnlyCache.
        if (
          detachedWriter === null &&
          readOnlyCache !== null &&
          isSameSerializedState(readOnlyCache.get(key), value)
        ) {
          return;
        }
        await writeViaDetachedOrThrow(postCutoverScopeId, key, (b) => b.update(key, value));
        return;
      }
      const tombstone = activeTombstone();
      if (tombstone !== null) {
        warnUnavailablePostCutoverOnce(tombstone, key);
        throw buildDurableStoreUnavailableError(key, tombstone.scopeId, durableBatchUnavailableReason);
      }
      if (durableBatchRequired && key === KEYS.controlLedger) {
        throw buildDurableStoreUnavailableError(key, null, durableBatchUnavailableReason);
      }
      await legacyMemento.update(key, value);
    },

    async updateBatch(entries: readonly MementoBatchEntry[]): Promise<void> {
      if (entries.length === 0) return;
      if (entries.some((entry) => entry.key === KEYS.sqliteCutoverAuthority)) {
        throw new PostCutoverMementoWriteForbiddenError(
          KEYS.sqliteCutoverAuthority,
          postCutoverScopeId ?? activeTombstone()?.scopeId ?? 'cutover-authority'
        );
      }
      const passthroughEntries = entries.filter((entry) => PASSTHROUGH_OWNERSHIP_KEYS.has(entry.key));
      const operationalEntries = entries.filter((entry) => !PASSTHROUGH_OWNERSHIP_KEYS.has(entry.key));
      if (passthroughEntries.length > 0 && operationalEntries.length > 0) {
        throw new MixedOperationalBatchError(
          passthroughEntries.map((entry) => entry.key),
          operationalEntries.map((entry) => entry.key)
        );
      }
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
        const keyLabel = operationalEntries.map((entry) => entry.key).join('+');
        if (activeSqlite !== null) {
          activeSqlite.updateBatch(operationalEntries);
        } else if (postCutoverScopeId !== null) {
          const allUnchangedReadOnly =
            detachedWriter === null &&
            readOnlyCache !== null &&
            operationalEntries.every((entry) =>
              isSameSerializedState(readOnlyCache?.get(entry.key), entry.value)
            );
          if (!allUnchangedReadOnly) {
            await writeViaDetachedOrThrow(postCutoverScopeId, keyLabel, (b) =>
              b.updateBatch(operationalEntries)
            );
          }
        } else {
          const tombstone = activeTombstone();
          if (tombstone !== null) {
            warnUnavailablePostCutoverOnce(tombstone, keyLabel);
            throw buildDurableStoreUnavailableError(
              keyLabel,
              tombstone.scopeId,
              durableBatchUnavailableReason
            );
          }
          if (durableBatchRequired) {
            const detail = durableBatchUnavailableReason ? ` (${durableBatchUnavailableReason})` : '';
            throw new QueueMutationRejected(
              'durable-store-unavailable',
              `Refused atomic operational batch write for ${keyLabel}: durable SQLite store is unavailable${detail}.`
            );
          }
          await applyLegacyWithRollback(operationalEntries);
        }
        return;
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
        pendingTombstoneWrite = persistCutoverAuthorityTombstone(legacyMemento, scopeId, nowMs(), logger);
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
      cutoverUnavailableWarned = false;
      pendingTombstoneWrite = persistCutoverAuthorityTombstone(legacyMemento, scopeId, nowMs(), logger);
      return activeSqlite;
    },

    async flushCutoverAuthority(): Promise<void> {
      await pendingTombstoneWrite;
    },

    attachReadOnlySnapshotIfPresent(
      databasePath: string,
      scopeId: string,
      openReadOnlyConnectionOrContainment?:
        | ((databasePath: string) => SqliteConnectionPort)
        | StrictReadOnlyContainment
    ): boolean {
      lastSyncProbeNeededAsync = false;
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
        cutoverUnavailableWarned = false;
        return true;
      } catch (err) {
        if (err instanceof Error && err.message === 'SQLITE_READONLY_WAL_PRESENT_REQUIRES_ASYNC') {
          lastSyncProbeNeededAsync = true;
        }
        return false;
      } finally {
        roConn?.close();
      }
    },

    lastSyncReadOnlyProbeNeededAsync(): boolean {
      return lastSyncProbeNeededAsync;
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
      cutoverUnavailableWarned = false;
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

    isReadOnlySnapshotAttached(): boolean {
      return activeSqlite === null && readOnlyCache !== null;
    },

    isPostCutoverAuthorityActive(): boolean {
      return activeSqlite !== null || postCutoverScopeId !== null || activeTombstone() !== null;
    },

    hasCutoverAuthorityForScope(scopeId: string): boolean {
      if (postCutoverScopeId === scopeId) return true;
      const tombstone = activeTombstone();
      return tombstone !== null && tombstone.scopeId === scopeId;
    },

    setActiveScope(scopeId: string): void {
      expectedScopeId = scopeId;
      if (activeSqlite === null && postCutoverScopeId !== null && postCutoverScopeId !== scopeId) {
        stateEpoch += 1;
        readOnlyCache = null;
        postCutoverScopeId = null;
        detachedWriter = null;
        durableBatchUnavailableReason = null;
        cutoverUnavailableWarned = false;
      }
    },

    getCutoverAuthorityStatus(): CutoverAuthorityStatus {
      const tombstone = activeTombstone();
      if (activeSqlite !== null) {
        return {
          mode: 'sqlite-primary',
          scopeId: activeSqlite.scopeId,
          cutoverAt: tombstone?.cutoverAt ?? null,
          reason: null
        };
      }
      if (readOnlyCache !== null && postCutoverScopeId !== null) {
        return {
          mode: 'sqlite-readonly',
          scopeId: postCutoverScopeId,
          cutoverAt: tombstone?.cutoverAt ?? null,
          reason: durableBatchUnavailableReason
        };
      }
      if (tombstone !== null) {
        return {
          mode: 'sqlite-unavailable-post-cutover',
          scopeId: tombstone.scopeId,
          cutoverAt: tombstone.cutoverAt,
          reason: durableBatchUnavailableReason ?? 'sqlite-unavailable'
        };
      }
      return {
        mode: 'pre-cutover',
        scopeId: null,
        cutoverAt: null,
        reason: durableBatchUnavailableReason
      };
    }
  };
}
