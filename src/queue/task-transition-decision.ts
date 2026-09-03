import { isTerminalRequestStatus, type FeatureRequestStatus, type TerminalRequestStatus } from './feature-request';

/**
 * FR-R3-153 — the one authoritative rule set every Task status writer
 * consults before writing anything (spec.md's Acceptance boundary,
 * FR-001–FR-005; closed transition table, FR-006–FR-010).
 *
 * This module is a pure classifier: it reads the fields it is handed and
 * returns an eligibility verdict, never touching `store`, `queue`, or any
 * other effectful dependency (contracts/task-transition-decision.md
 * invariant 6). It mirrors FR-R3-151's `decidePhaseControl`
 * (`../controller/phase-control-decision.ts`) exactly — same shape, same
 * "operation"-keyed switch, same census-test guard pattern.
 *
 * Deletion (any visible status → absent) is deliberately not decided here —
 * it is a row removal, not a status write, and stays `task-deletion.ts`'s
 * concern (contracts/task-transition-decision.md invariant 5).
 */

/** The closed set of status-write operations this classifier decides for. */
export type TaskTransitionOperation = 'mark-in-flight' | 'pause' | 'finish' | 'return-to-pending';

/**
 * Closed rejection-reason vocabulary this classifier returns. Every literal
 * here is also a member of `QueueMutationRejectReason`
 * (`src/state/workspace-state.ts`) — extending that existing closed union
 * rather than introducing a second, parallel reason type (research.md R3).
 * Declared as its own narrowed union so this file has no runtime dependency
 * on `workspace-state.ts` (invariant 6 — no store access, not even a type
 * import that could grow one).
 */
export type TaskTransitionRejectionReason =
  | 'task-not-found'
  | 'queue-mismatch'
  | 'illegal-source-status'
  | 'in-flight-ownership-conflict';

export interface TaskTransitionDecisionInput {
  readonly operation: TaskTransitionOperation;
  /** `undefined` means no row exists for the addressed task id. */
  readonly currentStatus: FeatureRequestStatus | undefined;
  /** Only meaningful for `'finish'`; the status being written. */
  readonly targetStatus?: TerminalRequestStatus;
  /**
   * Whether the row's own `queueId` names the queue actually addressed —
   * computed by the caller via strict resolution (research.md R2), never by
   * falling back to a guessed default queue.
   */
  readonly queueOwnsTask: boolean;
  /**
   * Only meaningful for `'mark-in-flight'`; whether the addressed queue's
   * `inFlightId` is already set to a task other than this one.
   */
  readonly queueAlreadyHasDifferentInFlight: boolean;
}

export type TaskTransitionDecisionResult =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: TaskTransitionRejectionReason };

const ELIGIBLE: TaskTransitionDecisionResult = { eligible: true };

function reject(reason: TaskTransitionRejectionReason): TaskTransitionDecisionResult {
  return { eligible: false, reason };
}

export function decideTaskTransition(input: TaskTransitionDecisionInput): TaskTransitionDecisionResult {
  const { operation, currentStatus, targetStatus, queueOwnsTask, queueAlreadyHasDifferentInFlight } = input;

  // Existence and ownership are checked before any edge, for every
  // operation, in that order (contracts/task-transition-decision.md
  // invariant 2).
  if (currentStatus === undefined) return reject('task-not-found');
  if (!queueOwnsTask) return reject('queue-mismatch');

  switch (operation) {
    case 'mark-in-flight': {
      // Checked first: a genuinely different task already owns the queue's
      // one execution slot is always refused, regardless of this task's own
      // status. This is the actual safety invariant LC-T-01 named (a
      // duplicate admission that steals a queue's one slot from a different
      // task) — everything below is about which of THIS task's own
      // statuses may (re-)claim the slot once that check has passed.
      if (queueAlreadyHasDifferentInFlight) return reject('in-flight-ownership-conflict');
      // Corrected twice during implementation (not the original research.md
      // R2 design, which required `currentStatus === 'pending'`
      // unconditionally):
      //   - `in-flight`: `WorkflowController#resumeExistingOnQueue` re-marks
      //     a Task in-flight on the SAME Run after a delayed-retry countdown
      //     elapses. `RetryHandler#handleDelayedRetry` pauses the *Run*
      //     (`status: 'paused'`, `pendingRetryAt` armed) without ever moving
      //     the Task row off `in-flight` — see research.md R10.
      //   - `paused`: `RunDriver`'s pause-verify branches persist the Run as
      //     `paused` AND call `QueueManager.pause` on the same Task
      //     (clearing `inFlightId`) once an operator's `pauseActivePhase`
      //     sets `manualPauseAt`. `PhaseControlService#resumeActivePhase`'s
      //     `scheduleResume` → `resumeExistingOnQueue` then re-admits that
      //     same, now-`paused` Task directly — a real, existing production
      //     edge distinct from `retry()`'s separate `paused → pending` UI
      //     affordance.
      //   - `failed`: `WorkflowController#resumeExistingOnQueue` resumes a
      //     Run directly from `status: 'failed'` (its own guard refuses only
      //     `completed`/`canceled` — the same operable/terminal split
      //     `isOperableRunStatus` names for Runs: "failed is deliberately
      //     operable... only completed and canceled are finished in both
      //     senses"). An operator repointing a halted workflow and resuming
      //     it hits this directly, without going through `retry()` first.
      // All three are idempotent re-affirmations of a task this queue
      // already owns (or is free to admit), not a duplicate admission — the
      // check above already refuses the one case that matters. Only
      // `completed`/`canceled` — finished in both senses, per the same
      // Run-status precedent — remain refused.
      if (
        currentStatus === 'pending' ||
        currentStatus === 'in-flight' ||
        currentStatus === 'paused' ||
        currentStatus === 'failed'
      ) {
        return ELIGIBLE;
      }
      return reject('illegal-source-status');
    }

    case 'pause': {
      if (currentStatus !== 'in-flight') return reject('illegal-source-status');
      return ELIGIBLE;
    }

    case 'finish': {
      // FR-006 — a runtime check, not only the `TerminalRequestStatus`
      // compile-time narrowing: `targetStatus` is still an ordinary string at
      // the type boundary a caller crosses to get here, so a non-terminal
      // value must be refused here too, defense in depth.
      if (targetStatus === undefined || !isTerminalRequestStatus(targetStatus)) {
        return reject('illegal-source-status');
      }
      // research.md R4 — `finish` legitimately covers two edges of the closed
      // transition table with one method: in-flight → any terminal outcome,
      // and the "cancel before start" pending → canceled edge
      // (`src/commands/cancel.ts:133`).
      if (currentStatus === 'in-flight') return ELIGIBLE;
      if (currentStatus === 'pending' && targetStatus === 'canceled') return ELIGIBLE;
      return reject('illegal-source-status');
    }

    case 'return-to-pending': {
      if (currentStatus === 'paused' || currentStatus === 'failed' || currentStatus === 'canceled') {
        return ELIGIBLE;
      }
      return reject('illegal-source-status');
    }
  }
}
