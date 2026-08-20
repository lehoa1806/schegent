// Feature 089 T001 — the preflight core, extracted from the sidebar handler.
//
// Everything below the host seam moved here unchanged: byte parsing, kind
// dispatch, catalog assembly, per-kind planning, defect bounding, and the
// refusal audit append. What stayed behind in
// `src/ui/sidebar/commands/cmd-preflight-process-yaml.ts` is the part that is
// genuinely the editor's — opening a document and acknowledging the command.
//
// The move is the precondition for FR-003. A headless entrypoint must reach the
// same logic the webview reaches, and it cannot call a command handler: a handler
// takes a `HandlerContext` and answers by posting an ack. Copying the body into a
// facade would satisfy the letter of "same behavior" on the day it was written
// and diverge on the first edit that touched one copy. So the body moves down to
// a service both adapters call, which is Fowler's Service Layer applied to a
// handler that had grown one.
//
// The behavior is preserved byte-for-byte, deliberately. This file adds no
// validation, no bound, and no refusal that the handler did not already produce;
// the handler suites that covered it are expected to pass unchanged, which is
// what makes this a move rather than a rewrite (plan D7, T007).
//
// Dependencies arrive as the narrow structural ports of `data-model.md` §2 rather
// than as the router's whole `RouterDeps` bag. `RouterDeps` satisfies them
// structurally, so the host wires nothing new, and a test or an automation client
// supplies a smaller object.

