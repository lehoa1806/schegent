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

/**
 * The stable per-row identity. A row that cannot supply one keeps its slot under a synthetic id so
 * it stays visible for repair without ever resolving (FR-002, FR-031). `id` is the authored key
 * (§9); `workflowId` is accepted and normalized.
 */
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
  readonly nodePipelineIds: readonly string[];
  errors: WorkflowFieldError[];
}

/**
 * The Pipelines a stored row names, read from the raw row rather than from the
 * parsed definition so an `invalid` record keeps its references (FR-041,
 * FR-031). Deliberately independent of every other defect the row may carry: a
 * node that spells a well-formed identifier contributes one, and nothing else
 * about the row can take it away.
 *
 * Trimming and the pattern test match `readIdentifier` in the definition
 * validator, so a row that resolves cleanly yields exactly its definition's node
 * Pipelines and the two readings can never disagree.
 */
function readNodePipelineIds(row: unknown): readonly string[] {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
  const nodes = (row as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) return [];
  const pipelineIds = new Set<string>();
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    const raw = (node as Record<string, unknown>).pipelineId;
    if (typeof raw !== 'string') continue;
    const pipelineId = raw.trim();
    if (PIPELINE_ID_PATTERN.test(pipelineId)) pipelineIds.add(pipelineId);
  }
  return [...pipelineIds];
}

/**
 * The resolved Pipeline catalog this resolution is read against. `PipelineCatalogResolution` is
 * structurally assignable, so the caller passes it whole rather than unpacking it: the effective
 * list decides `unknown-pipeline`, and the records decide `pipeline-invalid`'s transitive cause
 * (FR-016, FR-017).
 */
export interface WorkflowPipelineContext {
  readonly effective: readonly PipelineDefinition[];
  readonly records: readonly PipelineSourceRecord[];
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/**
 * Pipelines that exist in the catalog but do not resolve, mapped to the first defect message so
 * `pipeline-invalid` can name the transitive cause. An id that also resolves somewhere is
 * omitted: a broken shadowed copy is not drift for a Workflow that reads the effective one.
 *
 * Exported so `cmd-save-workflows.ts` builds this map the same way resolution does — a row the
 * save accepts must be a row the next reload resolves.
 */
export function invalidPipelineCauses(
  pipelineCatalog: WorkflowPipelineContext
): ReadonlyMap<string, string> {
  const resolvable = new Set(pipelineCatalog.effective.map((pipeline) => pipeline.pipelineId));
  const causes = new Map<string, string>();
  for (const record of pipelineCatalog.records) {
    if (record.status !== 'invalid' || resolvable.has(record.pipelineId)) continue;
    if (causes.has(record.pipelineId)) continue;
    causes.set(record.pipelineId, record.errors[0]?.message ?? 'Pipeline definition is invalid');
  }
  return causes;
}

/**
 * Parse the stored rows into source records.
 *
 * Feature 099 (T489, FR-042) — formerly `parseLayer`, called three times. See
 * `parseRows` in `process-catalog.ts` for why `key` drops its scope segment and
 * why a clean row now starts `effective` rather than `shadowed`.
 */
function parseRows(
  rows: readonly unknown[],
  pipelineCatalog: WorkflowPipelineContext,
  invalidPipelines: ReadonlyMap<string, string>
): MutableSourceRecord[] {
  return rows.map((row, index) => {
    const result = validateWorkflowDefinition(row);
    const workflowId = workflowSourceIdentity(row, index);
    const errors = [...result.errors];
    let definition = result.definition;
    if (definition !== null) {
      errors.push(...validateWorkflowGraph(definition, pipelineCatalog.effective, invalidPipelines));
      if (errors.length > 0) definition = null;
    }
    return {
      key: `${workflowId}::${index}`,
      workflowId,
      status: errors.length === 0 ? 'effective' : 'invalid',
      definition,
      display: result.display,
      nodePipelineIds: readNodePipelineIds(row),
      errors
    };
  });
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

/**
 * Both thresholds are code-fixed and advisory (FR-032): they are never read from a setting or from
 * an authored row, and a breach never refuses a save. The catalog cap counts stored rows because it
 * is about how much the operator is carrying; the node cap counts effective definitions because an
 * invalid row's size is not what the operator is working in.
 *
 * Feature 099 (T489, FR-042) — the cap was per scope and reported the scope's name. There is one
 * layer, so the code loses its `-scope` suffix along with the enumeration.
 */
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

/**
 * Resolves the one Workflow layer in the fixed order of data-model.md §10: parse, reject duplicate
 * ids, then graph-validate against the **effective** Pipeline catalog. Graph validation runs during
 * parsing rather than after selection so an unresolved row carries its own defects for repair
 * instead of appearing clean.
 *
 * Feature 099 (T489, FR-042) — `rows` is the stored catalog and `revision` is the store's manifest
 * revision (FR-044a). The precedence walk over `['workspace', 'user', 'built-in']` is gone: a clean
 * row is effective by existing.
 */
export function resolveWorkflowCatalog(input: {
  readonly rows: readonly unknown[] | undefined;
  readonly revision: string;
  readonly pipelineCatalog: WorkflowPipelineContext;
}): WorkflowCatalogResolution {
  const invalidPipelines = invalidPipelineCauses(input.pipelineCatalog);
  const rows = input.rows ?? [];
  const records = parseRows(rows, input.pipelineCatalog, invalidPipelines);
  invalidateDuplicates(records);

  const effective: WorkflowDefinition[] = [];
  for (const record of records) {
    if (record.workflowId.startsWith(SYNTHETIC_WORKFLOW_ID_PREFIX)) continue;
    if (record.status !== 'effective' || record.definition === null) continue;
    effective.push(record.definition);
  }

  const frozenRecords: WorkflowSourceRecord[] = records.map((record) =>
    Object.freeze({
      key: record.key,
      workflowId: record.workflowId,
      status: record.status,
      definition: record.definition,
      display: record.display,
      nodePipelineIds: Object.freeze([...record.nodePipelineIds]),
      errors: Object.freeze([...record.errors])
    })
  );

  return Object.freeze({
    records: Object.freeze(frozenRecords),
    effective: Object.freeze(effective),
    revision: input.revision,
    warnings: Object.freeze(softCapWarnings(rows, effective))
  });
}
