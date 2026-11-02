// Feature 089 T001 / Feature 263 (FR-R5-F04) — the preflight core.
//
// Byte parsing, kind dispatch (`Phase`, `Workflow`, `ModelCatalog`), catalog assembly,
// per-kind planning, defect bounding, and refusal audit append live here.

import { coerceModels } from '../../config/pipeline-config-loader';
import { modelsLayerRevision } from '../../config/model-catalog';
import { resolvePhaseCatalog } from '../../config/process-catalog';
import { invalidPhaseCauses, resolveWorkflowCatalog } from '../../config/workflow-catalog';
import { WORKFLOW_ERROR_FIELD_MAX } from '../../config/workflow-definition-validator';
import { planPhaseImport, planWorkflowImport } from './import-planner';
import type {
  ProcessImportPlanResult,
  WorkflowPackageImportContext
} from './import-planner';
import { planModelCatalogImport } from './model-catalog-import-planner';
import { parseModelCatalogDocument } from './model-catalog-yaml-mapper';
import { findScalar, validatePhaseDocument } from './phase-yaml-validator';
import { parseWorkflowPackage } from './workflow-document';
import { parseDocumentBytes, tooLargeRefusal } from './yaml-parser';
import {
  MODEL_CATALOG_YAML_KIND,
  PHASE_YAML_API_VERSION,
  PHASE_YAML_KIND,
  WORKFLOW_YAML_KIND
} from './types';
import type { ProcessExchangePayload } from '../../contracts/audit-events';
import {
  RESOURCE_ID_MAX_LEN,
  type PreflightProcessYamlResult
} from '../../contracts/sidebar-ipc/process-yaml';
import type { ExchangeDeps } from './service-ports';
import type {
  BlockedDependency,
  BlockedReason,
  DocumentRefusal,
  ImportPlan,
  ImportPlanCounts,
  ImportPlanRow,
  ProcessYamlResourceKind,
  YamlMappingNode
} from './types';

export type PreflightDeps = ExchangeDeps;

export interface PreflightInput {
  readonly bytes: Uint8Array;
  readonly correlationId?: string;
}

export type PreflightOutcome = Extract<
  PreflightProcessYamlResult,
  { outcome: 'planned' | 'refused' }
>;

const FIELD_MAX = 32;
const CODE_MAX = 64;
const MESSAGE_MAX = 512;
const NAME_MAX = 80;
const DEFECTS_MAX = 20;

type Sanitize = (value: string) => string;

function bound(value: string, max: number, sanitize: Sanitize): string {
  return sanitize(value).slice(0, max);
}

function fieldMaxFor(resourceKind: ProcessYamlResourceKind): number {
  return resourceKind === 'workflow' ? WORKFLOW_ERROR_FIELD_MAX : FIELD_MAX;
}

function boundDependency(dependency: BlockedDependency, sanitize: Sanitize): BlockedDependency {
  return {
    kind: dependency.kind,
    resourceId: bound(dependency.resourceId, RESOURCE_ID_MAX_LEN[dependency.kind], sanitize)
  };
}

function boundReason(reason: BlockedReason, sanitize: Sanitize): BlockedReason {
  const dependency = boundDependency(reason.dependency, sanitize);
  return reason.code === 'dependency-blocked'
    ? { code: reason.code, dependency, via: boundDependency(reason.via, sanitize) }
    : { code: reason.code, dependency };
}

