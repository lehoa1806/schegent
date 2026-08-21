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
import { validRunRequest } from '../validators/run-request-shape';
import { hasUnexpectedKeys, QUEUE_ID_MAX } from '../validators/shared';

export type { RunRequest, RunRequestFieldError };

export interface LaunchPipelineRequest {
  readonly request: RunRequest;
  /**
   * Feature 103 (T068, FR-059) — which queue admits the run.
   *
   * Additive and optional: absent means the default queue, decided by
   * `scheduleOrEnqueue` as it always has been, so a launch from Runs puts
   * exactly the bytes on the wire it did before. It exists because History's
   * re-run has a queue to be faithful to — the one the historical run used —
   * and `LaunchWorkflowPayload.queueId` has carried the same field on the same
   * terms since feature 092. The two ingresses for one concept agree.
   *
   * Not checked against the registry here. Whether a named queue exists is a
   * question about live state, answered once by the enqueue path; a second
   * answer at the boundary would be a second oracle, and only one of the two
   * Pipeline/Workflow ingresses would hold it.
   */
  readonly queueId?: string;
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
  /**
   * Feature 098 (FR-031) — the effective catalog holds no Pipelines at all, so
   * nothing could have resolved. Distinct from `pipeline-not-found` because the
   * remedy differs: import a process document, rather than check the id.
   */
  | 'catalog-empty'
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
 *
 * Feature 102 (T039, FR-023) — it used to check only that the four required
 * keys were present and leave every other key alone, which meant the ingress
 * validator refused a submitted `catalogVersion` and this guard accepted the
 * same payload. Both answer for the same wire message, so they now share one
 * rule: `validRunRequest`, allowlisted at every depth.
 */
export function isLaunchPipelinePayload(payload: unknown): payload is LaunchPipelineRequest {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (hasUnexpectedKeys(payload as Record<string, unknown>, ['request', 'queueId'])) return false;
  const queueId = (payload as { queueId?: unknown }).queueId;
  // Feature 103 (T068) — same bound and same optionality as the Workflow
  // ingress applies. `undefined` passes because the key may be absent; a
  // present-but-empty or over-long id does not.
  if (
    queueId !== undefined &&
    (typeof queueId !== 'string' || queueId.length === 0 || queueId.length > QUEUE_ID_MAX)
  ) {
    return false;
  }
  return validRunRequest((payload as { request?: unknown }).request);
}
