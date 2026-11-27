// Feature 084 / Feature 086 / Feature 263 (FR-R5-F04) — the import planner.
//
// Pure, total, and free of I/O: parse and validate happen before it, the write
// happens after it.
//
// THE PRESENCE ORACLE: Presence is computed from the STORED DEFINITIONS AT EVERY
// STATE (`storedRows` + `storedIds`, including drafts), never from the resolved
// effective catalog.
//
// THE RESOLUTION ORACLE: `package-resolver.ts` resolves Phase and child Workflow
// references against the effective catalogs unioned with this plan's candidate
// `import` rows. Candidate Workflows in a package (`included.workflows` and the
// root Workflow) are evaluated in bottom-up topological dependency order after
// `included.phases`, while `plan.rows` is emitted in declared document order
// (`[root, ...included.workflows, ...included.phases]`).

import { readNodeWorkflowIds } from '../../config/workflow-catalog';
import { orderWorkflowItemsTopologically } from '../../config/workflow-closure-resolver';
import type { PhaseDefinition, PhaseSourceRecord } from '../../contracts/process-definitions';
import type { WorkflowDefinition, WorkflowSourceRecord } from '../../contracts/workflow-definitions';
import { resolveWorkflowDependencies } from './package-resolver';
import { phaseDefinitionFromDocument } from './phase-yaml-mapper';
import type { PhaseYamlValidationResult } from './phase-yaml-validator';
import type {
  DocumentRefusal,
  ImportDefect,
  ImportPlan,
  ImportPlanCounts,
  ImportPlanRow,
  PhaseYamlDocument,
  ProcessYamlCatalogRevision,
  ProcessYamlPresenceStatus,
  ProcessYamlResourceKind
} from './types';
import type { WorkflowPackageResource, WorkflowPackageResult } from './workflow-document';

export interface PhaseIdPresence {
  readonly status: ProcessYamlPresenceStatus;
}

export interface WorkflowIdPresence {
  readonly status: ProcessYamlPresenceStatus;
}

export type ProcessImportPlanResult =
  | { readonly outcome: 'refused'; readonly refusal: DocumentRefusal }
  | { readonly outcome: 'planned'; readonly plan: ImportPlan };

/** Every id one kind's manifest holds an entry for, at any state (FR-043). */
export type StoredDefinitionIds = ReadonlySet<string>;

export interface WorkflowPackageImportContext {
  /** STORED Phase rows at every status — presence, never resolution. */
  readonly phaseRows: readonly PhaseSourceRecord[];
  readonly phaseIds: StoredDefinitionIds;
  /** The RESOLVED Phase catalog — resolution oracle. */
  readonly effectivePhases: readonly PhaseDefinition[];
  /** The Phase kind's store revision. */
  readonly revision: ProcessYamlCatalogRevision;
  /** STORED Workflow rows at every status — presence, never resolution. */
  readonly workflowRows: readonly WorkflowSourceRecord[];
  readonly workflowIds: StoredDefinitionIds;
  /** The RESOLVED Workflow catalog — resolution oracle. */
  readonly effectiveWorkflows: readonly WorkflowDefinition[];
  /** The Workflow kind's store revision. */
  readonly workflowRevision: ProcessYamlCatalogRevision;
  readonly invalidPhases?: ReadonlyMap<string, string>;
  readonly invalidWorkflows?: ReadonlyMap<string, string>;
}

export function findPhaseIdPresence(
  storedRows: readonly PhaseSourceRecord[],
  phaseId: string,
  storedIds: StoredDefinitionIds
): PhaseIdPresence | null {
  const claimant = storedRows.find((row) => row.phaseId === phaseId);
  if (claimant !== undefined) return Object.freeze({ status: claimant.status });
  return storedIds.has(phaseId) ? Object.freeze({ status: 'draft' as const }) : null;
}

