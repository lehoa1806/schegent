// Feature 059 (US4) — per-capability trust gate for CMD_SAVE_PIPELINES.
// Contract: specs/059-fine-grained-trust-scopes/contracts/save-command-trust-gate-contract.md
//
// Reset-to-defaults (a payload byte-equivalent to `BUILT_IN_PIPELINES`)
// always passes (I-2). A non-default payload submitted while
// `allowPipelineOverrides` is `false` is rejected with `trust-denied`
// and one audit event is emitted (I-4, I-5).

import { PHASE_ID_PATTERN, equalsBuiltInPipelines } from '../../../config/pipeline-config';
import { isCapabilityAllowed } from '../../../state/capability-trust-resolver';
import type { SavePipelinesCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';
import { denyAndAudit } from './trust-gate';

export const handler: CommandHandler<SavePipelinesCommand> = async (ctx, command) => {
  if (!ctx.deps.updateConfig) {
    await ack(ctx, 'rejected', 'config-ops-unavailable');
    return;
  }

  // BUG-001 (FR-013) — foundational field validation. Runs BEFORE the
  // trust gate so invalid entries are caught at the IPC boundary instead
  // of being persisted and then silently discarded by the all-or-nothing
  // `loadCatalog()` fallback.
  const pipelinesPayload = command.payload.pipelines as readonly {
    id?: unknown;
    name?: unknown;
    phases?: unknown;
  }[];
  for (const pipeline of pipelinesPayload) {
    const pipelineId = typeof pipeline.id === 'string' ? pipeline.id : String(pipeline.id ?? '?');
    if (typeof pipeline.id !== 'string' || !PHASE_ID_PATTERN.test(pipeline.id)) {
      await ack(ctx, 'rejected', `pipeline-validation:${pipelineId}:id:invalid-pattern`);
      return;
    }
    if (typeof pipeline.name !== 'string' || pipeline.name.length === 0) {
      await ack(ctx, 'rejected', `pipeline-validation:${pipelineId}:name:must-be-non-empty`);
      return;
    }
    if (pipeline.name.length > 80) {
      await ack(ctx, 'rejected', `pipeline-validation:${pipelineId}:name:exceeds-max-length`);
      return;
    }
    if (!Array.isArray(pipeline.phases) || pipeline.phases.length === 0) {
      await ack(ctx, 'rejected', `pipeline-validation:${pipelineId}:phases:must-be-non-empty`);
      return;
    }
    if (!pipeline.phases.every((p: unknown) => typeof p === 'string')) {
      await ack(ctx, 'rejected', `pipeline-validation:${pipelineId}:phases:must-be-strings`);
      return;
    }
  }

  if (!equalsBuiltInPipelines(command.payload.pipelines as readonly unknown[])) {
    if (!isCapabilityAllowed('pipelineOverrides')) {
      await denyAndAudit(ctx, 'pipelineOverrides');
      return;
    }
  }
  await ctx.deps.updateConfig('pipelines', command.payload.pipelines);
  await ack(ctx, 'accepted');
};
