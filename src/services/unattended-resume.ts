// FR-R3-192 (T1862, T1863) — the one place Schegent tells the operator it resumed a Run on its own.
//
// Four paths resume a Run with nobody at the keyboard: the activation walk, the activation
// delayed-retry resume, and the credit watchdog's backoff-elapsed and credits-restored arms. Each used
// to call `SchegentWorkflowController.resumeExisting`, which resolves when the Run ENDS, so there was
// no moment at which "a Run is now executing" could be said. This helper is `resumeExisting`'s three
// statements with one synchronous step between admission and completion, and every path calls it.
import type { ResumeAdmission } from '../controller/run-admission';
import type { SanitizedLogger } from '../lib/logger';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { Notifier } from '../ui/notifications';
import { resumeAnnouncement } from './resume-decision';

// Fixed on purpose: no queue, Run or error text, so a failed announcement leaks nothing into the log.
const ANNOUNCEMENT_FAILED_LINE = 'unattended resume: the announcement could not be shown';
// FR-R4-F02 (contract U6 G22) — the same discipline for a Run that ended with an error after it was
// admitted: a fixed line and a reason code, never the error's text.
const COMPLETION_FAILED_LINE = 'unattended resume: the run ended with an error';
const COMPLETION_FAILED_REASON = 'unattended-completion-failed';

/** What the helper needs. Narrow on purpose, so a test supplies four fakes. */
export interface UnattendedResumeDeps {
  /** The controller's admission half. Never `resumeExisting`, which resolves at the Run's end. */
  readonly admit: (queueId: string) => Promise<ResumeAdmission>;
  /** Reads the admitted Run back, by queue (hard rule 57). */
  readonly store: Pick<WorkspaceStateStore, 'getRun'>;
  /** The editor's warning surface, the one the decline message uses. */
  readonly notifier: Pick<Notifier, 'warn'>;
  /** Redaction for the announcement's values, and the one fixed failure line. */
  readonly logger: Pick<SanitizedLogger, 'sanitize' | 'warn'>;
}

/**
 * Resume the Run on `queueId` without the operator, and tell the operator once it is admitted.
 *
 * When the resume was admitted, one warning naming the queue, the Run and the phase is raised, and
 * the promise resolves right then, with whether anything was resumed. FR-R4-F02 (contract U6 G21)
 * removed the wait for the Run's end: this used to await `admission.completed`, so a Run that ran for
 * hours held the watchdog callback or the liveness walk that called it. The Run's completion is
 * observed on the side instead (G22), so an error it ends with is logged once and never becomes an
 * unhandled rejection (G23). The announcement step is synchronous and cannot throw out of here.
 */
export async function resumeUnattended(
  queueId: string,
  deps: UnattendedResumeDeps
): Promise<boolean> {
  const admission = await deps.admit(queueId);
  if (admission.resumed) {
    announceUnattendedResume(queueId, deps);
    observeCompletion(admission.completed, deps.logger);
  }
  return admission.resumed;
}

/** Attach the observer that keeps a detached Run's failure from going unobserved. */
function observeCompletion(completed: Promise<void>, logger: Pick<SanitizedLogger, 'warn'>): void {
  void completed.catch(() => {
    logger.warn(COMPLETION_FAILED_LINE, { reasonCode: COMPLETION_FAILED_REASON });
  });
}

/**
 * The one operator notice for a Run that resumed without them. FR-R4-F02 moved the unattended
 * wakeups behind `SchegentWorkflowController.admitResume({ unattended })`, which calls this when it
 * admits one, so the notice is made once whichever path admitted it; `resumeUnattended` above
 * keeps calling it for the paths that still resume by `admit`.
 */
export function announceUnattendedResume(
  queueId: string,
  deps: Pick<UnattendedResumeDeps, 'store' | 'notifier' | 'logger'>
): void {
  try {
    const run = deps.store.getRun(queueId);
    if (run === null) {
      deps.logger.warn(ANNOUNCEMENT_FAILED_LINE);
      return;
    }
    const message = resumeAnnouncement(
      { queueId, runId: run.id, phase: run.currentPhase },
      (value) => deps.logger.sanitize(value)
    );
    // Adopted, not awaited: the surface may be slow or reject, and neither may touch the resume.
    void Promise.resolve(deps.notifier.warn(message)).catch(() => {
      deps.logger.warn(ANNOUNCEMENT_FAILED_LINE);
    });
  } catch {
    deps.logger.warn(ANNOUNCEMENT_FAILED_LINE);
  }
}
