import type { FrozenRunPlan } from '../contracts/run-request';
import type { QueuePauseSource } from './queue-registry';

export type FeatureRequestStatus =
  | 'pending'
  | 'in-flight'
  | 'paused'
  | 'completed'
  | 'canceled'
  | 'failed';

/**
 * The statuses that end a Task, enumerated beside the union they come from.
 *
 * Feature 102 (T049) — sited here for the reason `TERMINAL_RUN_STATUSES` is
 * sited beside `WorkflowRunStatus`: the set and the union change together, and a
 * caller that spelled the three words itself would be a second copy nobody
 * updates. It is emphatically not the same list as that one — this is the queue's
 * vocabulary, that is a Run's, and the two unions differ on `in-flight` and
 * `running`.
 *
 * Enumerated rather than derived by negating the active statuses: `!== 'pending'`
 * also admits `paused`, and a paused Task is accepted work that has not run yet.
 */
export const TERMINAL_REQUEST_STATUSES = ['completed', 'canceled', 'failed'] as const;

export function isTerminalRequestStatus(status: FeatureRequestStatus | string): boolean {
  return (TERMINAL_REQUEST_STATUSES as readonly string[]).includes(status);
}

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
  /**
   * FR-R3-011 — **migration input only.** Not written by live code, not read
   * by live logic, not the answer to "is this queue paused".
   *
   * It was one of three persisted representations of pausedness across two
   * memento keys, with an invariant stated in a comment
   * (`paused === (queueLifecycle === 'operator-paused')`) that no type
   * enforced and no transaction preserved — the memento has no multi-key
   * write, so every operator pause was two writes with a window between them.
   * A window disposed inside that gap left the pair split, which is what
   * `reconcileQueuePauseStateIfDivergent()` was written to repair and why its
   * existence was the proof the three could disagree.
   *
   * **Optional, and that is the shape gate.** `migrateV12ToV13()` drops it from
   * every entry it writes, so a record that still carries `paused` is a record
   * that has not been collapsed yet. Migrations in this repo are gated on record
   * shape rather than on the persisted version number, and this is that shape.
   * `tests/lint/no-legacy-pause-mirror-write.test.ts` fails the build on a live
   * write.
   *
   * @deprecated Migration input only. Read `queueLifecycle` / `pauseSource`.
   */
  paused?: boolean;
  /**
   * Why this queue was paused, in words — the `retry-cap-exhausted:<runId>`
   * marker the controller matches on, or an operator-facing sentence.
   *
   * **Live, and deliberately not collapsed.** It survived FR-R3-011 while
   * `paused` did not, because it is not a second representation of anything:
   * `paused` duplicated a boolean `queueLifecycle` already carried, whereas this
   * carries information no other field holds. It is written in the same
   * `updateQueue` call as `queueLifecycle` and `pauseSource`, so the three move
   * together and cannot disagree.
   *
   * Invariant: `null` whenever `queueLifecycle !== 'operator-paused'`.
   */
  pausedReason: string | null;
  updatedAt: number;
  // ─── v7 additive fields (feature 065) ──────────────────────────
  /**
   * FR-R3-011 — **the** persisted answer to whether this queue is paused, and
   * the only one. `queueLifecycle === 'operator-paused'` iff the queue is
   * paused; every other surface derives its view from this field.
   *
   * `KEYS.queue` is a `Record<queueId, QueueState>`, so the discriminator, its
   * attribution (`pauseSource` below) and the armed-restore pairing
   * (`scheduledStartAt` ⟷ `idle-pending`) all live in **one** record and move
   * in **one** write. That is the whole mechanism: there is no second key to
   * interleave with, so a split pair is unrepresentable rather than repaired.
   */
  queueLifecycle: QueueLifecycle;
  /**
   * FR-R3-011 — why this queue is paused, or `null` when it is not.
   *
   * Carried here rather than dropped because `queueLifecycle` alone cannot
   * express a distinction the cascade paths depend on: an operator pause must
   * outrank a cascade pause and must never be demoted to one, and a cascade
   * resume must leave an operator pause standing. That precedence used to live
   * in `QueueRegistryEntry.pauseSource`, in the other key — so collapsing to
   * `queueLifecycle` without it would have been a behaviour regression, not a
   * simplification.
   *
   * Invariant, enforced in one place by construction rather than asserted
   * across two records: `pauseSource === null` iff
   * `queueLifecycle !== 'operator-paused'`.
   */
  pauseSource: QueuePauseSource;
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
