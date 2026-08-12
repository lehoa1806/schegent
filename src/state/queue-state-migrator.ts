/**
 * Feature 017 — Queue state migrator (single-queue → multi-queue lift).
 *
 * STATE_SCHEMA_VERSION 2 → 3 forward migration. Extracted from the store so
 * it can be unit-tested without a VS Code Memento. Down-migration is
 * intentionally unsupported (forward-only is the project convention).
 *
 * The migrator constructs the default registry, lifts legacy requests into
 * the reserved default queue, assigns per-queue positions, and returns audit
 * metadata for the activation path to persist through the normal writer.
 */

import {
  DEFAULT_QUEUE_ID,
  type QueueRegistry,
  type QueueRegistryEntry,
  type QueuePauseSource
} from '../queue/queue-registry';
import { makeDefaultRegistry } from '../queue/queue-registry';
import {
  ensureExtendedFeatureRequest,
  type FeatureRequest,
  type FeatureRequestStatus,
  type QueueState
} from '../queue/feature-request';
import { STATE_SCHEMA_VERSION_V10 } from '../contracts/state-schema';

export interface LegacyQueueLiftResult {
  readonly queueState: QueueState;
  readonly registry: QueueRegistry;
  readonly defaultQueueId: typeof DEFAULT_QUEUE_ID;
  readonly migrated: boolean;
  readonly auditEvents: readonly LegacyQueueMigrationAuditEvent[];
  readonly quarantine: unknown | null;
}

export type LegacyQueueMigrationAuditEvent =
  | {
      readonly type: 'queue-state-migrated';
      readonly taskCount: number;
      readonly fromSchemaVersion: 2;
      readonly toSchemaVersion: 3;
    }
  | {
      readonly type: 'state-migration-failed';
      readonly reason: string;
      readonly fromSchemaVersion: 2;
      readonly toSchemaVersion: 3;
    }
  | StateMigratedV5ToV6AuditEvent
  | StateMigratedV6ToV7AuditEvent;

/**
 * Feature 030 — emitted by `migrateV5ToV6()` when the persisted state is
 * forward-migrated from the v5 multi-queue shape to the v6 single-queue
 * shape. The payload describes what was coalesced so an operator can
 * audit the migration after the fact.
 */
export interface StateMigratedV5ToV6AuditEvent {
  readonly type: 'state-migrated';
  readonly fromVersion: 5;
  readonly toVersion: 6;
  readonly sourceQueueCount: number;
  readonly pendingTaskCount: number;
  readonly inFlightTaskCount: number;
  readonly inheritedPausedState: boolean;
  readonly coalesceRule: 'createdAt-ascending';
}

/**
 * Lift a legacy persisted `QueueState` (v2 shape) into the v3 multi-queue
 * shape. The returned `queueState` keeps the legacy single-queue requests
 * untouched; the returned `registry` carries the reserved `'default'`
 * entry. Callers persist both keys atomically.
 *
 * If `legacy` is null/undefined (no prior queue persisted), returns a fresh
 * default-registry pair.
 */
