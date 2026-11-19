/**
 * FR-R7-07 — Per-entity SQLite operational row readers and incremental diff writers
 * for `KEYS.queue` (`operational_queue_meta` + `operational_tasks`) and `KEYS.run`
 * (`operational_runs`), relocated from `src/services/sqlite-store/operational-entity-schema.ts`
 * into `src/state/` and typed strictly against `SqliteConnectionPort`.
 *
 * `src/services/sqlite-store/operational-entity-schema.ts` re-exports all helpers
 * so Migration 9 bootstrap and tests keep their existing import paths.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 * Zero raw `node:fs` write primitives (docs/hard-rules.md rule 69).
 */

import {
  deepFreezeValue,
  isDeepEqualJsonValue,
  isDeepFrozenSnapshot,
  isPlainRecord,
  isSafeEntityKey,
  setOwnProp,
  toSafeIntOrDefault,
  toSafeIntOrNull,
  toStringOrNull
} from '../lib/operational-value-helpers';
import type { SqliteConnectionPort } from './sqlite-operational-port';

export interface QueueEntityDiffSummary {
  readonly queuesUpserted: number;
  readonly queuesDeleted: number;
  readonly tasksUpserted: number;
  readonly tasksDeleted: number;
}

export interface RunEntityDiffSummary {
  readonly runsUpserted: number;
  readonly runsDeleted: number;
  readonly changedRuns: readonly (readonly [string, Record<string, unknown>])[];
}

const VALIDATED_FROZEN_QUEUE_MAPS = new WeakSet<object>();
const VALIDATED_FROZEN_QUEUE_ENTRIES = new WeakSet<object>();
const VALIDATED_FROZEN_RUN_MAPS = new WeakSet<object>();

/**
 * Returns `true` when `value` is a v10+ `QueueStateMap` (`Record<queueId, QueueState>`) whose
 * entries each carry a `requests` array of plain task objects with unique non-empty string `id`s.
 * Bare pre-v10 `QueueState` objects (`Array.isArray(value.requests)`) return `false` so legacy
 * records remain readable via `operational_kv_documents` until `WorkspaceStateStore.initialize()`.
 */
export function isOperationalQueueMap(
  value: unknown
): value is Record<string, Record<string, unknown>> {
  if (!isPlainRecord(value)) return false;
  if (isDeepFrozenSnapshot(value) && VALIDATED_FROZEN_QUEUE_MAPS.has(value)) return true;
  if (Object.hasOwn(value, 'requests') && Array.isArray(value.requests)) return false;
  for (const queueId of Object.keys(value)) {
    const entry = value[queueId];
    if (entry === undefined) continue;
    if (!isSafeEntityKey(queueId)) return false;
    if (!isPlainRecord(entry)) return false;
    if (isDeepFrozenSnapshot(entry) && VALIDATED_FROZEN_QUEUE_ENTRIES.has(entry)) continue;
    if (!Object.hasOwn(entry, 'requests') || !Array.isArray(entry.requests)) return false;
    const seenTaskIds = new Set<string>();
    for (const task of entry.requests) {
      if (!isPlainRecord(task)) return false;
      const id = Object.hasOwn(task, 'id') ? task.id : undefined;
      if (typeof id !== 'string' || id.length === 0) return false;
      if (seenTaskIds.has(id)) return false;
      seenTaskIds.add(id);
    }
    if (isDeepFrozenSnapshot(entry)) VALIDATED_FROZEN_QUEUE_ENTRIES.add(entry);
  }
  if (isDeepFrozenSnapshot(value)) VALIDATED_FROZEN_QUEUE_MAPS.add(value);
  return true;
}

/**
 * Returns `true` when `value` is a v11+ `RunStateMap` (`Record<queueId, WorkflowRun>`).
 * Bare pre-v11 `WorkflowRun` records (`typeof value.id === 'string' && typeof value.currentPhase === 'string'`)
 * return `false` so legacy single-run shapes remain readable until `WorkspaceStateStore.initialize()`.
 */