function boundRow(row: ImportPlanRow, sanitize: Sanitize): ImportPlanRow {
  if (row.outcome === 'invalid') {
    return {
      outcome: 'invalid',
      resourceKind: row.resourceKind,
      resourceId:
        row.resourceId === null
          ? null
          : bound(row.resourceId, RESOURCE_ID_MAX_LEN[row.resourceKind], sanitize),
      defects: row.defects.slice(0, DEFECTS_MAX).map((defect) => ({
        field: bound(defect.field, fieldMaxFor(row.resourceKind), sanitize),
        code: bound(defect.code, CODE_MAX, sanitize),
        message: bound(defect.message, MESSAGE_MAX, sanitize)
      })),
      totalDefects: row.totalDefects
    };
  }
  if (row.outcome === 'skip' && row.resourceKind === 'modelCatalog') {
    return {
      outcome: 'skip',
      resourceKind: 'modelCatalog',
      resourceId: bound(row.resourceId, RESOURCE_ID_MAX_LEN.modelCatalog, sanitize),
      backend: bound(row.backend, RESOURCE_ID_MAX_LEN.modelCatalog, sanitize),
      modelId: bound(row.modelId, RESOURCE_ID_MAX_LEN.modelCatalog, sanitize),
      reason: row.reason
    };
  }
  if (row.outcome === 'skip') {
    return {
      outcome: 'skip',
      resourceKind: row.resourceKind,
      resourceId: bound(row.resourceId, RESOURCE_ID_MAX_LEN[row.resourceKind], sanitize),
      name: bound(row.name, NAME_MAX, sanitize),
      presentRowStatus: row.presentRowStatus
    };
  }
  if (row.outcome === 'blocked') {
    return {
      outcome: 'blocked',
      resourceKind: row.resourceKind,
      resourceId: bound(row.resourceId, RESOURCE_ID_MAX_LEN[row.resourceKind], sanitize),
      name: bound(row.name, NAME_MAX, sanitize),
      reason: boundReason(row.reason, sanitize)
    };
  }
  if (row.resourceKind === 'modelCatalog') {
    return {
      outcome: 'import',
      resourceKind: 'modelCatalog',
      resourceId: bound(row.resourceId, RESOURCE_ID_MAX_LEN.modelCatalog, sanitize),
      backend: bound(row.backend, RESOURCE_ID_MAX_LEN.modelCatalog, sanitize),
      modelId: bound(row.modelId, RESOURCE_ID_MAX_LEN.modelCatalog, sanitize)
    };
  }
  const common = {
    outcome: 'import',
    resourceId: bound(row.resourceId, RESOURCE_ID_MAX_LEN[row.resourceKind], sanitize),
    name: bound(row.name, NAME_MAX, sanitize)
  } as const;
  if (row.resourceKind === 'phase') {
    return {
      ...common,
      resourceKind: 'phase',
      requiresRetryConditionCapability: row.requiresRetryConditionCapability,
      definition: row.definition
    };
  }
  return { ...common, resourceKind: 'workflow', definition: row.definition };
}

function boundPlan(plan: ImportPlan, sanitize: Sanitize): ImportPlan {
  return {
    rows: plan.rows.map((row) => boundRow(row, sanitize)),
    counts: plan.counts,
    computedAgainstRevision: plan.computedAgainstRevision,
    ...(plan.computedAgainstWorkflowRevision !== undefined
      ? { computedAgainstWorkflowRevision: plan.computedAgainstWorkflowRevision }
      : {}),
    ...(plan.computedAgainstModelsRevision !== undefined
      ? { computedAgainstModelsRevision: plan.computedAgainstModelsRevision }
      : {})
  };
}

function boundRefusal(refusal: DocumentRefusal, sanitize: Sanitize): DocumentRefusal {
  return { code: refusal.code, message: bound(refusal.message, MESSAGE_MAX, sanitize) };
}

const ECHO_MAX = 64;

function dispatchKind(node: YamlMappingNode): ProcessYamlResourceKind | DocumentRefusal {
  const apiVersion = findScalar(node, 'apiVersion');
  if (apiVersion === undefined) {
    return { code: 'unsupported-version', message: 'Document does not declare apiVersion' };
  }
  if (apiVersion.value !== PHASE_YAML_API_VERSION) {
    return {
      code: 'unsupported-version',
      message: `Unsupported apiVersion '${apiVersion.value.slice(0, ECHO_MAX)}'; this build reads ${PHASE_YAML_API_VERSION}`
    };
  }

  const kind = findScalar(node, 'kind');
  if (kind === undefined) {
    return { code: 'unsupported-kind', message: 'Document does not declare kind' };
  }
  if (kind.value === PHASE_YAML_KIND) return 'phase';
  if (kind.value === WORKFLOW_YAML_KIND) return 'workflow';
  if (kind.value === MODEL_CATALOG_YAML_KIND) return 'modelCatalog';
  return {
    code: 'unsupported-kind',
    message: `Unsupported kind '${kind.value.slice(0, ECHO_MAX)}'; this build reads ${PHASE_YAML_KIND}, ${WORKFLOW_YAML_KIND} and ${MODEL_CATALOG_YAML_KIND}`
  };
}

async function appendRefusalAudit(
  deps: PreflightDeps,
  refusal: DocumentRefusal,
  resourceKind: ProcessYamlResourceKind,
  correlationId?: string
): Promise<void> {
  if (!deps.audit) return;
  const payload: ProcessExchangePayload = {
    operation: 'import-preflight',
    resourceKind,
    resourceIds: [],
    outcomes: [refusal.code],
    counts: { refused: 1 }
  };
  try {
    await deps.audit.append({
      runId: 'process-exchange:import-preflight',
      phase: 'process-exchange',
      iteration: 0,
      eventType: 'process-exchange-import-refused',
      payload: { ...payload },
      outcome: 'info',
      ...(correlationId !== undefined ? { correlationId } : {})
    });
  } catch (err) {
    deps.logger.warn(
      `sidebar router: process-yaml preflight audit append failed: ${deps.logger.sanitize(
        (err as Error).message ?? 'unknown error'
      )}`
    );
  }
}

async function refuse(
  deps: PreflightDeps,
  refusal: DocumentRefusal,
  sanitize: Sanitize,
  correlationId: string | undefined,
  resourceKind: ProcessYamlResourceKind = 'phase'
): Promise<PreflightOutcome> {
  const bounded = boundRefusal(refusal, sanitize);
  await appendRefusalAudit(deps, bounded, resourceKind, correlationId);
  return { outcome: 'refused', refusal: bounded };
}

