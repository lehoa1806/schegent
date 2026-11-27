/**
 * FR-R7-07 — `buildMutationPlan` and `mutationPlanIsApproved` moved to
 * `src/state/mutation-plan.ts` beside `WorkflowRunPipeline` and
 * `MutationPlanSnapshot` so `src/state/` does not value-import `src/services/`.
 * Re-exported here for full caller compatibility.
 */
export { buildMutationPlan, mutationPlanIsApproved } from '../state/mutation-plan';
