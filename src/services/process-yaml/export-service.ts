// Feature 089 T003 / Feature 263 (FR-R5-F04) — the export core.
//
// Selection, dependency resolution, closure, and serialization live here.
// This service returns a document; it never writes one.

import { groupsFromModelsConfig } from '../../config/model-catalog';
import { coerceModels } from '../../config/pipeline-config-loader';
import { resolvePhaseCatalog } from '../../config/process-catalog';
import {
  MAX_WORKFLOW_CLOSURE_DEFINITIONS,
  MAX_WORKFLOW_EXPANDED_NODES,
  MAX_WORKFLOW_NESTING_DEPTH,
  resolveWorkflowClosure
} from '../../config/workflow-closure-resolver';
import { serializeModelCatalogDocument } from './model-catalog-yaml-mapper';
import { documentFromPhaseDefinition } from './phase-yaml-mapper';
import { documentFromWorkflowDefinition, serializeWorkflowDocument } from './workflow-document';
import {
  referencedChildWorkflowOrder,
  referencedPhaseClosure,
  referencedPhaseOrder
} from './workflow-export-closure';
import { selectWorkflowForExport } from './workflow-export-selection';
import { serializePhaseDocument } from './yaml-serializer';
import type { ProcessExchangePayload } from '../../contracts/audit-events';
import type { PhaseDefinition } from '../../contracts/process-definitions';
import {
  RESOURCE_ID_MAX_LEN,
  type ExportProcessYamlRequest,
  type ExportProcessYamlResult,
  type ExportProcessYamlUnavailable
} from '../../contracts/sidebar-ipc/process-yaml';
import type { WorkflowDefinition } from '../../contracts/workflow-definitions';
import type { ExchangeDeps } from './service-ports';
import {
  MODEL_CATALOG_YAML_KIND,
  PHASE_YAML_API_VERSION,
  type ProcessYamlResourceKind
} from './types';
import type { WorkflowInclusion } from './workflow-document';

/**
 * Feature 096 — the audit `resourceId` for a Model Catalog export.
 */
export const MODEL_CATALOG_EXPORT_RESOURCE_ID = 'model-catalog';

export interface ResolvedExport {
  readonly outcome: 'resolved';
  readonly suggestedFileName: string;
  readonly text: string;
  /**
   * How many complete Phase definitions the document carries (FR-059). Absent
   * for a Phase export, which has no inclusion choice to make.
   */
  readonly includedPhaseCount?: number;
}

export type ExportSelection = ResolvedExport | ExportProcessYamlUnavailable;

type IncludedPhaseResolution =
  | { readonly outcome: 'resolved'; readonly phases: readonly PhaseDefinition[] }
  | ExportProcessYamlUnavailable;

type IncludedWorkflowResolution =
  | { readonly outcome: 'resolved'; readonly workflows: readonly WorkflowDefinition[] }
  | ExportProcessYamlUnavailable;

/** What an export records, once its outcome is known. */
export interface ExportAuditEntry {
  readonly resourceKind: ProcessYamlResourceKind;
  readonly resourceId: string;
  readonly outcome: ExportProcessYamlResult['outcome'];
  readonly includedPhaseCount?: number;
  readonly correlationId?: string;
}

export async function appendExportAudit(
  deps: ExchangeDeps,
  args: ExportAuditEntry
): Promise<void> {
  if (!deps.audit) return;
  const saved = args.outcome === 'saved';
  const payload: ProcessExchangePayload = {
    operation: 'export',
    resourceKind: args.resourceKind,
    resourceIds: [args.resourceId],
    outcomes: [args.outcome],
    counts: {
      exported: saved ? 1 : 0,
      ...(args.includedPhaseCount !== undefined
        ? { includedPhases: saved ? args.includedPhaseCount : 0 }
        : {})
    }
  };
  try {
    await deps.audit.append({
      runId: `process-exchange:${args.resourceId}`,
      phase: 'process-exchange',
      iteration: 0,
      eventType: 'process-exchange-export',
      payload: { ...payload },
      outcome: args.outcome === 'failed' ? 'failure' : 'info',
      ...(args.correlationId !== undefined ? { correlationId: args.correlationId } : {})
    });
  } catch (err) {
    deps.logger.warn(
      `sidebar router: process-yaml export audit append failed: ${deps.logger.sanitize(
        (err as Error).message ?? 'unknown error'
      )}`
    );
  }
}

