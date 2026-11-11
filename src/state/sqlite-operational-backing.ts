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

import { ACCEPTANCE_BINDINGS_KEY } from '../contracts/containment-qualification';
import type { AcceptanceMementoPort } from '../services/containment-qualification/acceptance-bindings';
import type { SanitizedLogger } from '../lib/logger';
import {
  NodeSqliteConnection,
  SqliteApplicationStore,
  type LegacyRunRecordInput,
  type MigrationPipelineOutcome
} from '../services/sqlite-store';
import type { RunStatus } from '../contracts/sqlite-store/schema-types';
import type { ConnectedWorkflowRun } from './connected-workflow-run';
import { isTerminalRunStatus, type WorkflowRun } from './workflow-run';
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

function isConnectedRunTerminal(
  run: ConnectedWorkflowRun,
  liveRunMap: Readonly<Record<string, WorkflowRun | undefined>>
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
  const activeFeatureIds = new Set<string>();
  for (const live of Object.values(liveRunMap)) {
    if (live !== undefined && !isTerminalRunStatus(live.status)) {
      activeFeatureIds.add(live.featureId);
    }
  }
  for (const node of Object.values(run.nodes ?? {})) {
    for (const attempt of node.attempts) {
      if (activeFeatureIds.has(attempt.queueItemId)) {
        return false;
      }
    }
  }
  return Object.keys(run.nodes ?? {}).length > 0;
}

