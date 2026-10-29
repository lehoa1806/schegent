import type { SanitizedLogger } from '../lib/logger';
import type { ContainmentRefusal } from '../lib/path-containment';
import type { CompletionProvenance } from '../queue/feature-request';
import type { QueueManager } from '../queue/queue-manager';
import type { SessionCleanupOutcome } from '../services/session-cleanup/session-cleanup-service';
import { isRunRaceRefusal, type WorkspaceStateStore } from '../state/workspace-state';
import {
  canceledRunPatch,
  isTerminalRunStatus,
  LIVE_RUN_STATUSES,
  type WorkflowRun
} from '../state/workflow-run';

/**
 * Pluggable cleanup seam invoked after task deletion resolves a run ID.
 * Production uses `cleanupSessionArtifacts`; tests inject a deterministic
 * replacement without spying on non-configurable `fs.rm`.
 */
export type SessionCleanupRunner = (input: {
  workspaceRoot: string;
  runId: string;
  logger: SanitizedLogger;
}) => Promise<SessionCleanupOutcome>;

export interface TaskDeletionOutcome {
  ok: boolean;
  reason?: string;
  queueId?: string;
  taskId?: string;
  priorStatus?: string;
  runId?: string | null;
  /** FR-R4-F16 (contract P2.2) — carried from `removeTask` by the spread below; the type only. */
  completionProvenance?: CompletionProvenance | null;
  /**
   * Feature 034 — additive field. Always populated on `ok: true`
   * (`true` iff the cleanup succeeded for both targets; `false` when
   * `runId` was null OR at least one sub-op failed). Omitted on
   * `ok: false` because the rejection path bypasses cleanup entirely.
   */
  sessionCleaned?: boolean;
  /**
   * Feature FR-R3-005 (T327) — set only when the cleanup was *refused* on
   * containment rather than attempted and failed. A bounded code with no
   * path in it; the queue removal above still stands either way.
   */
  sessionCleanupRefusal?: ContainmentRefusal;
}

export interface TaskDeletionDeps {
  readonly logger: SanitizedLogger;
  readonly queue: Pick<QueueManager, 'findById' | 'queueIdForTask' | 'removeTask'>;
  readonly store: Pick<WorkspaceStateStore, 'getRun' | 'updateRun' | 'runCommitClaim'>;
  readonly cancelActive: (queueId: string) => void;
  readonly releaseExecutionLeaseForRun: (run: WorkflowRun) => Promise<void>;
  readonly sessionCleanup: SessionCleanupRunner;
  readonly workspaceRoot: string;
}

/**
 * Remove a Task and, if it owned a Run, end that Run first.
 *
 * Extracted from `SchegentWorkflowController` because the ordering constraints
 * below are the whole content of this operation and they are easier to hold
 * with the surrounding lifecycle code out of view. The controller keeps a
 * two-line delegation: `cancelActive` is one of its own methods and the lease
 * release is a bound field, so both arrive as seams rather than as the
 * collaborators behind them.
 */