export function findWorkflowIdPresence(
  storedRows: readonly WorkflowSourceRecord[],
  workflowId: string,
  storedIds: StoredDefinitionIds
): WorkflowIdPresence | null {
  const claimant = storedRows.find((row) => row.workflowId === workflowId);
  if (claimant !== undefined) return Object.freeze({ status: claimant.status });
  return storedIds.has(workflowId) ? Object.freeze({ status: 'draft' as const }) : null;
}

function countRows(rows: readonly ImportPlanRow[]): ImportPlanCounts {
  let importCount = 0;
  let skipCount = 0;
  let blockedCount = 0;
  let invalidCount = 0;
  for (const row of rows) {
    if (row.outcome === 'import') importCount += 1;
    else if (row.outcome === 'skip') skipCount += 1;
    else if (row.outcome === 'blocked') blockedCount += 1;
    else invalidCount += 1;
  }
  return Object.freeze({
    import: importCount,
    skip: skipCount,
    blocked: blockedCount,
    invalid: invalidCount
  });
}

interface OptionalKindRevisions {
  readonly workflowRevision?: ProcessYamlCatalogRevision;
}

function planned(
  rows: readonly ImportPlanRow[],
  revision: ProcessYamlCatalogRevision,
  optional: OptionalKindRevisions = {}
): ProcessImportPlanResult {
  return {
    outcome: 'planned',
    plan: Object.freeze({
      rows: Object.freeze(rows),
      counts: countRows(rows),
      computedAgainstRevision: revision,
      ...(optional.workflowRevision !== undefined
        ? { computedAgainstWorkflowRevision: optional.workflowRevision }
        : {})
    })
  };
}

function invalidRow(
  resourceKind: ProcessYamlResourceKind,
  resourceId: string | null,
  defects: readonly ImportDefect[]
): ImportPlanRow {
  return Object.freeze({
    outcome: 'invalid' as const,
    resourceKind,
    resourceId,
    defects,
    totalDefects: defects.length
  });
}

function phaseSkipOrImportRow(
  document: PhaseYamlDocument,
  storedRows: readonly PhaseSourceRecord[],
  storedIds: StoredDefinitionIds
): ImportPlanRow {
  const { metadata, spec } = document;
  const presence = findPhaseIdPresence(storedRows, metadata.phaseId, storedIds);
  if (presence !== null) {
    return Object.freeze({
      outcome: 'skip' as const,
      resourceKind: 'phase' as const,
      resourceId: metadata.phaseId,
      name: metadata.name,
      presentRowStatus: presence.status
    });
  }

  return Object.freeze({
    outcome: 'import' as const,
    resourceKind: 'phase' as const,
    resourceId: metadata.phaseId,
    name: metadata.name,
    requiresRetryConditionCapability: spec.retryCondition !== undefined,
    definition: phaseDefinitionFromDocument(document)
  });
}

export function planPhaseImport(
  validation: PhaseYamlValidationResult,
  storedRows: readonly PhaseSourceRecord[],
  revision: ProcessYamlCatalogRevision,
  storedIds: StoredDefinitionIds
): ProcessImportPlanResult {
  if (!validation.ok && validation.kind === 'document') {
    return { outcome: 'refused', refusal: validation.refusal };
  }

  if (!validation.ok) {
    return planned([invalidRow('phase', validation.resourceId, validation.defects)], revision);
  }

  return planned([phaseSkipOrImportRow(validation.document, storedRows, storedIds)], revision);
}

