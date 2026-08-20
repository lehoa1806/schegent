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
import type { CatalogVersionRef } from '../../contracts/catalog-version';
import { CATALOG_EMPTY_REASON, type CatalogEmptyReason } from '../../contracts/empty-catalog-guidance';
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
  | 'no-workspace-root'
  // Feature 098 (T030, US3, FR-031) — the empty catalog is its own reason, not a
  // `pipeline-not-found` for whichever id the operator happened to ask for. The
  // two want different remedies: the first says "import a process document", the
  // second says "check the id". Collapsing them would send an operator with an
  // empty catalog looking for a typo, which is the case this feature makes the
  // common one rather than the rare one.
  //
  // T058 — spelled from the shared constant rather than as a literal, because
  // FR-031a makes the scheduled-start path carry this same name and a second
  // literal is a second thing to keep in step.
  | CatalogEmptyReason;

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
  /**
   * Feature 102 (T037, FR-022) — which published version the effective catalog's
   * copy of a Pipeline came from.
   *
   * The effective catalog carries no version ids (`pipelinesById` is
   * `PipelineDef`s), so the identity comes from the store on this narrow port
   * rather than by widening the resolved config. It takes an id and no kind: the
   * resolver names the kind, so this seam structurally cannot ask what version a
   * Workflow is at — a Workflow is never started here (FR-026).
   *
   * Optional. An absent dep yields an absent version, which is "not recorded"
   * (FR-027) and not an error.
   */
  readonly resolveCatalogVersion?: (pipelineId: string) => CatalogVersionRef | undefined;
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
 * What Gate 1 yields when it resolves: the Pipeline to validate and freeze
 * against, and the published version that Pipeline's body came from.
 *
 * One value carrying both, deliberately. The version is not a second fact looked
 * up beside the body — it is a property *of* the body, and the rule the whole
 * design rests on is that **the version comes from wherever the body came from**.
 * A separate resolution beside this one could answer for a different body than
 * the one the branch above selected, which is exactly the "version the system did
 * not resolve" FR-021 forbids.
 */
interface ResolvedPipelineSource {
  readonly source: EffectivePipelineSource;
  readonly catalogVersion?: CatalogVersionRef;
}

/**
 * Gate 1 for both callers: the Pipeline the request will be validated and frozen
 * against, or the refusal that stands in for it.
 */
function resolvePipelineSource(
  deps: NodeRunStartDeps,
  input: NodeRunStartInput
): ResolvedPipelineSource | { readonly reason: NodeRunStartRejection } {
  if (input.frozenPipeline !== undefined) {
    // A start addressed at a Pipeline the snapshot does not hold is a
    // mis-addressed start, not a catalog problem — refused rather than quietly
    // run against whichever Pipeline the caller did supply.
    if (input.frozenPipeline.id !== input.request.pipelineId) return { reason: 'pipeline-not-found' };
    // Read off the snapshot, never re-resolved. The snapshot's body was frozen
    // when the connected run started; today's Active version describes a body
    // this start is not going to execute, and stamping it would attach a version
    // to a plan that never froze it. A pre-feature snapshot carries none, and
    // that plan records none (FR-027).
    return {
      source: frozenPipelineSource(input.frozenPipeline),
      ...(input.frozenPipeline.catalogVersion !== undefined
        ? { catalogVersion: input.frozenPipeline.catalogVersion }
        : {})
    };
  }

  const catalog = deps.getCatalog?.();
  if (!catalog) return { reason: 'pipeline-not-found' };
  // Feature 098 (T030, FR-031) — checked before the id lookup, because after the
  // lookup every id looks equally absent and the distinction is lost. A catalog
  // with no Pipelines at all cannot resolve anything, and saying so is a different
  // message from "that id is not in the catalog". No reader at all stays
  // `pipeline-not-found` above: that is the host being unable to look, not a
  // catalog that is empty.
  if (catalog.pipelinesById.size === 0) return { reason: CATALOG_EMPTY_REASON };
  const definition = catalog.pipelinesById.get(input.request.pipelineId);
  if (!definition) return { reason: 'pipeline-not-found' };

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

  // FR-022, and FR-044's ordering. Resolved here, against the same effective
  // catalog the body above came from, and stamped onto the plan at the freeze a
  // few lines below. What happens if housekeeping runs in the interval:
  //
  //   Housekeeping yields, and the exclusion is the ACTIVE-VERSION EXEMPTION
  //   rather than a lock. What this port returns is the definition's Active
  //   version, and `catalog/catalog-retention.ts` exempts the Active version
  //   before any other test — no port call, no timing. So for as long as this
  //   version is the one a launch would resolve, retention cannot remove it. It
  //   stops being Active only by a publish, and a publish ADDS a version rather
  //   than removing the one it supersedes: reaching the just-superseded version
  //   in that same pass would require the oldest-first walk to step past every
  //   older version as exempt. Once the plan below is written, FR-033 carries the
  //   exemption on: the queue reader reports the version referenced for as long
  //   as the run has not reached a terminal state. Active, then referenced, with
  //   no gap between them in which the version is neither.
  //
  //   No lock, deliberately. One would serialize every launch behind every
  //   catalog save to close a window the exemption already closes, and would put
  //   the freeze — which must stay a pure function of what it read — behind a
  //   store the freeze does not otherwise touch.
  const catalogVersion = deps.resolveCatalogVersion?.(input.request.pipelineId);
  return {
    source: {
      definition,
      phases,
      ...(deps.defaultRunnerKind ? { defaultRunnerKind: deps.defaultRunnerKind } : {})
    },
    ...(catalogVersion === undefined ? {} : { catalogVersion })
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
  const resolved = resolvePipelineSource(deps, input);
  if ('reason' in resolved) return { outcome: 'rejected-definition', reason: resolved.reason };

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
    pipeline: resolved.source,
    workspaceRoot: input.workspaceRoot,
    now: Date.now(),
    localInputs: { checkFile: checkLocalFile, checkFolder: checkLocalFolder },
    outputProbe: OUTPUT_PROBE,
    priorOutputs: { outputsFor: (runId) => deps.readPriorRunOutputs?.(runId) ?? null },
    // Carried, not re-resolved (FR-021). Gate 1 resolved it from the same read
    // that produced the body; asking again here would be a second oracle that
    // could answer for a different body than the one about to be frozen.
    ...(resolved.catalogVersion === undefined ? {} : { catalogVersion: resolved.catalogVersion })
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
