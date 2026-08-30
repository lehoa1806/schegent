// FR-R3-144 (T018, D-2) — handler for `CMD_SET_UNCONTAINED_BACKEND_GRANT`.
//
// NOT ROUTED THROUGH `writeGeneralSettings`, and that is the point of the task
// rather than an implementation detail. `CMD_SAVE_GENERAL_SETTINGS` takes a draft
// of many keys and writes them as one batch; a rejected value anywhere in that
// batch is reported for the batch. Putting a security grant in it would mean an
// operator who mistyped `retry.maxAttempts` could lose a grant they made in the
// same visit, or keep one they revoked — and neither is visible in the ack, which
// names the batch. This command carries one id and one direction, and its ack says
// what happened to that one id.
//
// The handler is thin on purpose. Membership, the read-modify-write and the
// already-in-that-state short-circuit all live in
// `services/uncontained-grant-writer.ts`, because the consent modal reaches the
// same code by a different route and the two must not be able to disagree about
// what a grant is.

import type { SetUncontainedBackendGrantCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

export const handler: CommandHandler<SetUncontainedBackendGrantCommand> = async (ctx, command) => {
  const { kind, granted } = command.payload;
  const setGrant = ctx.deps.setUncontainedBackendGrant;
  if (!setGrant) {
    // Rejected, not silently accepted. A host with no wiring has written nothing,
    // and reporting that as success would leave the operator believing a backend
    // is granted — or revoked — when the setting never moved. `Feature 063`'s
    // suppression handler accepts silently in the same situation; a UI preference
    // and a spawn authorization are not the same kind of thing.
    await ack(ctx, 'rejected', 'config-ops-unavailable');
    return;
  }

  const outcome = await setGrant(kind, granted);
  switch (outcome.decision) {
    case 'granted':
    case 'denied':
      // Both are the state the operator asked for, reached. `denied` after a
      // revoke means the grant is gone, which is success for that request.
      await ack(ctx, 'accepted', undefined, { decision: outcome.decision, kind });
      return;
    case 'write-failed':
      await ack(ctx, 'rejected', 'write-failed', { kind, reason: outcome.reason });
      return;
    default:
      // `not-applicable`: the list does not govern this id — `codex` carries an
      // OS-enforced bound, or the id is not a backend. The message is the policy
      // module's own sentence, carried verbatim so the surface does not restate a
      // rule it does not own.
      await ack(ctx, 'rejected', outcome.problem, { kind, message: outcome.message });
      return;
  }
};
