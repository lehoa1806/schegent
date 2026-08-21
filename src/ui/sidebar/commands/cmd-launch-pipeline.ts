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
//   It does not fail open. FR-033 forbids it here, and feature 098 (T024/T025)
//   removed the last of it elsewhere: `WorkflowRunFactory.resolvePipeline()` used
//   to substitute the built-in Pipeline for an unknown id and to drop a Phase the
//   catalog lost, and refuses both now. A composed run either resolves exactly
//   what the operator submitted against, or it is refused.
//
//   It does not expand the plan itself. Resolution against the effective catalog
//   happens in the seam because that is the only layer that can see it; the
//   FREEZE happens inside `validateRunRequest()` (FR-030), so a plan cannot exist
//   that was expanded at some other time against some other catalog.
//
// No absolute path leaves this file (FR-020). The workspace root is resolved
// host-side and every field error names a field id and a limit, never a location.

import {
  CATALOG_EMPTY_REASON,
  EMPTY_CATALOG_REFUSAL
} from '../../../contracts/empty-catalog-guidance';
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
  // Feature 103 (T069, FR-059) — `queueId` forwarded verbatim into the seam's
  // existing parameter, which carries it to `scheduleOrEnqueue` and defaults it
  // there. Spread rather than assigned so an absent one stays absent: this path
  // has no opinion about which queue is the default, and writing an explicit
  // `undefined` would make the seam's "not named" and "named nothing" the same
  // value. Identical to what `cmd-launch-workflow.ts` does with its own.
  //
  // Nothing else about the four gates changes. A re-run reaches them in the same
  // order with the same refusal families (FR-038); the only difference between
  // it and a launch from Runs is which queue is named, and that is the point.
  const queueId = command.payload.queueId;
  const started = await startPipelineRun(ctx.deps, {
    request: command.payload.request,
    workspaceRoot: getCanonicalWorkspaceRoot()?.uri.fsPath ?? null,
    ...(queueId !== undefined ? { queueId } : {})
  });

  // Feature 098 (T058, FR-031) — the empty catalog is the one refusal whose
  // remedy is not in the request. Every other rejected-definition reason names
  // something the operator can address in the composer they are looking at; this
  // one asks them to leave it and import a process document, so it is said in
  // words rather than left as a reason literal for the composer to echo.
  //
  // Notified host-side rather than carried on the ack, on the same terms the
  // scheduled-start path uses — that path has no webview to render anything, and
  // a refusal an operator only sees if a surface happens to be open is not the
  // record FR-031b says the message is. The ack still carries the named reason
  // below, unchanged.
  if (started.outcome === 'rejected-definition' && started.reason === CATALOG_EMPTY_REASON) {
    ctx.deps.notifyWarning?.(EMPTY_CATALOG_REFUSAL);
  }

  // One arm differs from the seam's vocabulary: the queue item id is this wire's
  // `requestId`. The rest are the same refusal families, forwarded unchanged.
  await respond(
    ctx,
    started.outcome === 'enqueued'
      ? { outcome: 'enqueued', requestId: started.queueItemId }
      : started
  );
};
