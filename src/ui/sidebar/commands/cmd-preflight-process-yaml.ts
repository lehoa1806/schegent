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

import { BUILT_IN_PHASES } from '../../../config/pipeline-config';
import { resolvePhaseCatalog } from '../../../config/process-catalog';
import { planPhaseImport } from '../../../services/process-yaml/import-planner';
import { validatePhaseDocument } from '../../../services/process-yaml/phase-yaml-validator';
import { parseDocumentBytes } from '../../../services/process-yaml/yaml-parser';
import type { ProcessExchangePayload } from '../../../contracts/audit-events';
import type {
  DocumentRefusal,
  ImportPlan,
  ImportPlanRow
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
      resourceId: bound(row.resourceId, RESOURCE_ID_MAX, sanitize),
      name: bound(row.name, NAME_MAX, sanitize),
      presentIn: row.presentIn,
      presentRowStatus: row.presentRowStatus
    };
  }
  return {
    outcome: 'import',
    resourceId: bound(row.resourceId, RESOURCE_ID_MAX, sanitize),
    name: bound(row.name, NAME_MAX, sanitize),
    requiresRetryConditionCapability: row.requiresRetryConditionCapability,
    // The one field on this row that is passed through untouched. It is the
    // value the commit writes, and FR-046a forbids rewriting a declared value —
    // sanitizing it would silently alter what round-trips, and the caps above
    // would truncate an `instruction`. Nothing renders it: the webview forwards
    // it to `CMD_SAVE_PHASES`, whose own validator is the gate, and which it can
    // already reach through the Phase manager. The bounded `resourceId` and
    // `name` above are the fields the plan renders.
    definition: row.definition
  };
}

function boundPlan(plan: ImportPlan, sanitize: Sanitize): ImportPlan {
  return {
    rows: plan.rows.map((row) => boundRow(row, sanitize)),
    // Counts describe the rows the planner produced, not the bounded list, and
    // the cap is on defects within a row rather than on rows, so they still
    // agree with `rows.length` (FR-028).
    counts: plan.counts,
    computedAgainstRevision: plan.computedAgainstRevision
  };
}

function boundRefusal(refusal: DocumentRefusal, sanitize: Sanitize): DocumentRefusal {
  return { code: refusal.code, message: bound(refusal.message, MESSAGE_MAX, sanitize) };
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
 */
async function appendRefusalAudit(ctx: HandlerContext, refusal: DocumentRefusal): Promise<void> {
  if (!ctx.deps.audit) return;
  const payload: ProcessExchangePayload = {
    operation: 'import-preflight',
    resourceKind: 'phase',
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
  sanitize: Sanitize
): Promise<void> {
  const bounded = boundRefusal(refusal, sanitize);
  await appendRefusalAudit(ctx, bounded);
  await respond(ctx, { outcome: 'refused', refusal: bounded });
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

  const validation = validatePhaseDocument(parsed.node);
  const layers = ctx.deps.readPhaseConfig?.() ?? { user: [], workspace: [] };
  const catalog = resolvePhaseCatalog({
    builtIn: BUILT_IN_PHASES,
    user: layers.user,
    workspace: layers.workspace
  });

  // `catalog.records` is the STORED ROWS of every layer, whatever their status —
  // not `catalog.effective`. A shadowed or invalid row still claims its id, so
  // an import cannot take an id the operator is repairing (FR-030, research R4).
  const planned = planPhaseImport(validation, catalog.records, catalog.revisions);
  if (planned.outcome === 'refused') {
    // A document-level refusal produces no partial plan (FR-027).
    await refuse(ctx, planned.refusal, sanitize);
    return;
  }

  await respond(ctx, { outcome: 'planned', plan: boundPlan(planned.plan, sanitize) });
};