import { resolvePipelineCatalog } from '../../config/pipeline-catalog';
import { coerceModels } from '../../config/pipeline-config-loader';
import { modelsLayerRevision } from '../../config/model-catalog';
import { resolvePhaseCatalog } from '../../config/process-catalog';
import { invalidPipelineCauses, resolveWorkflowCatalog } from '../../config/workflow-catalog';
import { WORKFLOW_ERROR_FIELD_MAX } from '../../config/workflow-definition-validator';
import { planPhaseImport, planPipelineImport, planWorkflowImport } from './import-planner';
import type {
  PackageImportContext,
  ProcessImportPlanResult,
  WorkflowPackageImportContext
} from './import-planner';
import { planModelCatalogImport } from './model-catalog-import-planner';
import { parseModelCatalogDocument } from './model-catalog-yaml-mapper';
import { findScalar, validatePhaseDocument } from './phase-yaml-validator';
import { parsePipelinePackage } from './pipeline-document';
import { parseWorkflowPackage } from './workflow-document';
import { parseDocumentBytes } from './yaml-parser';
import {
  MODEL_CATALOG_YAML_KIND,
  PHASE_YAML_API_VERSION,
  PHASE_YAML_KIND,
  PIPELINE_YAML_KIND,
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

/** The narrow ports of `data-model.md` §2, shared with the export service. */
export type PreflightDeps = ExchangeDeps;

/**
 * The document itself, plus the correlation id the refusal audit carries.
 *
 * **Bytes, never a path.** The open dialog is the only thing that ever holds a
 * location and it stays in `extension.ts`; the handler passes the bytes it read
 * and a headless caller passes the bytes it already has, so no location can cross
 * this boundary in either direction.
 */
export interface PreflightInput {
  readonly bytes: Uint8Array;
  readonly correlationId?: string;
}

/**
 * Derived from the wire result rather than restated (FR-005), so a headless
 * caller and the webview cannot come to describe the same outcome differently.
 *
 * The two host-side arms are absent by construction: `canceled` and `failed`
 * describe the *dialog*, and this service never opens one.
 */
export type PreflightOutcome = Extract<
  PreflightProcessYamlResult,
  { outcome: 'planned' | 'refused' }
>;

const FIELD_MAX = 32;
const CODE_MAX = 64;
const MESSAGE_MAX = 512;
const NAME_MAX = 80;
/** Matches the cap `boundedValidationResult` puts on a phase-save error list. */
const DEFECTS_MAX = 20;

type Sanitize = (value: string) => string;

function bound(value: string, max: number, sanitize: Sanitize): string {
  return sanitize(value).slice(0, max);
}

/**
 * How wide a defect FIELD PATH may be, per resource kind (feature 086).
 *
 * Not one cap, because the catalogs it mirrors are not one family. The Phase and
 * Pipeline validators bound an error field at 32 and this boundary has matched
 * them since 084; the Workflow validator and its projector both chose 48, because
 * a Workflow path addresses a connection's condition operand
 * (`connections[0].condition.left.source`, 36 characters) and 32 would cut it
 * mid-word. Truncating a path an operator has to navigate by is worse than a
 * slightly wider string: it names a field that does not exist.
 *
 * The Workflow width is imported from the validator that owns it rather than
 * written as a literal here — the two disagreeing is exactly the drift that
 * produced this function.
 */
function fieldMaxFor(resourceKind: ProcessYamlResourceKind): number {
  return resourceKind === 'workflow' ? WORKFLOW_ERROR_FIELD_MAX : FIELD_MAX;
}

function boundDependency(dependency: BlockedDependency, sanitize: Sanitize): BlockedDependency {
  return {
    kind: dependency.kind,
    resourceId: bound(dependency.resourceId, RESOURCE_ID_MAX_LEN[dependency.kind], sanitize)
  };
}

/**
 * A blocked reason names identifiers the document declared, so each is bounded
 * exactly like the other declared identifiers on the row. `dependency-blocked`
 * names two — the dependency and the intermediate it is blocked through — and
 * both are author-supplied, so neither may skip the cap (feature 086).
 */
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
        row.resourceId === null ? null : bound(row.resourceId, RESOURCE_ID_MAX_LEN[row.resourceKind], sanitize),
      defects: row.defects.slice(0, DEFECTS_MAX).map((defect) => ({
        field: bound(defect.field, fieldMaxFor(row.resourceKind), sanitize),
        code: bound(defect.code, CODE_MAX, sanitize),
        message: bound(defect.message, MESSAGE_MAX, sanitize)
      })),
      // Deliberately the pre-cap count, so a truncated list is visible as one.
      totalDefects: row.totalDefects
    };
  }
  if (row.outcome === 'skip' && row.resourceKind === 'modelCatalog') {
    return {
      outcome: 'skip',
      resourceKind: 'modelCatalog',
      resourceId: bound(row.resourceId, RESOURCE_ID_MAX_LEN.modelCatalog, sanitize),
      // No dedicated cap declared for `backend`: it is this row's other
      // identifier-class field (not a display `name`, which this kind has no
      // use for), so it shares the resource-kind id bound rather than NAME_MAX.
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
  // The `definition` on an import row is the one field passed through
  // untouched. It is the value the commit writes, and FR-046a forbids rewriting
  // a declared value — sanitizing it would silently alter what round-trips, and
  // the caps above would truncate an `instruction`. Nothing renders it: the
  // webview forwards it to `CMD_SAVE_PHASES` / `CMD_SAVE_PIPELINES`, whose own
  // validators are the gate, and which it can already reach through the catalog
  // managers. The bounded `resourceId` and `name` are the rendered fields.
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
  if (row.resourceKind === 'pipeline') {
    return { ...common, resourceKind: 'pipeline', definition: row.definition };
  }
  return { ...common, resourceKind: 'workflow', definition: row.definition };
}

function boundPlan(plan: ImportPlan, sanitize: Sanitize): ImportPlan {
  return {
    rows: plan.rows.map((row) => boundRow(row, sanitize)),
    // Counts describe the rows the planner produced, not the bounded list, and
    // the cap is on defects within a row rather than on rows, so they still
    // agree with `rows.length` (FR-028).
    counts: plan.counts,
    computedAgainstRevision: plan.computedAgainstRevision,
    // Absent on the Phase path, and left absent here rather than defaulted: the
    // webview reads its presence as "this plan can write the Pipeline layer".
    ...(plan.computedAgainstPipelineRevision !== undefined
      ? { computedAgainstPipelineRevision: plan.computedAgainstPipelineRevision }
      : {}),
    // The same rule one layer up (feature 086). A revision is an opaque token,
    // so it is forwarded rather than sanitized or bounded; what it must not do is
    // acquire a value the planner did not compute.
    ...(plan.computedAgainstWorkflowRevision !== undefined
      ? { computedAgainstWorkflowRevision: plan.computedAgainstWorkflowRevision }
      : {}),
    // Feature 096, same rule one layer up again: an opaque token, forwarded
    // rather than sanitized, present only when the document declared a
    // ModelCatalog.
    ...(plan.computedAgainstModelsRevision !== undefined
      ? { computedAgainstModelsRevision: plan.computedAgainstModelsRevision }
      : {})
  };
}

function boundRefusal(refusal: DocumentRefusal, sanitize: Sanitize): DocumentRefusal {
  return { code: refusal.code, message: bound(refusal.message, MESSAGE_MAX, sanitize) };
}

/** How much of an author-supplied value a dispatch refusal quotes back. */
const ECHO_MAX = 64;

/**
 * Which reader this document is for (FR-055a), or the refusal for one no reader
 * claims.
 *
 * The identity gates are restated here rather than delegated because this
 * decision is one no single reader can make: each is total for its own kind and
 * refuses everything else, so handing an unknown document to one of them would
 * report it in that kind's vocabulary ("expected Phase") when the build in fact
 * reads three. Every reader keeps its own gate — this is a dispatch, not the
 * enforcement site, and the constants are shared so they cannot disagree.
 *
 * Version before kind, matching both readers: a `kind` this build does not know,
 * under an `apiVersion` it does not know either, is a document from another
 * format, and naming its kind unsupported would judge it by a vocabulary that
 * may not be its own.
 */
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
  if (kind.value === PIPELINE_YAML_KIND) return 'pipeline';
  if (kind.value === WORKFLOW_YAML_KIND) return 'workflow';
  if (kind.value === MODEL_CATALOG_YAML_KIND) return 'modelCatalog';
  return {
    code: 'unsupported-kind',
    // Every kind this build DOES read, so an operator holding a document from a
    // newer build learns which are available rather than only that theirs is not.
    message: `Unsupported kind '${kind.value.slice(0, ECHO_MAX)}'; this build reads ${PHASE_YAML_KIND}, ${PIPELINE_YAML_KIND}, ${WORKFLOW_YAML_KIND} and ${MODEL_CATALOG_YAML_KIND}`
  };
}

