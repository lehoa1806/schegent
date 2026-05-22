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

import type { FeatureRequest, QueueState } from '../../queue/feature-request';
import { DEFAULT_QUEUE_ID, type QueueRegistry } from '../../queue/queue-registry';
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
  readonly registry?: QueueRegistry;
  /**
   * Feature 028 — when the active run is paused at a future-phase breakpoint,
   * the run-level `manualPauseCause === 'breakpoint-paused'`. The projector
   * surfaces this as task-level `pauseCause: 'breakpoint'` on the in-flight
   * QueueItem. Null when the in-flight run is not breakpoint-paused.
   */
  readonly inFlightManualPauseCause?:
    | 'operator-paused'
    | 'queue-paused-mid-run'
    | 'breakpoint-paused'
    | null;
}

export interface QueueProjectionResult {
  inFlight: QueueItem | null;
  pending: QueueItem[];
  recent: QueueItem[];
  queues: QueueSummary[];
}

export function projectQueue(
  queue: QueueState,
  ctx: QueueProjectionContext
): QueueProjectionResult {
  const requests = queue.requests ?? [];
  const inFlightSrc =
    requests.find((r) => r.id === queue.inFlightId && r.status === 'in-flight') ?? null;
  const pendingSrc = requests
    .filter((r) => r.status === 'pending')
    .sort((a, b) => a.position - b.position);
  const recentSrc = requests
    .filter((r) => r.status === 'completed' || r.status === 'canceled' || r.status === 'failed')
    .sort((a, b) => b.enqueuedAt - a.enqueuedAt)
    .slice(0, RECENT_QUEUE_MAX);

  return {
    inFlight: inFlightSrc ? toQueueItem(inFlightSrc, ctx) : null,
    pending: pendingSrc.map((r) => toQueueItem(r, ctx)),
    recent: recentSrc.map((r) => toQueueItem(r, ctx)),
    queues: projectQueues(ctx.registry, requests)
  };
}

function toQueueItem(req: FeatureRequest, ctx: QueueProjectionContext): QueueItem {
  const isInFlight = req.status === 'in-flight' && req.id === ctx.inFlightId;
  const lastErrorMessage = extractLastErrorMessage(req.lastError);
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
    currentPhase: isInFlight ? ctx.inFlightPhase : null,
    queueId: req.queueId ?? DEFAULT_QUEUE_ID,
    position: req.position,
    pauseCause: derivePauseCause(req, ctx.registry, isInFlight ? ctx.inFlightManualPauseCause ?? null : null),
    // Feature 020 — surface the active pipeline id so the Activity
    // Feed selector can derive the diagnostics tuple
    // (pipelineId, phaseId, iterationN) without a host round-trip.
    currentPipelineId: req.pipelineId ?? null
  });
}

function projectQueues(
  registry: QueueRegistry | undefined,
  requests: readonly FeatureRequest[]
): QueueSummary[] {
  // Feature 030 — single-queue mode. The registry has exactly one entry
  // by v6 invariant (id === DEFAULT_QUEUE_ID, position === 0,
  // schedule === null). The summary is retained as a one-element array so
  // existing webview consumers (QueueGlobalActions cascade badge, paused
  // indicator) read the same shape unchanged; the flat ordered task list
  // surfaces on `QueueProjection.pending` / `recent` / `inFlight`. This
  // projection is UI-only and never persisted.
  if (!registry) return [];
  const entry = registry.entries[0];
  if (!entry) return [];
  return [
    {
      id: entry.id,
      name: entry.name,
      position: entry.position,
      state: entry.state,
      // Feature 028 — surface the queue's pause source so the dashboard
      // can render a "cascaded" badge alongside the manually-paused
      // indicator. Read directly from the registry.
      pauseSource: entry.pauseSource,
      // Feature 030 — schedule is always null under single-queue mode.
      schedule: null,
      // Feature 030 — single-queue: count every active task on the
      // default queue without filtering by per-entry queueId match
      // (legacy multi-queue rows have already been coalesced under the
      // v6 migration).
      taskCount: requests.filter(
        (request) => request.status === 'pending' || request.status === 'in-flight'
      ).length
    }
  ];
}

function derivePauseCause(
  req: FeatureRequest,
  registry: QueueRegistry | undefined,
  inFlightManualPauseCause:
    | 'operator-paused'
    | 'queue-paused-mid-run'
    | 'breakpoint-paused'
    | null
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
