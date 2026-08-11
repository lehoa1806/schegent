// Feature 087 (T044, US3) — compose, validate, freeze, enqueue.
//
// The whole handler is four gates in a fixed order (contracts/run-launcher-ipc.md
// gates 5-8), and the order is the contract: a definition that does not resolve
// is reported before any field is checked, and every field is checked before the
// queue is consulted. Reversing either pair would hand the operator the wrong
// thing to fix — a paused queue would mask a typo, and a typo would look like a
// missing Pipeline.
//
// Two things this file deliberately does NOT do:
//
//   It does not fail open. `WorkflowRunFactory.resolvePipeline()` substitutes the
//   built-in Pipeline for an unknown id and `done` for a Phase the catalog lost;
//   that behaviour is pinned for every pre-existing path (T041) and forbidden
//   here (FR-033). A composed run either resolves exactly what the operator
//   submitted against, or it is refused.
//
//   It does not expand the plan itself. Resolution against the effective catalog
//   happens here because this is the only layer that can see it; the FREEZE
//   happens inside `validateRunRequest()` (FR-030), so a plan cannot exist that
//   was expanded at some other time against some other catalog.
//
// No absolute path leaves this file (FR-020). The workspace root is resolved
// host-side and every field error names a field id and a limit, never a location.

import * as fs from 'fs/promises';
import type { PhaseDef } from '../../../config/pipeline-config';
import type { LaunchPipelineCommand, LaunchPipelineResult } from '../../../contracts/sidebar-ipc';
import type { FrozenRunPlan } from '../../../contracts/run-request';
import { checkLocalFile, checkLocalFolder } from '../../../services/run-request/local-input-validator';
import type { OutputTargetProbe } from '../../../services/run-request/output-target-validator';
import { validateRunRequest } from '../../../services/run-request/run-request-validator';
import { getCanonicalWorkspaceRoot } from '../../../state/workspace-folder-picker';
import type { CommandHandler, HandlerContext } from './handler-contract';
import { ack } from './handler-helpers';

/** How much of a queue guard's own refusal text is echoed back to the composer. */
const DETAIL_MAX = 120;

/**
 * The filesystem half of the output gate. `lstat` rather than `stat` on purpose:
 * a dangling symlink still occupies the target, and writing through it is still
 * an overwrite the operator has not confirmed.
 */
const OUTPUT_PROBE: OutputTargetProbe = {
  exists: async (absolutePath) => {
    try {
      await fs.lstat(absolutePath);
      return true;
    } catch {
      return false;
    }
  }
};

async function respond(ctx: HandlerContext, result: LaunchPipelineResult): Promise<void> {
  await ack(
    ctx,
    result.outcome === 'enqueued' ? 'accepted' : 'rejected',
    result.outcome === 'enqueued' ? undefined : result.outcome,
    result
  );
}

/**
 * What the queue row is labelled with.
 *
 * The operator's instructions when they wrote any — that is the task, in their
 * words, and it is what every other enqueue path puts here. Otherwise the
 * Pipeline's own name, which is catalog-authored and always present, so the
 * guarded service's non-empty-description gate cannot be reached by an operator
 * who simply had nothing to add.
 */
function describe(plan: FrozenRunPlan): string {
  const instructions = plan.instructions?.trim() ?? '';
  return instructions.length > 0 ? instructions : plan.pipeline.name;
}