export function migrateLegacyQueueState(
  legacy: unknown,
  now: number = Date.now()
): LegacyQueueLiftResult {
  const registry = makeDefaultRegistry(now);
  if (legacy === null || legacy === undefined) {
    return {
      queueState: emptyQueueState(now),
      registry,
      defaultQueueId: DEFAULT_QUEUE_ID,
      migrated: true,
      auditEvents: [migrationEvent(0)],
      quarantine: null
    };
  }
  if (typeof legacy !== 'object') {
    return {
      queueState: emptyQueueState(now),
      registry,
      defaultQueueId: DEFAULT_QUEUE_ID,
      migrated: true,
      auditEvents: [
        {
          type: 'state-migration-failed',
          reason: 'legacy-queue-not-object',
          fromSchemaVersion: 2,
          toSchemaVersion: 3
        },
        migrationEvent(0)
      ],
      quarantine: legacy
    };
  }
  const rec = legacy as Record<string, unknown>;
  const requests = Array.isArray(rec.requests) ? rec.requests : [];
  const paused = typeof rec.paused === 'boolean' ? rec.paused : false;
  const pausedReason = typeof rec.pausedReason === 'string' ? rec.pausedReason : null;
  const inFlightId = typeof rec.inFlightId === 'string' ? rec.inFlightId : null;
  const updatedAt =
    typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt) ? rec.updatedAt : now;
  const lifted = liftLegacyRequests(requests, now);
  const effectiveInFlightId =
    inFlightId !== null && lifted.requests.some((request) => request.id === inFlightId)
      ? inFlightId
      : null;
  return {
    queueState: {
      requests: lifted.requests,
      inFlightId: effectiveInFlightId,
      paused,
      pausedReason,
      updatedAt,
      queueLifecycle: deriveLifecycle(effectiveInFlightId, paused, lifted.requests.length),
      scheduledStartAt: null,
      scheduledStartSource: null
    },
    registry: paused
      ? {
          entries: registry.entries.map((entry) =>
            entry.id === DEFAULT_QUEUE_ID
              ? { ...entry, state: 'manually-paused', pauseSource: 'operator' }
              : entry
          ),
          updatedAt: registry.updatedAt
        }
      : registry,
    defaultQueueId: DEFAULT_QUEUE_ID,
    migrated: true,
    auditEvents:
      lifted.quarantined.length > 0
        ? [
            {
              type: 'state-migration-failed',
              reason: 'legacy-queue-request-invalid',
              fromSchemaVersion: 2,
              toSchemaVersion: 3
            },
            migrationEvent(lifted.requests.length)
          ]
        : [migrationEvent(lifted.requests.length)],
    quarantine: lifted.quarantined.length > 0 ? lifted.quarantined : null
  };
}

function emptyQueueState(now: number): QueueState {
  return {
    requests: [],
    inFlightId: null,
    paused: false,
    pausedReason: null,
    updatedAt: now,
    queueLifecycle: 'active-empty',
    scheduledStartAt: null,
    scheduledStartSource: null
  };
}

function migrationEvent(taskCount: number): LegacyQueueMigrationAuditEvent {
  return {
    type: 'queue-state-migrated',
    taskCount,
    fromSchemaVersion: 2,
    toSchemaVersion: 3
  };
}

function liftLegacyRequests(
  rawRequests: readonly unknown[],
  now: number
): { requests: FeatureRequest[]; quarantined: unknown[] } {
  const requests: FeatureRequest[] = [];
  const quarantined: unknown[] = [];
  for (const raw of rawRequests) {
    if (raw === null || typeof raw !== 'object') {
      quarantined.push(raw);
      continue;
    }
    const rec = raw as Record<string, unknown>;
    if (typeof rec.id !== 'string' || typeof rec.description !== 'string') {
      quarantined.push(raw);
      continue;
    }
    const enqueuedAt =
      typeof rec.enqueuedAt === 'number' && Number.isFinite(rec.enqueuedAt)
        ? rec.enqueuedAt
        : now;
    const status = parseStatus(rec.status);
    const runId = typeof rec.runId === 'string' ? rec.runId : null;
    requests.push(
      ensureExtendedFeatureRequest({
        ...(rec as Partial<FeatureRequest>),
        id: rec.id,
        description: rec.description,
        enqueuedAt,
        status,
        queueId: DEFAULT_QUEUE_ID,
        position: requests.length,
        pauseCause: null,
        runId
      })
    );
  }
  return { requests, quarantined };
}

function parseStatus(value: unknown): FeatureRequestStatus {
  switch (value) {
    case 'pending':
    case 'in-flight':
    case 'paused':
    case 'completed':
    case 'canceled':
    case 'failed':
      return value;
    default:
      return 'pending';
  }
}

// ---------------------------------------------------------------------------
// Feature 030 — v5 → v6 single-queue migration.
//
// Collapses the multi-queue registry to a single 'default' entry. Pending
// tasks across all source queues are coalesced, preserving each source
// queue's within-queue order, sequenced by the source queue's `createdAt`.
// In-flight tasks retain their full state; their `queueId` is rewritten to
// `'default'`. If ANY source queue had `state === 'manually-paused'`, the
// unified queue is born `'manually-paused'` with `pauseSource: 'operator'`.
//
// Forward-only. Down-migration is unsupported.
// ---------------------------------------------------------------------------

/**
 * Input shape the migrator accepts. The persisted v5 store splits queue
 * state across two memento keys (`queueRegistry` + `queue`); the migrator
 * accepts those two slices together with a `schemaVersion` hint so callers
 * can detect idempotency without re-reading the version key.
 */
export interface V5State {
  readonly schemaVersion: number;
  readonly queueRegistry: QueueRegistry | null;
  readonly queueState: QueueState | null;
}

