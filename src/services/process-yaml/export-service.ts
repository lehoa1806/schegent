// Feature 089 T003 — the export core, extracted from the sidebar handler.
//
// Selection, dependency resolution, closure, and serialization moved here
// unchanged. What stayed in
// `src/ui/sidebar/commands/cmd-export-process-yaml.ts` is the save seam and the
// ack — the part that is genuinely the editor's.
//
// **This service returns a document; it never writes one.** That is the whole
// point of the split: the webview adapter hands the serialized text to the host's
// save dialog, and a headless caller receives the same text and does whatever it
// likes with it. Neither ever names a location, and the byte-identity FR-009
// asks for is a property of one shared serializer rather than a coincidence
// between two.
//
// The three resource kinds still differ only in how the definition is selected
// and how it is serialized. Everything after that — the bounded audit envelope
// and the refusal shapes — remains shared, so a Workflow export cannot drift into
// disclosing something a Phase export does not. The audit append moved with the
// selection rather than staying above it, because both adapters must record the
// same envelope; a second copy is how two surfaces come to log the same act
// differently.

import { groupsFromModelsConfig } from '../../config/model-catalog';
import { resolvePipelineCatalog } from '../../config/pipeline-catalog';
import { coerceModels } from '../../config/pipeline-config-loader';
import { resolvePhaseCatalog } from '../../config/process-catalog';
import { serializeModelCatalogDocument } from './model-catalog-yaml-mapper';
import { documentFromPhaseDefinition } from './phase-yaml-mapper';
import {
  documentFromPipelineDefinition,
  referencedPhaseOrder,
  serializePipelineDocument
} from './pipeline-document';
import { selectPipelineForExport } from './pipeline-export-selection';
import { documentFromWorkflowDefinition, serializeWorkflowDocument } from './workflow-document';
import { referencedPhaseClosure, referencedPipelineOrder } from './workflow-export-closure';
import { selectWorkflowForExport } from './workflow-export-selection';
import { serializePhaseDocument } from './yaml-serializer';
import type { ProcessExchangePayload } from '../../contracts/audit-events';
import type { PipelineDefinition } from '../../contracts/pipeline-definitions';
import type { PhaseDefinition } from '../../contracts/process-definitions';
import {
  RESOURCE_ID_MAX_LEN,
  type ExportProcessYamlRequest,
  type ExportProcessYamlResult,
  type ExportProcessYamlUnavailable
} from '../../contracts/sidebar-ipc/process-yaml';
import type { WorkflowNode } from '../../contracts/workflow-definitions';
import type { ExchangeDeps } from './service-ports';
import { MODEL_CATALOG_YAML_KIND, PHASE_YAML_API_VERSION, type ProcessYamlResourceKind } from './types';
import type { WorkflowInclusion } from './workflow-document';

/**
 * Feature 096 — the audit `resourceId` for a Model Catalog export. Contract
 * §3 states there is no operator-facing id for this kind ("there is exactly
 * one Model Catalog — nothing to identify"), but `ExportAuditEntry.resourceId`
 * is a required `string` shared by all four kinds. This fixed literal fills
 * that field where every other kind's caller-supplied id would go; it never
 * crosses the IPC boundary itself and is bounded well within
 * `RESOURCE_ID_MAX_LEN.modelCatalog`.
 */
export const MODEL_CATALOG_EXPORT_RESOURCE_ID = 'model-catalog';

/**
 * The definition to write, already serialized. Selecting it is the only thing
 * the three resource kinds do differently.
 *
 * Feature 099 (FR-041) — `scope` is gone with the layer tier it named. An
 * export writes the one definition the catalog holds, so there is no longer a
 * layer to report alongside it.
 */
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

/** The included-Phase resolution, sharing `outcome` so the arms discriminate. */
type IncludedPhaseResolution =
  | { readonly outcome: 'resolved'; readonly phases: readonly PhaseDefinition[] }
  | ExportProcessYamlUnavailable;

