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
  | StateMigratedV5ToV6AuditEvent;

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
      updatedAt
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
    updatedAt: now
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

  const newQueueState: QueueState = {
    requests: nextRequests,
    inFlightId: keptInFlight?.id ?? null,
    paused: inheritedPaused,
    pausedReason: inheritedPaused ? queueState.pausedReason ?? null : null,
    updatedAt: now
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
