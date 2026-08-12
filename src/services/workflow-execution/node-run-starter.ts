// Feature 088 (T021) — the one seam a Pipeline Run is started through.
//
// `cmd-launch-pipeline.ts` was four ordered gates: resolve → validate → guard →
// enqueue. Starting a Workflow node needs the same four, plus one gate before
// (is this node startable) and one record after (which child run it produced).
// Rather than copy the four, they live here and both callers reach them
// (plan D2).
//
// The gate ORDER is the contract, not an implementation detail. A definition
// that does not resolve is reported before any field is checked, and every field
// is checked before the queue is consulted — reverse either pair and the
// operator is handed the wrong thing to fix. `cmd-launch-pipeline.ts`'s own
// suite pins that ordering and its refusal families; this module was extracted
// under it, so that suite is the proof the extraction changed nothing.
//
// What this module does NOT do:
//
//   It does not ack. Handlers own their ack shape, and the two callers have
//   different result vocabularies — a launch answers `LaunchPipelineResult`, a
//   continuation answers a connected-run result. So the outcome below is
//   neutral, and each caller maps it to its own wire type.
//
//   It does not read the workspace root. The root arrives as a value, so the
//   seam stays free of `vscode` and the canonical-root rule keeps its single
//   enforcement site in `state/workspace-folder-picker.ts`.
//
//   It does not fail open. An unknown Pipeline or a missing Phase is refused,
//   never substituted (FR-033 of feature 087, carried forward here).

import * as fs from 'fs/promises';
import type { PhaseDef, PipelineCatalog } from '../../config/pipeline-config';
import type { RunRequestFieldError } from '../../contracts/run-request';
import type { FrozenRunPlan, RunRequest } from '../../contracts/run-request';
import type { RunOutputRecord } from '../../contracts/run-results';
import type { BackendRunnerKind } from '../../runner/backend-runner-factory';
import type { SanitizedLogger } from '../../lib/logger';
import type { WorkflowRunPipeline } from '../../state/workflow-run';
import { checkLocalFile, checkLocalFolder } from '../run-request/local-input-validator';
import type { OutputTargetProbe } from '../run-request/output-target-validator';
import type { EffectivePipelineSource } from '../run-request/run-request-validator';
import { validateRunRequest } from '../run-request/run-request-validator';
import type { GuardedScheduleRequest, GuardedScheduleResult } from '../guarded-run-service';

/** How much of a queue guard's own refusal text is echoed back to the caller. */
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

/**
 * Why a start was refused before any field was checked, in the vocabulary both
 * callers translate from.
 *
 * The queue's own refusal is deliberately not a member: it belongs to a later
 * gate and carries a detail string, so folding it in here would let a caller
 * write an exhaustive-looking `switch` over definition failures that silently
 * accepts one that is not.
 */
export type NodeRunStartRejection =
  | 'pipeline-not-found'
  | 'pipeline-invalid'
  | 'no-workspace-root';

export type NodeRunStartResult =
  | { readonly outcome: 'enqueued'; readonly queueItemId: string; readonly plan: FrozenRunPlan }
  | { readonly outcome: 'rejected-definition'; readonly reason: NodeRunStartRejection }
  | { readonly outcome: 'rejected-validation'; readonly errors: readonly RunRequestFieldError[] }
  | {
      readonly outcome: 'rejected-queue';
      readonly reason: 'queue-refused';
      readonly detail?: string;
    };

/**
 * Exactly the subset of the router's deps the four gates need, so a handler can
 * pass its own `deps` object straight through and no new wiring appears at the
 * call sites.
 */
export interface NodeRunStartDeps {
  readonly guardedRun?: {
    scheduleOrEnqueue(request: GuardedScheduleRequest): Promise<GuardedScheduleResult>;
  };
  readonly getCatalog?: () => PipelineCatalog;
  readonly defaultRunnerKind?: BackendRunnerKind;
  readonly readPriorRunOutputs?: (runId: string) => readonly RunOutputRecord[] | null;
  readonly logger: Pick<SanitizedLogger, 'warn' | 'sanitize'>;
}

