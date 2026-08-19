import type { SanitizedLogger } from '../lib/logger';
import type { ContainmentRefusal } from '../lib/path-containment';
import type { QueueManager } from '../queue/queue-manager';
import type { SessionCleanupOutcome } from '../services/session-cleanup/session-cleanup-service';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { WorkflowRun } from '../state/workflow-run';

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
  readonly store: Pick<WorkspaceStateStore, 'getRun' | 'setRun'>;
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
  if (feature?.status === 'in-flight') {
    // Feature 093 (T023) — pattern B. Reading ambiently asked whether the one
    // workspace Run happened to be this Task's; in a window running several it
    // would have cancelled a bystander's Run whenever it was not. The queue
    // answers *which* Run, and the `featureId` comparison below is left for
    // T040 to retire, so this phase changes addressing and nothing else.
    const queueId = queue.queueIdForTask(taskId);
    const run = store.getRun(queueId);
    if (run?.featureId === feature.id && run.status === 'running') {
      // Feature 093 (T042) — addressed. Cancelling ambiently here would have
      // aborted every Run in the window because one Task was deleted.
      deps.cancelActive(queueId);
      const canceled: WorkflowRun = {
        ...run,
        status: 'canceled',
        lastTransitionAt: Date.now()
      };
      await store.setRun(queueId, canceled);
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
      await deps.releaseExecutionLeaseForRun(canceled);
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
