// Feature 089 T014 — continue one connected Workflow run without the editor host.
// Contract: specs/089-headless-parity-qualification/contracts/headless-api.md §4
//
// A delegate over `continuation-service.ts`, which owns every gate a continuation
// has: the run lookup, the revision compare-and-set, the eligibility fold, the
// node start, and the compare-and-set write. This module adds none of them
// (FR-011).
//
// **Nothing here reads a catalog.** Everything a continuation resolves comes from
// the run's own frozen graph and its frozen Pipeline snapshot, so a Pipeline
// edited, reordered, or deleted since the run started cannot reach a run already
// underway (FR-032). That is the same rule the standing project invariant states
// for an in-flight `WorkflowRun.pipeline`, holding on a second adapter.
//
// The workspace root and the clock are both **values** (data-model.md §2). The
// clock especially: a service that reads it directly cannot be tested for the
// ordering properties this platform depends on.
//
// This module imports no editor host API (FR-007).

import {
  continueConnectedRun,
  type ContinuationDeps,
  type ContinuationInput
} from '../services/workflow-execution/continuation-service';
import type { ContinueWorkflowResult } from '../contracts/sidebar-ipc';
import {
  checkContinuationArgs,
  checkWorkspaceRoot,
  type BoundaryRefusal
} from './process-api-validators';

export type ContinueWorkflowRunInput = ContinuationInput;

/**
 * Start one eligible node of a connected run (FR-011, FR-032).
 *
 * The argument check is the continue command's own wire validator, unchanged, so
 * the run id bound, the revision, the node id bound, and the nested run request
 * are held to exactly what the sidebar holds them to (FR-015).
 */
export async function continueWorkflowRun(
  deps: ContinuationDeps,
  input: ContinueWorkflowRunInput
): Promise<ContinueWorkflowResult | BoundaryRefusal> {
  const rootRefusal = checkWorkspaceRoot(input?.workspaceRoot);
  if (rootRefusal !== null) return rootRefusal;
  const payloadRefusal = checkContinuationArgs(input.payload);
  if (payloadRefusal !== null) return payloadRefusal;
  if (!Number.isFinite(input.startedAt)) {
    return { outcome: 'rejected-argument', field: 'startedAt', code: 'wrong-type' };
  }

  return continueConnectedRun(deps, input);
}
