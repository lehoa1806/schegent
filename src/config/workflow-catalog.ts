import type {
  PhaseDefinition,
  PhaseSourceRecord
} from '../contracts/process-definitions';
import type {
  PipelineDefinition,
  PipelineSourceRecord
} from '../contracts/pipeline-definitions';
import type {
  WorkflowCatalogResolution,
  WorkflowCatalogWarning,
  WorkflowDefinition,
  WorkflowFieldError,
  WorkflowSourceRecord,
  WorkflowSourceStatus
} from '../contracts/workflow-definitions';
import { PIPELINE_ID_PATTERN } from './pipeline-definition-validator';
import { DRAFT_KEY_PREFIX } from './process-catalog';
import { validateWorkflowGraph } from './workflow-graph-validator';
import {
  WORKFLOW_ID_MAX_LEN,
  validateWorkflowDefinition,
  workflowFieldError
} from './workflow-definition-validator';

/** Advisory ceiling on stored Workflow definitions; exceeding it warns, never blocks (FR-032). */
export const WORKFLOW_CATALOG_SOFT_CAP = 20;
/** Advisory ceiling on one Workflow's node count (FR-032). */
export const WORKFLOW_NODE_SOFT_CAP = 20;

const SYNTHETIC_WORKFLOW_ID_PREFIX = '?invalid-';

export function workflowSourceIdentity(row: unknown, index: number): string {
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    const value = row as Record<string, unknown>;
    const rawId =
      typeof value.workflowId === 'string'
        ? value.workflowId
        : typeof value.id === 'string'
          ? value.id
          : null;
    const workflowId = rawId?.trim();
    if (workflowId) return workflowId;
  }
  return `${SYNTHETIC_WORKFLOW_ID_PREFIX}${index + 1}`;
}

interface MutableSourceRecord {
  readonly key: string;
  readonly workflowId: string;
  status: WorkflowSourceStatus;
  definition: WorkflowDefinition | null;
  readonly display: Readonly<Record<string, unknown>>;
  readonly nodePhaseIds: readonly string[];
  readonly nodeWorkflowIds: readonly string[];
  readonly nodePipelineIds: readonly string[];
  errors: WorkflowFieldError[];
}

function readNodeIdField(
  row: unknown,
  fieldName: 'phaseId' | 'workflowId' | 'pipelineId'
): readonly string[] {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
  const nodes = (row as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) return [];
  const ids = new Set<string>();
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    const raw = (node as Record<string, unknown>)[fieldName];
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (PIPELINE_ID_PATTERN.test(id)) ids.add(id);
  }
  return [...ids];
}

export function readNodePhaseIds(row: unknown): readonly string[] {
  return readNodeIdField(row, 'phaseId');
}

export function readNodeWorkflowIds(row: unknown): readonly string[] {
  return readNodeIdField(row, 'workflowId');
}

export function readNodePipelineIds(row: unknown): readonly string[] {
  return readNodeIdField(row, 'pipelineId');
}

export interface WorkflowPhaseContext {
  readonly effective: readonly PhaseDefinition[];
  readonly records: readonly PhaseSourceRecord[];
}

