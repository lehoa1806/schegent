// Feature 063 — `runClearAll` orchestrator for the Clean All button.
//
// Wires together:
//   1. Workspace-lock primary check (`lock.isHeld()`) — same pattern as
//      `runClearCompleted` / `runClearFailed` in `queue-ops.ts`. Non-primary
//      windows surface a toast and exit without mutating state.
//   2. A bounded runner-ack probe (FR-007) that fires `controller.cancelActive()`
//      then races `!controller.running` against a 2s timer. The probe is only
//      called by `QueueManager.clearAll()` when there was actually an in-flight
//      task at snapshot time; otherwise it is skipped and `runnerAcked` is
//      reported as `false` in the "no-op" sense.
//   3. `QueueManager.clearAll(probe)` which performs all five canonical writes
//      atomically (queue items, in-flight, pause, active run, watchdog backoff).
//   4. Lock release — only when the operation actually aborted an in-flight
//      run AND the runner acked the cancel. If the runner did not ack within
//      the 2s window, the lock release is deferred to the runner's eventual
//      exit path (which is invariant under cancel-then-cleanup). This avoids
//      racing the runner's own `lock.release()` in its `finally` and prevents
//      the same-owner re-acquire pattern from double-releasing.
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

// Toast copy — duplicated from `webview-ui/src/lib/action-copy.ts` so the
// host can surface these strings without importing the webview bundle. The
// webview file is the source of truth for human-facing copy; this module
// is the host mirror. If either string changes, update the other.
const CLEAN_ALL_LOCK_CONTENTION_TOAST =
  'Clean All could not start — another operation is in progress.';
const CLEAN_ALL_PERSISTENCE_ERROR_TOAST =
  'Clean All could not complete — workspace state could not be written.';
const CLEAN_ALL_RUNNER_STILL_PENDING_TOAST =
  'Clean All completed; runner cancellation is still pending.';

// Bounded poll window from FR-007. The 2s budget is split across short
// poll intervals so the probe resolves promptly once the runner's
// `cancelActive()` propagates through the running flag.
const RUNNER_ACK_WINDOW_MS = 2_000;
const RUNNER_ACK_POLL_INTERVAL_MS = 25;

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
  if (!ctx.lock.isHeld()) {
    ctx.notifier.warn(CLEAN_ALL_LOCK_CONTENTION_TOAST);
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
    ctx.notifier.error(CLEAN_ALL_PERSISTENCE_ERROR_TOAST);
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
        watchdogBackoffCleared: result.watchdogCleared
      },
      outcome: 'info'
    });
  } catch (err) {
    ctx.logger.warn(
      `runClearAll: audit append failed: ${(err as Error).message}`
    );
  }

  if (result.inflightAborted && result.runnerAcked) {
    await ctx.lock.release().catch((err) => {
      ctx.logger.warn(
        `runClearAll: lock release failed: ${(err as Error).message}`
      );
    });
  }

  if (result.inflightAborted && !result.runnerAcked) {
    ctx.notifier.warn(CLEAN_ALL_RUNNER_STILL_PENDING_TOAST);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deriveRunnerState(result: {
  inflightAborted: boolean;
  runnerAcked: boolean;
}): 'acked' | 'timed-out' | 'no-active-run' {
  if (!result.inflightAborted) return 'no-active-run';
  return result.runnerAcked ? 'acked' : 'timed-out';
}
