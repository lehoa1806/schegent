import type { PhaseDefinition } from '../contracts/process-definitions';
import { MAX_CONTROL_NESTING_DEPTH } from '../contracts/workflow-controls';
import type {
  WorkflowDefinition,
  WorkflowFieldError
} from '../contracts/workflow-definitions';
import { workflowFieldError } from './workflow-definition-validator';

/**
 * Bounded dependency and closure resolution for unified Workflow definitions
 * (FR-R5-F01, FR-007–FR-009, FR-R5-F25 D1, hard rule 38).
 *
 * Pure: no `vscode` import, no dynamic code execution, deterministic traversal.
 */

/** Maximum child-Workflow nesting depth (`W0 -> W1 -> ... -> W8` is depth 8). */
export const MAX_WORKFLOW_NESTING_DEPTH = 8;

/** Maximum distinct referenced definitions (Phases + child Workflows) in one closure. */
export const MAX_WORKFLOW_CLOSURE_DEFINITIONS = 64;

/** Maximum total expanded node occurrences across a Workflow and its nested Workflows. */
export const MAX_WORKFLOW_EXPANDED_NODES = 256;

export { MAX_CONTROL_NESTING_DEPTH };

export interface WorkflowClosureContext {
  readonly effectivePhases?: readonly PhaseDefinition[] | undefined;
  readonly invalidPhases?: ReadonlyMap<string, string> | undefined;
  readonly effectiveWorkflows?: readonly WorkflowDefinition[] | undefined;
  readonly invalidWorkflows?: ReadonlyMap<string, string> | undefined;
}

export interface WorkflowClosureResult {
  readonly ok: boolean;
  readonly errors: readonly WorkflowFieldError[];
  readonly referencedPhaseIds: readonly string[];
  readonly referencedWorkflowIds: readonly string[];
  readonly closureSize: number;
  readonly expandedNodeCount: number;
  readonly maxDepthReached: number;
  readonly maxControlDepthReached: number;
  /** Child-before-parent topological order of valid Workflows in the closure. */
  readonly topologicalWorkflowIds: readonly string[];
}