export interface V6State {
  readonly schemaVersion: 6;
  readonly queueRegistry: QueueRegistry;
  readonly queueState: QueueState;
}

export interface MigrateV5ToV6Result {
  readonly state: V6State;
  readonly migrated: boolean;
  readonly auditEvents: readonly StateMigratedV5ToV6AuditEvent[];
}

/**
 * Migrate a v5 persisted state to the v6 single-queue shape.
 *
 * Algorithm (data-model.md §migration-algorithm):
 *   1. Clone input. Bump `schemaVersion` to 6.
 *   2. Identify in-flight runs (`status === 'in-flight'`). If multiple
 *      exist defensively, keep the one whose source queue has the lowest
 *      `createdAt`; demote the rest to `pending` preserving their relative
 *      order.
 *   3. For each source queue (ordered by `createdAt` ascending), append
 *      its pending runs sorted by `position` ascending. Concatenate.
 *   4. Reassign `position` densely from 0 (in-flight first, then pending).
 *   5. Rewrite every request's `queueId` to `'default'`.
 *   6. Construct the new single-entry `QueueRegistry`:
 *      - `id: 'default'`, `name: 'Default queue'`, `position: 0`.
 *      - `state: 'manually-paused'` if ANY source queue was paused;
 *        else `'active'`.
 *      - `pauseSource: 'operator'` if paused; else `null`.
 *      - `schedule: null`.
 *      - `createdAt: min(source createdAt)` (preserves provenance).
 *      - `updatedAt: now`.
 *   7. Emit a `state-migrated` audit event with `fromVersion: 5`,
 *      `toVersion: 6`, and the coalesce metadata.
 *
 * Idempotency: if `state.schemaVersion === 6`, returns the input unchanged
 * with `migrated: false` and an empty `auditEvents` array.
 */
