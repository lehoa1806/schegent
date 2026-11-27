import type { AttestTaskCompletedCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { execAndAck } from './handler-helpers';

// Feature 195 (T064, FR-025) — the operator asserts that a failed task's work
// completed outside the tool, ending the halt without a re-run and without
// discarding the row.
//
// One line, the same shape as `cmd-retry-queue-item` and
// `cmd-restart-canceled-task`, and deliberately not the shape of
// `cmd-set-queue-failure-policy`, which re-checks its own payload: the ingress
// validator has already refused an attestation that did not carry
// `confirmed: true`, and a second consent check here would be a second site
// deciding whether the operator asserted anything.
//
// It delegates rather than calling `QueueManager.attestCompleted` itself for the
// reason `cmd-retry-queue-item`'s comment records: returning a task to a
// non-blocking status is not the same thing as asking the queue to drain, and
// the registered command is where that trigger lives.
//
// The refusal reason still reaches the operator — `runAttestTaskCompleted` warns
// through the host notifier before returning `{ ok: false }`, and the ACK
// carries the reason the transition table gave.
export const handler: CommandHandler<AttestTaskCompletedCommand> = async (ctx, command) => {
  await execAndAck(ctx, 'schegent.attestTaskCompleted', { id: command.payload.taskId });
};
