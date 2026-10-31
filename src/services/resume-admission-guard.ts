// FR-R4-F06 (FR-016, FR-018; contract P, P7 and P8; data-model section 7) — the admission guard
// every resume reaches.
//
// THE GAP THIS CLOSES. Only the activation sweep asked whether the previous host's backend tree
// was gone (`resume-decision.ts`). A Run the sweep declined kept its in-flight status and its
// recorded identity, so a manual resume, the drain's `admitResume`, primacy-gain recovery or an
// unattended wakeup then admitted it with no check at all. `alive` was bypassable, and so would
// `orphaned-group` have been. FR-016 asks that the verdict be repeated on each resume attempt;
// `resumeExistingOnQueue` is the one seam all of those paths reach, and the sweep itself goes
// through it by way of `resumeUnattended`.
//
// WHAT IT OWNS. The two refusals that opened `resumeExistingOnQueue` (no Run, a Run that has
// ended) move here unchanged. It adds the shutdown refusal, so that once the drain is closed no
// resume begins, and the liveness refusals. The order is the contract: the first refusal that
// applies is the one the operator and the audit trail see.
//
// WHY A MODULE. The controller sits within a few lines of its size ceiling, and a policy about
// whether to enter a shared worktree is not controller wiring (the reasoning `resume-decision.ts`
// records for the activation walk).
//
// WHAT IT DOES NOT DO. It never signals anything and never kills an orphan: a decline surfaces,
// exactly as the activation walk's does. Liveness code sends signal 0 only.
import type { WorkflowRun } from '../state/workflow-run';
import {
  NOT_RESUMED,
  NOT_RESUMED_SHUTDOWN,
  NOT_RESUMED_TREE_LIVE,
  type ResumeAdmission
} from '../controller/run-admission';
import { checkLiveness, createLivenessProbe, type LivenessProbe } from './process-liveness';
import {
  decideResume,
  declineMessage,
  orphanedGroupDeclineMessage,
  type ResumeCandidate,
  type ResumeWalkDeps
} from './resume-decision';

/** Why a resume was refused, in the order the guard checks. */
export type ResumeAdmissionRefusal =
  | 'no-run'
  | 'run-ended' // completed or canceled: the two checks that moved from the controller
  | 'shutdown-begun' // the auto-drain coordinator is closed
  | 'previous-tree-alive' // liveness gave `alive`
  | 'previous-group-orphaned'; // liveness gave `orphaned-group`

/**
 * The guard's answer: the Run to resume, or the refusal. Named apart from the controller's
 * `ResumeAdmission` (TA4), which is the value the drain reads and already exists.
 */
export type ResumeCandidateAdmission =
  | { readonly admitted: true; readonly run: WorkflowRun }
  | { readonly admitted: false; readonly refusal: ResumeAdmissionRefusal };

/** What the guard needs. Narrow on purpose, so a test supplies six small fakes. */
export interface ResumeAdmissionGuardDeps {
  /** The queue's persisted Run, or none. */
  readonly getRun: (queueId: string) => WorkflowRun | null | undefined;
  /**
   * Is this window already driving the queue (`controller.isDriving`)? Then the recorded
   * identity is its own live child, and probing it would decline the Run as an orphan of itself.
   */
  readonly isDriving: (queueId: string) => boolean;
  /** Has shutdown begun (`AutoDrainCoordinator.isClosed`)? */
  readonly isClosed: () => boolean;
  readonly liveness: LivenessProbe;
  readonly appendAudit: ResumeWalkDeps['appendAudit'];
  readonly notify: (message: string) => void;
}

/**
 * The controller's option for the probe. The controller's own options extend this, so the
 * guard owns the type and the controller adds no line of its own for it. Absent, the real
 * probe is used, which is what production wants and why `extension.ts` passes nothing.
 */
export interface ResumeGuardOptions {
  readonly livenessProbe?: LivenessProbe | undefined;
}

/** The controller's own parts the guard's deps are assembled from. */
export interface ResumeGuardParts {
  readonly store: { getRun(queueId: string): WorkflowRun | null };
  readonly coordinator: { isClosed(): boolean };
  readonly auditor: { appendResumeDeclined: ResumeAdmissionGuardDeps['appendAudit'] };
  readonly notifier: { warn(message: string): unknown };
  readonly options: ResumeGuardOptions;
  readonly isDriving: (queueId: string) => boolean;
}

