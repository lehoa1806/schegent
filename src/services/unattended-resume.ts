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
 * Equivalent to `resumeExisting(queueId)` with one added step: when the resume was admitted, one
 * warning naming the queue, the Run and the phase is raised before the Run's completion is awaited.
 * The step is synchronous and cannot throw out of here, so it changes neither which Runs resume, nor
 * when, nor the error path. Like `resumeExisting`, the returned promise resolves at the Run's
 * terminal transition, with whether anything was resumed.
 */
export async function resumeUnattended(
  queueId: string,
  deps: UnattendedResumeDeps
): Promise<boolean> {
  const admission = await deps.admit(queueId);
  if (admission.resumed) announce(queueId, deps);
  await admission.completed;
  return admission.resumed;
}

function announce(queueId: string, deps: UnattendedResumeDeps): void {
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