function workflowRow(
  definition: WorkflowDefinition,
  context: WorkflowPackageImportContext,
  plannedPhaseRows: readonly ImportPlanRow[],
  plannedWorkflowRows: readonly ImportPlanRow[],
  candidateWorkflows: readonly WorkflowDefinition[]
): ImportPlanRow {
  const presence = findWorkflowIdPresence(
    context.workflowRows,
    definition.workflowId,
    context.workflowIds
  );
  if (presence !== null) {
    return Object.freeze({
      outcome: 'skip' as const,
      resourceKind: 'workflow' as const,
      resourceId: definition.workflowId,
      name: definition.name,
      presentRowStatus: presence.status
    });
  }

  const resolution = resolveWorkflowDependencies(definition, {
    effectivePhases: context.effectivePhases,
    storedPhases: context.phaseRows,
    plannedPhaseRows,
    effectiveWorkflows: context.effectiveWorkflows,
    storedWorkflows: context.workflowRows,
    plannedWorkflowRows,
    candidateWorkflows,
    ...(context.invalidPhases !== undefined ? { invalidPhases: context.invalidPhases } : {}),
    ...(context.invalidWorkflows !== undefined
      ? { invalidWorkflows: context.invalidWorkflows }
      : {})
  });

  if (resolution.outcome === 'blocked') {
    return Object.freeze({
      outcome: 'blocked' as const,
      resourceKind: 'workflow' as const,
      resourceId: definition.workflowId,
      name: definition.name,
      reason: resolution.reason
    });
  }

  if (resolution.outcome === 'invalid') {
    return invalidRow('workflow', definition.workflowId, resolution.defects);
  }

  return Object.freeze({
    outcome: 'import' as const,
    resourceKind: 'workflow' as const,
    resourceId: definition.workflowId,
    name: definition.name,
    definition
  });
}

function workflowPackagePhaseRows(
  resources: readonly WorkflowPackageResource[],
  storedRows: readonly PhaseSourceRecord[],
  storedIds: StoredDefinitionIds
): readonly ImportPlanRow[] {
  const rows: ImportPlanRow[] = [];
  for (const resource of resources) {
    if (!resource.ok || resource.resourceKind !== 'phase') continue;
    rows.push(phaseSkipOrImportRow(resource.document, storedRows, storedIds));
  }
  return rows;
}

function declaresKind(
  resources: readonly WorkflowPackageResource[],
  kind: ProcessYamlResourceKind
): boolean {
  return resources.some((resource) => resource.resourceKind === kind);
}

/**
 * Turn one read Workflow package into the plan an operator confirms or abandons.
 *
 * Candidate Workflows (`included.workflows` and the root Workflow) are evaluated in
 * bottom-up topological dependency order after `included.phases`, and `plan.rows` is
 * emitted in declared document order (`[root, ...included.workflows, ...included.phases]`).
 */
export function planWorkflowImport(
  result: WorkflowPackageResult,
  context: WorkflowPackageImportContext
): ProcessImportPlanResult {
  if (!result.ok) {
    return { outcome: 'refused', refusal: result.refusal };
  }

  const plannedPhaseRows = workflowPackagePhaseRows(
    result.resources,
    context.phaseRows,
    context.phaseIds
  );

  const validWorkflowDefs: WorkflowDefinition[] = [];
  for (const resource of result.resources) {
    if (resource.ok && resource.resourceKind === 'workflow') {
      validWorkflowDefs.push(resource.definition);
    }
  }

  const orderedWorkflowDefs = orderWorkflowItemsTopologically(
    validWorkflowDefs,
    (wf) => wf.workflowId,
    (wf) => readNodeWorkflowIds(wf)
  );

  const plannedWorkflowRows: ImportPlanRow[] = [];
  const workflowRowsById = new Map<string, ImportPlanRow>();
  for (const def of orderedWorkflowDefs) {
    const row = workflowRow(
      def,
      context,
      plannedPhaseRows,
      plannedWorkflowRows,
      validWorkflowDefs
    );
    plannedWorkflowRows.push(row);
    workflowRowsById.set(def.workflowId, row);
  }

  const rows = result.resources.map((resource): ImportPlanRow => {
    if (!resource.ok) {
      return invalidRow(resource.resourceKind, resource.resourceId, resource.defects);
    }
    if (resource.resourceKind === 'workflow') {
      return workflowRowsById.get(resource.definition.workflowId)!;
    }
    return phaseSkipOrImportRow(resource.document, context.phaseRows, context.phaseIds);
  });

  return planned(rows, context.revision, {
    ...(declaresKind(result.resources, 'workflow')
      ? { workflowRevision: context.workflowRevision }
      : {})
  });
}
