// FR-R4-F01 (spec 239, US1, FR-003, FR-004, contract C5 G15, decision TA3) — what
// the controller does when this window loses ONE queue's execution claim.
//
// A function in its own file rather than a method on `WorkflowController`: that
// class sits at 1,012 lines against a 1,040-line budget, and the behaviour here is
// small enough to be driven with three doubles. The controller only subscribes.
//
// The handler acts on the queue it is told about and on no other, and it never
// releases anything. A lost claim means another window is driving that queue; the
// loser stops its own driver for it and leaves everything the winner owns alone.
// Window primacy and every sibling queue's lease are none of its business (hard
// rule 4), which is why none of them is among its dependencies.

import type { SanitizedLogger } from '../lib/logger';
import type { ClaimLostReason } from '../state/execution-lease';

export interface LostOwnershipHandlerDeps {
  /** The controller's existing cancel ladder, addressed to one queue. */
  readonly cancelActive: (queueId: string) => void;
  readonly logger: Pick<SanitizedLogger, 'warn'>;
  /**
   * Queues whose claim this window lost. The caller's drain path reads it, so that
   * no drain is scheduled for one of them while its tenure is lost. Only a
   * `tryAcquire` that returns `acquired` takes a queue back out.
   */
  readonly lostQueueIds: Set<string>;
}

/**
 * Stop the driver of a queue this window no longer owns, once, and say so.
 *
 * Recording the loss comes first: a runner that fails to cancel must not be able
 * to hide it from the drain path. The runner's session gives back its slot through
 * `RunSession.disposeIfEnded` once the driver stops, as it does today.
 *
 * The notice is metadata only (FR-033): the queue id and a closed reason code. No
 * path, owner id or registry payload.
 */
export function handleClaimLost(
  deps: LostOwnershipHandlerDeps,
  queueId: string,
  reason: ClaimLostReason
): void {
  deps.lostQueueIds.add(queueId);
  deps.logger.warn('execution claim lost; stopping this queue', { queueId, reason });
  try {
    deps.cancelActive(queueId);
  } catch {
    deps.logger.warn('stopping the driver of a queue with a lost claim failed', { queueId });
  }
}
