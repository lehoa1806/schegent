// FR-R3-150 (T1618) — thin IPC handler for `CMD_CLEAR_QUEUE`, the
// queue-scoped Clean All that replaces `CMD_CLEAR_ALL` as the sidebar-postable
// route (research.md D1). Delegates to the `schegent.clearQueue` VS Code
// command, which runs `runClearQueue(...)` against the real workspace state
// through the queue-scoped orchestrator (`src/commands/clear-queue.ts`). The
// orchestrator owns toast messaging, audit emission, and lock handling; this
// module forwards the addressed `queueId` and relays the orchestrator's own
// `ok`/`reason` outcome back over the IPC ack — code review finding: the
// retired `cmd-clear-all.ts` this was first modeled on could get away with an
// unconditional `ack(ctx, 'accepted')` because `CMD_CLEAR_ALL` had no
// unknown-id refusal path; `CMD_CLEAR_QUEUE` does (FR-011), and swallowing it
// here would leave the operator believing a refused Clean All had succeeded.
//
// Code-review finding (iteration 5) — the relay is `execAndAck`, the helper
// FR-R3-154 (T1646) added for exactly this shape, rather than a hand-rolled
// `executeCommand` + `ackGenericResult` pair. Three things the hand-rolled
// version got wrong or could not say:
//
//   1. NO CATCH. `executeCommand` rejects when VS Code cannot resolve the id,
//      or when the command's own conversion does not hold. That rejection
//      escaped this handler, so the route ACKed nothing at all and the
//      webview's correlation timed out — an operator told "the host did not
//      answer" about a Clean All that may well have run. `execForOutcome`
//      catches it, logs the SANITIZED message, and ACKs the code
//      `command-dispatch-failed`; the message never enters `reason`, because
//      `reason` crosses to the webview and a message from this layer carries
//      paths.
//   2. THE TRUST REFUSAL, READ AS AN UNEXPLAINED ONE. `ackGenericResult` maps
//      a reasonless `{ ok: false }` to `operation-rejected`, so the Workspace
//      Trust gate's `undefined` — the case where the handler never ran —
//      reached the operator as "The host refused the operation."
//      `normalizeCommandResult` names it `workspace-not-trusted`.
//   3. NO `outcome` FIELD. Every other mutating route on this transport now
//      carries the four-word vocabulary (`accepted`/`no-op`/`refused`/
//      `failed`) alongside `status`; this one carried only `status`.
//
// The orchestrator's own `{ ok, reason }` shape still travels verbatim through
// `fromMutationResult`, so `not-primary` and `persistence-error` reach
// `refusalText` exactly as before.
//
// Code-review finding (iteration 5, second) — the `queueId` read is guarded.
// `isCmdClearQueue` is a discriminator-only check by decision, and its own test
// pins that decision ("accepts a missing payload too — shape/registry
// validation lives one layer down"). That layering holds only if this handler
// can REACH the layer below, and `command.payload.queueId` on an absent payload
// does not: it throws a `TypeError` here. `message-router.ts` then ACKs
// `logger.sanitize(err.message)` — a free-form message in the field the ACK
// contract reserves for codes, which no refusal table maps, so it renders as
// "The host refused: Cannot read properties of undefined…". The refusal below
// is `missing-payload`, which `REFUSAL_TEXT` already words ("The request was
// incomplete and was not sent.").
//
// The read goes through a widened view of the message rather than
// `command.payload?.queueId`. The declared type calls `payload` required, so
// an optional chain on it reads as dead code to
// `@typescript-eslint/no-unnecessary-condition` — a baselined lint gate here —
// and the widening cast is the honest statement of the mismatch: the type
// guard admits messages this type does not describe, so the property really
// can be absent at runtime.
import type { ClearQueueCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ackCommandOutcome, execAndAck } from './handler-helpers';
import { refused } from '../../../contracts/command-outcome';

export const handler: CommandHandler<ClearQueueCommand> = async (ctx, command) => {
  const queueId = (command as { payload?: { queueId?: unknown } }).payload?.queueId;
  if (typeof queueId !== 'string' || queueId.length === 0) {
    await ackCommandOutcome(ctx, refused('missing-payload'));
    return;
  }
  await execAndAck(ctx, 'schegent.clearQueue', queueId);
};
