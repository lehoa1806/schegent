import type { SanitizedLogger } from '../lib/logger';
import type { QueueManager } from '../queue/queue-manager';
import type { RetryCoordinator } from '../services/retry-coordinator';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { WorkflowRun } from '../state/workflow-run';
import type { MutationResult } from './phase-control-service';
import type { RunSessionRegistry } from './run-session';
import { resolveControlTarget } from './sole-run-resolver';

export interface ManualRetryOverrideDeps {
  readonly logger: SanitizedLogger;
  readonly store: Pick<WorkspaceStateStore, 'getRun' | 'getRunMap' | 'getQueue' | 'setRun' | 'runCommitClaim'>;
  readonly queue: Pick<QueueManager, 'setQueuePausedState'>;
  readonly sessions: Pick<RunSessionRegistry, 'peek' | 'acquire'>;
  readonly retryCoordinator: Pick<
    RetryCoordinator,
    'cancelPendingTimer' | 'appendManualRetryAudit'
  >;
  readonly resumeExisting: (queueId: string) => Promise<boolean>;
}

/**
 * Feature 011 — manual override for an active delayed-retry run.
 * Wired to `CMD_RETRY_PHASE_NOW` from the webview and the
 * `schegent.retryPhaseNow` command. Per contracts/delayed-retry.md
 * §Manual override.
 *
 * Extracted from `SchegentWorkflowController` because the sequence is a
 * self-contained transaction over one queue — resolve, reject, arm, disarm,
 * clear, audit, resume — and every step names its queue explicitly. Nothing in
 * it reaches the drive loop, so it was only in the controller because that is
 * where the webview command lands.
 */
export async function applyManualRetryOverride(
  deps: ManualRetryOverrideDeps,
  queueId?: string
): Promise<MutationResult> {
  const { logger, store, sessions, retryCoordinator } = deps;
  logger.info(`Workflow operation triggered: retryPhaseNow`);
  const target = resolveControlTarget(queueId, store.getRunMap());
  if (!target.ok) {
    // Preserve this control's own vocabulary: it answered `no-active-run`
    // before the queue existed, and an operator-facing reason string is not
    // the place to leak the addressing change.
    return { ok: false, reason: target.reason === 'no-run-in-flight' ? 'no-active-run' : target.reason };
  }
  const run = store.getRun(target.queueId);
  if (!run) return { ok: false, reason: 'no-active-run' };
  if (run.pendingRetryAt === null || run.pendingRetryCause === null) {
    return { ok: false, reason: 'not-pending-retry' };
  }
  if (sessions.peek(target.queueId)?.driver.running === true) {
    return { ok: false, reason: 'already-retrying' };
  }

  // Feature 032 — manual override of a delayed retry is a continuation
  // (same semantics as the watchdog-fired retry). Arm the gate before
  // clearing `pendingRetryCause` below so `RunDriver.drive()` consumes it.
  // Feature 093 (T042) — on this queue's session: a shared gate would append
  // `-c` to whichever conversation drove next, not to the one being retried.
  sessions.acquire(target.queueId).isContinueGate.arm();
  // Feature 093 (T045) — retrying this queue now drops this queue's armed
  // deadline and no other's; a sibling still counting down keeps counting.
  retryCoordinator.cancelPendingTimer(target.queueId);

  const queueState = store.getQueue(target.queueId);
  const expectedReason = `retry-cap-exhausted:${run.id}`;
  // FR-R3-011 — see `phase-control-service.ts`: the lifecycle is the pause
  // value, `pausedReason` is the live reason payload beside it.
  const queueUnpaused =
    queueState.queueLifecycle === 'operator-paused' && queueState.pausedReason === expectedReason;
  if (queueUnpaused) {
    await deps.queue.setQueuePausedState(false, target.queueId, null);
  }

  const priorCount = run.delayedRetryCount;
  const updated: WorkflowRun = {
    ...run,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null
  };
  await store.setRun(target.queueId, updated, store.runCommitClaim(target.queueId));
  await retryCoordinator.appendManualRetryAudit({
    runId: run.id,
    phase: run.currentPhase,
    iteration: run.currentIteration,
    payload: {
      runId: run.id,
      phaseId: run.currentPhase,
      prevDelayedRetryCount: priorCount,
      queueUnpaused
    }
  });

  setImmediate(() => {
    void deps.resumeExisting(target.queueId).catch((err) =>
      logger.warn(`retryPhaseNow resume failed: ${(err as Error).message}`)
    );
  });
  return { ok: true };
}
