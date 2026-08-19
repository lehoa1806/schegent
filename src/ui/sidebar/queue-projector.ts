// Feature 013 — Wave 7 (US7 / T090): queue projection extracted from
// state-projector.ts. Pure functions only; the orchestrator
// (StateProjector) owns the mutable state and calls these helpers.
//
// `sanitizeAndCap` lives here (was in state-projector under US4 Wave 4)
// because pausedReason capping is a queue-shape concern: the cap aligns
// with the IPC validator floor (runtime-validators.ts) so the projector
// never emits a payload the validator would reject.
//
// The PAUSED_REASON_MAX_LENGTH constant remains the authoritative source
// for the projector-side cap; the validator file pins its own constant
// at the same numeric value (with a comment cross-reference).

import type {
  FeatureRequest,
  QueueState,
  ScheduledStartSource
} from '../../queue/feature-request';
import { DEFAULT_QUEUE_ID, type ProjectedQueueRegistry } from '../../queue/queue-registry';
import type { ManualPauseCause } from '../../state/workflow-run';
import { projectQueues } from './queue-summary-projector';
import {
  RECENT_QUEUE_MAX,
  type PhaseName,
  type QueueItem,
  type QueueSummary
} from './snapshot';

export const PAUSED_REASON_MAX_LENGTH = 500;

export function sanitizeAndCap(
  raw: string | null | undefined,
  sanitize: (s: string) => string
): string | null {
  if (raw === null || raw === undefined) return null;
  const sanitized = sanitize(raw);
  if (sanitized.length === 0) return null;
  if (sanitized.length > PAUSED_REASON_MAX_LENGTH) {
    return sanitized.slice(0, PAUSED_REASON_MAX_LENGTH - 1) + '…';
  }
  return sanitized;
}

export interface QueueProjectionContext {
  readonly sanitize: (input: string) => string;
  readonly inFlightPhase: PhaseName | null;
  readonly inFlightId: string | null;
  readonly registry?: ProjectedQueueRegistry;
  /**
   * Feature 028 — when the active run is paused at a future-phase breakpoint,
   * the run-level `manualPauseCause === 'breakpoint-paused'`. The projector
   * surfaces this as task-level `pauseCause: 'breakpoint'` on the in-flight
   * QueueItem. Null when the in-flight run is not breakpoint-paused.
   *
   * BUG-003 — was a hand-copied inline union that had fallen a member behind
   * `ManualPauseCause`. `snapshot-composer` assigns `run.manualPauseCause`
   * straight into it, so it is that type.
   */
  readonly inFlightManualPauseCause?: ManualPauseCause | null;
  /** The id of the run currently held in the orchestrator store (may be failed/paused). */
  readonly activeRunTaskId?: string | null;
  /** The current phase of the run currently held in the orchestrator store. */
  readonly activeRunPhase?: PhaseName | null;
  /**
   * Feature 065 / BUG-006 — queue-lifecycle scheduled-start context, used
   * to populate the `paused` field on paused tasks (drives the QueueItem
   * badge + auto-resume countdown). `null` when the queue is not in
   * `idle-pending` with an armed restore target.
   */
  readonly scheduledStartSource?: ScheduledStartSource | null;
  readonly scheduledStartAt?: number | null;
  /**
   * Feature 092 (T092, FR-022) — the rows of an arbitrary queue, so the summary
   * list can carry a per-queue `taskCount` instead of repeating the queue this
   * projection was invoked for. Absent on a host with no multi-queue wiring, in
   * which case the caller's own rows answer for the default queue and every
   * other entry counts zero rather than guessing.
   */
  readonly requestsOf?: (queueId: string) => readonly FeatureRequest[];
}

export interface QueueProjectionResult {
  inFlight: QueueItem | null;
  pending: QueueItem[];
  recent: QueueItem[];
  orderedItems: QueueItem[];
  queues: QueueSummary[];
}

export function projectQueue(
  queue: QueueState,
  ctx: QueueProjectionContext
): QueueProjectionResult {
  const requests = queue.requests ?? [];
  // BUG-006 — paused tasks now participate in the inFlight / pending
  // projection so the operator can still see them. The single decision
  // authority for routing is `queue.inFlightId`: a paused task whose id
  // matches `inFlightId` lands in the inFlight bucket (preserves the
  // Activity Feed binding across a system-armed scheduled restore); other
  // paused tasks land in pending, sorted by `position` alongside actual
  // pending rows. Operator-paused tasks land in pending because the
  // pause path clears `inFlightId`; system-paused (rate-limit) tasks land
  // in inFlight because the pause path preserves it (FR-026).
  const inFlightSrc =
    requests.find(
      (r) =>
        r.id === queue.inFlightId &&
        (r.status === 'in-flight' || r.status === 'paused')
    ) ?? null;
  const pendingSrc = requests
    .filter(
      (r) =>
        r.status === 'pending' ||
        (r.status === 'paused' && r.id !== queue.inFlightId)
    )
    .sort((a, b) => a.position - b.position);
  const recentSrc = requests
    .filter((r) => r.status === 'completed' || r.status === 'canceled' || r.status === 'failed')
    .sort((a, b) => b.enqueuedAt - a.enqueuedAt)
    .slice(0, RECENT_QUEUE_MAX);

  return {
    inFlight: inFlightSrc ? toQueueItem(inFlightSrc, ctx) : null,
    pending: pendingSrc.map((r) => toQueueItem(r, ctx)),
    recent: recentSrc.map((r) => toQueueItem(r, ctx)),
    orderedItems: requests.slice().sort((a, b) => a.position - b.position).map((r) => toQueueItem(r, ctx)),
    queues: projectQueues(ctx.registry, requests, ctx.requestsOf)
  };
}