/**
 * T054/T055 — a refused document leaves a record, so a blocked import is
 * distinguishable from an import that never happened (FR-049).
 *
 * Only refusals are audited. A plan is not an operation: preflight changes
 * nothing, and auditing every inspection would make the log describe the
 * operator's browsing rather than the catalog's history. A cancellation is not
 * audited for the same reason — it is the absence of an operation, which is
 * exactly what the absence of an event says. Cancellation is now also outside
 * this service entirely, which is the same statement made structurally.
 *
 * The payload carries the refusal CODE and no message (FR-047, FR-048): the code
 * is one of seven literals, while the message quotes what the document said.
 * `resourceIds` is empty because a document-level refusal identified no
 * resource, and `scope` is null because nothing had been targeted yet.
 *
 * `resourceKind` is the kind the dispatch settled on, and `'phase'` when it never
 * got that far — a document refused for bad syntax, an unreadable size, or a
 * `kind` no reader claims declared no kind this build can name. The payload has
 * no null to record that with, and inventing one would widen a closed envelope
 * for a distinction the operator reads off the refusal code anyway.
 */
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
    // A log that cannot be written must not turn a clean refusal into a failure
    // the operator has to interpret.
    deps.logger.warn(
      `sidebar router: process-yaml preflight audit append failed: ${deps.logger.sanitize(
        (err as Error).message ?? 'unknown error'
      )}`
    );
  }
}

/** Audit the refusal, then report it. */
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

/**
 * The two presence oracles and the one resolution oracle a package is planned
 * against, gathered in the single place that can read both catalogs.
 *
 * The Pipeline catalog is resolved against the EFFECTIVE Phase catalog, which is
 * what `resolvePipelineCatalog` validates stored bindings with — the standing
 * rule that a binding is never resolved against anything else. That is a
 * different question from the one the planner asks of `records`, which is who
 * claims an id; both are supplied, and neither substitutes for the other.
 */
function resolvedPipelineCatalog(
  deps: PreflightDeps,
  phaseCatalog: ReturnType<typeof resolvePhaseCatalog>
): ReturnType<typeof resolvePipelineCatalog> {
  const stored = deps.readPipelineConfig?.() ?? { rows: [], revision: '' };
  return resolvePipelineCatalog({
    rows: stored.rows,
    revision: stored.revision,
    phaseCatalog: phaseCatalog.effective
  });
}

function packageContext(
  phaseCatalog: ReturnType<typeof resolvePhaseCatalog>,
  pipelineCatalog: ReturnType<typeof resolvePipelineCatalog>
): PackageImportContext {
  return {
    phaseRows: phaseCatalog.records,
    pipelineRows: pipelineCatalog.records,
    effectivePhases: phaseCatalog.effective,
    revision: phaseCatalog.revision,
    // Read here, from the same resolve the presence oracle came from, so the
    // revision a confirmed write is gated on describes the catalog this plan was
    // actually computed against (FR-040, FR-043).
    pipelineRevision: pipelineCatalog.revision
  };
}

/**
 * The three presence oracles and the one resolution oracle a Workflow package is
 * planned against (feature 086).
 *
 * It SPREADS the Pipeline context rather than restating it, so the Phase and
 * Pipeline oracles a Workflow package reads are literally the ones a Pipeline
 * package reads. Only the third catalog is added here.
 *
 * The Workflow catalog is resolved against the EFFECTIVE Pipeline catalog, which
 * is what `resolveWorkflowCatalog` validates stored graphs with — the standing rule
 * that a node and its ports are never resolved against anything else. That is a
 * different question from the one the planner asks of `records`, which is who
 * claims an id; both are supplied, and neither substitutes for the other.
 */
