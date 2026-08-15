import type { WorkflowRun } from '../state/workflow-run';

/**
 * BUG-003 — resume-entry interpretation of a Run's pause cause.
 *
 * `resumeExistingOnQueue` asks two questions of a Run it is about to drive, and
 * both are answered by which of the four `ManualPauseCause` values it carries.
 * They live here rather than inline because the answers are per-cause and the
 * reasoning is longer than the code: a reader of the resume path needs to know
 * *that* the cause is consulted, not the case analysis for all four.
 *
 * The sibling path, `PhaseControlService.resumeActivePhase`, clears the pair
 * itself before delegating, so a Run arriving here with `'operator-paused'` or
 * `'breakpoint-paused'` set has come some other way.
 */

/**
 * Whether the resumed invocation continues the paused one's CLI conversation.
 *
 * Two triggers, both pre-existing:
 *   1. `pendingRetryCause !== null` — a watchdog-fired delayed retry, which
 *      continues the failed invocation's conversation.
 *   2. a manual-pause cause that survived to here — the queue-paused-mid-run
 *      cascade, where the queue manager cleared its own field but no controller
 *      entry point cleared the Run's.
 *
 * `'verify-paused'` is excluded by name. It is the third cause that can arrive
 * set, and it is not a continuation: a verify pause resumes by re-invoking the
 * same phase from a clean invocation, which is what it did for as long as that
 * branch left `manualPauseCause` null. Folding it into trigger 2 would make the
 * stamp that fixed the Run's resumability also change how the CLI is invoked —
 * a separate decision, and not one this bug asked for.
 */
export function shouldContinueConversation(run: WorkflowRun): boolean {
  if (run.pendingRetryCause !== null) return true;
  return run.manualPauseCause !== null && run.manualPauseCause !== 'verify-paused';
}

/**
 * The manual-pause fields to clear as the Run leaves `paused`, as a spreadable
 * partial — empty when the cause must survive the resume.
 *
 * A `'verify-paused'` stamp records the pause being left, not a new request to
 * pause, and it has to go: `PhaseSequencer.decideAfterPhase` re-reads
 * `manualPauseAt` from the persisted snapshot at every phase boundary and
 * returns `pause-manual` whenever it is set. Left in place, the resumed Run
 * re-verifies cleanly and then immediately pauses again, one phase further on,
 * for a pause that already happened.
 *
 * Scoped to that one cause rather than to every paused Run.
 * `'queue-paused-mid-run'` MUST survive — `QueueManager.resumeMatchingRunForQueue`
 * keys the queue-unpause auto-resume on that exact string, so clearing it here
 * would leave those Runs unreachable by the control that owns them.
 */
export function clearedPauseFieldsOnResume(
  run: WorkflowRun
): Partial<Pick<WorkflowRun, 'manualPauseAt' | 'manualPauseCause'>> {
  if (run.manualPauseCause !== 'verify-paused') return {};
  return { manualPauseAt: null, manualPauseCause: null };
}