/**
 * Feature 092 (T108, FR-057) — one queue's rows in position order, projected
 * with the same mapping the default queue's `orderedItems` gets.
 *
 * Exported so `composeQueueRuntimes` can publish a queue's own rows without
 * owning a second copy of `toQueueItem`. The caller passes the *owning* queue's
 * `inFlightId` and scheduled-start context, so a row's phase, pause cause and
 * auto-resume countdown are read against the queue it actually belongs to.
 */
export function projectQueueRows(
  requests: readonly FeatureRequest[],
  ctx: QueueProjectionContext
): readonly QueueItem[] {
  return requests
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((request) => toQueueItem(request, ctx));
}

function toQueueItem(req: FeatureRequest, ctx: QueueProjectionContext): QueueItem {
  const isInFlight = (req.status === 'in-flight' || req.status === 'paused') && req.id === ctx.inFlightId;
  const isActiveRun = req.id === ctx.activeRunTaskId;
  const lastErrorMessage = extractLastErrorMessage(req.lastError);
  const pausedField = derivePausedField(req, ctx);
  return Object.freeze({
    id: req.id,
    label: truncateLabel(req.description),
    enqueuedAt: new Date(req.enqueuedAt).toISOString(),
    startedAt:
      req.startedAt !== null && req.startedAt !== undefined
        ? new Date(req.startedAt).toISOString()
        : null,
    updatedAt: new Date(req.updatedAt ?? req.enqueuedAt).toISOString(),
    completedAt:
      req.completedAt !== null && req.completedAt !== undefined
        ? new Date(req.completedAt).toISOString()
        : null,
    status: req.status,
    retryCount: req.retryCount ?? 0,
    lastErrorSummary: lastErrorMessage !== null ? ctx.sanitize(lastErrorMessage) : null,
    pausedReason:
      req.pausedReason !== null && req.pausedReason !== undefined
        ? ctx.sanitize(req.pausedReason)
        : null,
    currentPhase: isInFlight ? ctx.inFlightPhase : isActiveRun ? (ctx.activeRunPhase ?? null) : null,
    queueId: req.queueId ?? DEFAULT_QUEUE_ID,
    position: req.position,
    pauseCause: derivePauseCause(req, ctx.registry, isInFlight ? ctx.inFlightManualPauseCause ?? null : null),
    // Feature 020 — surface the active pipeline id so the Activity
    // Feed selector can derive the diagnostics tuple
    // (pipelineId, phaseId, iterationN) without a host round-trip.
    currentPipelineId: req.pipelineId ?? null,
    // BUG-006 (063) — Activity Feed cold-start fallback predicate.
    // Conservative heuristic: a task that was assigned a pipeline id
    // entered the phase machinery, so at least one iteration directory
    // exists (or was about to be created). The cold-start fallback's
    // contract handles empty reads gracefully, so we prefer a cheap
    // snapshot-only test over a per-emission filesystem stat.
    hasOnDiskLogs: req.pipelineId !== null && req.pipelineId !== undefined,
    ...(pausedField !== undefined ? { paused: pausedField } : {})
  });
}

/**
 * Feature 065 / BUG-006 — compute the optional `paused` enrichment for a
 * task projection. Returns:
 *   - undefined when the task is not paused (the field is omitted).
 *   - `{pauseSource: 'system-paused', pauseCauseCategory: 'rate-limit',
 *      resetsAtMs: ctx.scheduledStartAt}` when the queue lifecycle is
 *      an idle-pending scheduled-restore AND this paused task is the
 *      one whose inFlightId was preserved.
 *   - `{pauseSource: 'operator-paused'}` for any other paused task.
 *
 * `pauseCauseCategory` is intentionally omitted on the operator-paused
 * branch — operator-canceled is a separate state and the `phase-paused`
 * cause does not have a matching category literal.
 */
function derivePausedField(
  req: FeatureRequest,
  ctx: QueueProjectionContext
): QueueItem['paused'] {
  if (req.status !== 'paused') return undefined;
  const isSystemRateLimitRestore =
    ctx.scheduledStartSource === 'system-rate-limit-recovery' &&
    ctx.inFlightId === req.id &&
    typeof ctx.scheduledStartAt === 'number' &&
    Number.isFinite(ctx.scheduledStartAt);
  if (isSystemRateLimitRestore) {
    return {
      pauseSource: 'system-paused',
      pauseCauseCategory: 'rate-limit',
      resetsAtMs: ctx.scheduledStartAt as number
    };
  }
  return { pauseSource: 'operator-paused' };
}

function derivePauseCause(
  req: FeatureRequest,
  registry: ProjectedQueueRegistry | undefined,
  inFlightManualPauseCause: ManualPauseCause | null
): QueueItem['pauseCause'] {
  // Feature 028 — when the in-flight run is paused at a future-phase
  // breakpoint, surface task-level pauseCause 'breakpoint'. Takes precedence
  // over the persisted `req.pauseCause` so the dashboard distinguishes a
  // breakpoint halt from a manual operator pause.
  if (inFlightManualPauseCause === 'breakpoint-paused') return 'breakpoint';
  if (req.pauseCause !== null && req.pauseCause !== undefined) return req.pauseCause;
  const queueId = req.queueId ?? DEFAULT_QUEUE_ID;
  const queue = registry?.entries.find((entry) => entry.id === queueId);
  if (queue?.state === 'manually-paused' && (req.status === 'pending' || req.status === 'in-flight')) {
    return 'queue-paused';
  }
  return null;
}

function extractLastErrorMessage(value: FeatureRequest['lastError']): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return value.message ?? null;
}

export function truncateLabel(description: string): string {
  if (description.length <= 300) return description;
  return `${description.slice(0, 297)}...`;
}
