// Feature 063 — T031. Handler for `CMD_SET_CONFIRM_SUPPRESSION`. Persists
// the per-action "Don't ask again" preference to the
// `schegent.ui.confirmSuppression` memento via `WorkspaceState`.
//
// Validation:
//   1. `command.payload.actionKey` MUST be a member of the closed
//      `KNOWN_ACTION_KEYS` set (mirrored from action-copy.ts). Unknown
//      keys are rejected with a sanitized log line and NO memento write.
//   2. `command.payload.suppressed` is already constrained to `boolean`
//      by the IPC type guard.
//
// No audit event: suppression preference changes are non-destructive UX
// state per the contract.

import type { SetConfirmSuppressionCommand } from '../messages';
import { KNOWN_ACTION_KEYS } from '../../../state/confirm-suppression';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

export const handler: CommandHandler<SetConfirmSuppressionCommand> = async (ctx, command) => {
  const { actionKey, suppressed } = command.payload;
  if (!KNOWN_ACTION_KEYS.has(actionKey)) {
    ctx.deps.logger.warn(
      `sidebar router: CMD_SET_CONFIRM_SUPPRESSION rejected — unknown actionKey ${ctx.deps.logger.sanitize(
        actionKey
      )}`
    );
    await ack(ctx, 'rejected', 'unknown-action-key');
    return;
  }
  if (!ctx.deps.setConfirmSuppression) {
    // No wiring — accept silently rather than wedging the dialog. This
    // path is only reachable in tests that build a partial RouterDeps;
    // production wires it in extension.ts.
    await ack(ctx, 'accepted');
    return;
  }
  await ctx.deps.setConfirmSuppression(actionKey, suppressed);
  await ack(ctx, 'accepted');
};
