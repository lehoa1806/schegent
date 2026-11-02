// Feature 086 T021/T027 / Feature 263 (FR-R5-F04) — the composable Workflow
// export closure walk.
//
// A composable Workflow's nodes reference either Phases (`phaseId`) or child
// Workflows (`workflowId`). `include-closure` emits two flat lookup sections
// under `included`:
//
//   1. `included.workflows` — all transitive child Workflows in deterministic
//      first-encountered pre-order depth-first traversal order, excluding the
//      root Workflow itself and deduplicating shared child Workflows at their
//      first mention.
//   2. `included.phases` — all distinct Phases referenced across the root
//      Workflow followed by `included.workflows` in that emitted order, each
//      at its first mention.

import { MAX_WORKFLOW_NESTING_DEPTH } from '../../config/workflow-closure-resolver';
import type { WorkflowDefinition, WorkflowNode } from '../../contracts/workflow-definitions';

/**
 * Distinct Phase IDs in first-occurrence order.
 *
 * `Set` preserves insertion order, so the first reference to a Phase fixes its
 * position and every later reference collapses onto it.
 */
export function referencedPhaseOrder(phaseIds: readonly string[]): readonly string[] {
  return [...new Set(phaseIds)];
}

/**
 * Distinct Phase IDs directly referenced by a single Workflow's nodes, in
 * authored node order.
 */
export function referencedNodePhaseOrder(nodes: readonly WorkflowNode[]): readonly string[] {
  return referencedPhaseOrder(
    nodes
      .filter((node) => node.kind !== 'workflow' && node.phaseId !== undefined)
      .map((node) => node.phaseId!)
  );
}

/**
 * Distinct child Workflow IDs directly referenced by a single Workflow's nodes,
 * in authored node order.
 */
export function referencedChildWorkflowOrder(nodes: readonly WorkflowNode[]): readonly string[] {
  return [
    ...new Set(
      nodes
        .filter((node) => node.kind === 'workflow' || (node.kind === undefined && node.workflowId !== undefined))
        .map((node) => node.workflowId)
        .filter((id): id is string => id !== undefined)
    )
  ];
}

/**
 * Transitive child Workflows reachable from `root`, in deterministic
 * first-encountered pre-order depth-first traversal order (excluding `root`
 * itself and deduplicating shared child Workflows at their first mention).
 *
 * Guards against cyclic inclusions and bounds recursion at
 * `MAX_WORKFLOW_CLOSURE_DEPTH` so even an unvalidated graph cannot loop.
 */
export function referencedWorkflowClosure(
  root: WorkflowDefinition,
  workflowsById: ReadonlyMap<string, WorkflowDefinition>
): readonly WorkflowDefinition[] {
  const seen = new Set<string>([root.workflowId]);
  const ordered: WorkflowDefinition[] = [];

  function visit(current: WorkflowDefinition, depth: number): void {
    if (depth > MAX_WORKFLOW_NESTING_DEPTH) return;
    for (const childId of referencedChildWorkflowOrder(current.nodes)) {
      if (seen.has(childId)) continue;
      const child = workflowsById.get(childId);
      if (child === undefined) continue;
      seen.add(childId);
      ordered.push(child);
      visit(child, depth + 1);
    }
  }

  visit(root, 1);
  return ordered;
}

/**
 * Distinct Phase IDs referenced across `workflows` (typically
 * `[root, ...includedWorkflows]`), in first-encountered order.
 */
export function referencedPhaseClosure(
  workflows: readonly WorkflowDefinition[]
): readonly string[] {
  return referencedPhaseOrder(
    workflows.flatMap((workflow) => referencedNodePhaseOrder(workflow.nodes))
  );
}
