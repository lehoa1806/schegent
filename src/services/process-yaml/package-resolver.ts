// Feature 085 / Feature 086 / Feature 263 (FR-R5-F04) — dependency resolution for a
// composable Workflow package.
//
// `import-planner.ts` owns presence (read from stored rows + draft ids at every state).
// This module owns dependency resolution against the EFFECTIVE Phase and Workflow catalogs
// unioned with the candidate definitions this same package plan will import.
//
// Pure and total. Errors are values; nothing here throws or performs I/O.

import { readNodeWorkflowIds } from '../../config/workflow-catalog';
import { validateWorkflowGraph } from '../../config/workflow-graph-validator';
import type { PhaseDefinition, PhaseSourceRecord } from '../../contracts/process-definitions';
import type { WorkflowDefinition, WorkflowSourceRecord } from '../../contracts/workflow-definitions';
import type { BlockedDependency, BlockedReason, ImportDefect, ImportPlanRow } from './types';

/**
 * How one referenced `phaseId` resolves.
 */
export type PhaseDependencyResolution =
  | { readonly status: 'resolved-effective' }
  | { readonly status: 'resolved-planned' }
  | { readonly status: 'resolved-skipped' }
  | { readonly status: 'blocked'; readonly reason: BlockedReason };

/**
 * How one referenced child `workflowId` resolves.
 */
export type WorkflowDependencyResolution =
  | { readonly status: 'resolved-effective' }
  | { readonly status: 'resolved-planned' }
  | { readonly status: 'resolved-skipped' }
  | { readonly status: 'blocked'; readonly reason: BlockedReason };

export interface PackageResolutionContext {
  readonly effectivePhases: readonly PhaseDefinition[];
  readonly storedPhases: readonly PhaseSourceRecord[];
  readonly plannedPhaseRows: readonly ImportPlanRow[];
}

export interface WorkflowResolutionContext extends PackageResolutionContext {
  readonly effectiveWorkflows: readonly WorkflowDefinition[];
  readonly storedWorkflows: readonly WorkflowSourceRecord[];
  readonly plannedWorkflowRows: readonly ImportPlanRow[];
  readonly candidateWorkflows?: readonly WorkflowDefinition[];
  readonly invalidPhases?: ReadonlyMap<string, string>;
  readonly invalidWorkflows?: ReadonlyMap<string, string>;
}

export type WorkflowResolution =
  | { readonly outcome: 'resolved' }
  | { readonly outcome: 'blocked'; readonly reason: BlockedReason }
  | { readonly outcome: 'invalid'; readonly defects: readonly ImportDefect[] };

function blockedPhase(
  code: 'dependency-absent' | 'dependency-unresolvable',
  phaseId: string
): Extract<PhaseDependencyResolution, { status: 'blocked' }> {
  return Object.freeze({
    status: 'blocked' as const,
    reason: Object.freeze({
      code,
      dependency: Object.freeze({ kind: 'phase' as const, resourceId: phaseId })
    })
  });
}

function workflowDependency(workflowId: string): BlockedDependency {
  return Object.freeze({ kind: 'workflow' as const, resourceId: workflowId });
}

function plannedPhases(context: PackageResolutionContext): readonly PhaseDefinition[] {
  const definitions: PhaseDefinition[] = [];
  for (const row of context.plannedPhaseRows) {
    if (row.outcome !== 'import' || row.resourceKind !== 'phase') continue;
    definitions.push(row.definition);
  }
  return definitions;
}

/**
 * The effective Phase catalog unioned with the Phases this same confirmed write will import.
 */
export function prospectivePhaseCatalog(
  context: PackageResolutionContext
): readonly PhaseDefinition[] {
  const byId = new Map<string, PhaseDefinition>();
  for (const definition of context.effectivePhases) {
    byId.set(definition.phaseId, definition);
  }
  for (const definition of plannedPhases(context)) {
    if (!byId.has(definition.phaseId)) byId.set(definition.phaseId, definition);
  }
  return Object.freeze([...byId.values()]);
}

/**
 * How one referenced Phase id resolves.
 */
export function resolvePhaseDependency(
  phaseId: string,
  context: PackageResolutionContext
): PhaseDependencyResolution {
  if (plannedPhases(context).some((definition) => definition.phaseId === phaseId)) {
    return Object.freeze({ status: 'resolved-planned' as const });
  }

  if (context.effectivePhases.some((definition) => definition.phaseId === phaseId)) {
    const declared = context.plannedPhaseRows.some(
      (row) => row.outcome === 'skip' && row.resourceKind === 'phase' && row.resourceId === phaseId
    );
    return Object.freeze({
      status: declared ? ('resolved-skipped' as const) : ('resolved-effective' as const)
    });
  }

  const claimed = context.storedPhases.some((row) => row.phaseId === phaseId);
  return blockedPhase(claimed ? 'dependency-unresolvable' : 'dependency-absent', phaseId);
}

function plannedWorkflows(context: WorkflowResolutionContext): readonly WorkflowDefinition[] {
  const definitions: WorkflowDefinition[] = [];
  for (const row of context.plannedWorkflowRows) {
    if (row.outcome !== 'import' || row.resourceKind !== 'workflow') continue;
    definitions.push(row.definition);
  }
  return definitions;
}