export const handler: CommandHandler<LaunchPipelineCommand> = async (ctx, command) => {
  const { request } = command.payload;
  const guardedRun = ctx.deps.guardedRun;
  if (!guardedRun) {
    // No seam to submit through, which is the queue being unreachable rather
    // than anything wrong with what the operator composed.
    await respond(ctx, {
      outcome: 'rejected-queue',
      reason: 'queue-refused',
      detail: 'launcher-unavailable'
    });
    return;
  }

  // Gate 5 — resolution, against the EFFECTIVE catalog and nothing else. A row
  // that is shadowed or invalid is not in it, and that is the point: the
  // definition frozen below has to be the one that would actually run.
  const catalog = ctx.deps.getCatalog?.();
  const definition = catalog?.pipelinesById.get(request.pipelineId);
  if (!catalog || !definition) {
    await respond(ctx, { outcome: 'rejected-definition', reason: 'pipeline-not-found' });
    return;
  }

  const phases: PhaseDef[] = [];
  for (const phaseId of definition.phases) {
    const phase = catalog.phasesById.get(phaseId);
    // Absent, never substituted. In practice the effective catalog cannot hold a
    // Pipeline whose Phase is missing — such a row resolves as invalid and is
    // excluded — so this is the floor under that guarantee rather than a case
    // the operator is expected to hit, and it refuses instead of silently
    // executing a shorter sequence than the one they read.
    if (!phase) {
      await respond(ctx, { outcome: 'rejected-definition', reason: 'pipeline-invalid' });
      return;
    }
    phases.push(phase);
  }

  const workspaceRoot = getCanonicalWorkspaceRoot()?.uri.fsPath ?? null;
  if (workspaceRoot === null) {
    // Reported once, as a definition-family refusal, rather than as one
    // containment error per path-bearing field: they would all say the same
    // thing, and none of them would be the thing the operator has to fix. A run
    // with no root also has nowhere to write a declared output, so this is a
    // precondition on the launch and not a property of the request.
    await respond(ctx, { outcome: 'rejected-definition', reason: 'no-workspace-root' });
    return;
  }

  // Gate 6 — every field, in one pass. `validateRunRequest()` freezes first and
  // checks against the frozen snapshot, and accumulates rather than short-
  // circuits, so the response carries all failing fields (FR-013).
  const validated = await validateRunRequest(request, {
    pipeline: {
      definition,
      phases,
      ...(ctx.deps.defaultRunnerKind ? { defaultRunnerKind: ctx.deps.defaultRunnerKind } : {})
    },
    workspaceRoot,
    now: Date.now(),
    localInputs: { checkFile: checkLocalFile, checkFolder: checkLocalFolder },
    outputProbe: OUTPUT_PROBE,
    priorOutputs: { outputsFor: (runId) => ctx.deps.readPriorRunOutputs?.(runId) ?? null }
  });
  if (!validated.ok) {
    // Forwarded verbatim. Every `message` is one of a closed set of fixed
    // literals and the only author-supplied part of a `field` is a port id the
    // ingress validator already bounds at 64 — so there is nothing here to
    // sanitize, and rewriting the list would only risk dropping the `limit` and
    // `actual` FR-012 requires.
    await respond(ctx, { outcome: 'rejected-validation', errors: validated.errors });
    return;
  }

  // Gates 7 and 8 — the existing guards, then the single durable write. The plan
  // is carried through untouched; the `WorkflowRun` materializes later, at drain,
  // from this same plan (plan D2).
  const plan = validated.plan;
  let result;
  try {
    result = await guardedRun.scheduleOrEnqueue({
      description: describe(plan),
      scheduledAt: Date.now(),
      via: 'webview',
      pipelineId: plan.pipeline.id,
      runPlan: plan
    });
  } catch (err) {
    // `scheduleOrEnqueue` throws only for a scheduled-start horizon, which this
    // path cannot request — it sends no `startIntent`. Caught anyway so an
    // unexpected failure below is a refusal the composer can render rather than
    // an unhandled rejection the operator sees as a hang.
    ctx.deps.logger.warn(
      `sidebar router: launch-pipeline enqueue failed: ${ctx.deps.logger.sanitize(
        (err as Error).message ?? 'unknown error'
      )}`
    );
    await respond(ctx, {
      outcome: 'rejected-queue',
      reason: 'queue-refused',
      detail: 'enqueue-failed'
    });
    return;
  }

  if (result.outcome === 'enqueued' && result.queueItemId !== undefined) {
    await respond(ctx, { outcome: 'enqueued', requestId: result.queueItemId });
    return;
  }

  // Every other guarded outcome is one refusal family to the composer: the
  // operator's next action is to wait or to resume, not to edit the request.
  // The guard's own reason rides along as detail, already sanitized by the
  // service that produced it and bounded here so a long one cannot fill the ack.
  await respond(ctx, {
    outcome: 'rejected-queue',
    reason: 'queue-refused',
    ...(result.reason !== undefined
      ? { detail: ctx.deps.logger.sanitize(result.reason).slice(0, DETAIL_MAX) }
      : {})
  });
};
