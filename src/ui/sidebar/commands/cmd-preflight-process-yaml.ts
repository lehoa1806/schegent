// Feature 084 T030/T031 — import preflight: read one document, say what
// importing it would do, change nothing.
//
// Read-only by construction (FR-031, FR-032). It writes no configuration, moves
// no layer revision, takes no lock, and retains nothing past the read, so it is
// deliberately NOT a member of `MUTATING_COMMANDS`. The write happens later,
// through the existing `CMD_SAVE_PHASES`, which IS gated.
//
// This directory imports no `vscode`: the open dialog and the read are an
// injected dependency (`openProcessYamlDocument`) wired in `src/extension.ts`,
// so no location crosses this boundary in either direction (FR-020a, R3).
//
// T031 — everything leaving here is sanitized through the existing logger
// sanitizer and bounded to the caps `boundedValidationResult` in
// `cmd-save-phases.ts` already uses (field 32, code 64, message 512). The
// strings are author-supplied: defect messages quote the value the document
// carried, and `name` is whatever the document said. `SECRET_PATTERNS` is not
// forked — `logger.sanitize` remains the single source (FR-050).
//
// Feature 085 T033 — the same command now reads two kinds of document, chosen by
// the document's own `kind:` (FR-055a). The REQUEST names no kind: asking an
// operator to classify a file before opening it would make "picked the wrong
// per-kind action" a reachable failure, and this makes it unrepresentable rather
// than handled. Everything downstream is kind-tagged per row, because one
// package declares resources of both kinds.
//
// Feature 086 T037 — a third kind, on the same terms and with the request still
// empty. Two things are genuinely new. The plan may now carry a third layer
// revision, forwarded for the reason the second one is (its PRESENCE is what tells
// the webview that layer can be written). And the defect-field cap is now per
// resource kind: the Workflow family's own validator and projector both bound a
// field at 48 because its paths are longer (`connections[0].condition.left.source`
// is 36), so a single 32 here would hand the operator a truncated path and no way
// to know it was cut. The Phase and Pipeline families keep 32 byte-for-byte.

import { BUILT_IN_PHASES, BUILT_IN_PIPELINES } from '../../../config/pipeline-config';
import { resolvePipelineCatalog } from '../../../config/pipeline-catalog';
import { resolvePhaseCatalog } from '../../../config/process-catalog';
import { BUILT_IN_WORKFLOWS } from '../../../config/workflow-config';
import { invalidPipelineCauses, resolveWorkflowCatalog } from '../../../config/workflow-catalog';
import { WORKFLOW_ERROR_FIELD_MAX } from '../../../config/workflow-definition-validator';
import {
  planPhaseImport,
  planPipelineImport,
  planWorkflowImport
} from '../../../services/process-yaml/import-planner';
import type {
  PackageImportContext,
  WorkflowPackageImportContext
} from '../../../services/process-yaml/import-planner';
import { findScalar, validatePhaseDocument } from '../../../services/process-yaml/phase-yaml-validator';
import { parsePipelinePackage } from '../../../services/process-yaml/pipeline-document';
import { parseWorkflowPackage } from '../../../services/process-yaml/workflow-document';
import { parseDocumentBytes } from '../../../services/process-yaml/yaml-parser';
import {
  PHASE_YAML_API_VERSION,
  PHASE_YAML_KIND,
  PIPELINE_YAML_KIND,
  WORKFLOW_YAML_KIND
} from '../../../services/process-yaml/types';
import type { ProcessExchangePayload } from '../../../contracts/audit-events';
import type {
  BlockedDependency,
  BlockedReason,
  DocumentRefusal,
  ImportPlan,
  ImportPlanRow,
  ProcessYamlResourceKind,
  YamlMappingNode
} from '../../../services/process-yaml/types';
import type { PreflightProcessYamlCommand, PreflightProcessYamlResult } from '../messages';
import type { CommandHandler, HandlerContext } from './handler-contract';
import { ack } from './handler-helpers';

