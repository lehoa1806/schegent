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
  // FR-R3-161 (T053, FR-011/FR-012) — 2026-09-04. `'queue-mismatch'` stood
  // here and is removed. It named a refusal no operator could ever receive.
  // Every caller resolves the row *out of the queue it addressed* and then
  // derives ownership from that same resolution, so the input was a tautology
  // at all six computation sites and the branch below could not be taken
  // (research F18). No code anywhere in `src/` constructed a
  // `QueueMutationRejected('queue-mismatch', …)` by hand either (research F9,
  // re-confirmed at T052 immediately before this deletion), so the value had
  // no producer of any kind. An enumeration that carries a refusal the product
  // cannot produce is a claim about behaviour that does not exist; the other
  // way to resolve that — keep it and make it reachable — would mean inventing
  // a cross-queue addressing path this product does not have. T061 pins the
  // remaining count at three so restoring a fourth member cannot pass quietly.
  | 'illegal-source-status'
  | 'in-flight-ownership-conflict';

/**
 * FR-R3-161 (T062, US5 scenario 2) — the vocabulary above as a value, for the
 * one consumer that has to recognise a reason at runtime rather than at the
 * type level: `queue-manager.ts`, which converts a transition rejection into a
 * `{ ok: false, reason }` result and must re-throw anything else.
 *
 * It used to keep its own hand-written `Set` of the same literals. Two
 * enumerations of one vocabulary can drift, and the compiler only caught the
 * harmless direction: a value not in the union was an error, but a union
 * member missing from the Set was not — and that is the direction that hurts,
 * because a new reason nobody mirrored is re-thrown at an operator instead of
 * being reported. Deriving the Set from the union removes the second
 * enumeration rather than testing it: `Record<TaskTransitionRejectionReason,
 * true>` fails to compile if a member is missing *and* if a key is not a
 * member, so this literal cannot fall behind the union in either direction.
 */
const EVERY_REJECTION_REASON: Record<TaskTransitionRejectionReason, true> = {
  'task-not-found': true,
  'illegal-source-status': true,
  'in-flight-ownership-conflict': true
};

export const TASK_TRANSITION_REJECTION_REASONS: ReadonlySet<string> = new Set<string>(
  Object.keys(EVERY_REJECTION_REASON)
);

export interface TaskTransitionDecisionInput {
  readonly operation: TaskTransitionOperation;
  /** `undefined` means no row exists for the addressed task id. */
  readonly currentStatus: FeatureRequestStatus | undefined;
  /** Only meaningful for `'finish'`; the status being written. */
  readonly targetStatus?: TerminalRequestStatus;
  // FR-R3-161 (T055, FR-011b) — 2026-09-04. `readonly queueOwnsTask: boolean`
  // stood here, documented as "whether the row's own `queueId` names the queue
  // actually addressed". It fed exactly one branch, the one removed below, and
  // no other edge in this classifier reads ownership. With that branch gone the
  // input has no consumer, so it goes with it rather than remaining a value
  // every caller must compute and this file must accept and ignore.
  /**
   * Only meaningful for `'mark-in-flight'`; whether the addressed queue's
   * `inFlightId` is already set to a task other than this one.
   */
  readonly queueAlreadyHasDifferentInFlight: boolean;
  /**
   * FR-025 (feature 195, T063) — 2026-09-08. Whether an operator has
   * explicitly asserted that this task's work completed. Only meaningful for
   * `'finish'` with `targetStatus: 'completed'`, and it is the only extra
   * condition anywhere in this table beyond a pair of statuses.
   *
   * **Optional, and absent means not attested.** A caller that omits it is
   * refused, so refusal is the default and forgetting the field cannot widen
   * the table — the direction that matters, since the other one only costs a
   * legitimate operator a second attempt.
   *
   * Nothing may infer this from run state, exit code, or audit content
   * (FR-025). It carries an operator's assertion from the command that made
   * it, and invariant 6 still forbids this function from reading anything but
   * the fields it is handed — so this is the whole of what it knows about the
   * attestation.
   */
  readonly operatorAttestedCompletion?: boolean;
}

export type TaskTransitionDecisionResult =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: TaskTransitionRejectionReason };

const ELIGIBLE: TaskTransitionDecisionResult = { eligible: true };

function reject(reason: TaskTransitionRejectionReason): TaskTransitionDecisionResult {
  return { eligible: false, reason };
}

