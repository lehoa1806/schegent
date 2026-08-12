// Feature 089 T013 — launch one Pipeline run without the editor host.
// Contract: specs/089-headless-parity-qualification/contracts/headless-api.md §3
//
// A delegate, and deliberately nothing more. `startPipelineRun()` already owns
// gates 5-8 in their fixed order — definition resolution, request validation,
// freeze, enqueue — and this entrypoint neither reorders them, adds one, nor
// skips one (FR-010, FR-011).
//
// It adds **no scheduler and no drain loop of its own** (FR-012). The queue that
// admits the request is the queue the sidebar's launch reaches, promotion stays
// the `AutoDrainCoordinator`'s single gate, and a headless caller that enqueues
// while a run is in flight waits exactly as an operator does. A second scheduler
// here would be a second authority over the same single queue, which is the one
// thing the queue's design does not survive.
//
// The workspace root is a **value**, not a reader: it is the one thing only the
// editor host can resolve, it is already threaded through `startPipelineRun` as a
// value, and keeping that shape is what lets this module stay import-clean
// (FR-007, data-model.md §2).

import {
  startPipelineRun,
  type NodeRunStartDeps,
  type NodeRunStartResult
} from '../services/workflow-execution/node-run-starter';
import type { RunRequest } from '../contracts/run-request';
import {
  checkQueueId,
  checkRunRequest,
  checkWorkspaceRoot,
  type BoundaryRefusal
} from './process-api-validators';

export interface LaunchPipelineRunInput {
  readonly request: RunRequest;
  /** Resolved by the caller; `null` means no folder is open (gate 8 refuses). */
  readonly workspaceRoot: string | null;
  /** Overrides the queue row label. Absent leaves the service's own labelling. */
  readonly description?: string;
  /**
   * Feature 092 (T062, FR-034) — which queue admits the request.
   *
   * A **parameter**, never a prompt: this entrance is the non-interactive one
   * (Constitution Principle I), so an absent id is not a question to ask but a
   * decision already made — it means the default queue, exactly as every
   * pre-092 headless caller meant when there was only one. There is no chooser
   * here and no fallback to one.
   */
  readonly queueId?: string;
}

/**
 * Enqueue one standalone Pipeline run (FR-010).
 *
 * `frozenPipeline` is deliberately not accepted. It is the Workflow path's gate,
 * where the definition that must run is the snapshot the connected run froze at
 * start; a standalone launch resolves against the effective catalog because the
 * definition it freezes has to be the one that would actually run now. Exposing
 * the override here would let a caller start a run against a Pipeline no catalog
 * holds.
 */
export async function launchPipelineRun(
  deps: NodeRunStartDeps,
  input: LaunchPipelineRunInput
): Promise<NodeRunStartResult | BoundaryRefusal> {
  const rootRefusal = checkWorkspaceRoot(input?.workspaceRoot);
  if (rootRefusal !== null) return rootRefusal;
  const requestRefusal = checkRunRequest(input.request);
  if (requestRefusal !== null) return requestRefusal;
  const queueRefusal = checkQueueId(input.queueId);
  if (queueRefusal !== null) return queueRefusal;

  return startPipelineRun(deps, {
    request: input.request,
    workspaceRoot: input.workspaceRoot,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.queueId !== undefined ? { queueId: input.queueId } : {})
  });
}