/** The same, one level up (feature 086 T023). */
type IncludedPipelineResolution =
  | { readonly outcome: 'resolved'; readonly pipelines: readonly PipelineDefinition[] }
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
  // FR-047 bounds this to operation, ids, outcomes, and counts. The chosen file
  // name is absent by construction — FR-019, FR-048, SC-009.
  //
  // `includedPhases` counts the Phase definitions that actually left the
  // installation, so it follows `exported` rather than describing a document
  // nobody received. Without it a package export and a references-only export
  // record the same `{ exported: 1 }`, and the difference between them is
  // precisely whether other operators' Phase text was disclosed (FR-059).
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

/** Reads the effective Phase catalog, which every branch needs. */
function effectivePhases(deps: ExchangeDeps): ReturnType<typeof resolvePhaseCatalog> {
  const stored = deps.readPhaseConfig?.() ?? { rows: [], revision: '' };
  return resolvePhaseCatalog({ rows: stored.rows, revision: stored.revision });
}

function selectPhase(deps: ExchangeDeps, resourceId: string): ExportSelection {
  // FR-014 — the EFFECTIVE catalog, so what is exported is what this
  // installation would actually run, not whichever layer happens to be first.
  const catalog = effectivePhases(deps);
  const record = catalog.records.find(
    (row) => row.phaseId === resourceId && row.status === 'effective'
  );
  if (!record?.definition) {
    // FR-015 / QS-6 — two different absences, told apart so the reason is
    // stated rather than guessed. A row that exists but carries no valid
    // definition is `'does-not-resolve'`; an id the catalog does not hold at
    // all is `'not-found'`.
    return {
      outcome: 'unavailable',
      reason: catalog.records.some((row) => row.phaseId === resourceId)
        ? 'does-not-resolve'
        : 'not-found'
    };
  }
  return {
    outcome: 'resolved',
    // A bare name, never a location.
    suggestedFileName: `${record.phaseId}.phase.yaml`,
    text: serializePhaseDocument(documentFromPhaseDefinition(record.definition))
  };
}

/**
 * The Phase definitions a package must carry, or the first reference that does
 * not resolve (FR-017).
 *
 * Resolution is against the EFFECTIVE catalog, so an included Phase is the one
 * this installation actually runs rather than a row the catalog rejected
 * (FR-014). That is deliberately stricter than the reference-relaxed selection above:
 * a references-only export writes an identifier, which needs nothing to resolve
 * (FR-018), while an inclusion export writes a definition, which needs one.
 *
 * Refusal is on the FIRST unresolved reference in `phaseIds` order, so the same
 * catalog and the same Pipeline always name the same Phase. Nothing is written
 * on the way — a partial document is exactly what FR-017 forbids.
 */
