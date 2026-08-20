// Feature 082 (US1 FR-002, US7 FR-022a) — the single definition of "a Workflow
// that consumes a Pipeline".
//
// Two surfaces needed the same answer and had to never disagree:
//   * the Library, which lists each Pipeline's consuming Workflows so an
//     operator can see what a change would affect (FR-002);
//   * gate 13 in `commands/cmd-save-pipelines.ts`, which refused a removal that
//     would leave one of those references unresolved (FR-022a).
//
// Feature 100 (T513b) — the second is gone with the whole-array save (T509), so
// the Library is the only caller. What replaced the gate — the `referenced`
// refusal on deactivate — deliberately asks a narrower question: FR-025b scopes
// it to direct references from *active stored definitions*, and a queued request
// that has not frozen its plan is covered by FR-026 instead. The queue-derived
// answer below is therefore still correct for what it is used for, and is no
// longer load-bearing for a refusal.
//
// A queued request is a consumer only while it still resolves its Pipeline from
// the catalog. Two things end that, and both must be checked:
//
//   * it started — the Run froze the Pipeline contract (FR-027), so editing or
//     removing the catalog source can no longer reach it;
//   * it reached a terminal status — it will never resolve the Pipeline again.
//
// The two are not the same test. `QueueManager.cancel()` acts only on a
// *pending* request and leaves `runId` null, so a canceled Workflow passes the
// started check; counting it would block a removal nothing is waiting on. A
// request that pins no `pipelineId` is never a consumer either.

import type { FeatureRequest, FeatureRequestStatus } from '../../queue/feature-request';
import type { WorkflowRunRequestPipelineReference } from './commands/router-types';

/**
 * Statuses no request leaves except through `QueueManager.retry()`, which resets
 * it to `pending` with a cleared `runId` — at which point it is a consumer again.
 */
const TERMINAL_STATUSES: ReadonlySet<FeatureRequestStatus> = new Set([
  'completed',
  'canceled',
  'failed'
]);

export function collectWorkflowPipelineRefs(
  requests: readonly FeatureRequest[]
): readonly WorkflowRunRequestPipelineReference[] {
  const refs: WorkflowRunRequestPipelineReference[] = [];
  for (const request of requests) {
    if (request.runId !== null) continue;
    if (TERMINAL_STATUSES.has(request.status)) continue;
    const pipelineId = request.pipelineId;
    if (pipelineId === undefined) continue;
    refs.push({ workflowId: request.id, pipelineId, kind: 'run-request' });
  }
  return refs;
}