export function isOperationalRunMap(
  value: unknown
): value is Record<string, Record<string, unknown>> {
  if (!isPlainRecord(value)) return false;
  if (isDeepFrozenSnapshot(value) && VALIDATED_FROZEN_RUN_MAPS.has(value)) return true;
  if (
    Object.hasOwn(value, 'id') &&
    Object.hasOwn(value, 'status') &&
    Object.hasOwn(value, 'currentPhase') &&
    typeof value.id === 'string' &&
    typeof value.status === 'string' &&
    typeof value.currentPhase === 'string'
  ) {
    return false;
  }
  for (const queueId of Object.keys(value)) {
    const entry = value[queueId];
    if (entry === undefined) continue;
    if (!isSafeEntityKey(queueId)) return false;
    if (!isPlainRecord(entry)) return false;
    const id = Object.hasOwn(entry, 'id') ? entry.id : undefined;
    if (typeof id !== 'string' || id.length === 0) return false;
  }
  if (isDeepFrozenSnapshot(value)) VALIDATED_FROZEN_RUN_MAPS.add(value);
  return true;
}

function isSameQueueMeta(
  prevQueue: Readonly<Record<string, unknown>>,
  nextQueue: Readonly<Record<string, unknown>>
): boolean {
  if (prevQueue === nextQueue) return true;
  let definedPrev = 0;
  for (const key of Object.keys(prevQueue)) {
    if (key === 'requests') continue;
    const val = prevQueue[key];
    if (val === undefined) continue;
    definedPrev += 1;
    if (!Object.hasOwn(nextQueue, key)) return false;
    if (!isDeepEqualJsonValue(val, nextQueue[key])) return false;
  }
  let definedNext = 0;
  for (const key of Object.keys(nextQueue)) {
    if (key === 'requests') continue;
    if (nextQueue[key] !== undefined) definedNext += 1;
  }
  return definedPrev === definedNext;
}

function serializeQueueRemainder(queue: Readonly<Record<string, unknown>>): string {
  const remainder: Record<string, unknown> = {};
  for (const key of Object.keys(queue)) {
    if (key === 'requests') continue;
    const val = queue[key];
    if (val !== undefined) {
      setOwnProp(remainder, key, val);
    }
  }
  return JSON.stringify(remainder);
}

