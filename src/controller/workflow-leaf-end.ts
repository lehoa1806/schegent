// What a Workflow Pause or Cancel does to the one Phase leaf it reaches.
//
// The control service commits its own record of the attempt. This is the queue row and the leaf
// `WorkflowRun` underneath that record, which feature 262 requires stopped ("interrupt the active
// leaf runner", "terminate the active leaf runner"). Both controls end the leaf rather than
// phase-pause it, because a Resume dispatches a new attempt with a new row.
//
// Shaped like `task-deletion.ts`, the closest precedent, and for the same reason: it holds no
// controller, so the ordering below can be read and tested on its own.
//
// Who answers for the lease is the question most of this file exists to answer:
//
//   leaf                                    this file            the driver's terminal funnel
//   --------------------------------------  -------------------  ----------------------------
//   row pending                             cancels the row      not started
//   row in flight, Run driven               signals, writes      releases, records history
//   row in flight, Run in backoff           settles everything   not on the stack
//   row paused, Run phase-paused            settles everything   not on the stack
//   row in flight, Run is not this leaf's   cancels the row      answers for its own Run
//
// A release here while the funnel still owes one could clear a successor's lease: every Run in a
// window shares one owner id, so `release()`'s ownership guard cannot tell the two apart.

import { errorMessage } from '../lib/errors';
import type { SanitizedLogger } from '../lib/logger';
import { isTerminalRequestStatus, type FeatureRequest } from '../queue/feature-request';
import type { MutationResult, QueueManager } from '../queue/queue-manager';
import {
  canceledRunPatch,
  isTerminalRunStatus,
  LIVE_RUN_STATUSES,
  type WorkflowRun
} from '../state/workflow-run';
import { isRunRaceRefusal, type WorkspaceStateStore } from '../state/workspace-state';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { ExecutionLeasePort } from '../services/auto-drain-coordinator';
import {
  isQueueClaimLostToRival,
  releaseExecutionLeaseForTerminalRun
} from '../services/execution-lease-release';
import type { TerminalTransitionCoordinator } from '../services/terminal-transition-coordinator';
import { WorkflowLifecycleAuditor } from './workflow-lifecycle-auditor';

export interface WorkflowLeafEndDeps {
  readonly logger: Pick<SanitizedLogger, 'warn'>;
  readonly queue: Pick<QueueManager, 'findById' | 'finish' | 'removeTask'>;
  readonly store: Pick<WorkspaceStateStore, 'getRun' | 'updateRun' | 'runCommitClaim'>;
  readonly cancelActive: (queueId: string) => void;
  readonly isDriving: (queueId: string) => boolean;
  readonly cancelPendingRetry: (queueId: string) => void;
  readonly isClaimLostToRival: (queueId: string) => boolean;
  readonly releaseExecutionLeaseForRun: (run: WorkflowRun) => Promise<void>;
  readonly completeTerminalRun: (run: WorkflowRun, description: string) => Promise<void>;
  readonly auditLeafCanceled: (row: FeatureRequest, run: WorkflowRun | null) => Promise<void>;
}

export interface WorkflowLeafTarget {
  readonly queueId: string;
  /** The attempt's `queueItemId`: the row, and the `featureId` of any Run it started. */
  readonly taskId: string;
}

/**
 * End the leaf. Never throws: the control service awaits this before it commits, with no catch,
 * and a leaf that could not be settled must not also lose the operator's Pause or Cancel.
 */
export async function endWorkflowLeaf(
  deps: WorkflowLeafEndDeps,
  target: WorkflowLeafTarget
): Promise<void> {
  try {
    await endLeaf(deps, target);
  } catch (error) {
    deps.logger.warn(`workflow-leaf-end: leaf not settled: ${errorMessage(error)}`);
  }
}