export async function deleteTaskWithSessionCleanup(
  deps: TaskDeletionDeps,
  taskId: string
): Promise<TaskDeletionOutcome> {
  const { logger, queue, store } = deps;
  logger.info(`Workflow operation triggered: deleteTask`, { taskId });
  const feature = queue.findById(taskId);
  // The guard read `feature?.status === 'in-flight'` and was the whole of the
  // deleted-paused-task defect (docs/features/bugs/DONE_a-deleted-paused-task-
  // strands-its-run-and-deadlocks-its-queue.md). A phase-paused Task's ROW
  // reads `paused` — `QueueManager.pause` moves it out of `in-flight` — while
  // its Run stays non-terminal and keeps the queue's Run slot, its session and
  // its execution lease. The whole block below was skipped for that
  // combination, and `removeTask` then deleted the only row that could address
  // the Run it left behind: drain step 3 refuses to start anything else on the
  // queue, and every cancel, resume and retry route resolves by row identity,
  // so all of them refuse it at once.
  //
  // FR-R3-153 widened the *inner* check for exactly this class of bug and left
  // this one narrow, so control never reached the fix. Reading the row's status
  // here is not merely too narrow, it is the wrong question: what decides
  // whether the cancel sequence must run is whether a non-terminal Run is
  // pointing at this Task, and the two checks below already answer that
  // completely. `run.featureId === feature.id` establishes ownership — it is
  // load-bearing now rather than redundant, and the T040 note that proposed
  // retiring it is retracted below.
  if (feature) {
    // Feature 093 (T023) — pattern B. Reading ambiently asked whether the one
    // workspace Run happened to be this Task's; in a window running several it
    // would have cancelled a bystander's Run whenever it was not. The queue
    // answers *which* Run.
    const queueId = queue.queueIdForTask(taskId);
    const run = store.getRun(queueId);
    // FR-R3-153 (T1640, research.md R6) — widened from `run.status ===
    // 'running'`. A delayed-retry countdown (`RetryHandler#handleDelayedRetry`,
    // e.g. after a rate limit) sets the Run's own status to `paused` (with
    // `pendingRetryAt` armed) without ever calling `QueueManager.pause` on
    // the task row — the row stays `in-flight` the whole time the Run waits
    // to auto-resume. The narrower check skipped cancelActive/lease release
    // for exactly that combination, silently falling through to
    // `removeTask`'s own weaker fallback cancellation (now removed — see
    // queue-manager.ts). Any non-terminal Run status must go through this
    // same cancel/release sequence before the row is removed (spec FR-013,
    // FR-018).
    // The ownership half of the pair. It is what makes the widened guard above
    // safe: a `pending` row on a queue whose Run belongs to a sibling reaches
    // here and stops, because the Run it found is not this Task's.
    if (run?.featureId === feature.id && !isTerminalRunStatus(run.status)) {
      // Feature 093 (T042) — addressed. Cancelling ambiently here would have
      // aborted every Run in the window because one Task was deleted.
      deps.cancelActive(queueId);
      // FR-R3-077 made this commit point fenced, so it can refuse when this
      // window's lease has moved on or the ownership record cannot be read.
      //
      // This used to warn and carry on to `removeTask`, on the reasoning that a
      // refused deletion strands the row with nothing left running to repair
      // it. That produced the same orphan the row-status guard above produced —
      // driver cancelled, Run still non-terminal in the store, row gone — on a
      // path no widening of that guard reaches, so it is reversed here rather
      // than left as the surviving half of the defect.
      //
      // The reason is stronger than the smaller of two costs. A refusal at a
      // fenced commit means this window's execution lease has moved on: another
      // window owns the queue and is answering for its Run. A window with no
      // standing to write the Run has no standing to delete the row that
      // addresses it either. Both halves survive, both stay addressable by id,
      // and the operator can retry — which is not true of an orphaned Run.
      //
      // The lease is deliberately not released on the way out. The Run the
      // store still holds is non-terminal, and releasing on its behalf would
      // hand the queue away while it still owns it (hard rule 4).
      //
      // FR-R4-F01 (FR-008) — the cancel is a PATCH of the Run as it is inside the
      // chain, the same one the cancel command writes: the driver cancelled just
      // above is already winding down and writing its own transitions, and a whole
      // Run built from the read at the top of this block could carry a stale status
      // back over one of them.
      let canceled: WorkflowRun | null;
      try {
        canceled = await store.updateRun(
          queueId,
          {
            runId: run.id,
            allowedStatuses: LIVE_RUN_STATUSES,
            label: 'cancel',
            patch: () => canceledRunPatch(Date.now())
          },
          store.runCommitClaim(queueId)
        );
      } catch (error) {
        // The driver cancelled just above reached the chain first and ended the Run
        // itself, or the Run was replaced: either way it is no longer this Task's live
        // Run, which is all the deletion needed. Its own terminal funnel answers for
        // the lease, so nothing is released here on its behalf.
        if (isRunRaceRefusal(error)) {
          canceled = null;
        } else {
          logger.warn(`task-deletion: canceled run not persisted: ${(error as Error).message}`);
          return { ok: false, reason: 'run-cancel-not-committed' };
        }
      }
      // Feature 093 (T068b, FR-028) — no window-primacy release here either.
      // Deleting one Task cancelled one queue's Run; primacy is the window's
      // and its siblings are still executing under it.
      //
      // Feature 092 (T133, FR-033a) — the second terminal path: a Run
      // canceled out from under itself by the removal of its own Task. It
      // never reaches the driver's terminal funnel, so it returns its queue
      // here. MUST precede `removeTask` below — once the row is gone the
      // queue is no longer resolvable, and the helper correctly declines to
      // guess.
      if (canceled !== null) await deps.releaseExecutionLeaseForRun(canceled);
    }
  }
  const removed = await queue.removeTask(taskId);
  if (!removed.ok) {
    // Rejection branch — bypass cleanup; do NOT set sessionCleaned.
    return removed;
  }
  // Feature 034 — best-effort cleanup of the per-runId session tree
  // and the sibling raw transcript file. The cleanup is awaited but
  // ALWAYS resolves; an I/O failure surfaces as `sessionCleaned: false`
  // (with exactly one sanitized warn) and NEVER rolls back the queue
  // removal. See specs/034-task-deletion-cleanup/contracts/session-
  // cleanup.md.
  let sessionCleaned = false;
  let sessionCleanupRefusal: ContainmentRefusal | undefined;
  if (typeof removed.runId === 'string' && removed.runId.length > 0) {
    const outcome = await deps.sessionCleanup({
      workspaceRoot: deps.workspaceRoot,
      runId: removed.runId,
      logger
    });
    sessionCleaned = outcome.cleaned;
    sessionCleanupRefusal = outcome.refusal;
  }
  return sessionCleanupRefusal
    ? { ...removed, sessionCleaned, sessionCleanupRefusal }
    : { ...removed, sessionCleaned };
}
