// Feature 195 (T036, FR-018, FR-019) — `CMD_SET_QUEUE_FAILURE_POLICY` handler
// body, extracted the same way `phase-control-commands.ts` and
// `start-queue.ts` are: the sidebar route (`cmd-set-queue-failure-policy.ts`)
// has a `CommandOutcome` to ack rather than an unconditional `accepted`.
//
// `policy: null` means "follow the workspace default" and is `QueueManager
// .setFailurePolicy`'s own signal to remove the stored field, not to write
// one (contract §6, FR-018). This command evaluates no eligibility rule of
// its own — `QueueManager` is the single place that decides unknown-queue and
// already-set, and this is a reader of what it decided, on the same "one
// decision site" precedent `start-queue.ts` documents for the halt predicate.

import type { QueueManager } from '../queue/queue-manager';
import type { QueueFailurePolicy } from '../contracts/queue-failure-policy';
import type { SanitizedLogger } from '../lib/logger';
import {
  ACCEPTED,
  failed,
  noOp,
  refused,
  type CommandOutcome
} from '../contracts/command-outcome';
import { errorMessage } from '../lib/errors';

export interface SetQueueFailurePolicyCommandDeps {
  readonly queue: Pick<QueueManager, 'setFailurePolicy'>;
  readonly logger: Pick<SanitizedLogger, 'error'>;
}

export interface SetQueueFailurePolicyCommandArg {
  readonly queueId: string;
  readonly policy: QueueFailurePolicy | null;
}

export async function runSetQueueFailurePolicyCommand(
  arg: SetQueueFailurePolicyCommandArg,
  deps: SetQueueFailurePolicyCommandDeps
): Promise<CommandOutcome> {
  try {
    const result = await deps.queue.setFailurePolicy(arg.queueId, arg.policy);
    if (result.ok) return ACCEPTED;
    const reason = result.reason ?? 'operation-rejected';
    // `QueueManager.setFailurePolicy`'s own idempotent-reject reason — the
    // one case this command reads as "nothing to commit" rather than "the
    // host declined" (FR-019).
    if (reason === 'failure-policy-unchanged') return noOp(reason);
    return refused(reason);
  } catch (err) {
    deps.logger.error(`setQueueFailurePolicy: ${errorMessage(err)}`);
    // A code, not the caught error's message: this value crosses to the webview.
    return failed('set-queue-failure-policy-failed');
  }
}