export interface NodeRunStartInput {
  readonly request: RunRequest;
  /** Resolved host-side; `null` means no folder is open. */
  readonly workspaceRoot: string | null;
  /** Overrides the queue row label; the Workflow path names its node here. */
  readonly description?: string;
  /**
   * Feature 092 (T062, FR-034) — which queue admits the enqueue. Carried to
   * `scheduleOrEnqueue` verbatim and defaulted there, not here: this seam has
   * no opinion about which queue is the default one, and inventing that opinion
   * would make a second site deciding it.
   */
  readonly queueId?: string;
  /**
   * The connected run's own frozen Pipeline, when the caller has one (FR-005).
   *
   * This is the one gate that legitimately differs between the two callers. A
   * standalone launch resolves against the effective catalog, because the
   * definition it freezes has to be the one that would actually run *now*. A
   * Workflow node start resolves against the snapshot the connected run froze at
   * start, because the definition that has to run is the one the operator
   * started — the catalog may have been edited, reordered, or had the Pipeline
   * deleted outright since, and none of that may reach a run already underway.
   *
   * Supplying it bypasses the catalog lookup entirely, so neither
   * `pipeline-not-found` nor `pipeline-invalid` can arise: a snapshot is
   * complete by construction, Phases included.
   */
  readonly frozenPipeline?: WorkflowRunPipeline;
}

/**
 * Present a frozen snapshot as the source shape validation consumes.
 *
 * `snapshotPipelineContract()` dropped `phaseIds` in favour of the resolved
 * `PhaseDef[]`, so the reverse is just reading the ids back off them. Re-freezing
 * inside `validateRunRequest()` is idempotent — every field the snapshot
 * defaults is already set, so each `??` keeps what is there.
 *
 * No `defaultRunnerKind`, deliberately. It is the backend a Phase inherits when
 * it names none, and every frozen Phase already carries the one it inherited at
 * start; supplying today's value would let a backend the operator reconfigured
 * mid-run reach a run already underway, which is the drift the freeze exists to
 * prevent.
 */
