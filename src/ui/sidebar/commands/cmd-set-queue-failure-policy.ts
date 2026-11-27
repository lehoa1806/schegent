// Feature 195 (T038, FR-018, FR-019) — thin IPC handler for
// `CMD_SET_QUEUE_FAILURE_POLICY`. Same shape as `cmd-clear-queue.ts`:
// delegates to the `schegent.setQueueFailurePolicy` VS Code command
// (registered-only, `ui-wiring.ts`), which runs
// `runSetQueueFailurePolicyCommand(...)` against the real `QueueManager`, and
// relays the host's own `CommandOutcome` back over the IPC ack through
// `execAndAck` — never an unconditional `accepted` (FR-019).
//
// `isCmdSetQueueFailurePolicy` is a discriminator-only guard by decision
// (`sidebar-ipc.ts`'s own comment on the pattern); the payload shape and the
// `policy ∈ QUEUE_FAILURE_POLICIES ∪ {null}` bound are `validators/
// queue-management.ts`'s job, one layer down. This handler still narrows the
// two fields it reads defensively, the same way `cmd-clear-queue.ts` reads
// `queueId`: the declared payload type is required, so an optional chain on
// it reads as dead code to the baselined `no-unnecessary-condition` lint, and
// a widened read is the honest statement that a message narrowed only by its
// discriminant can still carry a missing or malformed field at runtime.
import type { SetQueueFailurePolicyCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ackCommandOutcome, execAndAck } from './handler-helpers';
import { refused } from '../../../contracts/command-outcome';
import { QUEUE_FAILURE_POLICIES } from '../../../contracts/queue-failure-policy';

export const handler: CommandHandler<SetQueueFailurePolicyCommand> = async (ctx, command) => {
  const payload = (command as { payload?: { queueId?: unknown; policy?: unknown } }).payload;
  const queueId = payload?.queueId;
  if (typeof queueId !== 'string' || queueId.length === 0) {
    await ackCommandOutcome(ctx, refused('missing-payload'));
    return;
  }
  const policy = payload?.policy;
  const isKnownPolicy =
    typeof policy === 'string' && (QUEUE_FAILURE_POLICIES as readonly string[]).includes(policy);
  if (policy !== null && !isKnownPolicy) {
    await ackCommandOutcome(ctx, refused('missing-payload'));
    return;
  }
  await execAndAck(ctx, 'schegent.setQueueFailurePolicy', queueId, policy);
};
