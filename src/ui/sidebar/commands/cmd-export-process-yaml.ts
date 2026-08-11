// Feature 084 T022/T023, feature 085 T021, feature 086 T015 — export one Phase,
// one Pipeline, or one Workflow as a portable document.
//
// Read-only: it writes a file the operator named in the host's own dialog and
// changes no extension state, so it is deliberately NOT a member of
// `MUTATING_COMMANDS` (research R2). This directory imports no `vscode`; the
// dialog and the write are an injected dependency (`saveProcessYamlDocument`)
// wired in `src/extension.ts`, so no location crosses this boundary in either
// direction (FR-019, FR-020a, research R3).
//
// The three resource kinds differ only in how the definition is selected and how
// it is serialized. Everything after that — the missing-adapter refusal, the
// generic write failure, the bounded audit envelope, the ack — is shared, so a
// Workflow export cannot drift into leaking a location that a Phase export does
// not. That sharing is the reason a third kind is a third branch here rather than
// a third handler: the invariants the shared tail enforces are re-proven for the
// new kind by construction, not by a second copy of them.

import { BUILT_IN_PHASES, BUILT_IN_PIPELINES } from '../../../config/pipeline-config';
import { resolvePipelineCatalog } from '../../../config/pipeline-catalog';
import { resolvePhaseCatalog } from '../../../config/process-catalog';
import { BUILT_IN_WORKFLOWS } from '../../../config/workflow-config';
import type { ProcessExchangePayload } from '../../../contracts/audit-events';
import type {
  PipelineDefinition,
  PipelineDefinitionScope
} from '../../../contracts/pipeline-definitions';
import type { PhaseDefinitionScope } from '../../../contracts/process-definitions';
import type { PhaseDefinition } from '../../../contracts/process-definitions';
import type {
  WorkflowDefinitionScope,
  WorkflowNode
} from '../../../contracts/workflow-definitions';
import { documentFromPhaseDefinition } from '../../../services/process-yaml/phase-yaml-mapper';
import {
  documentFromPipelineDefinition,
  referencedPhaseOrder,
  serializePipelineDocument
} from '../../../services/process-yaml/pipeline-document';
import { selectPipelineForExport } from '../../../services/process-yaml/pipeline-export-selection';
import type { ProcessYamlResourceKind } from '../../../services/process-yaml/types';
import type { WorkflowInclusion } from '../../../services/process-yaml/workflow-document';
import {
  documentFromWorkflowDefinition,
  serializeWorkflowDocument
} from '../../../services/process-yaml/workflow-document';
import {
  referencedPhaseClosure,
  referencedPipelineOrder
} from '../../../services/process-yaml/workflow-export-closure';
import { selectWorkflowForExport } from '../../../services/process-yaml/workflow-export-selection';
import { serializePhaseDocument } from '../../../services/process-yaml/yaml-serializer';
import type {
  ExportProcessYamlCommand,
  ExportProcessYamlRequest,
  ExportProcessYamlResult,
  ExportProcessYamlUnavailable
} from '../messages';
import type { CommandHandler, HandlerContext } from './handler-contract';
import { ack } from './handler-helpers';

type ExportScope = PhaseDefinitionScope | PipelineDefinitionScope | WorkflowDefinitionScope;

/**
 * Matches the cap the preflight boundary puts on an identifier. `logger.sanitize`
 * stays the single redaction source — `SECRET_PATTERNS` is not forked (FR-050).
 */
const RESOURCE_ID_MAX = 64;

/**
 * The definition to write, already serialized. Selecting it is the only thing
 * the two resource kinds do differently.
 */
interface ResolvedExport {
  readonly outcome: 'resolved';
  readonly scope: ExportScope;
  readonly suggestedFileName: string;
  readonly text: string;
  /**
   * How many complete Phase definitions the document carries (FR-059). Absent
   * for a Phase export, which has no inclusion choice to make.
   */
  readonly includedPhaseCount?: number;
}

type ExportSelection = ResolvedExport | ExportProcessYamlUnavailable;

/** The included-Phase resolution, sharing `outcome` so the arms discriminate. */
type IncludedPhaseResolution =
  | { readonly outcome: 'resolved'; readonly phases: readonly PhaseDefinition[] }
  | ExportProcessYamlUnavailable;

/** The same, one level up (feature 086 T023). */
type IncludedPipelineResolution =
  | { readonly outcome: 'resolved'; readonly pipelines: readonly PipelineDefinition[] }
  | ExportProcessYamlUnavailable;

