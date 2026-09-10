import type { FrozenRunPlan } from '../contracts/run-request';
import type { QueuePauseSource } from './queue-registry';
import type { QueueFailurePolicy } from '../contracts/queue-failure-policy';
import type { DegradedPhaseEntry, TaskPhaseProgressProjection } from '../contracts/snapshot-projections';

// FR-R3-132 (T1502) — moved to `src/contracts/snapshot-vocabulary.ts` so the webview
// imports it instead of restating it. Re-exported unchanged.
import type { QueueLifecycle } from '../contracts/snapshot-vocabulary';

export type { QueueLifecycle };


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

/**
 * FR-R3-153 — the narrowed target type for `QueueManager.finish`. Replaces the
 * over-permissive `FeatureRequestStatus` the method's `status` parameter used
 * to accept, which let a caller (in principle) "finish" a task into `paused`
 * or `in-flight`. A pure type addition; `TERMINAL_REQUEST_STATUSES` remains
 * the one runtime source of truth this type is derived from.
 */
export type TerminalRequestStatus = (typeof TERMINAL_REQUEST_STATUSES)[number];

export function isTerminalRequestStatus(status: FeatureRequestStatus | string): boolean {
  return (TERMINAL_REQUEST_STATUSES as readonly string[]).includes(status);
}



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

/**
 * Feature 195 (T065, FR-026, SC-017) — how a `completed` row came to be
 * `completed`, when the answer is not "the host watched it succeed".
 *
 * **One member, and that is the shape rather than an unfinished union.** The
 * alternative reading is the field's own absence, and absence is not a
 * convention here — it is provable. Before T063 there was exactly one edge into
 * `completed` and it was the host's (`QueueManager.finish`), so no stored row
 * carrying no marker can have been attested, including every row written before
 * this feature existed. Adding `'host-verified'` as a second member would
 * therefore record nothing a reader cannot already conclude, at the cost of
 * putting a provenance argument on `finish` — the generic terminal-write path
 * every failure handler in the product calls, which is the exact coupling T063
 * refused when it made attestation a separate method.
 *
 * A future third route into `completed` adds a member here and needs no
 * migrator, because absence keeps meaning what it already means.
 */
export type CompletionProvenance = 'operator-attested';

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
  /**
   * FR-R3-158 (FR-009) — the settled-phase pair recorded when this task
   * reached a terminal status, so the figure outlives the Run that produced
   * it. Runs are held one per queue, so a second failure in the same queue
   * disposes of the first Run: without this field the earlier row's count
   * would simply vanish, which is the defect the feature exists to end.
   *
   * Optional and additive, on the `runPlan` precedent directly above — a
   * record from before this feature carries none, reads back byte-identical,
   * and gives a migrator nothing to do. Absence means **unknown**, never
   * "settled nothing"; a task that genuinely settled none records
   * `{ settled: 0, total: N }`.
   *
   * Cleared on retry (FR-009b), so a new attempt is never reported with the
   * previous attempt's numbers. Its reader lands with it, in the queue
   * projector.
   */
  phaseProgress?: TaskPhaseProgressProjection;
  /**
   * FR-R3-157 (FR-011a) — the phases this task carried past their retry cap,
   * recorded when it reached a terminal status so the mark outlives the Run
   * that produced it. Same durability argument as `phaseProgress` directly
   * above, and for the same reason: a mark held only on the Run reads blank on
   * every finished row the moment the next task starts.
   *
   * Optional and additive, so a pre-feature record reads back byte-identical
   * and no `STATE_SCHEMA_VERSION` bump is needed. **Absence means NOT
   * degraded** — which is the opposite of `phaseProgress` above, where absence
   * means unknown, and the difference is not an inconsistency: a settled-phase
   * count is a measurement that may be unavailable, while a degradation is an
   * event that either happened and was recorded or did not happen at all. An
   * empty list means the same thing and is never written (`run-degradation.ts`).
   *
   * Cleared on retry (FR-013), so a new attempt never carries the previous
   * attempt's doubt.
   */
  degradedPhases?: readonly DegradedPhaseEntry[];
  /**
   * Feature 195 (T065, FR-026, SC-017) — present when the operator asserted
   * this task's outcome rather than the host observing it.
   *
   * **A fact about the task, never about the halt.** SC-008 forbids storing
   * anything that describes a halt, and this is not that: it says how this row
   * reached its status, and it is written on a row that may never have halted
   * anything. The halt still ends by FR-003's recomputation with nothing stored
   * — see `QueueManager.attestCompleted`, which writes this and no flag.
   *
   * **A marker beside the status, not a seventh `FeatureRequestStatus`.** A new
   * member of that union would fail the blocking census's exhaustiveness
   * enforcement with no registered expectation (data-model.md §5) and break
   * FR-025's promise of no new vocabulary. Attested and verified completions
   * are identical under the census's own question — is this row blocking — and
   * differ only in provenance, which is why provenance is a separate field.
   *
   * Optional and additive, on the `degradedPhases` precedent directly above, so
   * a pre-feature record reads back byte-identical and no `STATE_SCHEMA_VERSION`
   * bump or migrator is needed (FR-017, research D2). **Absence means the host
   * verified the outcome** — see `CompletionProvenance` for why that is a
   * provable reading and not a default.
   *
   * **Nothing in the host reads it, by requirement.** FR-026 asks that an
   * attested outcome be distinguishable "so a later reader can tell", and
   * SC-017 measures exactly that: an assertion over the stored record, in
   * `tests/integration/completion-provenance.test.ts`. This is deliberately not
   * the `completedAwaitingExit` defect that
   * `tests/lint/completed-awaiting-exit-has-a-reader.test.ts` was written for:
   * that field's absence made the host decide something wrongly, whereas this
   * one is required to change no decision at all — FR-025 admits the attested
   * exit precisely because it needs no machinery, and a host reader branching on
   * provenance would be the machinery it promised not to add.
   *
   * Not cleared on retry, unlike the two fields above, because it cannot
   * survive one: `retry` admits only `failed | canceled | paused`, and a row
   * carrying this marker is `completed`.
   */
  completionProvenance?: CompletionProvenance;
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
  /**
   * Feature 195 (T007, FR-001, FR-017, FR-018) — this queue's own answer to
   * "does a failed task stop it", or absent when the operator has never
   * stated one.
   *
   * The optionality IS the shape gate, not an incidental default: a record
   * carrying this field has been touched by an operator (`CMD_SET_QUEUE_
   * FAILURE_POLICY`, `src/commands/set-queue-failure-policy.ts`); one without
   * it has not. That is what lets a later change to the workspace default
   * (`schegent.queue.haltOnTaskFailure`) reach exactly the un-opinionated
   * queues and none of the overridden ones (FR-018) — see
   * `effectiveQueueFailurePolicy` in `src/contracts/queue-failure-policy.ts`.
   * Every pre-existing record lacks this field and loads unchanged (FR-017):
   * no schema bump, no migrator (research.md D2).
   */
  failurePolicy?: QueueFailurePolicy;
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
