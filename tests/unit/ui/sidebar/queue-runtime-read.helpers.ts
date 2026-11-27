// Feature 092 (T096, US4) — host-side reads of the v4 snapshot.
//
// The per-run singulars (`status`, `phases`, `liveActivity`, `activeFeature`,
// `activePipeline`, `workflowElapsedMs`, `resumeTargetPhaseId`,
// `phaseOverrides`, `phaseBreakpoints`, `manualPauseAt`/`manualPauseCause`) were
// deleted from the snapshot root by FR-049 and now hang off the queue that owns
// the Run. These two accessors are what a v3-era projector assertion becomes.
//
// They are two, not one, because they answer different questions. `runtimeOf`
// is the *queue*: it is published whether or not the queue owns a Run, and it
// carries the readings that survive a Run ending (the phase strip, the pending
// count, the lifecycle). `runOf` is the *Run*, and it is `null` for a queue that
// owns none — which is the empty projection of FR-053, not a missing queue.
//
// `runtimeOf` throws rather than returning null when the queue is absent,
// because a test that names a queue the registry does not have is asserting
// against nothing; a silent `undefined` there would read as a passing test.

import { findQueueRuntime, type WorkflowSnapshot } from '../../../../src/ui/sidebar/snapshot';
import type { InFlightRunProjection, QueueRuntime, WorkflowStatus } from '../../../../src/ui/sidebar/snapshot';
import { DEFAULT_QUEUE_ID } from '../../../../src/contracts/queue-identity';

export function runtimeOf(
  snapshot: Pick<WorkflowSnapshot, 'queues'>,
  queueId: string = DEFAULT_QUEUE_ID
): QueueRuntime {
  const runtime = findQueueRuntime(snapshot, queueId);
  if (runtime === null) throw new Error(`no queue runtime published for ${queueId}`);
  return runtime;
}

export function runOf(
  snapshot: Pick<WorkflowSnapshot, 'queues'>,
  queueId: string = DEFAULT_QUEUE_ID
): InFlightRunProjection | null {
  return runtimeOf(snapshot, queueId).inFlightRun;
}

/**
 * v3's root `status`, which read `'idle'` whenever no Run was up. A queue that
 * owns no Run has no status of its own, so the fallback is stated here once
 * rather than at each of the call sites that used to read the root field.
 */
export function statusOf(
  snapshot: Pick<WorkflowSnapshot, 'queues'>,
  queueId: string = DEFAULT_QUEUE_ID
): WorkflowStatus {
  return runOf(snapshot, queueId)?.status ?? 'idle';
}