async function appendExportAudit(
  ctx: HandlerContext,
  args: {
    readonly resourceKind: ProcessYamlResourceKind;
    readonly resourceId: string;
    readonly scope: ExportScope | null;
    readonly outcome: ExportProcessYamlResult['outcome'];
    readonly includedPhaseCount?: number;
  }
): Promise<void> {
  if (!ctx.deps.audit) return;
  const saved = args.outcome === 'saved';
  // FR-047 bounds this to operation, ids, scope, outcomes, and counts. The
  // chosen file name is absent by construction — FR-019, FR-048, SC-009.
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
    scope: args.scope,
    outcomes: [args.outcome],
    counts: {
      exported: saved ? 1 : 0,
      ...(args.includedPhaseCount !== undefined
        ? { includedPhases: saved ? args.includedPhaseCount : 0 }
        : {})
    }
  };
  try {
    await ctx.deps.audit.append({
      runId: `process-exchange:${args.resourceId}`,
      phase: 'process-exchange',
      iteration: 0,
      eventType: 'process-exchange-export',
      payload: { ...payload },
      outcome: args.outcome === 'failed' ? 'failure' : 'info',
      correlationId: ctx.correlationId
    });
  } catch (err) {
    ctx.deps.logger.warn(
      `sidebar router: process-yaml export audit append failed: ${ctx.deps.logger.sanitize(
        (err as Error).message ?? 'unknown error'
      )}`
    );
  }
}

/** Reads the effective Phase catalog, which both branches need. */
function effectivePhases(ctx: HandlerContext): ReturnType<typeof resolvePhaseCatalog> {
  const layers = ctx.deps.readPhaseConfig?.() ?? { user: [], workspace: [] };
  return resolvePhaseCatalog({
    builtIn: BUILT_IN_PHASES,
    user: layers.user,
    workspace: layers.workspace
  });
}

function selectPhase(ctx: HandlerContext, resourceId: string): ExportSelection {
  // FR-014 — the EFFECTIVE catalog, so what is exported is what this
  // installation would actually run, not whichever layer happens to be first.
  const catalog = effectivePhases(ctx);
  const record = catalog.records.find(
    (row) => row.phaseId === resourceId && row.status === 'effective'
  );
  if (!record?.definition) {
    // FR-015 / QS-6 — two different absences, told apart so the reason is
    // stated rather than guessed. A row that exists but carries no valid
    // definition is `'does-not-resolve'`; an id no layer mentions at all is
    // `'not-found'`.
    return {
      outcome: 'unavailable',
      reason: catalog.records.some((row) => row.phaseId === resourceId)
        ? 'does-not-resolve'
        : 'not-found'
    };
  }
  return {
    outcome: 'resolved',
    scope: record.scope,
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
 * this installation actually runs rather than a shadowed layer's copy (FR-014).
 * That is deliberately stricter than the reference-relaxed selection above:
 * a references-only export writes an identifier, which needs nothing to resolve
 * (FR-018), while an inclusion export writes a definition, which needs one.
 *
 * Refusal is on the FIRST unresolved reference in `phaseIds` order, so the same
 * catalog and the same Pipeline always name the same Phase. Nothing is written
 * on the way — a partial document is exactly what FR-017 forbids.
 */
function resolveIncludedPhases(
  ctx: HandlerContext,
  phaseIds: readonly string[]
): IncludedPhaseResolution {
  const effective = effectivePhases(ctx).effective;
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
          resourceId: ctx.deps.logger.sanitize(phaseId).slice(0, RESOURCE_ID_MAX)
        }
      };
    }
    phases.push(definition);
  }
  return { outcome: 'resolved', phases };
}

