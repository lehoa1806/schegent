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
// Feature 089 T004 — what remains here is the save seam and the ack. Selecting a
// definition, resolving a package's dependencies, walking a closure, serializing,
// and recording the audit envelope all moved to
// `services/process-yaml/export-service.ts`, which the headless entrypoint calls
// too (FR-003, FR-004). The service returns the document; this handler adds
// nothing to it before handing it to the dialog, which is what FR-009's
// byte-identity claim rests on.
//
// The three resource kinds still differ only in how the definition is selected,
// and the shared tail below — the missing-adapter refusal, the generic write
// failure, the ack — is the same for all three, so a Workflow export cannot drift
// into leaking a location that a Phase export does not.

import {
  appendExportAudit,
  selectProcessExportDocument
} from '../../../services/process-yaml/export-service';
import type { ExportProcessYamlCommand, ExportProcessYamlResult } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

export const handler: CommandHandler<ExportProcessYamlCommand> = async (ctx, command) => {
  const request = command.payload;
  const { resourceKind, resourceId } = request;
  const correlationId = ctx.correlationId;
  const selection = selectProcessExportDocument(ctx.deps, request);

  if (selection.outcome === 'unavailable') {
    // Spread rather than rebuilt, so the identifier a dependency refusal carries
    // reaches the operator (FR-017) without this site enumerating the arms.
    const unavailable: ExportProcessYamlResult = { ...selection };
    await appendExportAudit(ctx.deps, {
      resourceKind,
      resourceId,
      scope: null,
      outcome: 'unavailable',
      correlationId
    });
    await ack(ctx, 'rejected', selection.reason, unavailable);
    return;
  }

  const includedPhaseCount =
    selection.includedPhaseCount !== undefined
      ? { includedPhaseCount: selection.includedPhaseCount }
      : {};

  if (!ctx.deps.saveProcessYamlDocument) {
    const failure: ExportProcessYamlResult = {
      outcome: 'failed',
      message: 'Export is unavailable in this window.'
    };
    await appendExportAudit(ctx.deps, {
      resourceKind,
      resourceId,
      scope: selection.scope,
      outcome: 'failed',
      correlationId,
      ...includedPhaseCount
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

  await appendExportAudit(ctx.deps, {
    resourceKind,
    resourceId,
    scope: selection.scope,
    outcome: result.outcome,
    correlationId,
    ...includedPhaseCount
  });
  await ack(
    ctx,
    result.outcome === 'saved' ? 'accepted' : 'rejected',
    result.outcome === 'saved' ? undefined : result.outcome,
    result
  );
};