/**
 * Assemble the guard's deps from the controller's parts, defaulting the probe. Built per call
 * from live references, so nothing here can go stale between attempts.
 */
export function resumeGuardDeps(parts: ResumeGuardParts): ResumeAdmissionGuardDeps {
  return {
    getRun: (queueId) => parts.store.getRun(queueId),
    isDriving: parts.isDriving,
    isClosed: () => parts.coordinator.isClosed(),
    liveness: parts.options.livenessProbe ?? createLivenessProbe(),
    appendAudit: (entry) => parts.auditor.appendResumeDeclined(entry),
    notify: (message) => void parts.notifier.warn(message)
  };
}

function refuse(refusal: ResumeAdmissionRefusal): ResumeCandidateAdmission {
  return { admitted: false, refusal };
}

/**
 * Decide whether a resume of `queueId` may begin. Asked on every attempt, never cached: the
 * state it reads changes between attempts, and a verdict from an earlier one is exactly the
 * stale answer FR-016 rules out.
 *
 * On a liveness refusal the decline is appended (`run-resume-declined-orphan-alive`, outcome
 * `failure`, `payload.liveness` set to the verdict) and then the operator is told, with the
 * sentence that is true for the verdict. An audit failure never changes the decision: evidence
 * about a decision must not be able to decide it.
 */
export async function admitResumeCandidate(
  deps: ResumeAdmissionGuardDeps,
  queueId: string
): Promise<ResumeCandidateAdmission> {
  const run = deps.getRun(queueId);
  if (!run) return refuse('no-run');
  if (run.status === 'completed' || run.status === 'canceled') return refuse('run-ended');
  if (deps.isClosed()) return refuse('shutdown-begun');
  if (run.spawnIdentity === undefined || deps.isDriving(queueId)) return { admitted: true, run };

  const candidate: ResumeCandidate = { queueId, runId: run.id, spawnIdentity: run.spawnIdentity };
  const verdict = await checkLiveness(run.spawnIdentity, deps.liveness);
  const decision = decideResume(candidate, verdict);
  if (decision.resume) return { admitted: true, run };

  try {
    await deps.appendAudit({
      runId: run.id,
      phase: run.currentPhase,
      iteration: run.currentIteration,
      eventType: decision.eventType,
      payload: decision.payload,
      outcome: 'failure'
    });
  } catch {
    /* evidence about a decision must not change the decision */
  }
  const orphaned = verdict === 'orphaned-group';
  deps.notify(orphaned ? orphanedGroupDeclineMessage(candidate) : declineMessage(candidate));
  return refuse(orphaned ? 'previous-group-orphaned' : 'previous-tree-alive');
}

const ADMISSION_FOR_REFUSAL: Readonly<Record<ResumeAdmissionRefusal, ResumeAdmission>> = {
  'no-run': NOT_RESUMED,
  'run-ended': NOT_RESUMED,
  'shutdown-begun': NOT_RESUMED_SHUTDOWN,
  'previous-tree-alive': NOT_RESUMED_TREE_LIVE,
  'previous-group-orphaned': NOT_RESUMED_TREE_LIVE
};

/**
 * The value the controller's admission seam returns for a refusal. `no-run` and `run-ended`
 * keep the plain `NOT_RESUMED`: there is nothing to resume, and the drain may start afresh.
 * The other three carry their own refusal so the drain does NOT fall through to a fresh start
 * (TA3): that would put a second backend beside a survivor, or start work during shutdown.
 */
export function toResumeAdmission(refusal: ResumeAdmissionRefusal): ResumeAdmission {
  return ADMISSION_FOR_REFUSAL[refusal];
}

/**
 * The controller's seam: the Run to resume, or the value the drain reads for the refusal. A
 * `WorkflowRun` has no `resumed` member and a `ResumeAdmission` always has one, so the caller
 * tells the two apart with `'resumed' in result` and the compiler narrows on it.
 */
export async function admitResumeRun(
  deps: ResumeAdmissionGuardDeps,
  queueId: string
): Promise<WorkflowRun | ResumeAdmission> {
  const guard = await admitResumeCandidate(deps, queueId);
  return guard.admitted ? guard.run : toResumeAdmission(guard.refusal);
}