export function migrateV5ToV6(state: V5State, now: number = Date.now()): MigrateV5ToV6Result {
  if (state.schemaVersion === 6) {
    return {
      state: {
        schemaVersion: 6,
        queueRegistry: state.queueRegistry ?? makeDefaultRegistry(now),
        queueState: state.queueState ?? emptyQueueState(now)
      },
      migrated: false,
      auditEvents: []
    };
  }

  const registry = state.queueRegistry;
  const queueState = state.queueState ?? emptyQueueState(now);
  const sourceEntries: readonly QueueRegistryEntry[] = registry?.entries ?? [];

  // Source queue createdAt lookup for ordering. Missing entries default to
  // `Number.POSITIVE_INFINITY` so unknown ids sort after known queues.
  const queueCreatedAt = new Map<string, number>();
  for (const entry of sourceEntries) {
    queueCreatedAt.set(entry.id, entry.createdAt);
  }
  const createdAtOf = (queueId: string | undefined): number => {
    if (queueId === undefined) return Number.POSITIVE_INFINITY;
    const v = queueCreatedAt.get(queueId);
    return v === undefined ? Number.POSITIVE_INFINITY : v;
  };

  // Stable partition: in-flight first, then pending. All other statuses
  // (completed/canceled/failed/paused) pass through with `queueId` rewritten
  // but no positional reshuffle — they retain their original position field
  // so historical projections remain consistent.
  const inFlight: FeatureRequest[] = [];
  const pending: FeatureRequest[] = [];
  const others: FeatureRequest[] = [];
  for (const req of queueState.requests) {
    if (req.status === 'in-flight') {
      inFlight.push(req);
    } else if (req.status === 'pending') {
      pending.push(req);
    } else {
      others.push(req);
    }
  }

  // Defensive: if multiple in-flight runs exist, keep the one whose source
  // queue has the lowest createdAt; demote the rest to pending preserving
  // relative order.
  let keptInFlight: FeatureRequest | null = null;
  if (inFlight.length > 0) {
    const sortedInFlight = inFlight
      .slice()
      .sort((a, b) => createdAtOf(a.queueId) - createdAtOf(b.queueId));
    keptInFlight = sortedInFlight[0] ?? null;
    for (let i = 1; i < sortedInFlight.length; i++) {
      pending.push({ ...sortedInFlight[i], status: 'pending' as FeatureRequestStatus });
    }
  }

  // Coalesce pending: group by source queueId, sort each group by position,
  // concatenate in source-createdAt-ascending order.
  const pendingByQueue = new Map<string, FeatureRequest[]>();
  for (const req of pending) {
    const key = req.queueId ?? DEFAULT_QUEUE_ID;
    const bucket = pendingByQueue.get(key) ?? [];
    bucket.push(req);
    pendingByQueue.set(key, bucket);
  }
  const orderedQueueIds = Array.from(pendingByQueue.keys()).sort(
    (a, b) => createdAtOf(a) - createdAtOf(b)
  );
  const coalescedPending: FeatureRequest[] = [];
  for (const qid of orderedQueueIds) {
    const bucket = pendingByQueue.get(qid) ?? [];
    bucket
      .slice()
      .sort((a, b) => a.position - b.position)
      .forEach((req) => coalescedPending.push(req));
  }

  // Densely re-assign positions: in-flight at 0, then coalesced pending.
  const nextRequests: FeatureRequest[] = [];
  let nextPos = 0;
  if (keptInFlight !== null) {
    nextRequests.push({
      ...keptInFlight,
      queueId: DEFAULT_QUEUE_ID,
      position: nextPos,
      updatedAt: now
    });
    nextPos += 1;
  }
  for (const req of coalescedPending) {
    nextRequests.push({
      ...req,
      queueId: DEFAULT_QUEUE_ID,
      position: nextPos,
      updatedAt: now
    });
    nextPos += 1;
  }
  // Non-pending / non-in-flight requests pass through with queueId rewritten;
  // positions are left as-is (history rows; visible position is not load-bearing).
  for (const req of others) {
    nextRequests.push({ ...req, queueId: DEFAULT_QUEUE_ID });
  }

  // Inherit manually-paused state if ANY source queue was paused.
  const inheritedPaused = sourceEntries.some((e) => e.state === 'manually-paused');
  const minCreatedAt =
    sourceEntries.length > 0
      ? sourceEntries.reduce((m, e) => Math.min(m, e.createdAt), Number.POSITIVE_INFINITY)
      : now;

  const newEntry: QueueRegistryEntry = {
    id: DEFAULT_QUEUE_ID,
    name: 'Default queue',
    position: 0,
    state: inheritedPaused ? 'manually-paused' : 'active',
    pauseSource: (inheritedPaused ? 'operator' : null) as QueuePauseSource,
    schedule: null,
    createdAt: Number.isFinite(minCreatedAt) ? minCreatedAt : now,
    updatedAt: now
  };

  const newRegistry: QueueRegistry = {
    entries: [newEntry],
    updatedAt: now
  };

  const pendingCountAfter = nextRequests.filter((r) => r.status === 'pending').length;
  const newInFlightId = keptInFlight?.id ?? null;
  const newQueueState: QueueState = {
    requests: nextRequests,
    inFlightId: newInFlightId,
    paused: inheritedPaused,
    pausedReason: inheritedPaused ? queueState.pausedReason ?? null : null,
    updatedAt: now,
    queueLifecycle: deriveLifecycle(newInFlightId, inheritedPaused, pendingCountAfter),
    scheduledStartAt: null,
    scheduledStartSource: null
  };

  const sourceQueueCount = sourceEntries.length;
  const pendingTaskCount = coalescedPending.length;
  const inFlightTaskCount = keptInFlight ? 1 : 0;

  const event: StateMigratedV5ToV6AuditEvent = {
    type: 'state-migrated',
    fromVersion: 5,
    toVersion: 6,
    sourceQueueCount,
    pendingTaskCount,
    inFlightTaskCount,
    inheritedPausedState: inheritedPaused,
    coalesceRule: 'createdAt-ascending'
  };

  return {
    state: {
      schemaVersion: 6,
      queueRegistry: newRegistry,
      queueState: newQueueState
    },
    migrated: true,
    auditEvents: [event]
  };
}

function emptyQueueStateV6(now: number): QueueState {
  return emptyQueueState(now);
}
// Re-exported for tests / migration call sites; avoids leaking the private
// helper while keeping a single canonical empty shape.
export { emptyQueueStateV6 };

// ---------------------------------------------------------------------------
// Feature 065 — v6 → v7 migration: lift the legacy QueueState shape into the
// explicit `QueueLifecycle` discriminator + scheduled-start fields. Pending
// tasks MUST be preserved byte-for-byte (SC-005). Forward-only.
// ---------------------------------------------------------------------------