function effectivePhases(deps: ExchangeDeps): ReturnType<typeof resolvePhaseCatalog> {
  const stored = deps.readPhaseConfig?.() ?? { rows: [], revision: '' };
  return resolvePhaseCatalog({ rows: stored.rows, revision: stored.revision });
}

function selectPhase(deps: ExchangeDeps, resourceId: string): ExportSelection {
  const catalog = effectivePhases(deps);
  const record = catalog.records.find(
    (row) => row.phaseId === resourceId && row.status === 'effective'
  );
  if (!record?.definition) {
    return {
      outcome: 'unavailable',
      reason: catalog.records.some((row) => row.phaseId === resourceId)
        ? 'does-not-resolve'
        : 'not-found'
    };
  }
  return {
    outcome: 'resolved',
    suggestedFileName: `${record.phaseId}.phase.yaml`,
    text: serializePhaseDocument(documentFromPhaseDefinition(record.definition))
  };
}

function resolveIncludedPhases(
  deps: ExchangeDeps,
  phaseCatalog: ReturnType<typeof effectivePhases>,
  phaseIds: readonly string[]
): IncludedPhaseResolution {
  const byId = new Map(phaseCatalog.effective.map((phase) => [phase.phaseId, phase]));
  const phases: PhaseDefinition[] = [];
  for (const phaseId of referencedPhaseOrder(phaseIds)) {
    const definition = byId.get(phaseId);
    if (definition === undefined) {
      return {
        outcome: 'unavailable',
        reason: 'dependency-does-not-resolve',
        unresolvedDependency: {
          kind: 'phase',
          resourceId: deps.logger.sanitize(phaseId).slice(0, RESOURCE_ID_MAX_LEN.phase)
        }
      };
    }
    phases.push(definition);
  }
  return { outcome: 'resolved', phases };
}

function resolveIncludedWorkflows(
  deps: ExchangeDeps,
  root: WorkflowDefinition,
  phaseCatalog: ReturnType<typeof effectivePhases>
): IncludedWorkflowResolution {
  const stored = deps.readWorkflowConfig?.() ?? { rows: [], revision: '' };
  const workflows: WorkflowDefinition[] = [];
  const seen = new Set<string>([root.workflowId]);
  let expandedNodes = root.nodes.length;

  const walk = (
    current: WorkflowDefinition,
    chain: readonly string[],
    depth: number
  ): ExportProcessYamlUnavailable | null => {
    for (const childId of referencedChildWorkflowOrder(current.nodes)) {
      if (chain.includes(childId) || depth + 1 > MAX_WORKFLOW_NESTING_DEPTH) {
        return {
          outcome: 'unavailable',
          reason: 'dependency-does-not-resolve',
          unresolvedDependency: {
            kind: 'workflow',
            resourceId: deps.logger.sanitize(childId).slice(0, RESOURCE_ID_MAX_LEN.workflow)
          }
        };
      }
      if (!seen.has(childId) && workflows.length + 1 > MAX_WORKFLOW_CLOSURE_DEFINITIONS) {
        return {
          outcome: 'unavailable',
          reason: 'dependency-does-not-resolve',
          unresolvedDependency: {
            kind: 'workflow',
            resourceId: deps.logger.sanitize(childId).slice(0, RESOURCE_ID_MAX_LEN.workflow)
          }
        };
      }
      const existing = workflows.find((w) => w.workflowId === childId);
      let childDef: WorkflowDefinition;
      if (existing !== undefined) {
        childDef = existing;
      } else {
        const selection = selectWorkflowForExport({
          rows: stored.rows,
          phaseCatalog,
          workflowId: childId
        });
        if (selection.outcome === 'unavailable') {
          return {
            outcome: 'unavailable',
            reason: 'dependency-does-not-resolve',
            unresolvedDependency: {
              kind: 'workflow',
              resourceId: deps.logger.sanitize(childId).slice(0, RESOURCE_ID_MAX_LEN.workflow)
            }
          };
        }
        seen.add(childId);
        workflows.push(selection.definition);
        childDef = selection.definition;
      }
      expandedNodes += childDef.nodes.length;
      if (expandedNodes > MAX_WORKFLOW_EXPANDED_NODES) {
        return {
          outcome: 'unavailable',
          reason: 'dependency-does-not-resolve',
          unresolvedDependency: {
            kind: 'workflow',
            resourceId: deps.logger.sanitize(childId).slice(0, RESOURCE_ID_MAX_LEN.workflow)
          }
        };
      }
      const nestedFailure = walk(childDef, [...chain, childId], depth + 1);
      if (nestedFailure !== null) return nestedFailure;
    }
    return null;
  };

  const failure = walk(root, [root.workflowId], 0);
  if (failure !== null) return failure;
  return { outcome: 'resolved', workflows };
}

