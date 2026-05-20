// Feature 059 (US1/US3) — per-capability trust gate for CMD_SAVE_PHASES.
// Contract: specs/059-fine-grained-trust-scopes/contracts/save-command-trust-gate-contract.md
//
// The gate runs AFTER existing DSL/effort/model validation and BEFORE
// the persistent `updateConfig` call. It honors three invariants from
// the contract:
//   I-2: a payload byte-equivalent to `BUILT_IN_PHASES` always passes
//        (reset-to-defaults is unconditionally allowed).
//   I-3: row-granularity retry-condition check uses
//        `defaultRetryConditionForPhaseId` as the per-row "default" baseline.
//   I-4: at most one denial per save; `phases` takes precedence over
//        `retryConditions` and short-circuits the row scan.

import { validate as validateRetryCondition } from '../../../lib/retry-condition';
import {
  EFFORT_LEVELS,
  PHASE_ID_PATTERN,
  defaultRetryConditionForPhaseId,
  equalsBuiltInPhases
} from '../../../config/pipeline-config';
import { isCapabilityAllowed } from '../../../state/capability-trust-resolver';
import type { SavePhasesCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';
import { denyAndAudit } from './trust-gate';

export const handler: CommandHandler<SavePhasesCommand> = async (ctx, command) => {
  if (!ctx.deps.updateConfig) {
    await ack(ctx, 'rejected', 'config-ops-unavailable');
    return;
  }
  const phasesPayload = command.payload.phases as readonly {
    id?: unknown;
    name?: unknown;
    instruction?: unknown;
    loopable?: unknown;
    retryCondition?: unknown;
    effort?: unknown;
    model?: unknown;
  }[];
  // BUG-001 (FR-012) — foundational field validation. Runs BEFORE the
  // existing effort/model/retryCondition checks and BEFORE the trust gate.
  // Mirrors the constraints in `validatePhaseRaw()` so invalid entries are
  // caught at the IPC boundary instead of being persisted and then silently
  // discarded by the all-or-nothing `loadCatalog()` fallback.
  for (const phase of phasesPayload) {
    const phaseId = typeof phase.id === 'string' ? phase.id : String(phase.id ?? '?');
    if (typeof phase.id !== 'string' || !PHASE_ID_PATTERN.test(phase.id)) {
      await ack(ctx, 'rejected', `phase-validation:${phaseId}:id:invalid-pattern`);
      return;
    }
    if (typeof phase.name !== 'string' || phase.name.length === 0) {
      await ack(ctx, 'rejected', `phase-validation:${phaseId}:name:must-be-non-empty`);
      return;
    }
    if (phase.name.length > 80) {
      await ack(ctx, 'rejected', `phase-validation:${phaseId}:name:exceeds-max-length`);
      return;
    }
    if (typeof phase.instruction !== 'string' || phase.instruction.length === 0) {
      await ack(ctx, 'rejected', `phase-validation:${phaseId}:instruction:must-be-non-empty`);
      return;
    }
    if (phase.instruction.length > 8192) {
      await ack(ctx, 'rejected', `phase-validation:${phaseId}:instruction:exceeds-max-length`);
      return;
    }
    if (typeof phase.loopable !== 'boolean') {
      await ack(ctx, 'rejected', `phase-validation:${phaseId}:loopable:must-be-boolean`);
      return;
    }
  }
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
    if (rc === undefined || rc === null || rc === '') {
      if (phase.loopable === true) {
        await ack(
          ctx,
          'rejected',
          `phase-validation:${phaseId}:retryCondition:required-when-loopable`
        );
        return;
      }
      continue;
    }
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

  // Feature 059 trust gate — see header docstring.
  // I-2: reset-to-defaults is always allowed.
  if (!equalsBuiltInPhases(command.payload.phases as readonly unknown[])) {
    // Step 2: phases-level check (precedence).
    if (!isCapabilityAllowed('phases')) {
      await denyAndAudit(ctx, 'phases');
      return;
    }
    // Step 3: row-granularity retry-conditions check.
    for (let i = 0; i < phasesPayload.length; i++) {
      const phase = phasesPayload[i];
      const phaseId = String(phase.id ?? '');
      const submittedRc =
        typeof phase.retryCondition === 'string' && phase.retryCondition !== ''
          ? phase.retryCondition
          : undefined;
      const defaultRc = defaultRetryConditionForPhaseId(phaseId);
      if (submittedRc !== defaultRc) {
        if (!isCapabilityAllowed('retryConditions')) {
          await denyAndAudit(ctx, 'retryConditions', i);
          return;
        }
        // I-4: one denial per save. Break the row scan as soon as the
        // first non-default retry-condition row is observed AND the
        // capability is allowed.
        break;
      }
    }
  }

  await ctx.deps.updateConfig('phases', command.payload.phases);
  await ack(ctx, 'accepted');
};