function workflowContext(
  deps: PreflightDeps,
  phaseCatalog: ReturnType<typeof resolvePhaseCatalog>
): WorkflowPackageImportContext {
  const pipelineCatalog = resolvedPipelineCatalog(deps, phaseCatalog);
  const stored = deps.readWorkflowConfig?.() ?? { rows: [], revision: '' };
  // One context object, read by the catalog resolve and by the causes map, so the
  // graph oracle the planner uses is built from the same two lists resolution is.
  const pipelineContext = {
    effective: pipelineCatalog.effective,
    records: pipelineCatalog.records
  };
  const workflowCatalog = resolveWorkflowCatalog({
    rows: stored.rows,
    revision: stored.revision,
    pipelineCatalog: pipelineContext
  });
  return {
    ...packageContext(phaseCatalog, pipelineCatalog),
    workflowRows: workflowCatalog.records,
    workflowRevision: workflowCatalog.revision,
    effectivePipelines: pipelineCatalog.effective,
    // The catalog's own exported map, not a second implementation: a transitive
    // cause the preflight reports must be the one the next reload derives.
    invalidPipelines: invalidPipelineCauses(pipelineContext)
  };
}

/**
 * Say what importing this document would do, and change nothing.
 *
 * Read-only by construction (FR-031, FR-032): no configuration write, no layer
 * revision moved, no lock taken, nothing retained past the call. That is why the
 * command that wraps it is deliberately NOT a member of `MUTATING_COMMANDS`, and
 * why a headless caller reaching this function directly needs no trust gate
 * either — the gate lives on the write that may follow.
 */
export async function preflightProcessDocument(
  deps: PreflightDeps,
  input: PreflightInput
): Promise<PreflightOutcome> {
  const sanitize = deps.logger.sanitize;

  // Size, encoding, and disallowed syntax are all refused here, before any
  // declared value is constructed (FR-003a, FR-011).
  const parsed = parseDocumentBytes(input.bytes);
  if (!parsed.ok) {
    return refuse(deps, parsed.refusal, sanitize, input.correlationId);
  }

  // The document says which reader it is for; the request never did (FR-055a).
  const kind = dispatchKind(parsed.node);
  if (typeof kind !== 'string') {
    return refuse(deps, kind, sanitize, input.correlationId);
  }

  const phaseStored = deps.readPhaseConfig?.() ?? { rows: [], revision: '' };
  // `records` is the STORED ROWS, whatever their status — not `effective`. An
  // invalid row still claims its id, so an import cannot take an id the operator
  // is repairing (FR-030, research R4).
  const phaseCatalog = resolvePhaseCatalog({
    rows: phaseStored.rows,
    revision: phaseStored.revision
  });

  // One reader per kind, chosen once. A `switch` rather than a nested ternary now
  // that there are three: the arms are a closed set, and the compiler checks the
  // set is covered rather than a final `else` absorbing whatever is added next.
  let planned: ProcessImportPlanResult;
  switch (kind) {
    case 'phase':
      planned = planPhaseImport(
        validatePhaseDocument(parsed.node),
        phaseCatalog.records,
        phaseCatalog.revision
      );
      break;
    case 'pipeline':
      planned = planPipelineImport(
        parsePipelinePackage(parsed.node),
        packageContext(phaseCatalog, resolvedPipelineCatalog(deps, phaseCatalog))
      );
      break;
    case 'workflow':
      planned = planWorkflowImport(
        parseWorkflowPackage(parsed.node),
        workflowContext(deps, phaseCatalog)
      );
      break;
    case 'modelCatalog': {
      const parsedModelCatalog = parseModelCatalogDocument(parsed.node);
      if (!parsedModelCatalog.ok) {
        planned = { outcome: 'refused', refusal: parsedModelCatalog.refusal };
        break;
      }
      // Feature 096 — the Model Catalog stays in VS Code configuration and is
      // out of feature 099's scope; `readModelsConfig` is the whole of it
      // (data-model.md Decision 6).
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
          // Always the Phase catalog's revision (every plan can write
          // Phases); ModelCatalog's own revision is the field below.
          computedAgainstRevision: phaseCatalog.revision,
          computedAgainstModelsRevision: modelsLayerRevision(modelsConfig)
        }
      };
      break;
    }
  }

  if (planned.outcome === 'refused') {
    // A document-level refusal produces no partial plan (FR-027, FR-029).
    return refuse(deps, planned.refusal, sanitize, input.correlationId, kind);
  }

  return { outcome: 'planned', plan: boundPlan(planned.plan, sanitize) };
}