/**
 * The effective Workflow catalog unioned with the Workflows this same confirmed write will import.
 */
export function prospectiveWorkflowCatalog(
  context: WorkflowResolutionContext
): readonly WorkflowDefinition[] {
  const byId = new Map<string, WorkflowDefinition>();
  for (const definition of context.effectiveWorkflows) {
    byId.set(definition.workflowId, definition);
  }
  for (const definition of plannedWorkflows(context)) {
    if (!byId.has(definition.workflowId)) byId.set(definition.workflowId, definition);
  }
  return Object.freeze([...byId.values()]);
}

/**
 * How one referenced child Workflow id resolves.
 */
export function resolveWorkflowDependency(
  workflowId: string,
  context: WorkflowResolutionContext
): WorkflowDependencyResolution {
  if (plannedWorkflows(context).some((definition) => definition.workflowId === workflowId)) {
    return Object.freeze({ status: 'resolved-planned' as const });
  }

  if (context.effectiveWorkflows.some((definition) => definition.workflowId === workflowId)) {
    const declared = context.plannedWorkflowRows.some(
      (row) =>
        row.outcome === 'skip' && row.resourceKind === 'workflow' && row.resourceId === workflowId
    );
    return Object.freeze({
      status: declared ? ('resolved-skipped' as const) : ('resolved-effective' as const)
    });
  }

  const blockedRow = context.plannedWorkflowRows.find(
    (row) =>
      row.outcome === 'blocked' && row.resourceKind === 'workflow' && row.resourceId === workflowId
  );
  if (blockedRow?.outcome === 'blocked') {
    const rootCause =
      blockedRow.reason.code === 'dependency-blocked'
        ? blockedRow.reason.via
        : blockedRow.reason.dependency;
    return Object.freeze({
      status: 'blocked' as const,
      reason: Object.freeze({
        code: 'dependency-blocked' as const,
        dependency: workflowDependency(workflowId),
        via: rootCause
      })
    });
  }

  const claimed = context.storedWorkflows.some((row) => row.workflowId === workflowId);
  return Object.freeze({
    status: 'blocked' as const,
    reason: Object.freeze({
      code: claimed ? ('dependency-unresolvable' as const) : ('dependency-absent' as const),
      dependency: workflowDependency(workflowId)
    })
  });
}

function asDefect(error: {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}): ImportDefect {
  return Object.freeze({ field: error.field, code: error.code, message: error.message });
}

function reachesTargetWorkflow(
  startId: string,
  targetId: string,
  byId: ReadonlyMap<string, WorkflowDefinition>
): boolean {
  const visited = new Set<string>();
  const stack = [startId];
  while (stack.length > 0) {
    const currentId = stack.pop()!;
    if (currentId === targetId) return true;
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    const wf = byId.get(currentId);
    if (!wf) continue;
    for (const nextId of readNodeWorkflowIds(wf)) {
      stack.push(nextId);
    }
  }
  return false;
}

/**
 * Resolve one Workflow's dependencies (Phases and child Workflows) and validate its graph
 * and transitive closure against the candidate + effective catalog overlay.
 */
export function resolveWorkflowDependencies(
  definition: WorkflowDefinition,
  context: WorkflowResolutionContext
): WorkflowResolution {
  const effectiveWorkflows = prospectiveWorkflowCatalog(context);
  const allKnownWorkflows = new Map<string, WorkflowDefinition>();
  for (const wf of effectiveWorkflows) allKnownWorkflows.set(wf.workflowId, wf);
  for (const wf of context.candidateWorkflows ?? []) {
    if (!allKnownWorkflows.has(wf.workflowId)) allKnownWorkflows.set(wf.workflowId, wf);
  }
  allKnownWorkflows.set(definition.workflowId, definition);

  for (const node of definition.nodes) {
    if (node.phaseId !== undefined) {
      const resolution = resolvePhaseDependency(node.phaseId, context);
      if (resolution.status === 'blocked') {
        return Object.freeze({ outcome: 'blocked' as const, reason: resolution.reason });
      }
      continue;
    }
    if (node.workflowId !== undefined) {
      if (
        node.workflowId === definition.workflowId ||
        reachesTargetWorkflow(node.workflowId, definition.workflowId, allKnownWorkflows)
      ) {
        continue;
      }
      const resolution = resolveWorkflowDependency(node.workflowId, context);
      if (resolution.status === 'blocked') {
        return Object.freeze({ outcome: 'blocked' as const, reason: resolution.reason });
      }
    }
  }

  const errors = validateWorkflowGraph(definition, [], new Map(), {
    effectivePhases: prospectivePhaseCatalog(context),
    ...(context.invalidPhases !== undefined ? { invalidPhases: context.invalidPhases } : {}),
    effectiveWorkflows: [...allKnownWorkflows.values()],
    ...(context.invalidWorkflows !== undefined
      ? { invalidWorkflows: context.invalidWorkflows }
      : {})
  });
  if (errors.length === 0) return Object.freeze({ outcome: 'resolved' as const });

  return Object.freeze({
    outcome: 'invalid' as const,
    defects: Object.freeze(errors.map(asDefect))
  });
}