function selectPipeline(
  ctx: HandlerContext,
  request: Extract<ExportProcessYamlRequest, { resourceKind: 'pipeline' }>
): ExportSelection {
  const layers = ctx.deps.readPipelineConfig?.() ?? { user: [], workspace: [] };
  const selection = selectPipelineForExport({
    builtIn: BUILT_IN_PIPELINES,
    user: layers.user,
    workspace: layers.workspace,
    phaseCatalog: effectivePhases(ctx).effective,
    pipelineId: request.resourceId
  });
  if (selection.outcome === 'unavailable') return selection;

  let included: readonly PhaseDefinition[] | undefined;
  if (request.inclusion === 'include-referenced') {
    // FR-015 — a complete definition for each distinct referenced Phase.
    const resolved = resolveIncludedPhases(ctx, selection.definition.phaseIds);
    if (resolved.outcome === 'unavailable') return resolved;
    included = resolved.phases;
  }

  return {
    outcome: 'resolved',
    scope: selection.scope,
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
 * Built here rather than threaded in, so it is resolved from the same layers the
 * Pipeline branch above reads and cannot be a stale copy of them.
 */
function effectivePipelines(ctx: HandlerContext): ReturnType<typeof resolvePipelineCatalog> {
  const layers = ctx.deps.readPipelineConfig?.() ?? { user: [], workspace: [] };
  return resolvePipelineCatalog({
    builtIn: BUILT_IN_PIPELINES,
    user: layers.user,
    workspace: layers.workspace,
    phaseCatalog: effectivePhases(ctx).effective
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
  ctx: HandlerContext,
  nodes: readonly WorkflowNode[]
): IncludedPipelineResolution {
  const layers = ctx.deps.readPipelineConfig?.() ?? { user: [], workspace: [] };
  const phaseCatalog = effectivePhases(ctx).effective;
  const pipelines: PipelineDefinition[] = [];
  for (const pipelineId of referencedPipelineOrder(nodes)) {
    const selection = selectPipelineForExport({
      builtIn: BUILT_IN_PIPELINES,
      user: layers.user,
      workspace: layers.workspace,
      phaseCatalog,
      pipelineId
    });
    if (selection.outcome === 'unavailable') {
      return {
        outcome: 'unavailable',
        reason: 'dependency-does-not-resolve',
        unresolvedDependency: {
          kind: 'pipeline',
          resourceId: ctx.deps.logger.sanitize(pipelineId).slice(0, RESOURCE_ID_MAX)
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
  ctx: HandlerContext,
  request: Extract<ExportProcessYamlRequest, { resourceKind: 'workflow' }>
): ExportSelection {
  const layers = ctx.deps.readWorkflowConfig?.() ?? { user: [], workspace: [] };
  const selection = selectWorkflowForExport({
    builtIn: BUILT_IN_WORKFLOWS,
    user: layers.user,
    workspace: layers.workspace,
    pipelineCatalog: effectivePipelines(ctx),
    workflowId: request.resourceId
  });
  if (selection.outcome === 'unavailable') return selection;

  let inclusion: WorkflowInclusion | undefined;
  if (request.inclusion === 'include-pipelines' || request.inclusion === 'include-closure') {
    // FR-017 — a complete definition for each distinct referenced Pipeline.
    const resolved = resolveIncludedPipelines(ctx, selection.definition.nodes);
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
      const phases = resolveIncludedPhases(ctx, referencedPhaseClosure(resolved.pipelines));
      if (phases.outcome === 'unavailable') return phases;
      inclusion = { pipelines: resolved.pipelines, phases: phases.phases };
    }
  }

  return {
    outcome: 'resolved',
    scope: selection.scope,
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

export const handler: CommandHandler<ExportProcessYamlCommand> = async (ctx, command) => {
  const request = command.payload;
  const { resourceKind, resourceId } = request;
  const selection =
    request.resourceKind === 'workflow'
      ? selectWorkflow(ctx, request)
      : request.resourceKind === 'pipeline'
        ? selectPipeline(ctx, request)
        : selectPhase(ctx, resourceId);

  if (selection.outcome === 'unavailable') {
    // Spread rather than rebuilt, so the identifier a dependency refusal carries
    // reaches the operator (FR-017) without this site enumerating the arms.
    const unavailable: ExportProcessYamlResult = { ...selection };
    await appendExportAudit(ctx, {
      resourceKind,
      resourceId,
      scope: null,
      outcome: 'unavailable'
    });
    await ack(ctx, 'rejected', selection.reason, unavailable);
    return;
  }

  if (!ctx.deps.saveProcessYamlDocument) {
    const failure: ExportProcessYamlResult = {
      outcome: 'failed',
      message: 'Export is unavailable in this window.'
    };
    await appendExportAudit(ctx, {
      resourceKind,
      resourceId,
      scope: selection.scope,
      outcome: 'failed',
      ...(selection.includedPhaseCount !== undefined
        ? { includedPhaseCount: selection.includedPhaseCount }
        : {})
    });
    await ack(ctx, 'rejected', 'failed', failure);
    return;
  }

  let result: ExportProcessYamlResult;
  try {
    result = await ctx.deps.saveProcessYamlDocument({
      suggestedFileName: selection.suggestedFileName,
      text: selection.text
    });
  } catch (err) {
    ctx.deps.logger.warn(
      `sidebar router: process-yaml export failed: ${ctx.deps.logger.sanitize(
        (err as Error).message ?? 'unknown error'
      )}`
    );
    // The sanitized message stays in the log; the operator gets a generic one,
    // because an adapter's error text can name the location it tried to write.
    result = { outcome: 'failed', message: 'Could not write the document.' };
  }

  await appendExportAudit(ctx, {
    resourceKind,
    resourceId,
    scope: selection.scope,
    outcome: result.outcome,
    ...(selection.includedPhaseCount !== undefined
      ? { includedPhaseCount: selection.includedPhaseCount }
      : {})
  });
  await ack(
    ctx,
    result.outcome === 'saved' ? 'accepted' : 'rejected',
    result.outcome === 'saved' ? undefined : result.outcome,
    result
  );
};
