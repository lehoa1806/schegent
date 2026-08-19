import { randomUUID } from 'node:crypto';
import { type PhaseDef, type PipelineCatalog } from '../config/pipeline-config';
import { snapshotPhaseDef, snapshotPipelineContract } from '../config/pipeline-snapshot';
import type { SanitizedLogger } from '../lib/logger';
import type { FeatureRequest } from '../queue/feature-request';
import { DEFAULT_BACKEND, type BackendRunnerKind } from '../runner/backend-runner-factory';
import type {
  MutationPlanSnapshot,
  RawTranscriptMode,
  WorkflowRun,
  WorkflowRunPipeline
} from '../state/workflow-run';
import { buildMutationPlan } from './mutation-plan';
import { computePlannedTotal, DEFAULT_ITERATION_CAP } from './run-planned-total';

export interface WorkflowRunFactoryDeps {
  readonly getCatalog: () => PipelineCatalog;
  readonly defaultRunnerKind?: BackendRunnerKind;
  readonly getRawTranscriptMode?: () => RawTranscriptMode;
  readonly requestGitApproval?: (plan: MutationPlanSnapshot) => Promise<boolean>;
  /**
   * FR-R3-008 (T373) — the effective `loop.maxIterations` at creation, read once
   * and frozen into `plannedTotal`. Optional so the six existing construction
   * sites keep compiling; omitting it freezes `DEFAULT_ITERATION_CAP`, which is
   * the manifest default, so the field is present either way and its absence on
   * a record still means "written before this feature".
   */
  readonly getIterationCap?: () => number;
  readonly logger: SanitizedLogger;
}

/**
 * Feature 098 (T024/T025, US3, FR-023/FR-024) — why a resolution failure is a
 * value here and a throw one layer up.
 *
 * `resolvePipeline` is read from snapshot-projection paths as well as from
 * `create()`, and a projection renders the sidebar. A throw on that path takes
 * down the render rather than refusing a launch, so this function answers with a
 * discriminated resolution and lets each caller decide. `create()` is the caller
 * that decides "fail", and it does so through `requirePipeline` below — the same
 * shape it already uses for an unapproved mutation plan, and before any Run
 * record exists.
 */
export type PipelineRefusal =
  | { readonly reason: 'pipeline-not-found'; readonly pipelineId: string }
  | {
      readonly reason: 'unknown-phase';
      readonly pipelineId: string;
      readonly phaseId: string;
    };

export type PipelineResolution =
  | { readonly ok: true; readonly pipeline: WorkflowRunPipeline }
  | { readonly ok: false; readonly refusal: PipelineRefusal };

/** One phrasing, read by the log line and by the error the operator sees. */
export function describePipelineRefusal(refusal: PipelineRefusal): string {
  return refusal.reason === 'pipeline-not-found'
    ? `pipeline '${refusal.pipelineId}' is not in the effective catalog`
    : `pipeline '${refusal.pipelineId}' names phase '${refusal.phaseId}', ` +
      'which is not in the effective catalog';
}

/** The refusal, carried across the hop out of `create()` so SC-007 can name the id. */
export class UnresolvablePipelineError extends Error {
  public readonly refusal: PipelineRefusal;

  constructor(refusal: PipelineRefusal) {
    super(describePipelineRefusal(refusal));
    this.name = 'UnresolvablePipelineError';
    this.refusal = refusal;
  }
}

export class WorkflowRunFactory {
  constructor(private readonly deps: WorkflowRunFactoryDeps) {}

  public resolvePipeline(
    requestedId: string,
    defaultRunnerKind = this.deps.defaultRunnerKind ?? DEFAULT_BACKEND
  ): PipelineResolution {
    const catalog = this.deps.getCatalog();
    const pipeline = catalog.pipelinesById.get(requestedId);
    if (!pipeline) return this.refuse({ reason: 'pipeline-not-found', pipelineId: requestedId });
    const phases: PhaseDef[] = [];
    for (const phaseId of pipeline.phases) {
      // Feature 098 (T025, FR-022) — the pre-feature expression was
      // `phasesById.get(phaseId) ?? phasesById.get('done')`, guarded by
      // `if (def)`. No `PhaseDef` ever declared `done`, so a miss resolved to
      // `undefined` and the phase was *dropped*: a Run executed a shorter
      // sequence than the Pipeline it was launched from, with nothing recorded.
      // The terminal `done` append that followed the loop went the same way, for
      // the same reason. A Pipeline naming a Phase the catalog does not hold is
      // now refused, naming both.
      const def = catalog.phasesById.get(phaseId);
      if (!def) {
        return this.refuse({ reason: 'unknown-phase', pipelineId: requestedId, phaseId });
      }
      phases.push(snapshotPhaseDef(def, defaultRunnerKind));
    }
    return { ok: true, pipeline: snapshotPipelineContract(pipeline, phases) };
  }