export function writeOperationalQueueMapDiffInTx(
  conn: SqliteConnectionPort,
  scopeId: string,
  prevMap: Readonly<Record<string, Record<string, unknown> | undefined>>,
  nextMap: Readonly<Record<string, Record<string, unknown> | undefined>>,
  nowMs: number
): QueueEntityDiffSummary {
  let queuesUpserted = 0;
  let queuesDeleted = 0;
  let tasksUpserted = 0;
  let tasksDeleted = 0;

  for (const prevQueueId of Object.keys(prevMap)) {
    if (prevMap[prevQueueId] === undefined) continue;
    if (!Object.hasOwn(nextMap, prevQueueId) || nextMap[prevQueueId] === undefined) {
      conn.run(
        `DELETE FROM operational_tasks WHERE scope_id = ? AND queue_id = ?`,
        scopeId,
        prevQueueId
      );
      conn.run(
        `DELETE FROM operational_queue_meta WHERE scope_id = ? AND queue_id = ?`,
        scopeId,
        prevQueueId
      );
      queuesDeleted += 1;
    }
  }

  for (const [queueId, nextQueue] of Object.entries(nextMap)) {
    if (nextQueue === undefined) continue;
    const prevQueue = Object.hasOwn(prevMap, queueId) ? prevMap[queueId] : undefined;
    if (prevQueue === nextQueue) {
      continue;
    }

    if (prevQueue === undefined || !isSameQueueMeta(prevQueue, nextQueue)) {
      const remainderJson = serializeQueueRemainder(nextQueue);
      conn.run(
        `INSERT INTO operational_queue_meta (
          scope_id, queue_id, revision, in_flight_id, queue_lifecycle,
          pause_source, paused_reason, scheduled_start_at_ms, scheduled_start_source,
          failure_policy, updated_at_ms, remainder_json
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, queue_id) DO UPDATE SET
          revision = operational_queue_meta.revision + 1,
          in_flight_id = excluded.in_flight_id,
          queue_lifecycle = excluded.queue_lifecycle,
          pause_source = excluded.pause_source,
          paused_reason = excluded.paused_reason,
          scheduled_start_at_ms = excluded.scheduled_start_at_ms,
          scheduled_start_source = excluded.scheduled_start_source,
          failure_policy = excluded.failure_policy,
          updated_at_ms = excluded.updated_at_ms,
          remainder_json = excluded.remainder_json`,
        scopeId,
        queueId,
        toStringOrNull(nextQueue.inFlightId),
        typeof nextQueue.queueLifecycle === 'string' ? nextQueue.queueLifecycle : '',
        toStringOrNull(nextQueue.pauseSource),
        toStringOrNull(nextQueue.pausedReason),
        toSafeIntOrNull(nextQueue.scheduledStartAt),
        toStringOrNull(nextQueue.scheduledStartSource),
        toStringOrNull(nextQueue.failurePolicy),
        toSafeIntOrDefault(nextQueue.updatedAt, nowMs),
        remainderJson
      );
      queuesUpserted += 1;
    }

    const prevRequests = Array.isArray(prevQueue?.requests)
      ? (prevQueue.requests as readonly Record<string, unknown>[])
      : [];
    const nextRequests = Array.isArray(nextQueue.requests)
      ? (nextQueue.requests as readonly Record<string, unknown>[])
      : [];

    if (prevQueue !== undefined && prevQueue.requests === nextQueue.requests) {
      continue;
    }

    const upsertTask = (nextTask: Record<string, unknown>, taskId: string, position: number): void => {
      conn.run(
        `INSERT INTO operational_tasks (
          scope_id, queue_id, task_id, revision, position, status, run_id,
          enqueued_at_ms, updated_at_ms, payload_json
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_id, queue_id, task_id) DO UPDATE SET
          revision = operational_tasks.revision + 1,
          position = excluded.position,
          status = excluded.status,
          run_id = excluded.run_id,
          enqueued_at_ms = excluded.enqueued_at_ms,
          updated_at_ms = excluded.updated_at_ms,
          payload_json = excluded.payload_json`,
        scopeId,
        queueId,
        taskId,
        position,
        typeof nextTask.status === 'string' ? nextTask.status : '',
        toStringOrNull(nextTask.runId),
        toSafeIntOrDefault(nextTask.enqueuedAt, 0),
        toSafeIntOrDefault(nextTask.updatedAt, nowMs),
        JSON.stringify(nextTask)
      );
      tasksUpserted += 1;
    };

    let samePositions = prevRequests.length === nextRequests.length;
    if (samePositions) {
      for (let i = 0; i < nextRequests.length; i += 1) {
        if ((prevRequests[i]!.id as string) !== (nextRequests[i]!.id as string)) {
          samePositions = false;
          break;
        }
      }
    }

    if (samePositions) {
      for (let i = 0; i < nextRequests.length; i += 1) {
        const prevTask = prevRequests[i]!;
        const nextTask = nextRequests[i]!;
        if (prevTask === nextTask || isDeepEqualJsonValue(prevTask, nextTask)) {
          continue;
        }
        upsertTask(nextTask, nextTask.id as string, i);
      }
      continue;
    }

    const prevById = new Map<string, { readonly task: Record<string, unknown>; readonly index: number }>();
    for (let i = 0; i < prevRequests.length; i += 1) {
      const task = prevRequests[i]!;
      const taskId = task.id as string;
      prevById.set(taskId, { task, index: i });
    }

    const nextIds = new Set<string>();
    for (let i = 0; i < nextRequests.length; i += 1) {
      const nextTask = nextRequests[i]!;
      const taskId = nextTask.id as string;
      nextIds.add(taskId);

      const prevEntry = prevById.get(taskId);
      if (
        prevEntry !== undefined &&
        prevEntry.index === i &&
        (prevEntry.task === nextTask || isDeepEqualJsonValue(prevEntry.task, nextTask))
      ) {
        continue;
      }

      upsertTask(nextTask, taskId, i);
    }

    for (const prevTaskId of prevById.keys()) {
      if (!nextIds.has(prevTaskId)) {
        conn.run(
          `DELETE FROM operational_tasks WHERE scope_id = ? AND queue_id = ? AND task_id = ?`,
          scopeId,
          queueId,
          prevTaskId
        );
        tasksDeleted += 1;
      }
    }
  }

  return { queuesUpserted, queuesDeleted, tasksUpserted, tasksDeleted };
}