/**
 * Audit-event payload emitted by `migrateV6ToV7()`. Carried through
 * `LegacyQueueMigrationAuditEvent` so existing migrator call-sites surface it
 * via the same audit channel as the v5→v6 event.
 */
export interface StateMigratedV6ToV7AuditEvent {
  readonly type: 'state-migrated-v6-to-v7';
  readonly fromVersion: 6;
  readonly toVersion: 7;
  readonly occurredAt: number;
  readonly counts: {
    readonly running: number;
    readonly operatorPaused: number;
    readonly idlePending: number;
    readonly activeEmpty: number;
  };
}

export interface MigrateV6ToV7Result {
  readonly queueState: QueueState;
  readonly migrated: boolean;
  readonly auditEvents: readonly StateMigratedV6ToV7AuditEvent[];
}

/**
 * Derive `QueueLifecycle` from the legacy (inFlightId, paused, pendingCount)
 * triple per the v6→v7 derivation table in contracts/state-schema.diff.md.
 */
export function deriveLifecycle(
  inFlightId: string | null,
  paused: boolean,
  pendingCount: number
): QueueState['queueLifecycle'] {
  if (inFlightId !== null) return 'running';
  if (paused) return 'operator-paused';
  if (pendingCount > 0) return 'idle-pending';
  return 'active-empty';
}

/**
 * Migrate a v6 persisted `QueueState` to the v7 shape. Idempotent: if the
 * record already carries `queueLifecycle`, it is returned unchanged with
 * `migrated: false`. The migration preserves every pending task byte-for-byte
 * (SC-005) and emits a single audit event with derived-lifecycle counts.
 */
export function migrateV6ToV7(
  queueState: QueueState | null | undefined,
  now: number = Date.now()
): MigrateV6ToV7Result {
  const baseState = queueState ?? emptyQueueState(now);
  // Already migrated — preserve as-is.
  if (
    typeof (baseState as QueueState).queueLifecycle === 'string'
    && (baseState as QueueState).queueLifecycle !== undefined
  ) {
    return {
      queueState: baseState,
      migrated: false,
      auditEvents: []
    };
  }
  const paused = baseState.paused === true;
  const inFlightId = baseState.inFlightId ?? null;
  const pendingCount = baseState.requests.filter((r) => r.status === 'pending').length;
  const lifecycle = deriveLifecycle(inFlightId, paused, pendingCount);
  const scheduledStartSource: QueueState['scheduledStartSource'] =
    lifecycle === 'idle-pending' ? 'migration-default' : null;
  const migrated: QueueState = {
    requests: baseState.requests,
    inFlightId,
    paused,
    pausedReason: baseState.pausedReason ?? null,
    updatedAt: baseState.updatedAt ?? now,
    queueLifecycle: lifecycle,
    scheduledStartAt: null,
    scheduledStartSource,
    ...(lifecycle === 'idle-pending' ? { migrationNotice: 'pending' as const } : {})
  };
  const counts = {
    running: lifecycle === 'running' ? 1 : 0,
    operatorPaused: lifecycle === 'operator-paused' ? 1 : 0,
    idlePending: lifecycle === 'idle-pending' ? 1 : 0,
    activeEmpty: lifecycle === 'active-empty' ? 1 : 0
  } as const;
  const event: StateMigratedV6ToV7AuditEvent = {
    type: 'state-migrated-v6-to-v7',
    fromVersion: 6,
    toVersion: 7,
    occurredAt: now,
    counts
  };
  return { queueState: migrated, migrated: true, auditEvents: [event] };
}

// ---------------------------------------------------------------------------
// Feature 092 — v9 → v10 migration: pluralise `KEYS.queue`. One `QueueState`
// becomes `Record<queueId, QueueState>`, the shape that lets more than one
// queue drain at once.
//
// This is the deliberate reversal of the v5 → v6 collapse above, and it is
// written to be honest about what that collapse cost: v6 coalesced the queues
// that existed then without recording which Task came from which lane, so the
// information needed to separate them again is not in v9 state. The lift
// therefore produces exactly one entry and fabricates nothing.
//
// Like every migrator in this file it is a pure function over the queue
// record. It has no store, so `KEYS.run` is not merely left alone — there is
// nothing here that could reach it.
// ---------------------------------------------------------------------------

/**
 * The v10 persisted shape of `KEYS.queue`: one `QueueState` per queue,
 * keyed by queue id.
 */
export type QueueStateMap = Record<string, QueueState>;

