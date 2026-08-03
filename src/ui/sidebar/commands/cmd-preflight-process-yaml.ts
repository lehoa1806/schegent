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

import { BUILT_IN_PHASES, BUILT_IN_PIPELINES } from '../../../config/pipeline-config';
import { resolvePipelineCatalog } from '../../../config/pipeline-catalog';
import { resolvePhaseCatalog } from '../../../config/process-catalog';
import { planPhaseImport, planPipelineImport } from '../../../services/process-yaml/import-planner';
import type { PackageImportContext } from '../../../services/process-yaml/import-planner';
import { findScalar, validatePhaseDocument } from '../../../services/process-yaml/phase-yaml-validator';
import { parsePipelinePackage } from '../../../services/process-yaml/pipeline-document';
import { parseDocumentBytes } from '../../../services/process-yaml/yaml-parser';
import {
  PHASE_YAML_API_VERSION,
  PHASE_YAML_KIND,
  PIPELINE_YAML_KIND
} from '../../../services/process-yaml/types';
import type { ProcessExchangePayload } from '../../../contracts/audit-events';
import type {
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

function boundRow(row: ImportPlanRow, sanitize: Sanitize): ImportPlanRow {
  if (row.outcome === 'invalid') {
    return {
      outcome: 'invalid',
      resourceKind: row.resourceKind,
      resourceId:
        row.resourceId === null ? null : bound(row.resourceId, RESOURCE_ID_MAX, sanitize),
      defects: row.defects.slice(0, DEFECTS_MAX).map((defect) => ({
        field: bound(defect.field, FIELD_MAX, sanitize),
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
      // The reason names a `phaseId` the document declared, so it is bounded
      // exactly like the other declared identifiers on this row.
      reason: {
        code: row.reason.code,
        phaseId: bound(row.reason.phaseId, RESOURCE_ID_MAX, sanitize)
      },
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
  return row.resourceKind === 'phase'
    ? {
        ...common,
        resourceKind: 'phase',
        requiresRetryConditionCapability: row.requiresRetryConditionCapability,
        definition: row.definition
      }
    : { ...common, resourceKind: 'pipeline', definition: row.definition };
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
 * The two identity gates are restated here rather than delegated because this
 * decision is one neither reader can make: each is total for its own kind and
 * refuses everything else, so handing an unknown document to one of them would
 * report it in that kind's vocabulary ("expected Phase") when the build in fact
 * reads two. Both readers keep their own gates — this is a dispatch, not the
 * enforcement site, and the constants are shared so the three cannot disagree.
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
  return {
    code: 'unsupported-kind',
    message: `Unsupported kind '${kind.value.slice(0, ECHO_MAX)}'; this build reads ${PHASE_YAML_KIND} and ${PIPELINE_YAML_KIND}`
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
function packageContext(
  ctx: HandlerContext,
  phaseCatalog: ReturnType<typeof resolvePhaseCatalog>
): PackageImportContext {
  const layers = ctx.deps.readPipelineConfig?.() ?? { user: [], workspace: [] };
  const pipelineCatalog = resolvePipelineCatalog({
    builtIn: BUILT_IN_PIPELINES,
    user: layers.user,
    workspace: layers.workspace,
    phaseCatalog: phaseCatalog.effective
  });
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

  const planned =
    kind === 'phase'
      ? planPhaseImport(
          validatePhaseDocument(parsed.node),
          phaseCatalog.records,
          phaseCatalog.revisions
        )
      : planPipelineImport(parsePipelinePackage(parsed.node), packageContext(ctx, phaseCatalog));

  if (planned.outcome === 'refused') {
    // A document-level refusal produces no partial plan (FR-027, FR-029).
    await refuse(ctx, planned.refusal, sanitize, kind);
    return;
  }

  await respond(ctx, { outcome: 'planned', plan: boundPlan(planned.plan, sanitize) });
};
