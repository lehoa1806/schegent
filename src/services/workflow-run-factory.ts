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

export interface WorkflowRunFactoryDeps {
  readonly getCatalog: () => PipelineCatalog;
  readonly defaultRunnerKind?: BackendRunnerKind;
  readonly getRawTranscriptMode?: () => RawTranscriptMode;
  readonly requestGitApproval?: (plan: MutationPlanSnapshot) => Promise<boolean>;
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
    const pipeline = this.resolvePipeline(requestedId);
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
      rawTranscriptMode: this.deps.getRawTranscriptMode?.() ?? 'always',
      mutationPlan,
      ...(mutationPlan.gitCapablePhaseIds.length > 0 ? { gitApprovalReceipt: {
        approvedAt: now, planFingerprint: mutationPlan.fingerprint,
        approvedPhaseIds: mutationPlan.gitCapablePhaseIds
      } } : {}),
      pipeline,
      defaultRunnerKind: this.deps.defaultRunnerKind ?? DEFAULT_BACKEND,
      delayedRetryCount: 0, pendingRetryAt: null, pendingRetryCause: null,
      phaseOverrides: [], manualPauseAt: null, manualPauseCause: null,
      phaseBreakpoints: [], resumeTargetPhaseId: null
    };
  }
}