export function decideTaskTransition(input: TaskTransitionDecisionInput): TaskTransitionDecisionResult {
  const {
    operation,
    currentStatus,
    targetStatus,
    queueAlreadyHasDifferentInFlight,
    operatorAttestedCompletion
  } = input;

  // Existence is checked before any edge, for every operation (feature 192's
  // contracts/task-transition-decision.md invariant 2).
  //
  // FR-R3-161 (T054) — `if (!queueOwnsTask) return reject('queue-mismatch')`
  // stood on the next line, the second of two pre-edge checks; invariant 2 read
  // "existence and ownership … in that order". Ownership is no longer checked
  // here because the caller establishes it by construction when it resolves the
  // row, which is why the branch was unreachable — see the note on the reason
  // above.
  if (currentStatus === undefined) return reject('task-not-found');

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
      // research.md R4 — `finish` legitimately covers edges of the closed
      // transition table with one method: in-flight → any terminal outcome,
      // and the "cancel before start" pending → canceled edge, reached from
      // `runCancel` in `src/commands/cancel.ts` (named rather than cited by
      // line: FR-R3-161 moved those lines, and a line number is the half of a
      // reference that rots without failing anything).
      if (currentStatus === 'in-flight') return ELIGIBLE;
      if (currentStatus === 'pending' && targetStatus === 'canceled') return ELIGIBLE;
      // FR-R3-161 (T038, FR-014) — admitting a cancellation does not halt the
      // queue. `queue-halt-policy.ts` derives the blocking set from `failed`
      // rows alone and states there why `canceled` is deliberately excluded;
      // `tests/unit/queue/queue-halt-policy.test.ts` pins it. The two features
      // meet at this line and agree without either reading the other: this
      // table decides whether a cancellation is admitted, that predicate
      // decides whether the queue keeps draining.
      // FR-R3-160 — the third edge: "fail before start", the sibling of the
      // cancel-before-start edge above.
      //
      // `WorkflowController.admitNew` builds the Run *before* it marks the task
      // in-flight, and covers `runFactory.create`, `store.setRun` and
      // `markInFlight` with a single `try`. Anything that throws before
      // `markInFlight` commits therefore leaves the task `pending` — an
      // unresolvable `pipelineId` or an unknown phase (both
      // `UnresolvablePipelineError`), an unapproved git mutation plan, or a
      // `setRun` that fails. The unresolvable `pipelineId` is the case
      // reproduced in specs/196-host-suite-exit-zero/research.md §4a; the others
      // were reaching the identical trap, so this arm is what releases all of
      // them (widened from "thrown by `create`" on a code-review finding).
      //
      // `reportUnexpectedStartFailure` then tries to fail the task, and without
      // this arm that `finish` was refused `illegal-source-status`, logged, and
      // ignored: the task stayed pending, and the same failure path ended by
      // re-arming the auto-drain, which re-drove the same task into the same
      // refusal. ~19,500 iterations per second retaining ~1.3 KB each, until the
      // worker's heap was gone — the reason the host suite could not exit zero.
      //
      // Deliberately narrow, and not a general "finish from pending": `completed`
      // stays refused below, because a task that never ran cannot have completed.
      // Both admitted pre-start edges name an outcome reachable without executing.
      if (currentStatus === 'pending' && targetStatus === 'failed') return ELIGIBLE;
      // FR-025 (feature 195, T063, BUG-001) — 2026-09-08. Edge 4: attested
      // completion, and the first terminal → terminal edge in this table.
      //
      // Read the sentence three lines up carefully, because it is why this edge
      // had to be added rather than merely used. `failed -> completed` was
      // refused by the fallthrough below, not by any rule about it: the reason
      // recorded above reasons about `pending -> completed`, and "a task that
      // never ran cannot have completed" is a statement about a task that never
      // ran. A task whose phase committed an irreversible side effect and was
      // THEN recorded `failed` has run, and that sentence does not reach it.
      // The case was unconsidered, not decided against — which is easy to miss,
      // because an enumeration whose stated reason covers one of its neighbours
      // reads exactly like one that covers them all.
      //
      // Feature 195's queue halts on a `failed` row and had two ways out, both
      // of which change the row: retry re-runs the phase (repeating the side
      // effect) and removal deletes it (destroying the record that the work
      // happened). This is the third, and the only one that leaves the row.
      //
      // The gate is the operator's assertion and nothing else. `completed`
      // is already non-blocking, so the halt then ends by the same
      // recomputation FR-003 requires, with nothing stored about it.
      //
      // Justification and scope: specs/192-task-transitions-deletion-consent/
      // contracts/task-transition-decision.md, invariant 4, "Edge 4 — attested
      // completion" (the amendment that invariant's last sentence demands).
      // Note what stays refused: `failed -> canceled` — which feature 195's own
      // FR-009 guard proves and whose meaning FR-026 requires be left intact —
      // and `paused`/`canceled -> completed`.
      if (currentStatus === 'failed' && targetStatus === 'completed' && operatorAttestedCompletion === true) {
        return ELIGIBLE;
      }
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
