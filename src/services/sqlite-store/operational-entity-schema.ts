/**
 * FR-R7-02 — SQLite Migration 9 (`009_fr_r7_02_operational_per_entity_rows`):
 * `STRICT` per-entity operational tables (`operational_queue_meta`, `operational_tasks`,
 * `operational_runs`), lossless transactional backfill with row-count and SHA-256 digest
 * verification, incremental entity-diff writes, and deep-frozen copy-on-write read helpers.
 *
 * Every table is `STRICT`. Never edit migrations 1 to 8; checksum verification covers their text.
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 * Zero raw `node:fs` write primitives (docs/hard-rules.md rule 69).
 */

import { createHash } from 'node:crypto';
import type { NodeSqliteConnection } from './sqlite-driver';

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

export const MAX_OPERATIONAL_JSON_DEPTH = 128;

const DANGEROUS_ENTITY_KEYS = new Set<string>(['__proto__', 'constructor', 'prototype']);
const STRICT_POSITIVE_INT_PATTERN = /^[1-9]\d*$/;

export function parseStrictSchemaMetaVersion(raw: string): number | null {
  if (!STRICT_POSITIVE_INT_PATTERN.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

export function isSafeEntityKey(key: string): boolean {
  return key.length > 0 && !DANGEROUS_ENTITY_KEYS.has(key);
}

/**
 * Safely defines an own enumerable data property on `target`, avoiding `Object.prototype.__proto__`
 * setter invocation when `key === '__proto__'`.
 */
export function setOwnProp(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true
    });
  } else {
    target[key] = value;
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

export function hasOwnDefinedEntries(record: Readonly<Record<string, unknown>>): boolean {
  for (const key of Object.keys(record)) {
    if (record[key] !== undefined) return true;
  }
  return false;
}

const DEEP_FROZEN_SNAPSHOTS = new WeakSet<object>();
const VALIDATED_FROZEN_QUEUE_MAPS = new WeakSet<object>();
const VALIDATED_FROZEN_QUEUE_ENTRIES = new WeakSet<object>();
const VALIDATED_FROZEN_RUN_MAPS = new WeakSet<object>();

/**
 * Returns `true` only for objects deeply frozen by `deepFreezeValue` or
 * `freezeSnapshotWithStructuralSharing` (never raw shallow `Object.freeze` wrappers).
 */
export function isDeepFrozenSnapshot(value: unknown): boolean {
  return value !== null && typeof value === 'object' && DEEP_FROZEN_SNAPSHOTS.has(value);
}

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
  if (DEEP_FROZEN_SNAPSHOTS.has(value) && VALIDATED_FROZEN_QUEUE_MAPS.has(value)) return true;
  if (Object.hasOwn(value, 'requests') && Array.isArray(value.requests)) return false;
  for (const queueId of Object.keys(value)) {
    const entry = value[queueId];
    if (entry === undefined) continue;
    if (!isSafeEntityKey(queueId)) return false;
    if (!isPlainRecord(entry)) return false;
    if (DEEP_FROZEN_SNAPSHOTS.has(entry) && VALIDATED_FROZEN_QUEUE_ENTRIES.has(entry)) continue;
    if (!Object.hasOwn(entry, 'requests') || !Array.isArray(entry.requests)) return false;
    const seenTaskIds = new Set<string>();
    for (const task of entry.requests) {
      if (!isPlainRecord(task)) return false;
      const id = Object.hasOwn(task, 'id') ? task.id : undefined;
      if (typeof id !== 'string' || id.length === 0) return false;
      if (seenTaskIds.has(id)) return false;
      seenTaskIds.add(id);
    }
    if (DEEP_FROZEN_SNAPSHOTS.has(entry)) VALIDATED_FROZEN_QUEUE_ENTRIES.add(entry);
  }
  if (DEEP_FROZEN_SNAPSHOTS.has(value)) VALIDATED_FROZEN_QUEUE_MAPS.add(value);
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
  if (DEEP_FROZEN_SNAPSHOTS.has(value) && VALIDATED_FROZEN_RUN_MAPS.has(value)) return true;
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
  if (DEEP_FROZEN_SNAPSHOTS.has(value)) VALIDATED_FROZEN_RUN_MAPS.add(value);
  return true;
}