export interface WorkflowPipelineContext {
  readonly effective: readonly PipelineDefinition[];
  readonly records: readonly PipelineSourceRecord[];
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

export function invalidPhaseCauses(
  phaseCatalog: WorkflowPhaseContext | undefined
): ReadonlyMap<string, string> {
  if (!phaseCatalog) return new Map();
  const resolvable = new Set(phaseCatalog.effective.map((phase) => phase.phaseId));
  const causes = new Map<string, string>();
  for (const record of phaseCatalog.records) {
    if (record.status !== 'invalid' || resolvable.has(record.phaseId)) continue;
    if (causes.has(record.phaseId)) continue;
    causes.set(record.phaseId, record.errors.at(0)?.message ?? 'Phase definition is invalid');
  }
  return causes;
}

export function invalidPipelineCauses(
  pipelineCatalog: WorkflowPipelineContext | undefined
): ReadonlyMap<string, string> {
  if (!pipelineCatalog) return new Map();
  const resolvable = new Set(pipelineCatalog.effective.map((pipeline) => pipeline.pipelineId));
  const causes = new Map<string, string>();
  for (const record of pipelineCatalog.records) {
    if (record.status !== 'invalid' || resolvable.has(record.pipelineId)) continue;
    if (causes.has(record.pipelineId)) continue;
    causes.set(record.pipelineId, record.errors[0]?.message ?? 'Pipeline definition is invalid');
  }
  return causes;
}

const EMPTY_PIPELINE_CATALOG: WorkflowPipelineContext = Object.freeze({
  effective: Object.freeze([]),
  records: Object.freeze([])
});

function parseShapeRows(rows: readonly unknown[]): MutableSourceRecord[] {
  return rows.map((row, index) => {
    const result = validateWorkflowDefinition(row);
    const workflowId = workflowSourceIdentity(row, index);
    return {
      key: `${workflowId}::${index}`,
      workflowId,
      status: result.errors.length === 0 ? 'effective' : 'invalid',
      definition: result.definition,
      display: result.display,
      nodePhaseIds: readNodePhaseIds(row),
      nodeWorkflowIds: readNodeWorkflowIds(row),
      nodePipelineIds: readNodePipelineIds(row),
      errors: [...result.errors]
    };
  });
}

function validateGraphAcrossRecords(
  records: MutableSourceRecord[],
  phaseCatalog: WorkflowPhaseContext | undefined,
  invalidPhases: ReadonlyMap<string, string>,
  pipelineCatalog: WorkflowPipelineContext,
  invalidPipelines: ReadonlyMap<string, string>,
  baseEffectiveWorkflows?: readonly WorkflowDefinition[],
  baseInvalidWorkflows?: ReadonlyMap<string, string>
): void {
  // Multi-pass fixed-point resolution so a parent Workflow referencing an invalid child Workflow
  // also transitions to invalid and names the child's defect (hard rule 38).
  let changed = true;
  let pass = 0;
  while (changed && pass < records.length + 1) {
    changed = false;
    pass += 1;

    const effectiveWorkflows: WorkflowDefinition[] = [
      ...(baseEffectiveWorkflows ?? [])
    ];
    const seenEffective = new Set(effectiveWorkflows.map((w) => w.workflowId));
    for (const rec of records) {
      if (
        rec.status === 'effective' &&
        rec.definition !== null &&
        !seenEffective.has(rec.workflowId)
      ) {
        effectiveWorkflows.push(rec.definition);
        seenEffective.add(rec.workflowId);
      }
    }

    const invalidWorkflows = new Map<string, string>(baseInvalidWorkflows ?? []);
    for (const rec of records) {
      if (rec.status === 'invalid' && !seenEffective.has(rec.workflowId)) {
        if (!invalidWorkflows.has(rec.workflowId)) {
          invalidWorkflows.set(
            rec.workflowId,
            rec.errors.at(0)?.message ?? 'Workflow definition is invalid'
          );
        }
      }
    }

    for (const rec of records) {
      if (rec.status !== 'effective' || rec.definition === null) continue;
      const graphErrors = validateWorkflowGraph(
        rec.definition,
        pipelineCatalog.effective,
        invalidPipelines,
        {
          effectivePhases: phaseCatalog?.effective,
          invalidPhases,
          effectiveWorkflows,
          invalidWorkflows
        }
      );
      if (graphErrors.length > 0) {
        rec.errors.push(...graphErrors);
        rec.status = 'invalid';
        rec.definition = null;
        changed = true;
      }
    }
  }
}

function freezeRecords(
  records: readonly MutableSourceRecord[],
  keyPrefix: string
): WorkflowSourceRecord[] {
  return records.map((record) =>
    Object.freeze({
      key: `${keyPrefix}${record.key}`,
      workflowId: record.workflowId,
      status: record.status,
      definition: record.definition,
      display: record.display,
      nodePhaseIds: Object.freeze([...record.nodePhaseIds]),
      nodeWorkflowIds: Object.freeze([...record.nodeWorkflowIds]),
      nodePipelineIds: Object.freeze([...record.nodePipelineIds]),
      errors: Object.freeze([...record.errors])
    })
  );
}

function duplicateError(workflowId: string): WorkflowFieldError {
  return workflowFieldError(
    workflowId,
    'workflowId',
    'duplicate-in-scope',
    `Workflow id '${bounded(workflowId, WORKFLOW_ID_MAX_LEN)}' appears more than once in the catalog`
  );
}

function invalidateDuplicates(records: MutableSourceRecord[]): void {
  const byId = new Map<string, MutableSourceRecord[]>();
  for (const record of records) {
    if (record.workflowId.startsWith(SYNTHETIC_WORKFLOW_ID_PREFIX)) continue;
    const matches = byId.get(record.workflowId) ?? [];
    matches.push(record);
    byId.set(record.workflowId, matches);
  }
  for (const [workflowId, matches] of byId) {
    if (matches.length < 2) continue;
    for (const match of matches) {
      match.status = 'invalid';
      match.definition = null;
      match.errors.push(duplicateError(workflowId));
    }
  }
}

function softCapWarnings(
  rows: readonly unknown[],
  effective: readonly WorkflowDefinition[]
): WorkflowCatalogWarning[] {
  const warnings: WorkflowCatalogWarning[] = [];
  if (rows.length > WORKFLOW_CATALOG_SOFT_CAP) {
    warnings.push(
      Object.freeze({
        code: 'workflow-soft-cap',
        message: `Catalog holds ${rows.length} Workflow definitions; advisory limit is ${WORKFLOW_CATALOG_SOFT_CAP}`
      })
    );
  }
  for (const workflow of effective) {
    if (workflow.nodes.length <= WORKFLOW_NODE_SOFT_CAP) continue;
    warnings.push(
      Object.freeze({
        code: 'workflow-soft-cap-nodes',
        message: `Workflow '${bounded(workflow.workflowId, WORKFLOW_ID_MAX_LEN)}' has ${workflow.nodes.length} nodes; advisory limit is ${WORKFLOW_NODE_SOFT_CAP}`
      })
    );
  }
  return warnings;
}

export function resolveWorkflowCatalog(input: {
  readonly rows: readonly unknown[] | undefined;
  readonly revision: string;
  readonly phaseCatalog?: WorkflowPhaseContext;
  readonly pipelineCatalog?: WorkflowPipelineContext;
  readonly draftOnlyRows?: readonly unknown[];
}): WorkflowCatalogResolution {
  const pipelineCatalog = input.pipelineCatalog ?? EMPTY_PIPELINE_CATALOG;
  const invalidPhases = invalidPhaseCauses(input.phaseCatalog);
  const invalidPipelines = invalidPipelineCauses(pipelineCatalog);
  const rows = input.rows ?? [];
  const records = parseShapeRows(rows);
  invalidateDuplicates(records);
  validateGraphAcrossRecords(
    records,
    input.phaseCatalog,
    invalidPhases,
    pipelineCatalog,
    invalidPipelines
  );

  const effective: WorkflowDefinition[] = [];
  for (const record of records) {
    if (record.workflowId.startsWith(SYNTHETIC_WORKFLOW_ID_PREFIX)) continue;
    if (record.status !== 'effective' || record.definition === null) continue;
    effective.push(record.definition);
  }

  const invalidActiveWorkflows = new Map<string, string>();
  const effectiveIds = new Set(effective.map((w) => w.workflowId));
  for (const record of records) {
    if (record.status === 'invalid' && !effectiveIds.has(record.workflowId)) {
      if (!invalidActiveWorkflows.has(record.workflowId)) {
        invalidActiveWorkflows.set(
          record.workflowId,
          record.errors.at(0)?.message ?? 'Workflow definition is invalid'
        );
      }
    }
  }

  const frozenRecords = freezeRecords(records, '');

  return Object.freeze({
    records: Object.freeze(frozenRecords),
    effective: Object.freeze(effective),
    revision: input.revision,
    warnings: Object.freeze(softCapWarnings(rows, effective)),
    draftOnlyRecords: resolveDraftOnlyRecords(
      input.draftOnlyRows,
      input.phaseCatalog,
      invalidPhases,
      pipelineCatalog,
      invalidPipelines,
      effective,
      invalidActiveWorkflows
    )
  });
}

function resolveDraftOnlyRecords(
  rows: readonly unknown[] | undefined,
  phaseCatalog: WorkflowPhaseContext | undefined,
  invalidPhases: ReadonlyMap<string, string>,
  pipelineCatalog: WorkflowPipelineContext,
  invalidPipelines: ReadonlyMap<string, string>,
  effectiveWorkflows: readonly WorkflowDefinition[],
  invalidActiveWorkflows: ReadonlyMap<string, string>
): readonly WorkflowSourceRecord[] {
  if (rows === undefined || rows.length === 0) return Object.freeze([]);
  const records = parseShapeRows(rows);
  invalidateDuplicates(records);
  // Drafts resolve against ACTIVE effective Phases and ACTIVE effective Workflows only, never drafts.
  for (const rec of records) {
    if (rec.status !== 'effective' || rec.definition === null) continue;
    const graphErrors = validateWorkflowGraph(
      rec.definition,
      pipelineCatalog.effective,
      invalidPipelines,
      {
        effectivePhases: phaseCatalog?.effective,
        invalidPhases,
        effectiveWorkflows,
        invalidWorkflows: invalidActiveWorkflows
      }
    );
    if (graphErrors.length > 0) {
      rec.errors.push(...graphErrors);
      rec.status = 'invalid';
      rec.definition = null;
    }
  }
  return Object.freeze(freezeRecords(records, DRAFT_KEY_PREFIX));
}
