// Feature 063 — `runClearAll` orchestrator for the Clean All button.
//
// Wires together:
//   1. Workspace-lock primary check (`lock.hasPrimacy()`, FR-R3-024 FR-013) —
//      same pattern as
//      `runClearCompleted` / `runClearFailed` in `queue-ops.ts`. Non-primary
//      windows surface a toast and exit without mutating state.
//   2. A bounded runner-ack probe (FR-007) that fires `controller.cancelActive()`
//      then races `!controller.running` against a 2s timer. The probe is only
//      called by `QueueManager.clearAll()` when there was actually an in-flight
//      task at snapshot time; otherwise it is skipped and `runnerAcked` is
//      reported as `false` in the "no-op" sense.
//   3. `QueueManager.clearAll(probe)` which performs all five canonical writes
//      atomically (queue items, in-flight, pause, active run, watchdog backoff).
//   4. (Retired by feature 093 T068b, FR-028.) This step released the
//      workspace lock when the operation aborted an in-flight run and the
//      runner acked. Window primacy is the window's for its whole lifetime —
//      activation to disposal — and Clean All is not a disposal. See the note
//      at the former call site below.
//   5. A single `queue-cleared-all` audit event, emitted ONLY when
//      `result.wasNoop === false`. The no-op path is silent on the audit log
//      per the contract (specs/063-clean-all-confirmations/contracts/cmd-clear-all.md
//      §Idempotency).
//   6. Operator-visible toast translation for the three failure modes:
//      lock contention (caught here BEFORE the queue write), persistence
//      error (caught after the queue write throws), and runner non-ack
//      (warning, non-blocking — the state was still cleared).

import type { SchegentWorkflowController } from '../controller/workflow-controller';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { QueueManager } from '../queue/queue-manager';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { WorkspaceLockManager } from '../state/lock';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import {
  RUNNER_ACK_POLL_INTERVAL_MS,
  RUNNER_ACK_WINDOW_MS,
  deriveRunnerState,
  sleep
} from '../controller/runner-ack-shared';

// Toast copy — duplicated from `webview-ui/src/lib/action-copy.ts` so the
// host can surface these strings without importing the webview bundle. The
// webview file is the source of truth for human-facing copy; this module
// is the host mirror. If either string changes, update the other.
//
// Code-review finding (iteration 4) — exported as functions, not plain
// string constants, and taking an optional `queueId`: `clear-queue.ts`'s
// lock-contention and persistence-error toasts are this same host-mirror
// wording with "for {queueId}" named mid-sentence, not appended after it —
// a plain shared constant a caller string-templates around cannot produce
// that shape, which is why the constants used to be exported "for reuse"
// but nothing actually imported them (the wording drifted into two
// hand-maintained copies instead). A shared function is what makes a future
// copy edit a one-place edit instead of a two-host-file edit that can drift,
// for both the addressed and unaddressed wording at once.
export function cleanAllLockContentionToast(queueId?: string): string {
  return queueId === undefined
    ? 'Clean All could not start — another operation is in progress.'
    : `Clean All for ${queueId} could not start — another operation is in progress.`;
}
export function cleanAllPersistenceErrorToast(queueId?: string): string {
  return queueId === undefined
    ? 'Clean All could not complete — workspace state could not be written.'
    : `Clean All for ${queueId} could not complete — workspace state could not be written.`;
}
// Code-review finding (iteration 5) — the third of the three, on the same
// terms as the two above and for the same reason: `clear-queue.ts` renders
// this wording with "for {queueId}" named MID-SENTENCE, and it was doing so
// from its own inline template literal, so the file that documents "a shared
// function is what makes a future copy edit a one-place edit" left one of its
// three toasts as the two hand-maintained copies it warns about. All three
// addressed forms now come from here.
export function cleanAllRunnerStillPendingToast(queueId?: string): string {
  return queueId === undefined
    ? 'Clean All completed; runner cancellation is still pending.'
    : `Clean All completed for ${queueId}; runner cancellation is still pending.`;
}

export type ClearAllResult = { ok: true } | { ok: false; reason: string };

export interface ClearAllCtx {
  controller: SchegentWorkflowController;
  store: WorkspaceStateStore;
  queue: QueueManager;
  audit: AuditLogWriter;
  lock: WorkspaceLockManager;
  notifier: Notifier;
  logger: SanitizedLogger;
}

export async function runClearAll(ctx: ClearAllCtx): Promise<ClearAllResult> {
  if (!(await ctx.lock.hasPrimacy())) {
    ctx.notifier.warn(cleanAllLockContentionToast());
    return { ok: false, reason: 'not-primary' };
  }

  const probe = async (): Promise<boolean> => {
    try {
      ctx.controller.cancelActive();
    } catch (err) {
      ctx.logger.warn(
        `runClearAll: controller.cancelActive() threw: ${(err as Error).message}`
      );
    }
    return await waitForRunnerStop(ctx.controller);
  };

  let result;
  try {
    result = await ctx.queue.clearAll(probe);
  } catch (err) {
    ctx.logger.error(`runClearAll: clearAll failed: ${(err as Error).message}`);
    ctx.notifier.error(cleanAllPersistenceErrorToast());
    return { ok: false, reason: 'persistence-error' };
  }

  if (result.wasNoop) {
    return { ok: true };
  }

  try {
    await ctx.audit.append({
      runId: 'queue:default',
      phase: 'queue',
      iteration: 0,
      eventType: 'queue-cleared-all',
      payload: {
        removedPending: result.removed.pending,
        removedInFlight: result.inflightAborted ? 1 : 0,
        pauseStateCleared: result.pauseCleared,
        runnerState: deriveRunnerState(result),
        watchdogBackoffCleared: result.watchdogCleared,
        scheduleCleared: result.scheduleCleared
      },
      outcome: 'info'
    });
  } catch (err) {
    ctx.logger.warn(
      `runClearAll: audit append failed: ${(err as Error).message}`
    );
  }

  // Feature 093 (T068b, FR-028) — the primacy release that stood here is gone.
  // Its own rationale retired it: it existed to avoid racing "the runner's own
  // `lock.release()` in its `finally`", and 092's T136 deleted that `finally`
  // with the `withLock('drive-run', …)` wrapper. What was left released the
  // *window's* primacy on an operator action the window survives — and
  // `release()` stops the heartbeat and nulls the record, while nothing but
  // `tryAcquire()` ever restores it. So a single Clean All left this window
  // non-primary for the rest of the session: its own step-1 `isHeld()` guard
  // would reject the next Clean All, `isPrimary` would read false everywhere,
  // and a rival window could claim a workspace this one is still live in.
  // Under concurrency it is worse — Clean All aborts every queue's Run, so the
  // release lands while other drivers are still unwinding.

  if (result.inflightAborted && !result.runnerAcked) {
    ctx.notifier.warn(cleanAllRunnerStillPendingToast());
  }

  return { ok: true };
}

async function waitForRunnerStop(
  controller: SchegentWorkflowController
): Promise<boolean> {
  const deadline = Date.now() + RUNNER_ACK_WINDOW_MS;
  while (Date.now() < deadline) {
    if (!controller.running) return true;
    await sleep(RUNNER_ACK_POLL_INTERVAL_MS);
  }
  return !controller.running;
}