/**
 * Deterministic canonical JSON stringification with sorted object keys (omitting `undefined`
 * object properties to match `JSON.stringify` round-trip semantics), bounded by
 * `MAX_OPERATIONAL_JSON_DEPTH` and guarded against cyclic references.
 */
export function canonicalJsonStringify(
  value: unknown,
  depth = 0,
  seen?: WeakSet<object>
): string {
  if (value === null || typeof value !== 'object') {
    const encoded: unknown = JSON.stringify(value);
    return typeof encoded === 'string' ? encoded : 'null';
  }
  if (depth > MAX_OPERATIONAL_JSON_DEPTH) {
    throw new RangeError('OPERATIONAL_JSON_MAX_DEPTH_EXCEEDED');
  }
  const active = seen ?? new WeakSet<object>();
  if (active.has(value)) {
    throw new TypeError('OPERATIONAL_JSON_CYCLE_DETECTED');
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let i = 0; i < value.length; i += 1) {
        const elem = value[i];
        items.push(elem === undefined ? 'null' : canonicalJsonStringify(elem, depth + 1, active));
      }
      return `[${items.join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const pairs: string[] = [];
    for (const key of keys) {
      const prop = record[key];
      if (prop === undefined) continue;
      pairs.push(`${JSON.stringify(key)}:${canonicalJsonStringify(prop, depth + 1, active)}`);
    }
    return `{${pairs.join(',')}}`;
  } finally {
    active.delete(value);
  }
}

export function computeCanonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJsonStringify(value)).digest('hex');
}

/**
 * Fast recursive value equality for JSON-compatible operational state objects, using reference
 * identity (`Object.is(a, b)`) as an O(1) short-circuit, own-property lookup (`Object.hasOwn`),
 * and depth bounding (`MAX_OPERATIONAL_JSON_DEPTH`).
 */
export function isDeepEqualJsonValue(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (depth > MAX_OPERATIONAL_JSON_DEPTH) {
    throw new RangeError('OPERATIONAL_JSON_MAX_DEPTH_EXCEEDED');
  }
  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray || bIsArray) {
    if (!aIsArray || !bIsArray) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!isDeepEqualJsonValue(a[i], b[i], depth + 1)) return false;
    }
    return true;
  }
  if (!isPlainRecord(a) || !isPlainRecord(b)) return false;
  const recA = a;
  const recB = b;
  const keysA = Object.keys(recA);
  const keysB = Object.keys(recB);

  let definedA = 0;
  for (const key of keysA) {
    const valA = recA[key];
    if (valA === undefined) continue;
    definedA += 1;
    if (!Object.hasOwn(recB, key)) return false;
    if (!isDeepEqualJsonValue(valA, recB[key], depth + 1)) return false;
  }

  let definedB = 0;
  for (const key of keysB) {
    if (recB[key] !== undefined) definedB += 1;
  }
  return definedA === definedB;
}

/**
 * In-place deep freeze for freshly parsed SQLite objects. Subtrees already marked in
 * `DEEP_FROZEN_SNAPSHOTS` short-circuit in O(1); externally shallow-frozen objects still have
 * their descendants frozen before being added to `DEEP_FROZEN_SNAPSHOTS`.
 */
export function deepFreezeValue<T>(value: T, depth = 0, seen?: WeakSet<object>): T {
  if (value === null || typeof value !== 'object') return value;
  if (DEEP_FROZEN_SNAPSHOTS.has(value)) return value;
  if (depth > MAX_OPERATIONAL_JSON_DEPTH) {
    throw new RangeError('OPERATIONAL_JSON_MAX_DEPTH_EXCEEDED');
  }
  const active = seen ?? new WeakSet<object>();
  if (active.has(value)) {
    throw new TypeError('OPERATIONAL_JSON_CYCLE_DETECTED');
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        deepFreezeValue(value[i], depth + 1, active);
      }
    } else {
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        deepFreezeValue(record[key], depth + 1, active);
      }
    }
  } finally {
    active.delete(value);
  }
  Object.freeze(value);
  DEEP_FROZEN_SNAPSHOTS.add(value);
  return value;
}

/**
 * Produces a deeply frozen cache snapshot with structural sharing:
 * - Subtrees verified deeply frozen by this module (`DEEP_FROZEN_SNAPSHOTS`) are reused in O(1).
 * - Unfrozen or externally shallow-frozen caller objects/arrays are copied before freezing so
 *   callers remain isolated from store cache internals and mutable descendants cannot leak in.
 */
export function freezeSnapshotWithStructuralSharing<T>(
  value: T,
  depth = 0,
  seen?: WeakSet<object>
): T {
  if (value === null || typeof value !== 'object') return value;
  if (DEEP_FROZEN_SNAPSHOTS.has(value)) return value;
  if (depth > MAX_OPERATIONAL_JSON_DEPTH) {
    throw new RangeError('OPERATIONAL_JSON_MAX_DEPTH_EXCEEDED');
  }
  const active = seen ?? new WeakSet<object>();
  if (active.has(value)) {
    throw new TypeError('OPERATIONAL_JSON_CYCLE_DETECTED');
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const clone = new Array<unknown>(value.length);
      for (let i = 0; i < value.length; i += 1) {
        clone[i] = freezeSnapshotWithStructuralSharing(value[i], depth + 1, active);
      }
      Object.freeze(clone);
      DEEP_FROZEN_SNAPSHOTS.add(clone);
      return clone as unknown as T;
    }
    if (isPlainRecord(value)) {
      const clone: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        setOwnProp(clone, key, freezeSnapshotWithStructuralSharing(value[key], depth + 1, active));
      }
      Object.freeze(clone);
      DEEP_FROZEN_SNAPSHOTS.add(clone);
      return clone as unknown as T;
    }
    return deepFreezeValue(structuredClone(value), depth, active);
  } finally {
    active.delete(value);
  }
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

export function toSafeIntOrDefault(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const truncated = Math.trunc(value);
  return Number.isSafeInteger(truncated) ? truncated : fallback;
}

export function toSafeIntOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const truncated = Math.trunc(value);
  return Number.isSafeInteger(truncated) ? truncated : null;
}

export function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function writeOperationalQueueMapDiffInTx(
  conn: NodeSqliteConnection,
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

    // Zero-allocation fast path when queue task order and IDs are unchanged (e.g., single-Task
    // status/field transition in a 500-Task queue).
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
  conn: NodeSqliteConnection,
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
  conn: NodeSqliteConnection,
  scopeId: string
): void {
  conn.run(`DELETE FROM operational_tasks WHERE scope_id = ?`, scopeId);
  conn.run(`DELETE FROM operational_queue_meta WHERE scope_id = ?`, scopeId);
}

export function deleteOperationalRunScopeInTx(
  conn: NodeSqliteConnection,
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
  conn: NodeSqliteConnection,
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
  conn: NodeSqliteConnection,
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
        // Pre-v10 bare QueueState or non-canonical shape stays in operational_kv_documents until
        // WorkspaceStateStore.initialize() normalizes it forward.
        continue;
      }

      if (!hasOwnDefinedEntries(parsed)) {
        // Preserve explicit empty `{}` map marker in operational_kv_documents so `{}` does not
        // collapse into `undefined` on reload or read-only snapshot attachment.
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
        // Pre-v11 bare WorkflowRun stays in operational_kv_documents until initialize() upgrades it.
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
