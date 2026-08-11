// Feature 088 (T037, US3) — start one more node of a run that already exists.
// Contract: specs/088-workflow-continuation/contracts/workflow-run-ipc.md
//
// The handler owns gate 1 and the ack; gates 2-7 belong to
// `services/workflow-execution/workflow-launcher.ts`.
//
// The one thing this handler does that its launch sibling does not is read NO
// catalog at all. A continuation resolves everything from the run's own frozen
// snapshot (FR-003, FR-004): the graph it started against, the Pipeline it froze,
// the Phases inside it. The catalog may have been edited, reordered, or had the
// Pipeline deleted outright since the launch, and none of that may reach a run
// already underway — so there is nothing here to resolve it against and no
// temptation to.
//
// Both refusal arms that carry a projection build it with the same
// `projectConnectedRun` the snapshot uses, so a view on a superseded snapshot
// corrects itself from the refusal (FR-045) and there is one renderer, not two.
// Eligibility (gate 4) comes from that same projection through `isNodeStartable`,
// which is why the host and the view cannot come to disagree about what is legal.

import type {
  ContinueWorkflowCommand,
  ContinueWorkflowResult
} from '../../../contracts/sidebar-ipc';
import { continueWorkflow } from '../../../services/workflow-execution/workflow-launcher';
import { getCanonicalWorkspaceRoot } from '../../../state/workspace-folder-picker';
import type { ConnectedWorkflowRun } from '../../../state/connected-workflow-run';
import { isNodeStartable, projectConnectedRun } from '../connected-run-projector';
import type { ConnectedRunPort } from './router-types';
import type { CommandHandler, HandlerContext } from './handler-contract';
import { ack } from './handler-helpers';

async function respond(ctx: HandlerContext, result: ContinueWorkflowResult): Promise<void> {
  await ack(
    ctx,
    result.outcome === 'started' ? 'accepted' : 'rejected',
    result.outcome === 'started' ? undefined : result.outcome,
    result
  );
}

/**
 * The projection a refusal carries, or the run-not-found arm when there is nothing
 * left to project.
 *
 * `rejected-stale` reports the *authoritative* record — the one the store holds
 * now, not the one the caller addressed — because the whole point of the arm is to
 * tell a view built on a superseded snapshot what is actually true. A run that has
 * disappeared between gate 1 and gate 2 has no authoritative record, so it is
 * reported as `run-not-found`: the same answer gate 1 would have given a moment
 * earlier, rather than a projection of a run the operator can no longer act on.
 */
function staleResult(
  runs: ConnectedRunPort,
  current: ConnectedWorkflowRun | null
): ContinueWorkflowResult {
  if (current === null) return { outcome: 'rejected-run', reason: 'run-not-found' };
  return { outcome: 'rejected-stale', projection: projectConnectedRun(current, runs.readChildState) };
}

export const handler: CommandHandler<ContinueWorkflowCommand> = async (ctx, command) => {
  const connectedRuns = ctx.deps.connectedRuns;
  if (connectedRuns === undefined) {
    await respond(ctx, {
      outcome: 'rejected-queue',
      reason: 'queue-refused',
      detail: 'launcher-unavailable'
    });
    return;
  }

  // Gate 1.
  const run = connectedRuns.get(command.payload.connectedRunId);
  if (run === null) {
    await respond(ctx, { outcome: 'rejected-run', reason: 'run-not-found' });
    return;
  }

  const continued = await continueWorkflow(
    {
      ...ctx.deps,
      connectedRuns,
      isChildSettled: (queueItemId) => connectedRuns.readChildState(queueItemId) !== 'in-flight'
    },
    {
      run,
      expectedRevision: command.payload.expectedRevision,
      nodeId: command.payload.nodeId,
      request: command.payload.request,
      workspaceRoot: getCanonicalWorkspaceRoot()?.uri.fsPath ?? null,
      startedAt: Date.now(),
      isNodeStartable: (current, nodeId) =>
        isNodeStartable(current, nodeId, connectedRuns.readChildState)
    }
  );

  if (continued.outcome === 'started') {
    await respond(ctx, {
      outcome: 'started',
      revision: continued.run.revision,
      queueItemId: continued.queueItemId
    });
    return;
  }
  if (continued.outcome === 'rejected-stale') {
    await respond(ctx, staleResult(connectedRuns, continued.current));
    return;
  }
  if (continued.outcome === 'rejected-state') {
    await respond(ctx, {
      outcome: 'rejected-state',
      reason: continued.reason,
      projection: projectConnectedRun(continued.run, connectedRuns.readChildState)
    });
    return;
  }
  if (continued.outcome === 'rejected-definition') {
    // The wire narrows this arm to the two conditions a continuation can actually
    // reach. `workflow-not-found`, `workflow-invalid`, and `node-not-startable` are
    // launch-time refusals about the *catalog*, and a continuation reads none — so
    // a run whose frozen graph somehow produced one is a host defect, reported as a
    // queue refusal rather than widened into the wire's vocabulary.
    if (continued.reason === 'pipeline-mismatch' || continued.reason === 'no-workspace-root') {
      await respond(ctx, { outcome: 'rejected-definition', reason: continued.reason });
      return;
    }
    ctx.deps.logger.warn(
      `cmd-continue-workflow: launcher refused a continuation as ${continued.reason}, which a frozen run cannot reach`
    );
    await respond(ctx, {
      outcome: 'rejected-queue',
      reason: 'queue-refused',
      detail: 'launcher-unavailable'
    });
    return;
  }
  await respond(ctx, continued);
};
