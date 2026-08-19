import { randomUUID } from 'node:crypto';
import {
  BUILT_IN_PIPELINE,
  BUILT_IN_PIPELINE_ID,
  type PhaseDef,
  type PipelineCatalog
} from '../config/pipeline-config';
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

export class WorkflowRunFactory {
  constructor(private readonly deps: WorkflowRunFactoryDeps) {}

  public resolvePipeline(
    requestedId: string,
    defaultRunnerKind = this.deps.defaultRunnerKind ?? DEFAULT_BACKEND
  ): WorkflowRunPipeline {
    const catalog = this.deps.getCatalog();
    let pipeline = catalog.pipelinesById.get(requestedId);
    if (!pipeline) {
      if (requestedId !== BUILT_IN_PIPELINE_ID) {
        this.deps.logger.warn(
          `pipeline '${requestedId}' not found; falling back to '${BUILT_IN_PIPELINE_ID}'`
        );
      }
      pipeline = catalog.pipelinesById.get(BUILT_IN_PIPELINE_ID) ?? BUILT_IN_PIPELINE;
    }
    const phases: PhaseDef[] = [];
    for (const phaseId of pipeline.phases) {
      const def = catalog.phasesById.get(phaseId) ?? catalog.phasesById.get('done');
      if (def) phases.push(snapshotPhaseDef(def, defaultRunnerKind));
    }
    if (!phases.some((phase) => phase.id === 'done')) {
      const done = catalog.phasesById.get('done');
      if (done) phases.push(snapshotPhaseDef(done, defaultRunnerKind));
    }
    return snapshotPipelineContract(pipeline, phases);
  }

  public async create(
    feature: FeatureRequest,
    featureDir: string | null,
    requestedId: string
  ): Promise<WorkflowRun> {
    // Feature 087 (T040, US4, FR-030/FR-033) — a composed item already carries
    // the definition it was submitted against, expanded through the effective
    // catalog at that moment. Resolving again here would re-read the catalog as
    // it stands *now*, which is the drift this feature exists to close, and
    // `resolvePipeline()` fails open on top of it: an unknown Pipeline becomes
    // the built-in one and a deleted Phase becomes `done`, silently.
    //
    // Every other path — items enqueued before this feature, and the existing
    // non-composed starts — carries no plan and takes the original branch
    // unchanged.
    const plan = feature.runPlan;
    const pipeline = plan?.pipeline ?? this.resolvePipeline(requestedId);
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
