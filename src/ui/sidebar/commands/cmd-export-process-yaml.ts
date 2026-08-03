// Feature 084 T022/T023 — export one Phase as a portable document.
//
// Read-only: it writes a file the operator named in the host's own dialog and
// changes no extension state, so it is deliberately NOT a member of
// `MUTATING_COMMANDS` (research R2). This directory imports no `vscode`; the
// dialog and the write are an injected dependency (`saveProcessYamlDocument`)
// wired in `src/extension.ts`, so no location crosses this boundary in either
// direction (FR-019, FR-020a, research R3).

import { BUILT_IN_PHASES } from '../../../config/pipeline-config';
import { resolvePhaseCatalog } from '../../../config/process-catalog';
import type { ProcessExchangePayload } from '../../../contracts/audit-events';
import type { PhaseDefinitionScope } from '../../../contracts/process-definitions';
import { documentFromPhaseDefinition } from '../../../services/process-yaml/phase-yaml-mapper';
import { serializePhaseDocument } from '../../../services/process-yaml/yaml-serializer';
import type { ExportProcessYamlCommand, ExportProcessYamlResult } from '../messages';
import type { CommandHandler, HandlerContext } from './handler-contract';
import { ack } from './handler-helpers';

/** Seeds the save dialog's name field. A bare name, never a location. */
function suggestedFileNameFor(phaseId: string): string {
  return `${phaseId}.phase.yaml`;
}

async function appendExportAudit(
  ctx: HandlerContext,
  args: {
    readonly resourceId: string;
    readonly scope: PhaseDefinitionScope | null;
    readonly outcome: ExportProcessYamlResult['outcome'];
  }
): Promise<void> {
  if (!ctx.deps.audit) return;
  // FR-047 bounds this to operation, ids, scope, outcomes, and counts. The
  // chosen file name is absent by construction — FR-019, FR-048, SC-009.
  const payload: ProcessExchangePayload = {
    operation: 'export',
    resourceKind: 'phase',
    resourceIds: [args.resourceId],
    scope: args.scope,
    outcomes: [args.outcome],
    counts: { exported: args.outcome === 'saved' ? 1 : 0 }
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

export const handler: CommandHandler<ExportProcessYamlCommand> = async (ctx, command) => {
  const { resourceId } = command.payload;
  const layers = ctx.deps.readPhaseConfig?.() ?? { user: [], workspace: [] };
  const catalog = resolvePhaseCatalog({
    builtIn: BUILT_IN_PHASES,
    user: layers.user,
    workspace: layers.workspace
  });

  // FR-014 — the EFFECTIVE catalog, so what is exported is what this
  // installation would actually run, not whichever layer happens to be first.
  const record = catalog.records.find(
    (row) => row.phaseId === resourceId && row.status === 'effective'
  );
  if (!record?.definition) {
    // FR-015 / QS-6 — two different absences, told apart so the reason is
    // stated rather than guessed. A row that exists but carries no valid
    // definition is `'does-not-resolve'`; an id no layer mentions at all is
    // `'not-found'`.
    const reason = catalog.records.some((row) => row.phaseId === resourceId)
      ? 'does-not-resolve'
      : 'not-found';
    const unavailable: ExportProcessYamlResult = { outcome: 'unavailable', reason };
    await appendExportAudit(ctx, { resourceId, scope: null, outcome: 'unavailable' });
    await ack(ctx, 'rejected', reason, unavailable);
    return;
  }

  if (!ctx.deps.saveProcessYamlDocument) {
    const failure: ExportProcessYamlResult = {
      outcome: 'failed',
      message: 'Export is unavailable in this window.'
    };
    await appendExportAudit(ctx, { resourceId, scope: record.scope, outcome: 'failed' });
    await ack(ctx, 'rejected', 'failed', failure);
    return;
  }

  const text = serializePhaseDocument(documentFromPhaseDefinition(record.definition));
  let result: ExportProcessYamlResult;
  try {
    result = await ctx.deps.saveProcessYamlDocument({
      suggestedFileName: suggestedFileNameFor(record.phaseId),
      text
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
    resourceId,
    scope: record.scope,
    outcome: result.outcome
  });
  await ack(
    ctx,
    result.outcome === 'saved' ? 'accepted' : 'rejected',
    result.outcome === 'saved' ? undefined : result.outcome,
    result
  );
};
