import { createHash } from 'node:crypto';
import type { WorkflowRunPipeline, MutationPlanSnapshot } from '../state/workflow-run';

export function buildMutationPlan(
  pipeline: WorkflowRunPipeline,
  capturedAt = Date.now()
): MutationPlanSnapshot {
  const gitCapablePhaseIds = pipeline.phases
    .filter((phase) => phase.sideEffects === 'git' || phase.sideEffects === 'unrestricted')
    .map((phase) => phase.id);
  const canonical = JSON.stringify({
    pipelineId: pipeline.id,
    phases: pipeline.phases.map((phase) => ({
      id: phase.id,
      runner: phase.runner ?? null,
      sideEffects: phase.sideEffects ?? 'unrestricted',
      promptVersion: phase.promptVersion ?? null
    }))
  });
  return Object.freeze({
    fingerprint: createHash('sha256').update(canonical).digest('hex'),
    gitCapablePhaseIds: Object.freeze(gitCapablePhaseIds),
    capturedAt
  });
}

export function mutationPlanIsApproved(
  plan: MutationPlanSnapshot,
  receipt: import('../state/workflow-run').GitApprovalReceipt | undefined
): boolean {
  return receipt?.planFingerprint === plan.fingerprint;
}
