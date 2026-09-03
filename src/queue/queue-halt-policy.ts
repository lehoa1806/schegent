// Feature 195 (T005, FR-002, FR-004, FR-005, FR-006) — the halt predicate.
//
// Pure: no clock, no store, no I/O, no logging. Every call recomputes its
// answer from the rows handed to it (FR-003) — nothing here remembers a
// previous verdict, and nothing here may start remembering one.
//
// Contract: specs/195-queue-halt-on-failure/contracts/queue-failure-policy.md
// Data model: specs/195-queue-halt-on-failure/data-model.md

import type { FeatureRequest, FeatureRequestStatus } from './feature-request';
import type { QueueFailurePolicy } from '../contracts/queue-failure-policy';

/**
 * The one status that blocks further starts (FR-005). `canceled` is
 * deliberately excluded: an operator cancelling a task is expressing intent
 * to move past it, not reporting a fault the queue should stop over, and
 * `paused` is a Task an operator or the retry cap will resume on its own —
 * neither is evidence the queue is broken the way a `failed` row is.
 */
const BLOCKING_STATUSES: ReadonlySet<FeatureRequestStatus> = new Set(['failed']);

export function isBlockingTaskStatus(status: FeatureRequestStatus): boolean {
  return BLOCKING_STATUSES.has(status);
}

/**
 * The failed row a halt names, or `null` when the queue is not halted.
 *
 * Only `taskId`/`taskName` — no status, no timestamp. The verdict is not
 * carried anywhere (FR-003); a caller that needs more reads the row itself
 * off the same `requests` array this function was handed.
 */
export interface QueueHaltVerdict {
  readonly taskId: string;
  readonly taskName: string;
}

/**
 * `halt-on-failure` MUST NOT be evaluated when the effective policy is
 * `continue` — there is nothing to halt on, and a caller that skips this
 * function entirely under `continue` gets the identical answer.
 *
 * FR-008 — when more than one row blocks, names the earliest in queue
 * (`position`) order, so a halted queue reports the same task on every
 * attempt until that task is dealt with.
 */
export function evaluateQueueHalt(
  policy: QueueFailurePolicy,
  requests: readonly FeatureRequest[]
): QueueHaltVerdict | null {
  if (policy !== 'halt-on-failure') return null;
  const blocking = requests
    .filter((request) => isBlockingTaskStatus(request.status))
    .sort((a, b) => a.position - b.position);
  if (blocking.length === 0) return null;
  const first = blocking[0];
  return { taskId: first.id, taskName: first.description };
}