export function resolveWorkflowClosure(
  root: WorkflowDefinition,
  context: WorkflowClosureContext
): WorkflowClosureResult {
  const phasesById = new Map((context.effectivePhases ?? []).map((p) => [p.phaseId, p]));
  const invalidPhases = context.invalidPhases ?? new Map<string, string>();
  const workflowsById = new Map(
    (context.effectiveWorkflows ?? []).map((w) => [w.workflowId, w])
  );
  const invalidWorkflows = context.invalidWorkflows ?? new Map<string, string>();

  const errors: WorkflowFieldError[] = [];
  const referencedPhaseIds = new Set<string>();
  const referencedWorkflowIds = new Set<string>();
  const closureDefinitions = new Set<string>();
  const topologicalWorkflowIds: string[] = [];
  const emittedTopological = new Set<string>();

  let expandedNodeCount = 0;
  let maxDepthReached = 0;
  let maxControlDepthReached = 0;
  let expansionErrorEmitted = false;
  let closureErrorEmitted = false;

  function recordClosureDefinition(
    kind: 'phase' | 'workflow',
    targetId: string,
    field: string,
    chain: readonly string[]
  ): boolean {
    const key = `${kind}:${targetId}`;
    if (!closureDefinitions.has(key)) {
      if (closureDefinitions.size >= MAX_WORKFLOW_CLOSURE_DEFINITIONS) {
        if (!closureErrorEmitted) {
          closureErrorEmitted = true;
          const pathText = [...chain, targetId].join(' -> ');
          errors.push(
            workflowFieldError(
              root.workflowId,
              field,
              'workflow-closure-exceeded',
              `Workflow closure exceeds maximum of ${MAX_WORKFLOW_CLOSURE_DEFINITIONS} distinct referenced definitions at ${pathText}`
            )
          );
        }
        return false;
      }
      closureDefinitions.add(key);
    }
    return true;
  }

  function visitWorkflow(
    current: WorkflowDefinition,
    chain: readonly string[],
    depth: number,
    controlDepth: number,
    rootNodeFieldPrefix?: string | undefined
  ): void {
    if (depth > maxDepthReached) {
      maxDepthReached = depth;
    }
    if (controlDepth > maxControlDepthReached) {
      maxControlDepthReached = controlDepth;
    }

    for (const [index, node] of current.nodes.entries()) {
      const field = rootNodeFieldPrefix ?? `nodes[${index}]`;

      expandedNodeCount += 1;
      if (expandedNodeCount > MAX_WORKFLOW_EXPANDED_NODES) {
        if (!expansionErrorEmitted) {
          expansionErrorEmitted = true;
          const targetLabel = node.workflowId ?? node.phaseId ?? node.pipelineId ?? node.nodeId;
          const pathText = [...chain, targetLabel].join(' -> ');
          errors.push(
            workflowFieldError(
              root.workflowId,
              node.workflowId !== undefined
                ? `${field}.workflowId`
                : node.phaseId !== undefined
                  ? `${field}.phaseId`
                  : `${field}.nodeId`,
              'workflow-expansion-exceeded',
              `Expanded Workflow node occurrences exceed maximum of ${MAX_WORKFLOW_EXPANDED_NODES} at ${pathText}`
            )
          );
        }
        return;
      }

      const isPhaseNode = node.kind === 'phase' || (node.kind === undefined && node.phaseId !== undefined);
      const isWorkflowNode =
        node.kind === 'workflow' || (node.kind === undefined && node.workflowId !== undefined);

      if (isPhaseNode && node.phaseId !== undefined) {
        const phaseField = depth === 0 ? `nodes[${index}].phaseId` : `${field}.phaseId`;
        referencedPhaseIds.add(node.phaseId);
        if (!recordClosureDefinition('phase', node.phaseId, phaseField, chain)) {
          return;
        }
        const phase = phasesById.get(node.phaseId);
        if (!phase) {
          const invalidCause = invalidPhases.get(node.phaseId);
          const pathText = [...chain, node.phaseId].join(' -> ');
          if (invalidCause !== undefined) {
            errors.push(
              workflowFieldError(
                root.workflowId,
                phaseField,
                'phase-invalid',
                `Phase '${node.phaseId}' (${pathText}) is invalid: ${invalidCause}`
              )
            );
          } else {
            errors.push(
              workflowFieldError(
                root.workflowId,
                phaseField,
                'unknown-phase',
                `Phase '${node.phaseId}' (${pathText}) is not in the effective catalog`
              )
            );
          }
        }
        continue;
      }

      if (isWorkflowNode && node.workflowId !== undefined) {
        const wfField = depth === 0 ? `nodes[${index}].workflowId` : `${field}.workflowId`;
        const nextChain = [...chain, node.workflowId];
        const pathText = nextChain.join(' -> ');

        if (chain.includes(node.workflowId)) {
          errors.push(
            workflowFieldError(
              root.workflowId,
              wfField,
              'workflow-inclusion-cycle',
              `Workflow inclusion cycle detected: ${pathText}`
            )
          );
          continue;
        }

        const nextDepth = depth + 1;
        if (nextDepth > MAX_WORKFLOW_NESTING_DEPTH) {
          errors.push(
            workflowFieldError(
              root.workflowId,
              wfField,
              'workflow-depth-exceeded',
              `Workflow nesting depth ${nextDepth} exceeds maximum of ${MAX_WORKFLOW_NESTING_DEPTH}: ${pathText}`
            )
          );
          continue;
        }

        const isControlNode =
          node.control?.kind === 'repeat' || node.control?.kind === 'for-each';
        const nextControlDepth = isControlNode ? controlDepth + 1 : controlDepth;
        if (nextControlDepth > MAX_CONTROL_NESTING_DEPTH) {
          const controlField = depth === 0 ? `nodes[${index}].control` : `${field}.control`;
          errors.push(
            workflowFieldError(
              root.workflowId,
              controlField,
              'control-nesting-depth-exceeded',
              `Control nesting depth ${nextControlDepth} exceeds maximum of ${MAX_CONTROL_NESTING_DEPTH}: ${pathText}`
            )
          );
          continue;
        }

        referencedWorkflowIds.add(node.workflowId);
        if (!recordClosureDefinition('workflow', node.workflowId, wfField, chain)) {
          return;
        }

        const child = workflowsById.get(node.workflowId);
        if (!child) {
          const invalidCause = invalidWorkflows.get(node.workflowId);
          if (invalidCause !== undefined) {
            errors.push(
              workflowFieldError(
                root.workflowId,
                wfField,
                'workflow-invalid',
                `Workflow '${node.workflowId}' (${pathText}) is invalid: ${invalidCause}`
              )
            );
          } else {
            errors.push(
              workflowFieldError(
                root.workflowId,
                wfField,
                'unknown-workflow',
                `Workflow '${node.workflowId}' (${pathText}) is not in the effective catalog`
              )
            );
          }
          continue;
        }

        visitWorkflow(
          child,
          nextChain,
          nextDepth,
          nextControlDepth,
          depth === 0 ? `nodes[${index}]` : rootNodeFieldPrefix
        );
        if (!emittedTopological.has(child.workflowId)) {
          emittedTopological.add(child.workflowId);
          topologicalWorkflowIds.push(child.workflowId);
        }
      }
    }
  }

  visitWorkflow(root, [root.workflowId], 0, 0);
  if (!emittedTopological.has(root.workflowId)) {
    emittedTopological.add(root.workflowId);
    topologicalWorkflowIds.push(root.workflowId);
  }

  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    referencedPhaseIds: Object.freeze([...referencedPhaseIds]),
    referencedWorkflowIds: Object.freeze([...referencedWorkflowIds]),
    closureSize: closureDefinitions.size,
    expandedNodeCount,
    maxDepthReached,
    maxControlDepthReached,
    topologicalWorkflowIds: Object.freeze(topologicalWorkflowIds)
  });
}

/**
 * Orders a set of Workflow items so child Workflows precede the parent Workflows that
 * reference them (FR-R5-F01, FR-012). Items involved in a cycle or lacking dependencies
 * preserve their relative authored order.
 */
export function orderWorkflowItemsTopologically<T>(
  items: readonly T[],
  getId: (item: T) => string,
  getReferencedWorkflowIds: (item: T) => readonly string[]
): readonly T[] {
  if (items.length <= 1) {
    return items;
  }
  const byId = new Map<string, T>();
  for (const item of items) {
    const id = getId(item);
    if (!byId.has(id)) {
      byId.set(id, item);
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: T[] = [];

  function visit(item: T): void {
    const id = getId(item);
    if (visited.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      return;
    }
    visiting.add(id);
    for (const depId of getReferencedWorkflowIds(item)) {
      const dep = byId.get(depId);
      if (dep !== undefined && depId !== id) {
        visit(dep);
      }
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(item);
  }

  for (const item of items) {
    visit(item);
  }
  return ordered;
}
