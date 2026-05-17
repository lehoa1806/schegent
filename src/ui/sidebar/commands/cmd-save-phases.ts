import { validate as validateRetryCondition } from '../../../lib/retry-condition';
import { EFFORT_LEVELS } from '../../../config/pipeline-config';
import type { SavePhasesCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

export const handler: CommandHandler<SavePhasesCommand> = async (ctx, command) => {
  if (!ctx.deps.updateConfig) {
    await ack(ctx, 'rejected', 'config-ops-unavailable');
    return;
  }
  const phasesPayload = command.payload.phases as readonly {
    id?: unknown;
    retryCondition?: unknown;
    effort?: unknown;
    model?: unknown;
  }[];
  // Feature 011 T059 — final-validation pass: every phase that declares a
  // `retryCondition` MUST parse with the host's DSL validator. This catches
  // webview-validator drift (FR-030).
  //
  // Feature 026 T013a — per-row `effort` and `model` validation. Both fields
  // are optional at the wire (an absent override means "inherit from the
  // pipeline / built-in default"), but when present they must be
  // well-formed. The pass is all-or-nothing: a single bad row blocks the
  // entire `updateConfig('phases', …)` call so the user-layer state stays
  // coherent (FR-004 / FR-005).
  for (const phase of phasesPayload) {
    const phaseId = String(phase.id ?? '?');
    if (phase.effort !== undefined && phase.effort !== null && phase.effort !== '') {
      if (
        typeof phase.effort !== 'string' ||
        !(EFFORT_LEVELS as readonly string[]).includes(phase.effort)
      ) {
        await ack(
          ctx,
          'rejected',
          `phase-validation:${phaseId}:effort:must-be-one-of-${EFFORT_LEVELS.join(',')}`
        );
        return;
      }
    }
    if (phase.model !== undefined && phase.model !== null) {
      if (typeof phase.model !== 'string' || phase.model.length === 0) {
        await ack(
          ctx,
          'rejected',
          `phase-validation:${phaseId}:model:must-be-non-empty-string`
        );
        return;
      }
    }
    const rc = phase.retryCondition;
    if (rc === undefined || rc === null || rc === '') continue;
    if (typeof rc !== 'string') {
      await ack(ctx, 'rejected', `retry-condition-invalid:${phaseId}:must-be-string`);
      return;
    }
    const parsed = validateRetryCondition(rc);
    if (!parsed.ok) {
      await ack(ctx, 'rejected', `retry-condition-invalid:${phaseId}:${parsed.error}`);
      return;
    }
  }
  await ctx.deps.updateConfig('phases', command.payload.phases);
  await ack(ctx, 'accepted');
};