function selectWorkflow(
  deps: ExchangeDeps,
  request: Extract<ExportProcessYamlRequest, { resourceKind: 'workflow' }>
): ExportSelection {
  const phaseCatalog = effectivePhases(deps);
  const stored = deps.readWorkflowConfig?.() ?? { rows: [], revision: '' };
  const selection = selectWorkflowForExport({
    rows: stored.rows,
    phaseCatalog,
    workflowId: request.resourceId
  });
  if (selection.outcome === 'unavailable') return selection;

  let inclusion: WorkflowInclusion | undefined;
  if (request.inclusion === 'include-closure') {
    const resolvedWorkflows = resolveIncludedWorkflows(deps, selection.definition, phaseCatalog);
    if (resolvedWorkflows.outcome === 'unavailable') return resolvedWorkflows;

    const orderedWorkflows = [selection.definition, ...resolvedWorkflows.workflows];
    const resolvedPhases = resolveIncludedPhases(
      deps,
      phaseCatalog,
      referencedPhaseClosure(orderedWorkflows)
    );
    if (resolvedPhases.outcome === 'unavailable') return resolvedPhases;

    const closureCheck = resolveWorkflowClosure(selection.definition, {
      effectivePhases: resolvedPhases.phases,
      effectiveWorkflows: orderedWorkflows
    });
    if (!closureCheck.ok) {
      const offendingWorkflowId =
        resolvedWorkflows.workflows.at(-1)?.workflowId ?? selection.definition.workflowId;
      return {
        outcome: 'unavailable',
        reason: 'dependency-does-not-resolve',
        unresolvedDependency: {
          kind: 'workflow',
          resourceId: deps.logger
            .sanitize(offendingWorkflowId)
            .slice(0, RESOURCE_ID_MAX_LEN.workflow)
        }
      };
    }

    inclusion = {
      workflows: resolvedWorkflows.workflows,
      phases: resolvedPhases.phases
    };
  }

  return {
    outcome: 'resolved',
    includedPhaseCount: inclusion?.phases?.length ?? 0,
    suggestedFileName: `${selection.definition.workflowId}.workflow.yaml`,
    text: serializeWorkflowDocument(
      documentFromWorkflowDefinition(selection.definition, inclusion)
    )
  };
}

function selectModelCatalog(deps: ExchangeDeps): ExportSelection {
  const modelsConfig = coerceModels(deps.readModelsConfig?.());
  return {
    outcome: 'resolved',
    suggestedFileName: 'model-catalog.yaml',
    text: serializeModelCatalogDocument({
      apiVersion: PHASE_YAML_API_VERSION,
      kind: MODEL_CATALOG_YAML_KIND,
      groups: groupsFromModelsConfig(modelsConfig)
    })
  };
}

export function selectProcessExportDocument(
  deps: ExchangeDeps,
  request: ExportProcessYamlRequest
): ExportSelection {
  if (request.resourceKind === 'modelCatalog') return selectModelCatalog(deps);
  if (request.resourceKind === 'workflow') return selectWorkflow(deps, request);
  return selectPhase(deps, request.resourceId);
}
