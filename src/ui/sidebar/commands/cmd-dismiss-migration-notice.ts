// Feature 065 (T054a / FR-020) — handler for `CMD_DISMISS_MIGRATION_NOTICE`.
// Flips the persisted queue state's `migrationNotice` from `'pending'` to
// `'dismissed'` via a single persisted-state write.
//
// Trust profile:
//   - GATED (FR-R4-F05, FR-003): the dismiss writes the queue memento, which is
//     persisted state, so the router's workspace-trust gate and then its
//     primary-host gate run before this handler, and the command is serialized
//     with the other memento writers. Feature 065 FR-020 called it
//     non-destructive UX state and left it ungated; FR-003's rule is that any
//     persisted write is gated, however small.
//   - Empty payload — the operator's dismiss action carries no data beyond
//     the discriminator. The IPC type guard `isCmdDismissMigrationNotice`
//     enforces this in the contract layer.
//
// FR-020 invariants:
//   - The single persisted-state write MUST NOT touch
//     `scheduledStartSource` on any queue record. Those clear only on the
//     operator's next explicit start.
//   - Idempotent — calling dismiss when the notice is already `'dismissed'`
//     (or absent) returns a successful ack without an additional write.

import type { DismissMigrationNoticeCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

export const handler: CommandHandler<DismissMigrationNoticeCommand> = async (ctx) => {
  if (!ctx.deps.dismissMigrationNotice) {
    // No wiring — accept silently rather than wedging the dismiss. This
    // path is only reachable in tests that build a partial RouterDeps;
    // production wires it in extension.ts.
    await ack(ctx, 'accepted');
    return;
  }
  await ctx.deps.dismissMigrationNotice();
  await ack(ctx, 'accepted');
};