const FIELD_MAX = 32;
const CODE_MAX = 64;
const MESSAGE_MAX = 512;
const RESOURCE_ID_MAX = 64;
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
    resourceId: bound(dependency.resourceId, RESOURCE_ID_MAX, sanitize)
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
        row.resourceId === null ? null : bound(row.resourceId, RESOURCE_ID_MAX, sanitize),
      defects: row.defects.slice(0, DEFECTS_MAX).map((defect) => ({
        field: bound(defect.field, fieldMaxFor(row.resourceKind), sanitize),
        code: bound(defect.code, CODE_MAX, sanitize),
        message: bound(defect.message, MESSAGE_MAX, sanitize)
      })),
      // Deliberately the pre-cap count, so a truncated list is visible as one.
      totalDefects: row.totalDefects
    };
  }
  if (row.outcome === 'skip') {
    return {
      outcome: 'skip',
      resourceKind: row.resourceKind,
      resourceId: bound(row.resourceId, RESOURCE_ID_MAX, sanitize),
      name: bound(row.name, NAME_MAX, sanitize),
      presentIn: row.presentIn,
      presentRowStatus: row.presentRowStatus
    };
  }
  if (row.outcome === 'blocked') {
    return {
      outcome: 'blocked',
      resourceKind: row.resourceKind,
      resourceId: bound(row.resourceId, RESOURCE_ID_MAX, sanitize),
      name: bound(row.name, NAME_MAX, sanitize),
      reason: boundReason(row.reason, sanitize)
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
    resourceId: bound(row.resourceId, RESOURCE_ID_MAX, sanitize),
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
  return {
    code: 'unsupported-kind',
    // Every kind this build DOES read, so an operator holding a document from a
    // newer build learns which are available rather than only that theirs is not.
    message: `Unsupported kind '${kind.value.slice(0, ECHO_MAX)}'; this build reads ${PHASE_YAML_KIND}, ${PIPELINE_YAML_KIND} and ${WORKFLOW_YAML_KIND}`
  };
}

async function respond(ctx: HandlerContext, result: PreflightProcessYamlResult): Promise<void> {
  await ack(
    ctx,
    result.outcome === 'planned' ? 'accepted' : 'rejected',
    result.outcome === 'planned' ? undefined : result.outcome,
    result
  );
}

/**
 * T054/T055 — a refused document leaves a record, so a blocked import is
 * distinguishable from an import that never happened (FR-049).
 *
 * Only refusals are audited. A plan is not an operation: preflight changes
 * nothing, and auditing every inspection would make the log describe the
 * operator's browsing rather than the catalog's history. A cancellation is not
 * audited for the same reason — it is the absence of an operation, which is
 * exactly what the absence of an event says.
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
  ctx: HandlerContext,
  refusal: DocumentRefusal,
  resourceKind: ProcessYamlResourceKind
): Promise<void> {
  if (!ctx.deps.audit) return;
  const payload: ProcessExchangePayload = {
    operation: 'import-preflight',
    resourceKind,
    resourceIds: [],
    scope: null,
    outcomes: [refusal.code],
    counts: { refused: 1 }
  };
  try {
    await ctx.deps.audit.append({
      runId: 'process-exchange:import-preflight',
      phase: 'process-exchange',
      iteration: 0,
      eventType: 'process-exchange-import-refused',
      payload: { ...payload },
      outcome: 'info',
      correlationId: ctx.correlationId
    });
  } catch (err) {
    // A log that cannot be written must not turn a clean refusal into a failure
    // the operator has to interpret.
    ctx.deps.logger.warn(
      `sidebar router: process-yaml preflight audit append failed: ${ctx.deps.logger.sanitize(
        (err as Error).message ?? 'unknown error'
      )}`
    );
  }
}

/** Audit the refusal, then report it. */
async function refuse(
  ctx: HandlerContext,
  refusal: DocumentRefusal,
  sanitize: Sanitize,
  resourceKind: ProcessYamlResourceKind = 'phase'
): Promise<void> {
  const bounded = boundRefusal(refusal, sanitize);
  await appendRefusalAudit(ctx, bounded, resourceKind);
  await respond(ctx, { outcome: 'refused', refusal: bounded });
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
  ctx: HandlerContext,
  phaseCatalog: ReturnType<typeof resolvePhaseCatalog>
): ReturnType<typeof resolvePipelineCatalog> {
  const layers = ctx.deps.readPipelineConfig?.() ?? { user: [], workspace: [] };
  return resolvePipelineCatalog({
    builtIn: BUILT_IN_PIPELINES,
    user: layers.user,
    workspace: layers.workspace,
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
    revisions: phaseCatalog.revisions,
    // Read here, from the same resolve the presence oracle came from, so the
    // revision a confirmed write is gated on describes the layer this plan was
    // actually computed against (FR-040, FR-043).
    pipelineRevisions: pipelineCatalog.revisions
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
  ctx: HandlerContext,
  phaseCatalog: ReturnType<typeof resolvePhaseCatalog>
): WorkflowPackageImportContext {
  const pipelineCatalog = resolvedPipelineCatalog(ctx, phaseCatalog);
  const layers = ctx.deps.readWorkflowConfig?.() ?? { user: [], workspace: [] };
  // One context object, read by the catalog resolve and by the causes map, so the
  // graph oracle the planner uses is built from the same two lists resolution is.
  const pipelineContext = {
    effective: pipelineCatalog.effective,
    records: pipelineCatalog.records
  };
  const workflowCatalog = resolveWorkflowCatalog({
    builtIn: BUILT_IN_WORKFLOWS,
    user: layers.user,
    workspace: layers.workspace,
    pipelineCatalog: pipelineContext
  });
  return {
    ...packageContext(phaseCatalog, pipelineCatalog),
    workflowRows: workflowCatalog.records,
    workflowRevisions: workflowCatalog.revisions,
    effectivePipelines: pipelineCatalog.effective,
    // The catalog's own exported map, not a second implementation: a transitive
    // cause the preflight reports must be the one the next reload derives.
    invalidPipelines: invalidPipelineCauses(pipelineContext)
  };
}

export const handler: CommandHandler<PreflightProcessYamlCommand> = async (ctx) => {
  const sanitize = ctx.deps.logger.sanitize;
  if (!ctx.deps.openProcessYamlDocument) {
    await respond(ctx, { outcome: 'failed', message: 'Import is unavailable in this window.' });
    return;
  }

  let opened: Awaited<ReturnType<NonNullable<typeof ctx.deps.openProcessYamlDocument>>>;
  try {
    opened = await ctx.deps.openProcessYamlDocument();
  } catch (err) {
    ctx.deps.logger.warn(
      `sidebar router: process-yaml preflight read failed: ${sanitize(
        (err as Error).message ?? 'unknown error'
      )}`
    );
    // The sanitized detail stays in the log; the operator gets a generic
    // message, because an adapter's error text can name the location it read.
    await respond(ctx, { outcome: 'failed', message: 'Could not read the document.' });
    return;
  }

  if (opened.outcome === 'canceled') {
    await respond(ctx, { outcome: 'canceled' });
    return;
  }
  if (opened.outcome === 'failed') {
    await respond(ctx, { outcome: 'failed', message: 'Could not read the document.' });
    return;
  }

  // Size, encoding, and disallowed syntax are all refused here, before any
  // declared value is constructed (FR-003a, FR-011).
  const parsed = parseDocumentBytes(opened.bytes);
  if (!parsed.ok) {
    await refuse(ctx, parsed.refusal, sanitize);
    return;
  }

  // The document says which reader it is for; the request never did (FR-055a).
  const kind = dispatchKind(parsed.node);
  if (typeof kind !== 'string') {
    await refuse(ctx, kind, sanitize);
    return;
  }

  const phaseLayers = ctx.deps.readPhaseConfig?.() ?? { user: [], workspace: [] };
  // `records` is the STORED ROWS of every layer, whatever their status — not
  // `effective`. A shadowed or invalid row still claims its id, so an import
  // cannot take an id the operator is repairing (FR-030, research R4).
  const phaseCatalog = resolvePhaseCatalog({
    builtIn: BUILT_IN_PHASES,
    user: phaseLayers.user,
    workspace: phaseLayers.workspace
  });

  // One reader per kind, chosen once. A `switch` rather than a nested ternary now
  // that there are three: the arms are a closed set, and the compiler checks the
  // set is covered rather than a final `else` absorbing whatever is added next.
  let planned;
  switch (kind) {
    case 'phase':
      planned = planPhaseImport(
        validatePhaseDocument(parsed.node),
        phaseCatalog.records,
        phaseCatalog.revisions
      );
      break;
    case 'pipeline':
      planned = planPipelineImport(
        parsePipelinePackage(parsed.node),
        packageContext(phaseCatalog, resolvedPipelineCatalog(ctx, phaseCatalog))
      );
      break;
    case 'workflow':
      planned = planWorkflowImport(
        parseWorkflowPackage(parsed.node),
        workflowContext(ctx, phaseCatalog)
      );
      break;
  }

  if (planned.outcome === 'refused') {
    // A document-level refusal produces no partial plan (FR-027, FR-029).
    await refuse(ctx, planned.refusal, sanitize, kind);
    return;
  }

  await respond(ctx, { outcome: 'planned', plan: boundPlan(planned.plan, sanitize) });
};
