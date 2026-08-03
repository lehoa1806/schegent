import { createHash } from 'node:crypto';
import type {
  PipelineDefinition,
  PipelineSourceRecord
} from '../contracts/pipeline-definitions';
import type {
  WorkflowCatalogResolution,
  WorkflowCatalogWarning,
  WorkflowDefinition,
  WorkflowDefinitionScope,
  WorkflowFieldError,
  WorkflowSourceRecord,
  WorkflowSourceStatus,
  WritableWorkflowDefinitionScope
} from '../contracts/workflow-definitions';
import { PIPELINE_ID_PATTERN } from './pipeline-definition-validator';
import { validateWorkflowGraph } from './workflow-graph-validator';
import {
  WORKFLOW_ID_MAX_LEN,
  validateWorkflowDefinition,
  workflowFieldError
} from './workflow-definition-validator';

/** Advisory ceiling on Workflow definitions in one scope; exceeding it warns, never blocks (FR-032). */
export const WORKFLOW_CATALOG_SOFT_CAP = 20;
/** Advisory ceiling on one Workflow's node count (FR-032). */
export const WORKFLOW_NODE_SOFT_CAP = 20;

const SYNTHETIC_WORKFLOW_ID_PREFIX = '?invalid-';

/**
 * The stable per-row identity used to group source rows across layers. A row that cannot supply
 * one keeps its slot under a synthetic id so it stays visible for repair without ever resolving
 * (FR-002, FR-031). `id` is the authored key (§9); `workflowId` is accepted and normalized.
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
  readonly scope: WorkflowDefinitionScope;
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

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`)
    .join(',')}}`;
}

/** SHA-256 fingerprint of one writable layer, echoed as `expectedRevision` on save (FR-029). */
export function workflowLayerRevision(raw: readonly unknown[] | undefined): string {
  return createHash('sha256')
    .update(stableJsonStringify(raw ?? []), 'utf8')
    .digest('hex');
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

function parseLayer(
  scope: WorkflowDefinitionScope,
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
      key: `${scope}::${workflowId}::${index}`,
      workflowId,
      scope,
      status: errors.length === 0 ? 'shadowed' : 'invalid',
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
    `Workflow id '${bounded(workflowId, WORKFLOW_ID_MAX_LEN)}' appears more than once in this scope`
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
 * an authored row, and a breach never refuses a save. The scope cap counts stored rows because it
 * is about layer size; the node cap counts effective definitions because a shadowed row's size is
 * not what the operator is working in.
 */
function softCapWarnings(
  layers: readonly (readonly [WorkflowDefinitionScope, readonly unknown[]])[],
  effective: readonly WorkflowDefinition[]
): WorkflowCatalogWarning[] {
  const warnings: WorkflowCatalogWarning[] = [];
  for (const [scope, rows] of layers) {
    if (rows.length <= WORKFLOW_CATALOG_SOFT_CAP) continue;
    warnings.push(
      Object.freeze({
        code: 'workflow-soft-cap-scope',
        message: `Scope '${scope}' holds ${rows.length} Workflow definitions; advisory limit is ${WORKFLOW_CATALOG_SOFT_CAP}`
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
 * Resolves the three Workflow layers in the fixed order of data-model.md §10: parse, reject
 * in-scope duplicates, select precedence, then graph-validate against the **effective** Pipeline
 * catalog. Graph validation runs during parsing rather than after selection so a shadowed row
 * carries its own defects for repair instead of appearing clean until it is promoted.
 */
export function resolveWorkflowCatalog(input: {
  readonly builtIn: readonly unknown[];
  readonly user: readonly unknown[] | undefined;
  readonly workspace: readonly unknown[] | undefined;
  readonly pipelineCatalog: WorkflowPipelineContext;
}): WorkflowCatalogResolution {
  const invalidPipelines = invalidPipelineCauses(input.pipelineCatalog);
  const layer = (scope: WorkflowDefinitionScope, rows: readonly unknown[]) =>
    parseLayer(scope, rows, input.pipelineCatalog, invalidPipelines);

  const builtInRows = input.builtIn;
  const userRows = input.user ?? [];
  const workspaceRows = input.workspace ?? [];
  const builtInRecords = layer('built-in', builtInRows);
  const userRecords = layer('user', userRows);
  const workspaceRecords = layer('workspace', workspaceRows);
  invalidateDuplicates(userRecords);
  invalidateDuplicates(workspaceRecords);

  const records = [...builtInRecords, ...userRecords, ...workspaceRecords];
  const workflowIds = new Set(records.map((record) => record.workflowId));
  const effective: WorkflowDefinition[] = [];
  const scopeOrder: readonly WorkflowDefinitionScope[] = ['workspace', 'user', 'built-in'];

  for (const workflowId of workflowIds) {
    if (workflowId.startsWith(SYNTHETIC_WORKFLOW_ID_PREFIX)) continue;
    let selected: MutableSourceRecord | undefined;
    for (const scope of scopeOrder) {
      selected = records.find(
        (record) =>
          record.workflowId === workflowId &&
          record.scope === scope &&
          record.status !== 'invalid' &&
          record.definition !== null
      );
      if (selected) break;
    }
    if (!selected?.definition) continue;
    selected.status = 'effective';
    effective.push(selected.definition);
  }

  const frozenRecords: WorkflowSourceRecord[] = records.map((record) =>
    Object.freeze({
      key: record.key,
      workflowId: record.workflowId,
      scope: record.scope,
      status: record.status,
      definition: record.definition,
      display: record.display,
      nodePipelineIds: Object.freeze([...record.nodePipelineIds]),
      errors: Object.freeze([...record.errors])
    })
  );

  const revisions: Record<WritableWorkflowDefinitionScope, string> = {
    user: workflowLayerRevision(input.user),
    workspace: workflowLayerRevision(input.workspace)
  };
  return Object.freeze({
    records: Object.freeze(frozenRecords),
    effective: Object.freeze(effective),
    revisions: Object.freeze(revisions),
    warnings: Object.freeze(
      softCapWarnings(
        [
          ['built-in', builtInRows],
          ['user', userRows],
          ['workspace', workspaceRows]
        ],
        effective
      )
    )
  });
}