function presentIds(
  stored: { readonly ids?: ReadonlySet<string> } | undefined,
  rowIds: readonly string[]
): ReadonlySet<string> {
  return stored?.ids ?? new Set(rowIds);
}

function workflowContext(
  deps: PreflightDeps,
  phaseCatalog: ReturnType<typeof resolvePhaseCatalog>,
  phaseStored: { readonly ids?: ReadonlySet<string> } | undefined
): WorkflowPackageImportContext {
  const stored = deps.readWorkflowConfig?.() ?? { rows: [], revision: '' };
  const phaseContext = {
    effective: phaseCatalog.effective,
    records: phaseCatalog.records
  };
  const workflowCatalog = resolveWorkflowCatalog({
    rows: stored.rows,
    revision: stored.revision,
    phaseCatalog: phaseContext
  });
  const effectiveWorkflowIds = new Set(workflowCatalog.effective.map((w) => w.workflowId));
  const invalidWorkflows = new Map<string, string>();
  for (const record of workflowCatalog.records) {
    if (record.status !== 'invalid' || effectiveWorkflowIds.has(record.workflowId)) continue;
    if (invalidWorkflows.has(record.workflowId)) continue;
    invalidWorkflows.set(
      record.workflowId,
      record.errors.at(0)?.message ?? 'Workflow definition is invalid'
    );
  }

  return {
    phaseRows: phaseCatalog.records,
    phaseIds: presentIds(
      phaseStored,
      phaseCatalog.records.map((record) => record.phaseId)
    ),
    effectivePhases: phaseCatalog.effective,
    revision: phaseCatalog.revision,
    workflowRows: workflowCatalog.records,
    workflowIds: presentIds(
      stored,
      workflowCatalog.records.map((record) => record.workflowId)
    ),
    effectiveWorkflows: workflowCatalog.effective,
    workflowRevision: workflowCatalog.revision,
    invalidPhases: invalidPhaseCauses(phaseContext),
    invalidWorkflows
  };
}

export async function preflightOversizedDocument(
  deps: PreflightDeps,
  input: Pick<PreflightInput, 'correlationId'> = {}
): Promise<PreflightOutcome> {
  return refuse(deps, tooLargeRefusal(), deps.logger.sanitize, input.correlationId);
}

export async function preflightProcessDocument(
  deps: PreflightDeps,
  input: PreflightInput
): Promise<PreflightOutcome> {
  const sanitize = deps.logger.sanitize;

  const parsed = parseDocumentBytes(input.bytes);
  if (!parsed.ok) {
    return refuse(deps, parsed.refusal, sanitize, input.correlationId);
  }

  const kind = dispatchKind(parsed.node);
  if (typeof kind !== 'string') {
    return refuse(deps, kind, sanitize, input.correlationId);
  }

  const phaseStored = deps.readPhaseConfig?.() ?? { rows: [], revision: '' };
  const phaseCatalog = resolvePhaseCatalog({
    rows: phaseStored.rows,
    revision: phaseStored.revision
  });

  let planned: ProcessImportPlanResult;
  switch (kind) {
    case 'phase':
      planned = planPhaseImport(
        validatePhaseDocument(parsed.node),
        phaseCatalog.records,
        phaseCatalog.revision,
        presentIds(
          phaseStored,
          phaseCatalog.records.map((record) => record.phaseId)
        )
      );
      break;
    case 'workflow':
      planned = planWorkflowImport(
        parseWorkflowPackage(parsed.node),
        workflowContext(deps, phaseCatalog, phaseStored)
      );
      break;
    case 'modelCatalog': {
      const parsedModelCatalog = parseModelCatalogDocument(parsed.node);
      if (!parsedModelCatalog.ok) {
        planned = { outcome: 'refused', refusal: parsedModelCatalog.refusal };
        break;
      }
      const modelsConfig = coerceModels(deps.readModelsConfig?.());
      const rows = planModelCatalogImport(parsedModelCatalog.document, modelsConfig);
      const counts: ImportPlanCounts = {
        import: rows.filter((row) => row.outcome === 'import').length,
        skip: rows.filter((row) => row.outcome === 'skip').length,
        blocked: 0,
        invalid: 0
      };
      planned = {
        outcome: 'planned',
        plan: {
          rows,
          counts,
          computedAgainstRevision: phaseCatalog.revision,
          computedAgainstModelsRevision: modelsLayerRevision(modelsConfig)
        }
      };
      break;
    }
  }

  if (planned.outcome === 'refused') {
    return refuse(deps, planned.refusal, sanitize, input.correlationId, kind);
  }

  return { outcome: 'planned', plan: boundPlan(planned.plan, sanitize) };
}
