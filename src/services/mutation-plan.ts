import { createHash } from 'node:crypto';
import type { WorkflowRunPipeline, MutationPlanSnapshot } from '../state/workflow-run';

export function buildMutationPlan(
  pipeline: WorkflowRunPipeline,
  capturedAt = Date.now()
): MutationPlanSnapshot {
  const gitCapablePhaseIds = pipeline.phases
    .filter((phase) => phase.sideEffects === 'git' || phase.sideEffects === 'unrestricted')
    .map((phase) => phase.id);
  // `workspace` is the class an omitted `sideEffects` resolves to (FR-005), and
  // it is the class the `gitCapablePhaseIds` filter above already reads an
  // omission as. Substituting `unrestricted` here — the pre-098 default for an
  // unrecognised Phase — made the fingerprint stop identifying the plan: an
  // omitted declaration and an explicit `unrestricted` hashed alike while
  // producing different `gitCapablePhaseIds`, and the fingerprint is the whole
  // basis on which a stored approval receipt is deemed to still apply.
  const canonical = JSON.stringify({
    pipelineId: pipeline.id,
    phases: pipeline.phases.map((phase) => ({
      id: phase.id,
      runner: phase.runner ?? null,
      sideEffects: phase.sideEffects ?? 'workspace',
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