async function endLeaf(
  deps: WorkflowLeafEndDeps,
  { queueId, taskId }: WorkflowLeafTarget
): Promise<void> {
  const row = deps.queue.findById(taskId);
  // Already over. Its terminal, queued behind this command, reads the settled attempt and goes quiet.
  if (row === null || isTerminalRequestStatus(row.status)) return;

  // A queue has one Run slot and it may hold a sibling, which is never this control's to touch.
  const current = deps.store.getRun(queueId);
  const run =
    current?.featureId === taskId && !isTerminalRunStatus(current.status) ? current : null;

  if (deps.isClaimLostToRival(queueId)) {
    // Stop this window's child, and write nothing: the Run and the row belong to the winner now.
    if (run !== null) deps.cancelActive(queueId);
    return;
  }

  // Read before the signal and before any await. The driver can finish its whole `finally` during
  // the writes below, and a release decided afterwards could land on a successor's lease. A paused
  // Run with a driver on the stack is a driver on its way out, and it answers for nothing paused.
  const funnelAnswers = run !== null && run.status !== 'paused' && deps.isDriving(queueId);

  if (run !== null) {
    deps.cancelActive(queueId);
    deps.cancelPendingRetry(queueId);
  }
  await deps.auditLeafCanceled(row, run);
  const canceled = run === null ? null : await persistCanceled(deps, queueId, run);
  const settleHere = canceled !== null && !funnelAnswers;

  if (row.status === 'paused') {
    // The closed transition table refuses `paused` to `canceled`, so the row goes, as
    // `task-deletion.ts` does it but with the session evidence kept. The release comes first and
    // is not conditional: with no row the queue cannot be resolved, so nothing could release later.
    if (canceled !== null) await deps.releaseExecutionLeaseForRun(canceled);
    warnIfRefused(deps, 'remove', await deps.queue.removeTask(taskId));
  } else {
    warnIfRefused(deps, 'finish', await deps.queue.finish(taskId, 'canceled'));
    if (settleHere) await deps.releaseExecutionLeaseForRun(canceled);
  }
  if (settleHere) await deps.completeTerminalRun(canceled, row.description);
}

/** The canceled Run, or `null` when it moved first and whoever moved it answers for the lease. */
async function persistCanceled(
  deps: WorkflowLeafEndDeps,
  queueId: string,
  run: WorkflowRun
): Promise<WorkflowRun | null> {
  try {
    return await deps.store.updateRun(
      queueId,
      {
        runId: run.id,
        allowedStatuses: LIVE_RUN_STATUSES,
        label: 'cancel',
        patch: () => canceledRunPatch(Date.now())
      },
      deps.store.runCommitClaim(queueId)
    );
  } catch (error) {
    if (isRunRaceRefusal(error)) return null;
    throw error;
  }
}

function warnIfRefused(deps: WorkflowLeafEndDeps, action: string, result: MutationResult): void {
  if (result.ok) return;
  deps.logger.warn(`workflow-leaf-end: ${action} refused: ${result.reason ?? 'unknown'}`);
}

export interface WorkflowLeafEndWiring {
  readonly logger: SanitizedLogger;
  readonly queue: Pick<QueueManager, 'findById' | 'queueIdForTask' | 'finish' | 'removeTask'>;
  readonly store: Pick<WorkspaceStateStore, 'getRun' | 'updateRun' | 'runCommitClaim'>;
  readonly controller: {
    cancelActive(queueId: string): void;
    isDriving(queueId: string): boolean;
    cancelPendingRetry(queueId: string): void;
  };
  readonly executionLease: ExecutionLeasePort;
  readonly terminalTransitions: Pick<TerminalTransitionCoordinator, 'complete'>;
  readonly audit: Pick<AuditLogWriter, 'append'>;
}

/**
 * `endWorkflowLeaf` with its seams bound, for the composition root. Not a controller method: the
 * controller already exposes what this asks of it, and has no use for the operation itself.
 */
export function createWorkflowLeafEnd(
  wiring: WorkflowLeafEndWiring
): (queueId: string, taskId: string) => Promise<void> {
  const { logger, queue, store, controller, executionLease, terminalTransitions, audit } = wiring;
  const auditor = new WorkflowLifecycleAuditor(audit, logger);
  const deps: WorkflowLeafEndDeps = {
    logger,
    queue,
    store,
    cancelActive: (queueId) => controller.cancelActive(queueId),
    isDriving: (queueId) => controller.isDriving(queueId),
    cancelPendingRetry: (queueId) => controller.cancelPendingRetry(queueId),
    isClaimLostToRival: (queueId) => isQueueClaimLostToRival(executionLease, queueId),
    releaseExecutionLeaseForRun: (run) =>
      releaseExecutionLeaseForTerminalRun({ queue, executionLease, logger }, run),
    completeTerminalRun: (run, description) => terminalTransitions.complete(run, description),
    auditLeafCanceled: (row, run) => auditor.emitWorkflowLeafCanceled(row, run)
  };
  return (queueId, taskId) => endWorkflowLeaf(deps, { queueId, taskId });
}
