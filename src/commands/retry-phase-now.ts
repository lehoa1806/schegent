// Feature 011 — manual override for the active delayed-retry run.
// Wired to `CMD_RETRY_PHASE_NOW` from the webview and the
// `schegent.retryPhaseNow` command id from the command palette.
// Delegates to `controller.retryPhaseNow()` per contracts/delayed-retry.md.

import type { SchegentWorkflowController } from '../controller/workflow-controller';
import type { WorkspaceLockManager } from '../state/lock';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import { ACCEPTED, failed, refused, type CommandOutcome } from '../contracts/command-outcome';

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
/**
 * FR-R3-154 (T1645) — returns the outcome rather than `void`. Every early
 * return below was previously indistinguishable from success at the IPC
 * boundary: `cmd-retry-phase-now.ts` ACKed `accepted` as soon as this resolved,
 * so "another window holds the lock", "no active run to retry", and a thrown
 * failure all reported a retry that had started. The toasts are unchanged and
 * stay independent of the returned result.
 */
export async function runRetryPhaseNow(
  arg: unknown,
  ctx: RetryPhaseNowCtx
): Promise<CommandOutcome> {
  if (!(await ctx.lock.hasPrimacy())) {
    ctx.notifier.warn('Schegent: another window holds the workspace lock; ignoring retry.');
    return refused('not-primary-window');
  }
  const queueId = typeof arg === 'string' && arg.length > 0 ? arg : undefined;
  try {
    const result = await ctx.controller.retryPhaseNow(queueId);
    if (result.ok) {
      ctx.notifier.info('Schegent: retrying phase now.');
      return ACCEPTED;
    }
    const human = REJECTION_MESSAGES[result.reason] ?? `Retry rejected (${result.reason}).`;
    ctx.notifier.warn(`Schegent: ${human}`);
    return refused(result.reason);
  } catch (err) {
    ctx.logger.error(`runRetryPhaseNow failed: ${(err as Error).message}`);
    ctx.notifier.error('Schegent: retry-now failed.');
    // A code, not the caught error's message: this value crosses to the webview.
    return failed('retry-phase-now-failed');
  }
}
