// FR-R4-F05 (FR-016, FR-017; contract F, F7, F8) — what a failed enqueue write means,
// decided once and in one place.
//
// WHY THIS IS ITS OWN MODULE. `GuardedRunService.scheduleOrEnqueue` caught anything its
// enqueue threw and reported it as `rejected-validation` with the exception's message as
// the reason. That told the operator their request was invalid when the queue state could
// not be read or saved, and it put a path into an audit row and onto a toast. A thrown
// `QueueMutationRejected` really is the queue's own rules refusing the request, and its
// reason is a member of a closed union, so it is a validation outcome with that code. Any
// other throw, and the one rejection that means the ownership fence could not be read, is
// a storage fault: the request may be fine and nothing was committed, so the answer is a
// different outcome with one fixed code.
//
// The classifier lives here and not in `guarded-run-service.ts` because that file sits at
// 879 lines against a 1,000-line budget, and because the palette consumers import the
// shared toast text from the same place as the code they test for.
//
// It never reads `err.message`. This module imports no VS Code API and does no I/O.

import { QueueMutationRejected, type QueueMutationRejectReason } from '../state/workspace-state';

/** The one fixed reason a storage fault carries, in a result, an audit row and a webview map. */
export const QUEUE_STATE_UNAVAILABLE = 'queue-state-unavailable';

/**
 * The text every palette command shows for a storage fault (contract F, F8). One sentence
 * for four consumers, so they cannot drift, and it echoes no reason.
 */
export const ENQUEUE_STORAGE_FAULT_TOAST =
  'Schegent: the queue could not be read or saved. Check the queue before trying again.';

export type EnqueueFailureClass =
  | { readonly outcome: 'rejected-validation'; readonly reason: QueueMutationRejectReason }
  | { readonly outcome: 'failed-storage'; readonly reason: typeof QUEUE_STATE_UNAVAILABLE };

const STORAGE_FAULT: EnqueueFailureClass = Object.freeze({
  outcome: 'failed-storage',
  reason: QUEUE_STATE_UNAVAILABLE
});

/**
 * Classify whatever `queue.enqueue` threw. A queue rule refusal keeps its own code; the
 * unverifiable-fence refusal, and everything that is not a refusal, is a storage fault.
 */
export function classifyEnqueueFailure(thrown: unknown): EnqueueFailureClass {
  if (thrown instanceof QueueMutationRejected && thrown.reason !== 'fence-unverifiable') {
    return { outcome: 'rejected-validation', reason: thrown.reason };
  }
  return STORAGE_FAULT;
}