function connectedRunLastUpdatedMs(run: ConnectedWorkflowRun): number {
  let latest = typeof run.startedAt === 'number' && Number.isFinite(run.startedAt) ? run.startedAt : 0;
  if (run.invocations !== undefined) {
    for (const frame of Object.values(run.invocations)) {
      if (typeof frame.completedAt === 'number' && frame.completedAt > latest) {
        latest = frame.completedAt;
      } else if (typeof frame.startedAt === 'number' && frame.startedAt > latest) {
        latest = frame.startedAt;
      }
    }
  }
  for (const decision of run.decisions ?? []) {
    if (typeof decision.decidedAt === 'number' && decision.decidedAt > latest) {
      latest = decision.decidedAt;
    }
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
  const entries = Object.entries(rawValue as Record<string, ConnectedWorkflowRun>);
  if (entries.length === 0) return rawValue;

  const nonTerminal: Array<readonly [string, ConnectedWorkflowRun, number]> = [];
  const terminal: Array<{
    readonly id: string;
    readonly run: ConnectedWorkflowRun;
    readonly updatedAtMs: number;
    readonly bytes: number;
  }> = [];

  for (const [id, run] of entries) {
    if (run === null || typeof run !== 'object') continue;
    const serialized = JSON.stringify(run);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (!isConnectedRunTerminal(run, liveRunMap)) {
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
    kept[id] = run;
  }

  let keptTerminal = 0;
  for (const candidate of terminal) {
    if (keptTerminal >= maxTerminalCount) break;
    if (totalBytes + candidate.bytes > CONNECTED_RUNS_MAX_TOTAL_BYTES) continue;
    kept[candidate.id] = candidate.run;
    totalBytes += candidate.bytes;
    keptTerminal += 1;
  }

  return kept;
}

export class SqliteOperationalBacking {
  private readonly cache = new Map<string, unknown>();
  public readonly migrationOutcome: MigrationPipelineOutcome | null;

  public constructor(
    public readonly store: SqliteApplicationStore,
    public readonly scopeId: string,
    legacyMemento: Memento,
    private readonly nowMs: () => number = () => Date.now(),
    private readonly logger?: SanitizedLogger
  ) {
    this.migrationOutcome = this.importIfNeeded(legacyMemento);
    this.reloadCacheFromSqlite();
  }

  public get<T>(key: string): T | undefined {
    if (!this.cache.has(key)) return undefined;
    const val = this.cache.get(key);
    if (val === undefined) return undefined;
    return structuredClone(val) as T;
  }

  public exportSnapshot(): Map<string, unknown> {
    const out = new Map<string, unknown>();
    for (const [k, v] of this.cache.entries()) {
      out.set(k, structuredClone(v));
    }
    return out;
  }

  public update(key: string, value: unknown): void {
    const conn = this.store.writerConnection;
    const now = this.nowMs();
    const liveRuns = (this.cache.get(KEYS.run) as Readonly<Record<string, WorkflowRun | undefined>> | undefined) ?? {};
    const effectiveValue =
      key === KEYS.connectedRuns && value !== undefined
        ? pruneConnectedRunsMap(value, liveRuns, now)
        : value;

    conn.exec('BEGIN IMMEDIATE');
    try {
      if (effectiveValue === undefined) {
        conn.run(
          `DELETE FROM operational_kv_documents WHERE doc_namespace = ? AND doc_key = ?`,
          this.scopeId,
          key
        );
      } else {
        const json = JSON.stringify(effectiveValue);
        const bytes = Buffer.byteLength(json, 'utf8');
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
          bytes,
          now
        );
      }
      this.projectRelationalStateInTx(conn, key, effectiveValue, now);
      conn.exec('COMMIT');
    } catch (error) {
      try {
        conn.exec('ROLLBACK');
      } catch {
        // Ignore rollback failure.
      }
      throw error;
    }

    if (effectiveValue === undefined) {
      this.cache.delete(key);
    } else {
      this.cache.set(key, structuredClone(effectiveValue));
    }
  }

  private importIfNeeded(legacyMemento: Memento): MigrationPipelineOutcome | null {
    const sentinel = this.store.cutoverGuard.getSentinel(this.scopeId);
    if (sentinel && (sentinel.authority === 'sqlite' || sentinel.authority === 'retired_legacy')) {
      return null;
    }

    const legacyRunRecords: LegacyRunRecordInput[] = [];
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

    const migrationId = `f04-cutover-${this.scopeId}`;
    const outcome = this.store.migration.runMigrationThroughRetainSource({
      migrationId,
      scopeId: this.scopeId,
      runRecords: legacyRunRecords
    });

    if (!outcome.completed) {
      this.logger?.warn('sqlite cutover migration incomplete', {
        stage: outcome.currentStage,
        quarantined: outcome.quarantinedRecords
      });
      return outcome;
    }

    const conn = this.store.writerConnection;
    const now = this.nowMs();
    const allKeys = [...Object.values(KEYS), ...EXTRA_IMPORTED_MEMENTO_KEYS].filter(
      (k) => !PASSTHROUGH_OWNERSHIP_KEYS.has(k)
    );
    const liveRuns =
      runMapRaw !== null && typeof runMapRaw === 'object' && !Array.isArray(runMapRaw)
        ? (runMapRaw as Readonly<Record<string, WorkflowRun | undefined>>)
        : {};

    conn.exec('BEGIN IMMEDIATE');
    try {
      for (const key of allKeys) {
        const rawVal = legacyMemento.get<unknown>(key);
        if (rawVal === undefined) continue;
        const effectiveVal =
          key === KEYS.connectedRuns ? pruneConnectedRunsMap(rawVal, liveRuns, now) : rawVal;
        const json = JSON.stringify(effectiveVal);
        const bytes = Buffer.byteLength(json, 'utf8');
        conn.run(
          `INSERT INTO operational_kv_documents (
            doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms
          ) VALUES (?, ?, 1, 1, ?, ?, 0, ?)
          ON CONFLICT(doc_namespace, doc_key) DO NOTHING`,
          this.scopeId,
          key,
          json,
          bytes,
          now
        );
        this.projectRelationalStateInTx(conn, key, effectiveVal, now);
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

    return outcome;
  }

  private reloadCacheFromSqlite(): void {
    this.cache.clear();
    const rows = this.store.writerConnection.all<{
      doc_key: string;
      payload_json: string;
    }>(
      `SELECT doc_key, payload_json FROM operational_kv_documents WHERE doc_namespace = ?`,
      this.scopeId
    );
    for (const row of rows) {
      try {
        this.cache.set(row.doc_key, JSON.parse(row.payload_json));
      } catch {
        this.logger?.warn('corrupt operational_kv_documents payload skipped', { key: row.doc_key });
      }
    }
  }

  private projectRelationalStateInTx(
    conn: NodeSqliteConnection,
    key: string,
    value: unknown,
    now: number
  ): void {
    if (key === KEYS.run && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [queueId, candidate] of Object.entries(value as Record<string, WorkflowRun | undefined>)) {
        if (!candidate || typeof candidate.id !== 'string') continue;
        const sqlStatus = mapWorkflowStatusToSqlite(candidate.status);
        const workflowId = candidate.pipeline?.id ?? 'default-pipeline';
        const createdAt = typeof candidate.startedAt === 'number' ? candidate.startedAt : now;
        const updatedAt = typeof candidate.lastTransitionAt === 'number' ? candidate.lastTransitionAt : now;
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
          candidate.currentPhase ?? null,
          createdAt,
          completedAt,
          candidate.failureCause ?? null,
          createdAt,
          updatedAt,
          queueId,
          invocationCount
        );
      }
    } else if (
      key === KEYS.connectedRuns &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      for (const wfRun of Object.values(value as Record<string, ConnectedWorkflowRun>)) {
        if (!wfRun || typeof wfRun.connectedRunId !== 'string') continue;
        const isTerm = isConnectedRunTerminal(wfRun, {});
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
        const createdAt = typeof wfRun.startedAt === 'number' ? wfRun.startedAt : now;
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
          wfRun.workflowId,
          wfStatus,
          Math.max(1, wfRun.revision ?? 1),
          createdAt,
          isTerm ? updatedAt : null,
          createdAt,
          updatedAt,
          wfRun.queueId ?? null
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
          if (backendKind !== 'claude' && backendKind !== 'codex' && backendKind !== 'agy') continue;
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
  attachSqlite(
    store: SqliteApplicationStore,
    scopeId: string,
    nowMs?: () => number
  ): SqliteOperationalBacking;
  attachReadOnlySnapshotIfPresent(databasePath: string, scopeId: string): boolean;
  configureDetachedTrustedSqliteWriter(
    config: { readonly databasePath: string; readonly scopeId: string; readonly canWrite: () => boolean } | null
  ): void;
  detachSqlite(): void;
  isSqliteAttached(): boolean;
  isPostCutoverAuthorityActive(): boolean;
}

function isSameSerializedState(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
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
  let detachedWriter: {
    readonly databasePath: string;
    readonly scopeId: string;
    readonly canWrite: () => boolean;
  } | null = null;

  return {
    get<T>(key: string): T | undefined {
      if (PASSTHROUGH_OWNERSHIP_KEYS.has(key)) {
        return legacyMemento.get<T>(key);
      }
      if (activeSqlite !== null) {
        return activeSqlite.get<T>(key);
      }
      if (readOnlyCache !== null) {
        const val = readOnlyCache.get(key);
        return val === undefined ? undefined : (structuredClone(val) as T);
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
          const transient = new SqliteApplicationStore({
            databasePath: detachedWriter.databasePath,
            journalMode: 'wal'
          });
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

    attachSqlite(
      store: SqliteApplicationStore,
      scopeId: string,
      nowMs: () => number = () => Date.now()
    ): SqliteOperationalBacking {
      if (activeSqlite !== null && activeSqlite.store === store && activeSqlite.scopeId === scopeId) {
        return activeSqlite;
      }
      readOnlyCache = null;
      activeSqlite = new SqliteOperationalBacking(store, scopeId, legacyMemento, nowMs, logger);
      postCutoverScopeId = scopeId;
      return activeSqlite;
    },

    attachReadOnlySnapshotIfPresent(databasePath: string, scopeId: string): boolean {
      if (activeSqlite !== null) return true;
      let roConn: NodeSqliteConnection | null = null;
      try {
        roConn = new NodeSqliteConnection({ databasePath, readOnly: true });
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
            snapshot.set(row.doc_key, JSON.parse(row.payload_json));
          } catch {
            // Skip malformed row in read-only view.
          }
        }
        readOnlyCache = snapshot;
        postCutoverScopeId = scopeId;
        return true;
      } catch {
        return false;
      } finally {
        roConn?.close();
      }
    },

    configureDetachedTrustedSqliteWriter(config): void {
      detachedWriter = config;
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