export function writeOperationalRunMapDiffInTx(
  conn: SqliteConnectionPort,
  scopeId: string,
  prevMap: Readonly<Record<string, Record<string, unknown> | undefined>>,
  nextMap: Readonly<Record<string, Record<string, unknown> | undefined>>,
  nowMs: number
): RunEntityDiffSummary {
  let runsUpserted = 0;
  let runsDeleted = 0;
  const changedRuns: Array<readonly [string, Record<string, unknown>]> = [];

  for (const prevQueueId of Object.keys(prevMap)) {
    if (prevMap[prevQueueId] === undefined) continue;
    if (!Object.hasOwn(nextMap, prevQueueId) || nextMap[prevQueueId] === undefined) {
      conn.run(
        `DELETE FROM operational_runs WHERE scope_id = ? AND queue_id = ?`,
        scopeId,
        prevQueueId
      );
      runsDeleted += 1;
    }
  }

  for (const [queueId, nextRun] of Object.entries(nextMap)) {
    if (nextRun === undefined) continue;
    const prevRun = Object.hasOwn(prevMap, queueId) ? prevMap[queueId] : undefined;
    if (prevRun !== undefined && (prevRun === nextRun || isDeepEqualJsonValue(prevRun, nextRun))) {
      continue;
    }

    conn.run(
      `INSERT INTO operational_runs (
        scope_id, queue_id, run_id, revision, feature_id, status, current_phase,
        started_at_ms, last_transition_at_ms, failure_cause, payload_json
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_id, queue_id) DO UPDATE SET
        run_id = excluded.run_id,
        revision = operational_runs.revision + 1,
        feature_id = excluded.feature_id,
        status = excluded.status,
        current_phase = excluded.current_phase,
        started_at_ms = excluded.started_at_ms,
        last_transition_at_ms = excluded.last_transition_at_ms,
        failure_cause = excluded.failure_cause,
        payload_json = excluded.payload_json`,
      scopeId,
      queueId,
      typeof nextRun.id === 'string' ? nextRun.id : '',
      typeof nextRun.featureId === 'string' ? nextRun.featureId : '',
      typeof nextRun.status === 'string' ? nextRun.status : '',
      typeof nextRun.currentPhase === 'string' ? nextRun.currentPhase : '',
      toSafeIntOrDefault(nextRun.startedAt, nowMs),
      toSafeIntOrDefault(nextRun.lastTransitionAt, nowMs),
      toStringOrNull(nextRun.failureCause),
      JSON.stringify(nextRun)
    );
    runsUpserted += 1;
    changedRuns.push([queueId, nextRun]);
  }

  return { runsUpserted, runsDeleted, changedRuns };
}

export function deleteOperationalQueueScopeInTx(
  conn: SqliteConnectionPort,
  scopeId: string
): void {
  conn.run(`DELETE FROM operational_tasks WHERE scope_id = ?`, scopeId);
  conn.run(`DELETE FROM operational_queue_meta WHERE scope_id = ?`, scopeId);
}

export function deleteOperationalRunScopeInTx(
  conn: SqliteConnectionPort,
  scopeId: string
): void {
  conn.run(`DELETE FROM operational_runs WHERE scope_id = ?`, scopeId);
}

export interface ReadOperationalEntityOptions {
  readonly onCorruptRow?: (detail: { readonly table: string; readonly queueId: string }) => void;
}

function rejectCorruptEntityRow(
  code: string,
  table: string,
  queueId: string,
  options?: ReadOperationalEntityOptions
): undefined {
  if (options?.onCorruptRow) {
    options.onCorruptRow({ table, queueId });
    return undefined;
  }
  throw new Error(`${code}: table '${table}'`);
}

function parseAndFreezeEntityJson(
  rawJson: string,
  table: string,
  queueId: string,
  depthOffset: number,
  options?: ReadOperationalEntityOptions
): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return rejectCorruptEntityRow('OPERATIONAL_ENTITY_INVALID_JSON', table, queueId, options);
  }
  if (!isPlainRecord(parsed)) {
    return rejectCorruptEntityRow('OPERATIONAL_ENTITY_INVALID_SHAPE', table, queueId, options);
  }
  try {
    return deepFreezeValue(parsed, depthOffset);
  } catch {
    return rejectCorruptEntityRow('OPERATIONAL_ENTITY_INVALID_DEPTH', table, queueId, options);
  }
}

