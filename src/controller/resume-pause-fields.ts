import { OPERABLE_RUN_STATUSES, type RunPatch, type WorkflowRun } from '../state/workflow-run';
import { isRunRaceRefusal, type WorkspaceStateStore } from '../state/workspace-state';
import { decideUnattendedEligibility, type UnattendedWakeup } from '../services/unattended-eligibility';

/**
 * FR-R4-F02 (contract U3 G9) — thrown by the resume's patch, inside the `KEYS.run` link, when an
 * unattended wakeup finds the Run it was selected for is no longer eligible. `patchRunForResume`
 * maps it to a refusal, so nothing is written for it.
 */
export class UnattendedAdmissionRefused extends Error {
  constructor() {
    super('the Run is no longer eligible for this unattended wakeup');
    this.name = 'UnattendedAdmissionRefused';
  }
}

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

/** What the resume admission freezes onto the Run it is about to drive. */
export interface ResumeAdmissionFields {
  readonly pipeline: WorkflowRun['pipeline'];
  readonly defaultRunnerKind: WorkflowRun['defaultRunnerKind'];
  readonly mutationPlan: WorkflowRun['mutationPlan'];
  readonly envelope: WorkflowRun['envelope'] | undefined;
  readonly gitApprovalReceipt: WorkflowRun['gitApprovalReceipt'] | undefined;
}

/**
 * FR-R4-F01 (FR-008) — the admission write of `resumeExistingOnQueue`, as a PATCH of the Run
 * as it is inside the `KEYS.run` chain rather than a whole record built from an earlier read.
 *
 * The frozen plan comes from `fields`, which the caller computed; everything that depends on
 * the Run's own state (a failed Run's retry cap, a stale pause stamp) is read from `current`.
 * Absent stays absent: a Run with no plan on either side adds no key and serializes exactly as
 * it did before this feature (T267).
 */
export function resumeAdmissionPatch(
  current: WorkflowRun,
  fields: ResumeAdmissionFields,
  unattended?: UnattendedWakeup
): RunPatch {
  return {
    status: 'running',
    lastError: null,
    pipeline: fields.pipeline,
    defaultRunnerKind: fields.defaultRunnerKind,
    mutationPlan: fields.mutationPlan,
    ...(fields.envelope ? { envelope: fields.envelope } : {}),
    ...(fields.gitApprovalReceipt ? { gitApprovalReceipt: fields.gitApprovalReceipt } : {}),
    pendingRetryAt: null,
    pendingRetryCause: null,
    // FR-R4-F02 (contract U3 G12) — a resume leaves `paused`, so the credit pause goes with the
    // other pause fields; `validateRunInvariants` refuses the Run if this is forgotten.
    creditPause: null,
    // Resuming a terminally failed run (operator retry) resets the retry cap so the phase gets
    // a fresh set of attempts, and clears manual-pause fields that may linger from the failure.
    // An unattended wakeup is not an operator's retry (FR-005): it writes no count, so a count of
    // five stays five even if a failed Run were ever to reach here.
    ...(current.status === 'failed'
      ? {
          ...(unattended === undefined ? { delayedRetryCount: 0 } : {}),
          manualPauseAt: null,
          manualPauseCause: null,
          resumeTargetPhaseId: null
        }
      : {}),
    ...clearedPauseFieldsOnResume(current)
  };
}

/**
 * The resume admission's write, with the unattended recheck inside the lease (contract U3 G9).
 *
 * An unattended wakeup is rechecked on the Run as it is NOW, inside the `KEYS.run` link and after
 * the caller holds the lease: selection read the Run several awaits ago, and a pause, a replacement
 * or an ending in the gap refuses here with nothing written. `'ineligible'` is that refusal, kept
 * apart from `null` (a lost race) so the admission can report which it was.
 */
export async function patchRunForResumeAdmission(
  store: Pick<WorkspaceStateStore, 'updateRun' | 'runCommitClaim'>,
  queueId: string,
  run: WorkflowRun,
  fields: ResumeAdmissionFields,
  unattended?: UnattendedWakeup
): Promise<WorkflowRun | 'ineligible' | null> {
  // A holder, not a `let`: the flag is set inside the patch callback, which control-flow analysis
  // does not follow, so a `let` would read as always false at the check below.
  const recheck = { refused: false };
  const next = await patchRunForResume(store, queueId, run, 'resume-admission', (current) => {
    if (unattended !== undefined && !decideUnattendedEligibility(current, unattended, Date.now()).eligible) {
      recheck.refused = true;
      throw new UnattendedAdmissionRefused();
    }
    return resumeAdmissionPatch(current, fields, unattended);
  });
  if (next !== null) return next;
  return recheck.refused ? 'ineligible' : null;
}

/**
 * The resume's write: a patch of the Run as it is now, or `null` when it has ended or been
 * replaced since the caller read it (a lost race, not a fault; the resume is then not admitted).
 */
export async function patchRunForResume(
  store: Pick<WorkspaceStateStore, 'updateRun' | 'runCommitClaim'>,
  queueId: string,
  run: WorkflowRun,
  label: 'resume-prompt' | 'resume-admission',
  patch: (current: WorkflowRun) => RunPatch
): Promise<WorkflowRun | null> {
  try {
    return await store.updateRun(
      queueId,
      { runId: run.id, allowedStatuses: OPERABLE_RUN_STATUSES, label, patch },
      store.runCommitClaim(queueId)
    );
  } catch (error) {
    if (isRunRaceRefusal(error) || error instanceof UnattendedAdmissionRefused) return null;
    throw error;
  }
}
