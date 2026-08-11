// Feature 087 (T044, US3) — compose, validate, freeze, enqueue.
//
// The whole handler is four gates in a fixed order (contracts/run-launcher-ipc.md
// gates 5-8), and the order is the contract: a definition that does not resolve
// is reported before any field is checked, and every field is checked before the
// queue is consulted. Reversing either pair would hand the operator the wrong
// thing to fix — a paused queue would mask a typo, and a typo would look like a
// missing Pipeline.
//
// Feature 088 (T021) moved those four gates into
// `services/workflow-execution/node-run-starter.ts` so a Workflow node start
// reaches the same ones rather than a copy (plan D2). The ordering and the
// refusal families did not change — this suite pins them, and it is the proof.
// What stays here is what a handler owns: the workspace-root read and the ack.
//
// Two things this path deliberately does NOT do:
//
//   It does not fail open. `WorkflowRunFactory.resolvePipeline()` substitutes the
//   built-in Pipeline for an unknown id and `done` for a Phase the catalog lost;
//   that behaviour is pinned for every pre-existing path (T041) and forbidden
//   here (FR-033). A composed run either resolves exactly what the operator
//   submitted against, or it is refused.
//
//   It does not expand the plan itself. Resolution against the effective catalog
//   happens in the seam because that is the only layer that can see it; the
//   FREEZE happens inside `validateRunRequest()` (FR-030), so a plan cannot exist
//   that was expanded at some other time against some other catalog.
//
// No absolute path leaves this file (FR-020). The workspace root is resolved
// host-side and every field error names a field id and a limit, never a location.

import type { LaunchPipelineCommand, LaunchPipelineResult } from '../../../contracts/sidebar-ipc';
import { startPipelineRun } from '../../../services/workflow-execution/node-run-starter';
import { getCanonicalWorkspaceRoot } from '../../../state/workspace-folder-picker';
import type { CommandHandler, HandlerContext } from './handler-contract';
import { ack } from './handler-helpers';

async function respond(ctx: HandlerContext, result: LaunchPipelineResult): Promise<void> {
  await ack(
    ctx,
    result.outcome === 'enqueued' ? 'accepted' : 'rejected',
    result.outcome === 'enqueued' ? undefined : result.outcome,
    result
  );
}

export const handler: CommandHandler<LaunchPipelineCommand> = async (ctx, command) => {
  const started = await startPipelineRun(ctx.deps, {
    request: command.payload.request,
    workspaceRoot: getCanonicalWorkspaceRoot()?.uri.fsPath ?? null
  });

  // One arm differs from the seam's vocabulary: the queue item id is this wire's
  // `requestId`. The rest are the same refusal families, forwarded unchanged.
  await respond(
    ctx,
    started.outcome === 'enqueued'
      ? { outcome: 'enqueued', requestId: started.queueItemId }
      : started
  );
};