export function readOperationalQueueMapFromDb(
  conn: SqliteConnectionPort,
  scopeId: string,
  options?: ReadOperationalEntityOptions
): { readonly present: boolean; readonly map: Record<string, Record<string, unknown>> } {
  const metaRows = conn.all<{ queue_id: string; remainder_json: string }>(
    `SELECT queue_id, remainder_json FROM operational_queue_meta WHERE scope_id = ? ORDER BY queue_id ASC`,
    scopeId
  );
  if (metaRows.length === 0) {
    return { present: false, map: {} };
  }

  const taskRows = conn.all<{ queue_id: string; task_id: string; payload_json: string }>(
    `SELECT queue_id, task_id, payload_json FROM operational_tasks WHERE scope_id = ? ORDER BY queue_id ASC, position ASC, task_id ASC`,
    scopeId
  );

  const tasksByQueue = new Map<string, Record<string, unknown>[]>();
  const seenTaskIdsByQueue = new Map<string, Set<string>>();
  for (const row of taskRows) {
    if (!isSafeEntityKey(row.queue_id)) {
      rejectCorruptEntityRow('OPERATIONAL_ENTITY_UNSAFE_KEY', 'operational_tasks', row.queue_id, options);
      continue;
    }
    const parsedTask = parseAndFreezeEntityJson(row.payload_json, 'operational_tasks', row.queue_id, 3, options);
    if (parsedTask === undefined) continue;
    const taskId = Object.hasOwn(parsedTask, 'id') ? parsedTask.id : undefined;
    if (typeof taskId !== 'string' || taskId.length === 0 || taskId !== row.task_id) {
      rejectCorruptEntityRow('OPERATIONAL_ENTITY_INVALID_SHAPE', 'operational_tasks', row.queue_id, options);
      continue;
    }
    let seenIds = seenTaskIdsByQueue.get(row.queue_id);
    if (seenIds === undefined) {
      seenIds = new Set<string>();
      seenTaskIdsByQueue.set(row.queue_id, seenIds);
    }
    if (seenIds.has(taskId)) {
      rejectCorruptEntityRow('OPERATIONAL_ENTITY_INVALID_SHAPE', 'operational_tasks', row.queue_id, options);
      continue;
    }
    seenIds.add(taskId);
    const list = tasksByQueue.get(row.queue_id);
    if (list !== undefined) list.push(parsedTask);
    else tasksByQueue.set(row.queue_id, [parsedTask]);
  }

  const map: Record<string, Record<string, unknown>> = {};
  for (const metaRow of metaRows) {
    if (!isSafeEntityKey(metaRow.queue_id)) {
      rejectCorruptEntityRow('OPERATIONAL_ENTITY_UNSAFE_KEY', 'operational_queue_meta', metaRow.queue_id, options);
      continue;
    }
    const remainder = parseAndFreezeEntityJson(
      metaRow.remainder_json,
      'operational_queue_meta',
      metaRow.queue_id,
      1,
      options
    );
    if (remainder === undefined) continue;
    const queueRecord: Record<string, unknown> = {};
    for (const key of Object.keys(remainder)) {
      setOwnProp(queueRecord, key, remainder[key]);
    }
    queueRecord.requests = tasksByQueue.get(metaRow.queue_id) ?? [];
    setOwnProp(map, metaRow.queue_id, queueRecord);
  }
  return { present: Object.keys(map).length > 0, map };
}

export function readOperationalRunMapFromDb(
  conn: SqliteConnectionPort,
  scopeId: string,
  options?: ReadOperationalEntityOptions
): { readonly present: boolean; readonly map: Record<string, Record<string, unknown>> } {
  const rows = conn.all<{ queue_id: string; payload_json: string }>(
    `SELECT queue_id, payload_json FROM operational_runs WHERE scope_id = ? ORDER BY queue_id ASC`,
    scopeId
  );
  if (rows.length === 0) {
    return { present: false, map: {} };
  }
  const map: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    if (!isSafeEntityKey(row.queue_id)) {
      rejectCorruptEntityRow('OPERATIONAL_ENTITY_UNSAFE_KEY', 'operational_runs', row.queue_id, options);
      continue;
    }
    const parsedRun = parseAndFreezeEntityJson(row.payload_json, 'operational_runs', row.queue_id, 1, options);
    if (parsedRun === undefined) continue;
    const runId = Object.hasOwn(parsedRun, 'id') ? parsedRun.id : undefined;
    if (typeof runId !== 'string' || runId.length === 0) {
      rejectCorruptEntityRow('OPERATIONAL_ENTITY_INVALID_SHAPE', 'operational_runs', row.queue_id, options);
      continue;
    }
    setOwnProp(map, row.queue_id, parsedRun);
  }
  return { present: Object.keys(map).length > 0, map };
}
