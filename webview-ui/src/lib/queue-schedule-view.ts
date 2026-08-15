// Feature 095 (T001–T003, FR-008) — the webview's read seam for a queue's
// registry schedule.
//
// Two different things in this codebase are called "the schedule", and they are
// unrelated:
//
//   - `QueueState.scheduledStartAt` (feature 065) is written by CMD_START_QUEUE
//     with a `startIntent`, is paired with `queueLifecycle === 'idle-pending'`
//     by a hard rule, and is projected at the root as
//     `snapshot.queue.scheduledStartAt`. `ScheduledStartIndicator.svelte` reads
//     it. Nothing here touches it.
//
//   - `QueueRegistry.entries[].schedule` (feature 092) is written by
//     CMD_SET_QUEUE_SCHEDULE, is paired with nothing, and is projected per queue
//     as `QueueSummary.schedule`. That is what this file reads.
//
// The consequence worth stating: a queue's schedule is NOT gated on its
// lifecycle. A queue that is actively draining can carry one, and its target
// time must still display. Gating the read on `idle-pending` — which is what
// the 065 field requires — would blank the time for exactly the queues that are
// working.

import { formatAbsoluteTime } from './format';
import type { QueueSummary, WorkflowSnapshot } from './snapshot-types';

type SnapshotLike = Pick<WorkflowSnapshot, 'queue'> | null | undefined;

/**
 * The `QueueSummary` the snapshot publishes for `queueId`, or `null` when the
 * host has not projected the registry yet or the queue does not exist.
 */
export function findQueueSummary(snapshot: SnapshotLike, queueId: string): QueueSummary | null {
  return snapshot?.queue?.queues?.find((summary) => summary.id === queueId) ?? null;
}

/**
 * One queue's schedule, or `null` when it carries none. `null` means unarmed —
 * it is never a stand-in for "armed but not readable at this lifecycle".
 */
export function queueSchedule(snapshot: SnapshotLike, queueId: string): QueueSummary['schedule'] {
  return findQueueSummary(snapshot, queueId)?.schedule ?? null;
}

/**
 * The armed target as an operator-readable local timestamp. `targetAt` is an ISO
 * string the host already resolved from the expression; the webview formats it
 * and computes nothing (FR-007).
 */
export function formatScheduleTarget(targetAt: string): string {
  return formatAbsoluteTime(targetAt);
}
