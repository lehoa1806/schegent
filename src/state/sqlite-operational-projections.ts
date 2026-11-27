/**
 * Pure relational projections and connected-run pruning helpers extracted from
 * `sqlite-operational-backing.ts` so every module under `src/state/` stays well
 * under the 1,100-line ceiling (`tests/lint/layer-dependency-direction.test.ts`).
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 * Zero raw `node:fs` write primitives (docs/hard-rules.md rule 69).
 */

import { isBackendRunnerKind } from '../contracts/backend-kinds';
import { ACCEPTANCE_BINDINGS_KEY } from '../contracts/containment-qualification';
import type { RunStatus } from '../contracts/sqlite-store/schema-types';
import type { SanitizedLogger } from '../lib/logger';
import {
  isDeepEqualJsonValue,
  isPlainRecord,
  setOwnProp,
  toSafeIntOrDefault,
  toStringOrNull
} from '../lib/operational-value-helpers';
import {
  classifyConnectedRunEntry,
  connectedRunLastUpdatedMs,
  isConnectedRunTerminal,
  migrateConnectedRuns,
  selectPreservedRefusedEntries,
  serializedConnectedRunBytes
} from './connected-run-migrator';
import type { ConnectedWorkflowRun } from './connected-workflow-run';
import type { SqliteConnectionPort } from './sqlite-operational-port';
import { isOperationalRunMap } from './sqlite-operational-rows';
import { isTerminalRunStatus, type WorkflowRun } from './workflow-run';
import { KEYS } from './workspace-state-types';

/** F03 authority bound for `finding-persisted-connected-runs-map` (`target-sqlite-run-step-attempt-history`). */
export const CONNECTED_RUNS_CACHE_MAX = 512;
export const CONNECTED_RUNS_TERMINAL_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
export const CONNECTED_RUNS_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export interface SqliteStatusProjectors {
  readonly mapWorkflowStatus: (status: string | undefined) => RunStatus;
  readonly resolveConnectedRunStatus: (wfRun: ConnectedWorkflowRun, isTerm: boolean) => RunStatus;
}

function collectActiveFeatureIds(
  liveRunMap: Readonly<Record<string, WorkflowRun | undefined>> | unknown
): ReadonlySet<string> {
  const activeFeatureIds = new Set<string>();
  if (liveRunMap === null || typeof liveRunMap !== 'object' || Array.isArray(liveRunMap)) {
    return activeFeatureIds;
  }
  const rec = liveRunMap as Record<string, unknown>;
  if (
    Object.hasOwn(rec, 'id') &&
    typeof rec.id === 'string' &&
    typeof rec.status === 'string' &&
    typeof rec.featureId === 'string'
  ) {
    if (!isTerminalRunStatus(rec.status as WorkflowRun['status'])) activeFeatureIds.add(rec.featureId);
    return activeFeatureIds;
  }
  for (const live of Object.values(rec)) {
    if (live === null || typeof live !== 'object' || Array.isArray(live)) continue;
    const entry = live as Record<string, unknown>;
    if (
      typeof entry.featureId === 'string' &&
      typeof entry.status === 'string' &&
      !isTerminalRunStatus(entry.status as WorkflowRun['status'])
    ) {
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

export function projectRunEntriesInTx(
  conn: SqliteConnectionPort,
  scopeId: string,
  entries: readonly (readonly [string, Record<string, unknown>])[],
  now: number,
  mapWorkflowStatus: (status: string | undefined) => RunStatus
): void {
  for (const [queueId, rawCandidate] of entries) {
    const candidate = rawCandidate as unknown as WorkflowRun | undefined;
    if (!candidate || typeof candidate.id !== 'string') continue;
    const sqlStatus = mapWorkflowStatus(candidate.status);
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
      scopeId,
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

export function projectRelationalStateInTx(
  conn: SqliteConnectionPort,
  scopeId: string,
  key: string,
  value: unknown,
  previousValue: unknown,
  now: number,
  statusProjectors: SqliteStatusProjectors
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
      projectRunEntriesInTx(conn, scopeId, [['default', rec]], now, statusProjectors.mapWorkflowStatus);
    } else if (isOperationalRunMap(value)) {
      const entries = Object.entries(value).filter(
        (pair): pair is [string, Record<string, unknown>] => (pair[1] as unknown) !== undefined
      );
      projectRunEntriesInTx(conn, scopeId, entries, now, statusProjectors.mapWorkflowStatus);
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
      const wfStatus = statusProjectors.resolveConnectedRunStatus(wfRun, isTerm);
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
        scopeId,
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
