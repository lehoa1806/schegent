// The hooks a Workflow control needs from the window that runs it.
//
// `WorkflowControlService` is shared with the headless entrypoint and imports no controller, so
// what can only be answered here (stop this leaf, whose claim is this queue) reaches it as optional
// hooks. The controller is taken through a structural port for the same reason: this module stays
// free of `vscode`, like the rest of the directory.

import { errorMessage } from '../../lib/errors';
import type { SanitizedLogger } from '../../lib/logger';
import { connectedRunOwnsQueueItem } from '../../state/connected-workflow-run';
import type { WorkspaceStateStore } from '../../state/workspace-state';
import type { ExecutionLeasePort } from '../auto-drain-coordinator';
import { isQueueClaimLostToRival } from '../execution-lease-release';
import type { WorkflowControlServiceDeps } from './workflow-control-service';

export interface WorkflowLeafControlPort {
  cancelPendingRetry(queueId: string): void;
  isDriving(queueId: string): boolean;
  drainQueuedWork(queueId: string): Promise<void>;
}

export interface WorkflowLeafControlDeps {
  readonly controller: WorkflowLeafControlPort;
  /** Stops one leaf and settles what is under it; `workflow-leaf-end.ts` holds the ordering. */
  readonly endLeaf: (queueId: string, taskId: string) => Promise<void>;
  readonly executionLease: Pick<ExecutionLeasePort, 'tenureOf' | 'isForeignLeaseHeld'>;
  readonly logger: Pick<SanitizedLogger, 'warn'>;
  readonly store: Pick<WorkspaceStateStore, 'getRun' | 'getConnectedRun' | 'getQueueRegistry'>;
}

export type WorkflowLeafControlHooks = Required<
  Pick<
    WorkflowControlServiceDeps,
    | 'abortActiveLeaf'
    | 'cancelRetryTimer'
    | 'releaseQueueLease'
    | 'verifyLeaseFence'
    | 'isQueuePresent'
  >
>;

/**
 * Offer a queue its work, once. The drain is edge-triggered, so a command that frees a queue or
 * queues a leaf with no driver on the stack owes it this. A driver still on its way out schedules a
 * drain of its own, after its release, so it is left to do so. What the drain then does with the
 * offer is its own decision: a queue held for a Start stays held.
 */
export function createWorkflowQueueWake(
  deps: Pick<WorkflowLeafControlDeps, 'controller' | 'logger'>
): (queueId: string) => void {
  const { controller, logger } = deps;
  return (queueId) => {
    if (controller.isDriving(queueId)) return;
    void controller.drainQueuedWork(queueId).catch((error: unknown) => {
      logger.warn(`workflow-leaf-control: drain of a Workflow's queue failed: ${errorMessage(error)}`);
    });
  };
}

export function createWorkflowLeafControlHooks(
  deps: WorkflowLeafControlDeps
): WorkflowLeafControlHooks {
  const { controller, endLeaf, executionLease, store } = deps;
  return {
    abortActiveLeaf: async (leaf) => {
      if (leaf.queueItemId === undefined) return;
      await endLeaf(leaf.queueId, leaf.queueItemId);
    },

    // Asked once per frame, and the timer belongs to the queue's Run rather than to a frame, so it
    // is canceled only when that Run is a leaf of this Workflow. An unrelated Task's countdown stays.
    cancelRetryTimer: (queueId, runId) => {
      const current = store.getRun(queueId);
      const owner = store.getConnectedRun(runId);
      if (current === null || owner === null) return;
      if (connectedRunOwnsQueueItem(owner, current.featureId)) {
        controller.cancelPendingRetry(queueId);
      }
    },

    // "Not lost to a rival", never "held": a queue between two leaves holds no lease at all.
    verifyLeaseFence: (queueId) => !isQueueClaimLostToRival(executionLease, queueId),

    isQueuePresent: (queueId) =>
      store.getQueueRegistry().entries.some((entry) => entry.id === queueId),

    // Named for the service's contract: it calls this once, when the root has ended, after the
    // commit. In this window that moment is a wake, and no lease is released here. Leases are held
    // per leaf, and each is given back by the driver's terminal funnel or by `endWorkflowLeaf`, so
    // none is left for the Workflow. A release from here could not tell a leaf's lease from one the
    // drain has just taken for the next Task, and every Run in a window shares one owner id.
    //
    // The wake is what remains owed, for a queue that had work waiting behind a leaf with no driver.
    releaseQueueLease: createWorkflowQueueWake(deps)
  };
}
