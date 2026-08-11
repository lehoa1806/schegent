// Feature 087 (T006) — the Pipeline run-launcher wire contract.
//
// Lives in a sub-module for the same reason `process-yaml.ts` does: the barrel
// is at its LOC ceiling, and only the five mandatory registration edits belong
// there. See specs/087-pipeline-run-composition/contracts/run-launcher-ipc.md.
//
// No field here names a filesystem location in absolute form. Every `path` and
// `target` is workspace-relative and is resolved host-side through
// `getCanonicalWorkspaceRoot()`; the webview neither supplies a resolved path
// nor learns one back, including in an error (FR-020).

import type { CMD_LAUNCH_PIPELINE, CommandBase } from '../sidebar-ipc';
import type { RunRequest, RunRequestFieldError } from '../run-request';

export type { RunRequest, RunRequestFieldError };

export interface LaunchPipelineRequest {
  readonly request: RunRequest;
}

export interface LaunchPipelineCommand extends CommandBase<typeof CMD_LAUNCH_PIPELINE> {
  readonly payload: LaunchPipelineRequest;
}

/**
 * Why a launch was refused, kept distinct from `rejected-validation` because
 * the operator's next action differs: a definition problem is fixed in the
 * catalog, a queue problem by waiting or resuming, and a validation problem in
 * the composer they are already looking at.
 */
export type LaunchPipelineRejectionReason =
  /** The identifier did not resolve against the effective catalog (FR-014). */
  | 'pipeline-not-found'
  /** It resolved, but the definition itself is invalid (FR-014). */
  | 'pipeline-invalid'
  /** No folder is open, so no local reference can be contained. */
  | 'no-workspace-root'
  /** An existing queue guard refused: paused, foreign lock, capacity. */
  | 'queue-refused';

export type LaunchPipelineResult =
  | { readonly outcome: 'enqueued'; readonly requestId: string }
  | { readonly outcome: 'rejected-validation'; readonly errors: readonly RunRequestFieldError[] }
  | { readonly outcome: 'rejected-definition'; readonly reason: LaunchPipelineRejectionReason }
  | {
      readonly outcome: 'rejected-queue';
      readonly reason: LaunchPipelineRejectionReason;
      readonly detail?: string;
    };

export type LaunchPipelineOutcome = LaunchPipelineResult['outcome'];

/**
 * Transport shape of the command payload, as a plain predicate over `unknown`.
 *
 * It lives here rather than inline in the barrel because it needs none of the
 * barrel's runtime values — only the `CMD_LAUNCH_PIPELINE` discriminator does,
 * which is why the guard wrapping this one stays there. Field-level rules are
 * not this function's job: `validateRunRequest()` owns them and reports every
 * failing field at once (FR-013), which a boolean predicate cannot do.
 */
export function isLaunchPipelinePayload(payload: unknown): payload is LaunchPipelineRequest {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const req = (payload as { request?: unknown }).request as Record<string, unknown> | undefined;
  if (!req || typeof req !== 'object' || Array.isArray(req)) return false;
  return typeof req.pipelineId === 'string' && req.pipelineId.length > 0
    && Array.isArray(req.inputs) && Array.isArray(req.supplemental)
    && Array.isArray(req.outputs);
}
