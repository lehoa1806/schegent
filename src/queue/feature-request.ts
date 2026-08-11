import type { FrozenRunPlan } from '../contracts/run-request';

export type FeatureRequestStatus =
  | 'pending'
  | 'in-flight'
  | 'paused'
  | 'completed'
  | 'canceled'
  | 'failed';

/**
 * Queue lifecycle discriminator. Single source of truth for whether
 * `AutoDrainCoordinator` may promote the next pending task.
 *
 * - `running`         — `inFlightId !== null`; an in-flight task is draining.
 * - `operator-paused` — operator paused the queue; auto-drain is suppressed.
 * - `idle-pending`    — entered from `active-empty` via an enqueue without an
 *                       explicit start. May carry a scheduled trigger.
 * - `active-empty`    — no in-flight, no operator pause, no pending start
 *                       intent — the steady-state default.
 *
 * Transition graph and lockstep invariants live in
 * [data-model.md §QueueLifecycle](../../specs/065-enqueue-start-separation/data-model.md).
 */
export type QueueLifecycle =
  | 'running'
  | 'operator-paused'
  | 'idle-pending'
  | 'active-empty';

/**
 * Why the queue is currently (or was previously) in `idle-pending`. Used as the
 * `scheduledStartSource` field on `QueueState` and as the `source` field on
 * `EnqueueStartIntent`/`StartQueueIntent`. Cleared to `null` on the operator's
 * next explicit start (per FR-020).
 */
export type ScheduledStartSource =
  | 'operator-chooser'
  | 'operator-restart'
  | 'wake-up-runner'
  | 'programmatic-now'
  | 'programmatic-scheduled'
  | 'migration-default'
  | 'system-rate-limit-recovery';

export interface FeatureRequestFailure {
  readonly code?: string;
  readonly message: string;
  readonly phase?: string;
  readonly correlationId?: string;
}

export type FeatureRequestRerunReason = 'manual' | 'retry-active' | 'auto-drain';

export type FeatureRequestPauseCause = 'phase-paused' | 'manually-paused-task';

export interface FeatureRequestRerun {
  readonly originalRunId: string;
  readonly originalDescription: string;
  readonly reason: FeatureRequestRerunReason;
}

export interface FeatureRequest {
  id: string;
  description: string;
  enqueuedAt: number;
  createdAt: number;
  startedAt: number | null;
  updatedAt: number;
  completedAt: number | null;
  status: FeatureRequestStatus;
  queueId?: string;
  position: number;
  pauseCause?: FeatureRequestPauseCause | null;
  runId: string | null;
  retryCount: number;
  lastError: FeatureRequestFailure | string | null;
  pausedReason: string | null;
  pipelineId?: string;
  rerun?: FeatureRequestRerun;
  /**
   * Feature 087 (T034) — the plan frozen at submission, when this item came
   * from the run composer. Present only then: an item enqueued before this
   * feature, or from any other path, still carries none and is resolved
   * through the effective catalog at drain exactly as before.
   *
   * Additive and optional, so a pre-feature record reads back byte-identical
   * and no `STATE_SCHEMA_VERSION` bump is needed (the feature-082 precedent).
   */
  runPlan?: FrozenRunPlan;
}

export interface QueueState {
  requests: FeatureRequest[];
  inFlightId: string | null;
  paused: boolean;
  pausedReason: string | null;
  updatedAt: number;
  // ─── v7 additive fields (feature 065) ──────────────────────────
  // `paused` and `pausedReason` are retained as legacy mirrors:
  //   paused === (queueLifecycle === 'operator-paused')
  queueLifecycle: QueueLifecycle;
  scheduledStartAt: number | null;
  scheduledStartSource: ScheduledStartSource | null;
  /**
   * Set to `'pending'` by the v6→v7 migrator when at least one queue record
   * lands in `idle-pending` with `scheduledStartSource: 'migration-default'`.
   * Flipped to `'dismissed'` once the operator dismisses the one-time notice
   * via the existing inbound `WebviewMessage` channel (per FR-020 / T054a).
   * Default for a never-migrated queue is `'dismissed'` (nothing to surface).
   */
  migrationNotice?: 'pending' | 'dismissed';
}

export const MAX_DESCRIPTION_LENGTH = 32_000;
export const MAX_PENDING_TASKS_PER_QUEUE = 100;

export function validateDescription(description: string): string {
  const trimmed = description.trim();
  if (trimmed.length === 0) {
    throw new Error('Feature description must be non-empty');
  }
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`Feature description exceeds ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  return trimmed;
}

export function ensureExtendedFeatureRequest(raw: Partial<FeatureRequest> & { id: string; description: string; enqueuedAt: number; status: FeatureRequestStatus; position: number; runId: string | null }): FeatureRequest {
  return {
    retryCount: 0,
    lastError: null,
    pausedReason: null,
    queueId: 'default',
    pauseCause: null,
    startedAt: null,
    completedAt: null,
    createdAt: raw.enqueuedAt,
    updatedAt: raw.enqueuedAt,
    ...raw
  };
}
