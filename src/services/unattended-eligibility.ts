// FR-R4-F02 (spec 240, US1; contract U1; data-model §1, §2; FR-001, FR-002) — the one rule for
// whether an unattended wakeup may resume a Run.
//
// THE DEFECT. The credits-restored sweep resumed every key of the Run map that had no pending
// delayed retry. A failed sibling was restarted with a fresh retry budget, a Run the operator had
// paused was resumed over their decision, and a pause the operator had asked for by closing a
// queue was undone. Nothing said which Runs a wakeup was FOR.
//
// THE RULE, as an allow-list. A Run is eligible only when every rule passes, so a pause cause or a
// Run state added later is ineligible without an edit here (`ManualPauseCause` is enumerated by a
// test). The rules run in this order, and the first to fail names the reason:
//
//   1  the queue holds a Run                                       no-run
//   2  it is `paused`                                              not-paused
//   3  it carries no manual-pause cause                            manual-pause
//   a backoff wakeup:
//   4b it holds a delayed-retry pair                               cause-mismatch
//   5b the deadline has been reached                               deadline-not-reached
//   a credits wakeup:
//   4c it holds NO delayed-retry pair (a pending backoff wins)     backoff-pending
//   5c it carries a credit-pause record                            cause-mismatch
//   6c that record's polling window has not stopped                credit-polling-stopped
//
// A retry-cap-exhausted pause (paused, count at the cap, both pairs null, no credit record) fails
// 4b or 5c as `cause-mismatch`: nothing about it says a wakeup was meant for it.
//
// Pure: no I/O, no clock read (the caller hands `now`), no `vscode`. Two callers, and only two: the
// admission service's selection and the controller's recheck inside the lease; a census test
// counts them.
import type { WorkflowRun } from '../state/workflow-run';

/** An unattended trigger to resume a Run: what woke it, which queue, and when the evidence is from. */
export type UnattendedWakeup =
  | { readonly cause: 'credits-restored'; readonly queueId: string; readonly evidenceAt: number }
  | { readonly cause: 'backoff-elapsed'; readonly queueId: string; readonly deadline: number };

/** Why a Run may not be resumed by a wakeup. */
export type UnattendedIneligibility =
  | 'no-run'
  | 'not-paused'
  | 'manual-pause'
  | 'cause-mismatch'
  | 'backoff-pending'
  | 'deadline-not-reached'
  | 'credit-polling-stopped';

export type EligibilityDecision =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: UnattendedIneligibility };

const ineligible = (reason: UnattendedIneligibility): EligibilityDecision => ({
  eligible: false,
  reason
});

const ELIGIBLE: EligibilityDecision = { eligible: true };

function decideBackoff(run: WorkflowRun, now: number): EligibilityDecision {
  if (run.pendingRetryAt === null || run.pendingRetryCause === null) {
    return ineligible('cause-mismatch');
  }
  if (run.pendingRetryAt > now) return ineligible('deadline-not-reached');
  return ELIGIBLE;
}

function decideCredits(run: WorkflowRun): EligibilityDecision {
  if (run.pendingRetryAt !== null) return ineligible('backoff-pending');
  const creditPause = run.creditPause ?? null;
  if (creditPause === null) return ineligible('cause-mismatch');
  if (creditPause.stoppedAt !== null) return ineligible('credit-polling-stopped');
  return ELIGIBLE;
}

/**
 * Whether `wakeup` may resume `run`, with the reason when it may not. `run` is the Run the caller
 * read for `wakeup.queueId`, or `null` when the queue holds none.
 */
export function decideUnattendedEligibility(
  run: WorkflowRun | null,
  wakeup: UnattendedWakeup,
  now: number
): EligibilityDecision {
  if (run === null) return ineligible('no-run');
  if (run.status !== 'paused') return ineligible('not-paused');
  if (run.manualPauseCause !== null) return ineligible('manual-pause');
  return wakeup.cause === 'backoff-elapsed' ? decideBackoff(run, now) : decideCredits(run);
}