function resolveIncludedPhases(
  deps: ExchangeDeps,
  phaseIds: readonly string[]
): IncludedPhaseResolution {
  const effective = effectivePhases(deps).effective;
  const byId = new Map(effective.map((phase) => [phase.phaseId, phase]));
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

function selectPipeline(
  deps: ExchangeDeps,
  request: Extract<ExportProcessYamlRequest, { resourceKind: 'pipeline' }>
): ExportSelection {
  const stored = deps.readPipelineConfig?.() ?? { rows: [], revision: '' };
  const selection = selectPipelineForExport({
    rows: stored.rows,
    phaseCatalog: effectivePhases(deps).effective,
    pipelineId: request.resourceId
  });
  if (selection.outcome === 'unavailable') return selection;

  let included: readonly PhaseDefinition[] | undefined;
  if (request.inclusion === 'include-referenced') {
    // FR-015 — a complete definition for each distinct referenced Phase.
    const resolved = resolveIncludedPhases(deps, selection.definition.phaseIds);
    if (resolved.outcome === 'unavailable') return resolved;
    included = resolved.phases;
  }

  return {
    outcome: 'resolved',
    // Zero for a references-only export, which is a count and not an absence:
    // the operator chose to disclose no Phase text, and the log says so.
    includedPhaseCount: included?.length ?? 0,
    suggestedFileName: `${selection.definition.pipelineId}.pipeline.yaml`,
    // References-only (FR-013) passes no Phases, so the document carries no
    // `included` section at all: the referenced Phases appear as identifiers in
    // `phaseIds` and nowhere else. Either way `phaseIds` is untouched (FR-019).
    text: serializePipelineDocument(
      documentFromPipelineDefinition(selection.definition, included)
    )
  };
}

/**
 * The effective Pipeline catalog and the rows behind it, which a Workflow's graph
 * is resolved against per the project rule on graph resolution.
 *
 * Built here rather than threaded in, so it is resolved from the same rows the
 * Pipeline branch above reads and cannot be a stale copy of them.
 */
function effectivePipelines(deps: ExchangeDeps): ReturnType<typeof resolvePipelineCatalog> {
  const stored = deps.readPipelineConfig?.() ?? { rows: [], revision: '' };
  return resolvePipelineCatalog({
    rows: stored.rows,
    revision: stored.revision,
    phaseCatalog: effectivePhases(deps).effective
  });
}

/**
 * The Pipeline definitions a package must carry, or the first reference that does
 * not resolve (FR-022).
 *
 * Each reference goes through `selectPipelineForExport`, the same strict-then-
 * relaxed selection a single-Pipeline export uses — deliberately NOT the effective
 * Pipeline catalog. FR-018 is a claim about WHICH level must resolve: a Pipeline
 * naming a Phase this installation does not hold is not effective
 * (`resolvePipelineCatalog` pushes `unknown-phase` and nulls the definition), so
 * resolving against the effective catalog would let a missing PHASE refuse a mode
 * that carries no Phase text at all. The relaxation reaches reference-class gaps
 * only, so a Pipeline that is intrinsically broken still refuses here.
 *
 * Refusal is on the FIRST unresolved reference in node order, so the same catalog
 * and the same Workflow always name the same Pipeline. Both of the selection's
 * absences — a row that does not resolve and an id no layer mentions — are the one
 * dependency refusal from the operator's side: the document cannot be written and
 * this is the resource that stopped it. Nothing is written on the way; a partial
 * payload is exactly what FR-022 forbids.
 */
function resolveIncludedPipelines(
  deps: ExchangeDeps,
  nodes: readonly WorkflowNode[]
): IncludedPipelineResolution {
  const stored = deps.readPipelineConfig?.() ?? { rows: [], revision: '' };
  const phaseCatalog = effectivePhases(deps).effective;
  const pipelines: PipelineDefinition[] = [];
  for (const pipelineId of referencedPipelineOrder(nodes)) {
    const selection = selectPipelineForExport({
      rows: stored.rows,
      phaseCatalog,
      pipelineId
    });
    if (selection.outcome === 'unavailable') {
      return {
        outcome: 'unavailable',
        reason: 'dependency-does-not-resolve',
        unresolvedDependency: {
          kind: 'pipeline',
          resourceId: deps.logger.sanitize(pipelineId).slice(0, RESOURCE_ID_MAX_LEN.pipeline)
        }
      };
    }
    pipelines.push(selection.definition);
  }
  return { outcome: 'resolved', pipelines };
}

/**
 * One Workflow: the graph, the Pipeline identifiers its nodes name, and — in the
 * self-contained modes — the definitions behind them.
 *
 * The two self-contained modes share level 1 and differ only in whether they walk
 * level 2, so the closure mode is the middle mode plus one step rather than a
 * third branch resolving the graph again. Level 1 also refuses FIRST: a Phase
 * reference exists only once the Pipeline naming it resolves, so reporting a
 * missing Phase reached through a Pipeline that is itself missing would name the
 * wrong resource (FR-022).
 */
function selectWorkflow(
  deps: ExchangeDeps,
  request: Extract<ExportProcessYamlRequest, { resourceKind: 'workflow' }>
): ExportSelection {
  const stored = deps.readWorkflowConfig?.() ?? { rows: [], revision: '' };
  const selection = selectWorkflowForExport({
    rows: stored.rows,
    pipelineCatalog: effectivePipelines(deps),
    workflowId: request.resourceId
  });
  if (selection.outcome === 'unavailable') return selection;

  let inclusion: WorkflowInclusion | undefined;
  if (request.inclusion === 'include-pipelines' || request.inclusion === 'include-closure') {
    // FR-017 — a complete definition for each distinct referenced Pipeline.
    const resolved = resolveIncludedPipelines(deps, selection.definition.nodes);
    if (resolved.outcome === 'unavailable') return resolved;
    inclusion = { pipelines: resolved.pipelines };

    if (request.inclusion === 'include-closure') {
      // FR-019 — level 2, walked from the Pipelines level 1 just resolved rather
      // than from the graph, so the closure is exactly the Phases those
      // definitions name and the two `included` sections cannot disagree about
      // which Pipeline came first. The walk lives in one place
      // (`referencedPhaseClosure`) and is not re-derived here.
      //
      // `resolveIncludedPhases` is the resolver a single-Pipeline package already
      // uses, unchanged: the effective Phase catalog (FR-014), refusal on the
      // first unresolved reference in the order it was handed, and one
      // `{ kind: 'phase' }` dependency in the refusal. Re-ordering inside it is
      // idempotent on an already-closure-ordered list, so the refused Phase is
      // the first one in closure order.
      const phases = resolveIncludedPhases(deps, referencedPhaseClosure(resolved.pipelines));
      if (phases.outcome === 'unavailable') return phases;
      inclusion = { pipelines: resolved.pipelines, phases: phases.phases };
    }
  }

  return {
    outcome: 'resolved',
    // Zero in the two shallower modes, and that is a count rather than an absence:
    // the operator chose to disclose no Phase text and the log says so (FR-059).
    includedPhaseCount: inclusion?.phases?.length ?? 0,
    // A bare name, never a location.
    suggestedFileName: `${selection.definition.workflowId}.workflow.yaml`,
    // References-only (FR-015) passes no Pipelines, so the document carries no
    // `included` section at all: the referenced Pipelines appear as identifiers on
    // the nodes and nowhere else. Either way `spec` is untouched (FR-009).
    text: serializeWorkflowDocument(
      documentFromWorkflowDefinition(selection.definition, inclusion)
    )
  };
}

/**
 * Feature 096 — the Model Catalog stays in VS Code configuration and is out of
 * feature 099's scope, so this reads that configuration directly rather than
 * calling a `resolveXCatalog` the way the other three kinds do.
 *
 * Per FR-007 this never returns `ExportProcessYamlUnavailable` — an empty
 * catalog is still a valid, exportable document, so there is no absence this
 * branch can report.
 */
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

/**
 * Resolve one export request to a serialized document, or to the refusal that
 * says why there is none.
 *
 * Pure with respect to catalog state: it reads the effective catalogs and writes
 * nothing, which is why the command that wraps it is deliberately not a member of
 * `MUTATING_COMMANDS` and why a headless caller needs no trust gate to reach it.
 */
export function selectProcessExportDocument(
  deps: ExchangeDeps,
  request: ExportProcessYamlRequest
): ExportSelection {
  // Checked first — this arm carries no `resourceId`, so it must narrow out of
  // the union before any branch below reads one.
  if (request.resourceKind === 'modelCatalog') return selectModelCatalog(deps);
  if (request.resourceKind === 'workflow') return selectWorkflow(deps, request);
  if (request.resourceKind === 'pipeline') return selectPipeline(deps, request);
  return selectPhase(deps, request.resourceId);
}
