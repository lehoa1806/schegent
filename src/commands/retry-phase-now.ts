// Feature 011 — manual override for the active delayed-retry run.
// Wired to `CMD_RETRY_PHASE_NOW` from the webview and the
// `schegent.retryPhaseNow` command id from the command palette.
// Delegates to `controller.retryPhaseNow()` per contracts/delayed-retry.md.

import type { SchegentWorkflowController } from '../controller/workflow-controller';
import type { WorkspaceLockManager } from '../state/lock';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';

export interface RetryPhaseNowCtx {
  readonly controller: SchegentWorkflowController;
  readonly lock: WorkspaceLockManager;
  readonly notifier: Notifier;
  readonly logger: SanitizedLogger;
}

const REJECTION_MESSAGES: Record<string, string> = {
  'no-active-run': 'No active run to retry.',
  'not-pending-retry': 'Active run is not waiting for a delayed retry.',
  'already-retrying': 'A retry is already in progress.'
};

/**
 * Feature 093 (FR-018 / T080) — `arg` is the queue whose Run the operator
 * pointed at. The sidebar always supplies it; a palette invocation supplies
 * nothing, and the controller then resolves a sole Run rather than guessing
 * between several. Anything that is not a non-empty string is treated as
 * absent, so a stray argument from a keybinding cannot address a queue.
 */
export async function runRetryPhaseNow(
  arg: unknown,
  ctx: RetryPhaseNowCtx
): Promise<void> {
  if (!ctx.lock.isHeld()) {
    ctx.notifier.warn('Schegent: another window holds the workspace lock; ignoring retry.');
    return;
  }
  const queueId = typeof arg === 'string' && arg.length > 0 ? arg : undefined;
  try {
    const result = await ctx.controller.retryPhaseNow(queueId);
    if (result.ok) {
      ctx.notifier.info('Schegent: retrying phase now.');
      return;
    }
    const human = REJECTION_MESSAGES[result.reason] ?? `Retry rejected (${result.reason}).`;
    ctx.notifier.warn(`Schegent: ${human}`);
  } catch (err) {
    ctx.logger.error(`runRetryPhaseNow failed: ${(err as Error).message}`);
    ctx.notifier.error('Schegent: retry-now failed.');
  }
}