/**
 * Audit payload for the v9 → v10 lift.
 *
 * Queue **identifiers** only. A queue's name is operator-authored text, and
 * the structured audit log is not a place to put arbitrary operator content
 * (FR-038a) — the id is what an auditor needs to correlate the event with the
 * registry anyway.
 */
export interface StateMigratedV9ToV10AuditEvent {
  readonly type: 'state-migrated-v9-to-v10';
  readonly fromVersion: 9;
  readonly toVersion: 10;
  readonly occurredAt: number;
  readonly queueIds: readonly string[];
  readonly pendingTaskCount: number;
  readonly inFlightTaskCount: number;
}

export interface MigrateV9ToV10Result {
  readonly queueStates: QueueStateMap;
  readonly migrated: boolean;
  readonly auditEvents: readonly StateMigratedV9ToV10AuditEvent[];
}

/**
 * Forward-only gate. A workspace persisted by a newer release carries a
 * numeric version this runtime cannot read, and the queues it holds are real
 * work — refusing to open is the only outcome that does not risk discarding
 * them. `undefined` is a workspace that predates the numeric version and
 * migrates normally.
 */
export function assertPersistedVersionSupported(persistedNumeric: number | undefined): void {
  if (typeof persistedNumeric === 'number' && persistedNumeric > STATE_SCHEMA_VERSION_V10) {
    throw new Error(
      `Schegent state schemaVersion ${persistedNumeric} exceeds runtime ${STATE_SCHEMA_VERSION_V10}. Update the extension before opening this workspace.`
    );
  }
}

/** A v9 record: a single `QueueState`, recognisable by its `requests` array. */
function isSingleQueueState(raw: unknown): raw is QueueState {
  return (
    typeof raw === 'object'
    && raw !== null
    && !Array.isArray(raw)
    && Array.isArray((raw as QueueState).requests)
  );
}

/** A v10 record: a map whose every value is a `QueueState`. */
function isQueueStateMap(raw: unknown): raw is QueueStateMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const values = Object.values(raw as Record<string, unknown>);
  return values.length > 0 && values.every(isSingleQueueState);
}

/**
 * Enforce the `scheduledStartAt` / `idle-pending` lockstep on one entry.
 *
 * The implication is one-way: an armed timer requires `idle-pending`, but
 * `idle-pending` with no timer is an ordinary queue holding pending work. A
 * one-sided pair is repaired by dropping the orphaned timestamp rather than
 * by inventing a lifecycle, because the lifecycle is the field the rest of
 * the system gates on and a fabricated one would auto-promote a queue nobody
 * scheduled.
 */
function enforceLockstep(state: QueueState): QueueState {
  if (state.queueLifecycle === 'idle-pending') return state;
  if (state.scheduledStartAt === null && state.scheduledStartSource === null) return state;
  return { ...state, scheduledStartAt: null, scheduledStartSource: null };
}

/**
 * Lift a v9 persisted queue record into the v10 map shape.
 *
 * Returns `migrated: false` and an empty map when there is nothing to lift —
 * a fresh workspace, a record already in v10 shape, or a record whose shape
 * this migrator does not recognise. In every one of those cases the caller
 * writes nothing, so an unreadable record cannot be overwritten by a guess.
 */
export function migrateV9ToV10(raw: unknown, now: number = Date.now()): MigrateV9ToV10Result {
  if (isQueueStateMap(raw)) {
    const checked: QueueStateMap = {};
    for (const [queueId, state] of Object.entries(raw)) {
      checked[queueId] = enforceLockstep(state);
    }
    return { queueStates: checked, migrated: false, auditEvents: [] };
  }
  if (!isSingleQueueState(raw)) {
    return { queueStates: {}, migrated: false, auditEvents: [] };
  }

  const lifted = enforceLockstep(raw);
  const pendingTaskCount = lifted.requests.filter((r) => r.status === 'pending').length;
  const inFlightTaskCount = lifted.requests.filter((r) => r.status === 'in-flight').length;
  const event: StateMigratedV9ToV10AuditEvent = {
    type: 'state-migrated-v9-to-v10',
    fromVersion: 9,
    toVersion: 10,
    occurredAt: now,
    queueIds: [DEFAULT_QUEUE_ID],
    pendingTaskCount,
    inFlightTaskCount
  };
  return {
    queueStates: { [DEFAULT_QUEUE_ID]: lifted },
    migrated: true,
    auditEvents: [event]
  };
}