function frozenPipelineSource(pipeline: WorkflowRunPipeline): EffectivePipelineSource {
  return {
    definition: { ...pipeline, phases: pipeline.phases.map((phase) => phase.id) },
    phases: pipeline.phases
  };
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
function describe(plan: FrozenRunPlan, override: string | undefined): string {
  const supplied = (override ?? plan.instructions)?.trim() ?? '';
  return supplied.length > 0 ? supplied : plan.pipeline.name;
}

/**
 * Gate 1 for both callers: the Pipeline the request will be validated and frozen
 * against, or the refusal that stands in for it.
 */
function resolvePipelineSource(
  deps: NodeRunStartDeps,
  input: NodeRunStartInput
): EffectivePipelineSource | { readonly reason: NodeRunStartRejection } {
  if (input.frozenPipeline !== undefined) {
    // A start addressed at a Pipeline the snapshot does not hold is a
    // mis-addressed start, not a catalog problem — refused rather than quietly
    // run against whichever Pipeline the caller did supply.
    if (input.frozenPipeline.id !== input.request.pipelineId) return { reason: 'pipeline-not-found' };
    return frozenPipelineSource(input.frozenPipeline);
  }

  const catalog = deps.getCatalog?.();
  const definition = catalog?.pipelinesById.get(input.request.pipelineId);
  if (!catalog || !definition) return { reason: 'pipeline-not-found' };

  const phases: PhaseDef[] = [];
  for (const phaseId of definition.phases) {
    const phase = catalog.phasesById.get(phaseId);
    // Absent, never substituted. In practice the effective catalog cannot hold a
    // Pipeline whose Phase is missing — such a row resolves as invalid and is
    // excluded — so this is the floor under that guarantee rather than a case
    // the operator is expected to hit, and it refuses instead of silently
    // executing a shorter sequence than the one they read.
    if (!phase) return { reason: 'pipeline-invalid' };
    phases.push(phase);
  }
  return {
    definition,
    phases,
    ...(deps.defaultRunnerKind ? { defaultRunnerKind: deps.defaultRunnerKind } : {})
  };
}

/**
 * Resolve → validate → guard → enqueue, in that order.
 *
 * Total: every failure is one of the refusal arms above, and nothing is
 * persisted on any of them. The only durable write is the enqueue itself.
 */
export async function startPipelineRun(
  deps: NodeRunStartDeps,
  input: NodeRunStartInput
): Promise<NodeRunStartResult> {
  const guardedRun = deps.guardedRun;
  if (!guardedRun) {
    // No seam to submit through, which is the queue being unreachable rather
    // than anything wrong with what was composed.
    return { outcome: 'rejected-queue', reason: 'queue-refused', detail: 'launcher-unavailable' };
  }

  // Gate 1 — resolution. Against the frozen snapshot when the caller has one,
  // otherwise against the EFFECTIVE catalog and nothing else: a row that is
  // shadowed or invalid is not in the effective catalog, and that is the point —
  // the definition frozen below has to be the one that would actually run.
  const source = resolvePipelineSource(deps, input);
  if ('reason' in source) return { outcome: 'rejected-definition', reason: source.reason };

  if (input.workspaceRoot === null) {
    // Reported once, as a definition-family refusal, rather than as one
    // containment error per path-bearing field: they would all say the same
    // thing, and none of them would be the thing to fix. A run with no root also
    // has nowhere to write a declared output, so this is a precondition on the
    // start and not a property of the request.
    return { outcome: 'rejected-definition', reason: 'no-workspace-root' };
  }

  // Gate 2 — every field, in one pass. `validateRunRequest()` freezes first and
  // checks against the frozen snapshot, and accumulates rather than short-
  // circuits, so the response carries all failing fields.
  const validated = await validateRunRequest(input.request, {
    pipeline: source,
    workspaceRoot: input.workspaceRoot,
    now: Date.now(),
    localInputs: { checkFile: checkLocalFile, checkFolder: checkLocalFolder },
    outputProbe: OUTPUT_PROBE,
    priorOutputs: { outputsFor: (runId) => deps.readPriorRunOutputs?.(runId) ?? null }
  });
  if (!validated.ok) {
    // Forwarded verbatim. Every `message` is one of a closed set of fixed
    // literals and the only author-supplied part of a `field` is a port id the
    // ingress validator already bounds at 64 — so there is nothing here to
    // sanitize, and rewriting the list would only risk dropping the `limit` and
    // `actual` the composer renders.
    return { outcome: 'rejected-validation', errors: validated.errors };
  }

  // Gates 3 and 4 — the existing guards, then the single durable write. The plan
  // is carried through untouched; the `WorkflowRun` materializes later, at drain,
  // from this same plan.
  const plan = validated.plan;
  let result: GuardedScheduleResult;
  try {
    result = await guardedRun.scheduleOrEnqueue({
      description: describe(plan, input.description),
      scheduledAt: Date.now(),
      via: 'webview',
      pipelineId: plan.pipeline.id,
      ...(input.queueId !== undefined ? { queueId: input.queueId } : {}),
      runPlan: plan
    });
  } catch (err) {
    // `scheduleOrEnqueue` throws only for a scheduled-start horizon, which this
    // path cannot request — it sends no `startIntent`. Caught anyway so an
    // unexpected failure below is a refusal the caller can render rather than an
    // unhandled rejection the operator sees as a hang.
    deps.logger.warn(
      `node-run-starter: enqueue failed: ${deps.logger.sanitize(
        (err as Error).message ?? 'unknown error'
      )}`
    );
    return { outcome: 'rejected-queue', reason: 'queue-refused', detail: 'enqueue-failed' };
  }

  if (result.outcome === 'enqueued' && result.queueItemId !== undefined) {
    return { outcome: 'enqueued', queueItemId: result.queueItemId, plan };
  }

  // Every other guarded outcome is one refusal family: the next action is to
  // wait or to resume, not to edit the request. The guard's own reason rides
  // along as detail, already sanitized by the service that produced it and
  // bounded here so a long one cannot fill the ack.
  return {
    outcome: 'rejected-queue',
    reason: 'queue-refused',
    ...(result.reason !== undefined
      ? { detail: deps.logger.sanitize(result.reason).slice(0, DETAIL_MAX) }
      : {})
  };
}
