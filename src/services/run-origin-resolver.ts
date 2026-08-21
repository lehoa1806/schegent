// Feature 103 (T029, FR-013) — the production answer to "how was this run
// started", read once at completion and stamped into the history record.
//
// The link is `WorkflowRun.featureId === ChildRunRef.queueItemId`. A connected
// Workflow run enqueues one child Task per node attempt and keeps the queue-item
// id on the attempt; the child Run that later completes carries that same id as
// its `featureId`. Nothing else connects the two — a member Run holds no
// back-reference to the Workflow that started it, by design, because a member
// executes a frozen Pipeline snapshot and knows nothing about the graph above it.
//
// This lives beside the recorder rather than inside it so the recorder keeps
// taking a port it can be handed a stub for, exactly as `queueIdForTask` does,
// and so the two composition roots share one implementation instead of two
// copies of the same walk.

import type { ConnectedWorkflowRun } from '../state/connected-workflow-run';
import type { RunOriginRef } from '../contracts/run-origin';

/**
 * How the run holding `taskId` was started, from the live connected-run map.
 *
 * Answers `'standalone'` when no connected run claims the id, which is the
 * common case and the true one: a Task nothing connected was started on its own.
 * That is why this returns a value rather than `null` — "not found here" is a
 * real answer, unlike `queueIdForTask`'s, where a missing queue is genuinely
 * unknown rather than a default.
 *
 * Two callers, one answer. `createHistoryRecorder` reads it **once, at
 * completion**, and stamps the result into the record, which outlives the map.
 * The snapshot projector reads it on **every compose** (T031, FR-003), because
 * until the Run completes there is no record holding the answer and the
 * aggregate is deletable. Both read the same live map through the same walk, so
 * a Run in flight and the same Run once recorded answer identically.
 */
export function resolveRunOrigin(
  connectedRuns: Readonly<Record<string, ConnectedWorkflowRun>>,
  taskId: string
): RunOriginRef {
  if (taskId.length === 0) return { kind: 'standalone' };
  for (const run of Object.values(connectedRuns)) {
    for (const node of Object.values(run.nodes)) {
      for (const attempt of node.attempts) {
        if (attempt.queueItemId === taskId) {
          // `workflowId` is never `''` on a live aggregate, but a blank one
          // would be a present-but-blank identity — neither recorded nor
          // absent. Falling through to standalone would assert something false,
          // so the loop keeps looking and, finding nothing better, the caller
          // records a standalone run it can at least defend.
          if (run.workflowId.length > 0) {
            return { kind: 'workflow-member', workflowId: run.workflowId };
          }
        }
      }
    }
  }
  return { kind: 'standalone' };
}
