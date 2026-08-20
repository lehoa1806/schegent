// Feature 088 (T036, US1) — open a connected run at an allowed starting node.
// Contract: specs/088-workflow-continuation/contracts/workflow-run-ipc.md
//
// The handler owns gates 1-2 and the ack; gates 3-6 belong to
// `services/workflow-execution/workflow-launcher.ts`, which reaches the same
// resolve → validate → guard → enqueue seam `cmd-launch-pipeline.ts` reaches
// (plan D2). The split is not arbitrary: gates 1-2 are the only ones that need
// the **effective** catalog, and the launcher is deliberately kept free of it so
// a run in flight can never be re-resolved against a catalog that has since moved.
//
// Two catalogs are read here, and they are different objects for different jobs:
//
//   * `resolveWorkflowCatalog(...)` — the definitions layer, resolved from the raw
//     config rows the same way `loadCatalog` resolves it (Phases, then Pipelines
//     against those Phases, then Workflows against those Pipelines). This answers
//     gates 1-2, and resolving it here rather than accepting a cached copy is what
//     keeps the effective-catalog hard rule intact.
//   * `deps.getCatalog()` — the runtime catalog, which is what the connected run
//     freezes its Pipeline snapshots from.
//
// The host-wiring check runs before gate 1, deliberately. `startPipelineRun`
// already refuses a missing `guardedRun` as `launcher-unavailable` before it reads
// anything, and the same reasoning applies to the connected-run store: a host that
// cannot persist a run should say so rather than resolve a catalog, validate a
// request, and enqueue a child it can then not record.
//
// No filesystem path crosses this boundary. The workspace root is resolved
// host-side through `getCanonicalWorkspaceRoot()` and never leaves.

import { randomUUID } from 'node:crypto';
import { resolvePipelineCatalog } from '../../../config/pipeline-catalog';
import { resolvePhaseCatalog } from '../../../config/process-catalog';
import {
  resolveWorkflowCatalog,
  type WorkflowPipelineContext
} from '../../../config/workflow-catalog';
import type { LaunchWorkflowCommand, LaunchWorkflowResult } from '../../../contracts/sidebar-ipc';
import type { WorkflowDefinition } from '../../../contracts/workflow-definitions';
import { launchWorkflow } from '../../../services/workflow-execution/workflow-launcher';
import { getCanonicalWorkspaceRoot } from '../../../state/workspace-folder-picker';
import type { CommandHandler, HandlerContext } from './handler-contract';
import { ack } from './handler-helpers';

/**
 * The effective Pipeline catalog the Workflow catalog resolves against, built the
 * way `loadCatalog` builds it: Phases first, then Pipelines against those Phases.
 *
 * A local copy rather than a shared helper, matching
 * `cmd-preflight-process-yaml.ts` and `cmd-export-process-yaml.ts`, which each
 * hold their own. Extracting them is a refactor this feature has no mandate for;
 * what matters is that every one of them resolves the *effective* layer.
 * (`cmd-save-workflows.ts` held a fourth copy until feature 100 deleted it with
 * the whole-array save; the lifecycle path resolves through
 * `src/config/definition-semantics.ts` instead.)
 */
function effectivePipelineContext(ctx: HandlerContext): WorkflowPipelineContext {
  const storedPhases = ctx.deps.readPhaseConfig?.() ?? { rows: [], revision: '' };
  const storedPipelines = ctx.deps.readPipelineConfig?.() ?? { rows: [], revision: '' };
  return resolvePipelineCatalog({
    rows: storedPipelines.rows,
    revision: storedPipelines.revision,
    phaseCatalog: resolvePhaseCatalog({
      rows: storedPhases.rows,
      revision: storedPhases.revision
    }).effective
  });
}

type Resolution =
  | { readonly outcome: 'resolved'; readonly workflow: WorkflowDefinition }
  | { readonly outcome: 'refused'; readonly reason: 'workflow-not-found' | 'workflow-invalid' };

