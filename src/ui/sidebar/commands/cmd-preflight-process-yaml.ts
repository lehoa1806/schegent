// Feature 084 T030/T031 — import preflight: read one document, say what
// importing it would do, change nothing.
//
// Read-only by construction (FR-031, FR-032). It writes no configuration, moves
// no layer revision, takes no lock, and retains nothing past the read, so it is
// deliberately NOT a member of `MUTATING_COMMANDS`. The write happens later,
// through `CMD_PUBLISH_PACKAGE`, which IS gated.
//
// This directory imports no `vscode`: the open dialog and the read are an
// injected dependency (`openProcessYamlDocument`) wired in `src/extension.ts`,
// so no location crosses this boundary in either direction (FR-020a, R3).
//
// Feature 089 T002 — what remains here is the seam and nothing else: open a
// document, hand the bytes down, acknowledge the answer. Byte parsing, kind
// dispatch, catalog assembly, per-kind planning, defect bounding, and the refusal
// audit append moved to `services/process-yaml/preflight-service.ts`, which the
// headless entrypoint calls too (FR-003, FR-004). The three arms below are the
// ones that describe the DIALOG rather than the document — unavailable, canceled,
// unreadable — which is precisely why they are what stayed.
//
// The earlier notes on what leaves this boundary still hold, and now hold in the
// service: everything is sanitized through the host's own `logger.sanitize` and
// bounded to the caps `boundedValidationResult` uses, with `SECRET_PATTERNS`
// unforked (FR-050); a Workflow defect field is bounded at 48 rather than 32
// because its paths are longer; and the request names no kind, because asking an
// operator to classify a file before opening it would make "picked the wrong
// per-kind action" a reachable failure (FR-055a).

import { preflightProcessDocument } from '../../../services/process-yaml/preflight-service';
import type { PreflightProcessYamlCommand, PreflightProcessYamlResult } from '../messages';
import type { CommandHandler, HandlerContext } from './handler-contract';
import { ack } from './handler-helpers';

async function respond(ctx: HandlerContext, result: PreflightProcessYamlResult): Promise<void> {
  await ack(
    ctx,
    result.outcome === 'planned' ? 'accepted' : 'rejected',
    result.outcome === 'planned' ? undefined : result.outcome,
    result
  );
}

export const handler: CommandHandler<PreflightProcessYamlCommand> = async (ctx) => {
  if (!ctx.deps.openProcessYamlDocument) {
    await respond(ctx, { outcome: 'failed', message: 'Import is unavailable in this window.' });
    return;
  }

  let opened: Awaited<ReturnType<NonNullable<typeof ctx.deps.openProcessYamlDocument>>>;
  try {
    opened = await ctx.deps.openProcessYamlDocument();
  } catch (err) {
    ctx.deps.logger.warn(
      `sidebar router: process-yaml preflight read failed: ${ctx.deps.logger.sanitize(
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

  await respond(
    ctx,
    await preflightProcessDocument(ctx.deps, {
      bytes: opened.bytes,
      correlationId: ctx.correlationId
    })
  );
};
