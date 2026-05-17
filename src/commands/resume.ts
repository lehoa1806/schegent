import type { SchegentWorkflowController } from '../controller/workflow-controller';
import type { WorkspaceLockManager } from '../state/lock';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import type { WorkspaceStateStore } from '../state/workspace-state';
import { LockHeldError } from '../lib/errors';

export async function runResume(ctx: {
  store: WorkspaceStateStore;
  controller: SchegentWorkflowController;
  lock: WorkspaceLockManager;
  notifier: Notifier;
  logger: SanitizedLogger;
}): Promise<void> {
  try {
    const lockResult = await ctx.lock.tryAcquire();
    if (!lockResult.acquired) {
      throw new LockHeldError(lockResult.ownerId);
    }
    const run = ctx.store.getRun();
    if (!run || (run.status !== 'paused' && run.status !== 'failed')) {
      ctx.notifier.info('Schegent: no resumable run found.');
      return;
    }
    const resumed = await ctx.controller.resumeExisting();
    if (!resumed) {
      ctx.notifier.warn('Schegent: could not resume; run details missing.');
    }
  } catch (err) {
    if (err instanceof LockHeldError) {
      ctx.notifier.info('Schegent: another window holds the workspace lock.');
      return;
    }
    ctx.notifier.error(`Schegent: ${(err as Error).message}`);
    ctx.logger.error((err as Error).message);
  }
}
