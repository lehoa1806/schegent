import type { SchegentWorkflowController } from '../controller/workflow-controller';
import { resolveSoleRun } from '../controller/sole-run-resolver';
import type { WorkspaceLockManager } from '../state/lock';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import type { WorkspaceStateStore } from '../state/workspace-state';
import { LockHeldError, describeFailure } from '../lib/errors';

/**
 * FR-R4-F05 (FR-014; contract F, F6; contract O, O5) — what the operator is told when a
 * resume fails for a reason the command has no code for. Fixed text: an exception's
 * message can carry a path, so it goes to the log through `describeFailure` and never to
 * the toast. Another window holding the lock is a notice, not a failure, and keeps its own.
 */
export const RESUME_FAILED_TOAST =
  'Schegent: the run could not be resumed. See the Schegent log for details.';

export async function runResume(ctx: {
  store: WorkspaceStateStore;
  controller: SchegentWorkflowController;
  lock: WorkspaceLockManager;
  notifier: Notifier;
  logger: SanitizedLogger;
  prompt?: string;
}): Promise<void> {
  try {
    const lockResult = await ctx.lock.tryAcquire();
    if (!lockResult.acquired) {
      throw new LockHeldError(lockResult.ownerId);
    }
    // Feature 093 (T038) — the palette command names no queue, so it resumes
    // the one resumable Run or refuses. Resuming every paused Run would be the
    // other candidate reading, but `ctx.prompt` is an operator's continuation
    // message written for one Run; broadcasting it is worse than declining.
    const target = resolveSoleRun(
      ctx.store.getRunMap(),
      (run) => run.status === 'paused' || run.status === 'failed'
    );
    if (!target.ok) {
      ctx.notifier.info(
        target.reason === 'ambiguous-run-target'
          ? 'Schegent: several runs are resumable; resume one from the sidebar instead.'
          : 'Schegent: no resumable run found.'
      );
      return;
    }
    const resumed = await ctx.controller.resumeExisting(target.queueId, ctx.prompt);
    if (!resumed) {
      ctx.notifier.warn('Schegent: could not resume; run details missing.');
    }
  } catch (err) {
    if (err instanceof LockHeldError) {
      ctx.notifier.info('Schegent: another window holds the workspace lock.');
      return;
    }
    ctx.notifier.error(RESUME_FAILED_TOAST);
    ctx.logger.error('resume: unexpected failure', {
      error: describeFailure(err, (value) => ctx.logger.sanitize(value))
    });
  }
}