  private refuse(refusal: PipelineRefusal): PipelineResolution {
    this.deps.logger.warn(describePipelineRefusal(refusal));
    return { ok: false, refusal };
  }

  /** The one conversion from refusal to failure; see the note above the types. */
  private requirePipeline(requestedId: string): WorkflowRunPipeline {
    const resolution = this.resolvePipeline(requestedId);
    if (!resolution.ok) throw new UnresolvablePipelineError(resolution.refusal);
    return resolution.pipeline;
  }

  public async create(
    feature: FeatureRequest,
    featureDir: string | null,
    requestedId: string
  ): Promise<WorkflowRun> {
    // Feature 087 (T040, US4, FR-030/FR-033) — a composed item already carries
    // the definition it was submitted against, expanded through the effective
    // catalog at that moment. Resolving again here would re-read the catalog as
    // it stands *now*, which is the drift this feature exists to close.
    //
    // Feature 098 (T023) — that fail-open is gone: `requirePipeline` refuses an
    // unknown Pipeline id and a Pipeline naming an undefined Phase. The
    // short-circuit is what keeps the refusals off this branch — a plan carries
    // its own definition, so a Phase since deleted from the catalog still
    // executes from the snapshot.
    //
    // Every other path — items enqueued before this feature, and the existing
    // non-composed starts — carries no plan and takes the resolving branch.
    const plan = feature.runPlan;
    const pipeline = plan?.pipeline ?? this.requirePipeline(requestedId);
    const mutationPlan = buildMutationPlan(pipeline);
    const approved = mutationPlan.gitCapablePhaseIds.length === 0 ||
      await (this.deps.requestGitApproval?.(mutationPlan) ?? Promise.resolve(true));
    if (!approved) throw new Error('git-mutation-plan-not-approved');
    const now = Date.now();
    const specifyIndex = pipeline.phases.findIndex((phase) => phase.id === 'speckit-specify');
    const startPhase = featureDir
      ? pipeline.phases[specifyIndex + 1]?.id ?? pipeline.phases[0]?.id ?? 'done'
      : pipeline.phases[0]?.id ?? 'done';
    return {
      id: randomUUID(), featureId: feature.id, featureDir: featureDir ?? '',
      status: 'running', currentPhase: startPhase, currentIteration: 0,
      startedAt: now, lastTransitionAt: now, phasesCompleted: [], lastError: null,
      rawTranscriptMode: this.deps.getRawTranscriptMode?.() ?? 'errors-only',
      mutationPlan,
      ...(mutationPlan.gitCapablePhaseIds.length > 0 ? { gitApprovalReceipt: {
        approvedAt: now, planFingerprint: mutationPlan.fingerprint,
        approvedPhaseIds: mutationPlan.gitCapablePhaseIds
      } } : {}),
      pipeline,
      // FR-R3-008 (T373) — freeze the progress denominator beside the snapshot
      // that pins the phase list. The loop bound is read here, once, and every
      // later consumer reads it back off the record: `loop.maxIterations` is a
      // live setting, so re-deriving the total later would move the denominator
      // under a Run already in flight. A new Run has no overrides yet, so this is
      // the whole plan; `PhaseControlService` narrows it when one is recorded.
      plannedTotal: computePlannedTotal({
        phases: pipeline.phases,
        overrides: [],
        iterationCap: this.deps.getIterationCap?.() ?? DEFAULT_ITERATION_CAP
      }),
      // FR-R3-001 (T259/T267) — the composed branch attaches the envelope whole,
      // by reference. It is not rebuilt, re-derived, or narrowed here: this
      // factory is the seam where feature 087's plan used to lose four of its
      // five fields, and the fix is that the seam now copies nothing.
      //
      // Both spreads are conditioned on the same `plan`, so the plan-less branch
      // adds no key and a Run created from any other path serializes exactly as
      // it did before either feature (T035, T267). The two paths are a
      // discriminated choice — there is no merge and no fallback in either
      // direction.
      ...(plan ? { envelope: plan, runInputs: plan.inputs } : {}),
      defaultRunnerKind: this.deps.defaultRunnerKind ?? DEFAULT_BACKEND,
      delayedRetryCount: 0, pendingRetryAt: null, pendingRetryCause: null,
      phaseOverrides: [], manualPauseAt: null, manualPauseCause: null,
      phaseBreakpoints: [], resumeTargetPhaseId: null
    };
  }
}