/**
 * Gates 1-2, which are one lookup and one discrimination.
 *
 * `resolveWorkflowCatalog` graph-validates every row as it parses it and excludes
 * an invalid one from `effective`, so "in `effective`" already means "resolves and
 * its graph is valid and every node's Pipeline resolves". What is left is telling
 * the two refusals apart, and the records answer that: a row exists under this id
 * but did not become effective, so it is invalid — the operator has a definition
 * to repair, not one to create. (Feature 099, FR-040: `shadowed` was the other way
 * to be present and not effective, and it went with the layer tier.)
 */
function resolveWorkflow(ctx: HandlerContext, workflowId: string): Resolution {
  const stored = ctx.deps.readWorkflowConfig?.() ?? { rows: [], revision: '' };
  const catalog = resolveWorkflowCatalog({
    rows: stored.rows,
    revision: stored.revision,
    pipelineCatalog: effectivePipelineContext(ctx)
  });
  const workflow = catalog.effective.find((entry) => entry.workflowId === workflowId);
  if (workflow !== undefined) return { outcome: 'resolved', workflow };
  const claimed = catalog.records.some((record) => record.workflowId === workflowId);
  return { outcome: 'refused', reason: claimed ? 'workflow-invalid' : 'workflow-not-found' };
}

async function respond(ctx: HandlerContext, result: LaunchWorkflowResult): Promise<void> {
  await ack(
    ctx,
    result.outcome === 'started' ? 'accepted' : 'rejected',
    result.outcome === 'started' ? undefined : result.outcome,
    result
  );
}

export const handler: CommandHandler<LaunchWorkflowCommand> = async (ctx, command) => {
  const connectedRuns = ctx.deps.connectedRuns;
  const catalog = ctx.deps.getCatalog?.();
  if (connectedRuns === undefined || catalog === undefined) {
    await respond(ctx, {
      outcome: 'rejected-queue',
      reason: 'queue-refused',
      detail: 'launcher-unavailable'
    });
    return;
  }

  const resolved = resolveWorkflow(ctx, command.payload.workflowId);
  if (resolved.outcome === 'refused') {
    await respond(ctx, { outcome: 'rejected-definition', reason: resolved.reason });
    return;
  }

  const started = await launchWorkflow(
    {
      ...ctx.deps,
      connectedRuns,
      // The launcher's FR-044 gate asks one question — has this child stopped —
      // and derives it from the single child-state oracle rather than from a
      // second port, so the gate and the action set the view renders cannot
      // disagree. An id the host cannot resolve reads as settled, which is the
      // rule `ChildRunSettledProbe` documents.
      isChildSettled: (queueItemId) => connectedRuns.readChildState(queueItemId) !== 'in-flight'
    },
    {
      // Host-minted, never carried on the wire: a connected run id the webview
      // could choose would let it address a run it did not start.
      connectedRunId: randomUUID(),
      workflow: resolved.workflow,
      catalog,
      startNodeId: command.payload.startNodeId,
      request: command.payload.request,
      workspaceRoot: getCanonicalWorkspaceRoot()?.uri.fsPath ?? null,
      startedAt: Date.now(),
      ...(ctx.deps.defaultRunnerKind ? { defaultRunnerKind: ctx.deps.defaultRunnerKind } : {}),
      // Feature 092 (T080, FR-041) — forwarded, not resolved. Which queue is
      // the default one is the enqueue seam's answer to give, and giving it
      // here would make a second site deciding it.
      ...(command.payload.queueId !== undefined ? { queueId: command.payload.queueId } : {})
    }
  );

  // One arm differs from the launcher's vocabulary: it answers with the aggregate,
  // and the wire carries only the two identifiers and the revision the view needs
  // to address it. The rest are the same refusal families, forwarded unchanged.
  await respond(
    ctx,
    started.outcome === 'started'
      ? {
          outcome: 'started',
          connectedRunId: started.run.connectedRunId,
          revision: started.run.revision,
          queueItemId: started.queueItemId
        }
      : started
  );
};
