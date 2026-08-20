// Feature 088 (T031) — the connected-run wire contract.
//
// Lives in a sub-module for the same reason `run-launcher.ts` does: the barrel
// is at its LOC ceiling, and only the five mandatory registration edits belong
// there. See specs/088-workflow-continuation/contracts/workflow-run-ipc.md.
//
// Two rules govern every shape below, and neither has an exception:
//
//   * **No filesystem path crosses this boundary, in either direction.** A
//     launch names a Workflow and a node by identifier; a continuation names a
//     stored run, a revision, and a node. Every `path` and `target` inside the
//     nested `RunRequest` is workspace-relative and is resolved host-side
//     through `getCanonicalWorkspaceRoot()` — the same rule feature 087's
//     launcher holds, and the same one the process-YAML boundary holds.
//   * **No field carries document content.** Nothing here transports a prompt,
//     an output body, a pasted business document, or a secret. The projection
//     returned on a refusal is identifiers and states; the aggregate it is
//     derived from holds no content either (FR-065).
//
// The node-state vocabulary below says `in-flight`, and the state refusal says
// `child-not-terminal`, where in both cases the obvious word is the pinned
// status literal that `tests/lint/` scans host and webview sources for. This
// feature has no business widening that allowlist, and `in-flight` is already
// the vocabulary here (`hasInFlight()`, `inFlightCount()`). `child-not-terminal`
// is the more precise wording anyway: what the gate tests is the absence of a
// terminal state, not the presence of any particular one.

import type { CMD_CONTINUE_WORKFLOW, CMD_LAUNCH_WORKFLOW, CommandBase } from '../sidebar-ipc';
import type { RunRequest, RunRequestFieldError } from '../run-request';
import { validRunRequest } from '../validators/run-request-shape';
import { QUEUE_ID_MAX, hasUnexpectedKeys } from '../validators/shared';

export type { RunRequest, RunRequestFieldError };

// -- Projection (host → webview) ---------------------------------------------

/**
 * What a node looks like right now, derived on read by
 * `ui/sidebar/connected-run-projector.ts` and never stored (FR-055, FR-055a).
 *
 * The first four members are readings of the node's most recent child run; the
 * last three are a fold over the recorded routing decisions. A node whose most
 * recent attempt is terminal stays in that terminal state rather than returning
 * to `available` (FR-055a) — whether it will accept a repeat start is an
 * *action*, not a fifth state.
 */
export type ConnectedNodeState =
  | 'completed'
  | 'in-flight'
  | 'failed'
  | 'canceled'
  /** Offered by the most recent decision, with no non-terminal attempt. */
  | 'available'
  /** Considered and not offered: an incoming condition did not match (FR-055). */
  | 'blocked'
  /** Never yet considered — absent from every decision and from `nodes`. */
  | 'unvisited';

/**
 * What the host would accept for this node at this revision (FR-057).
 *
 * `start` is a first start of an offered node; `restart` is the repeat start
 * FR-016 allows once the most recent child is terminal. They are distinct
 * because the operator's composer differs: a first start is prefilled from the
 * incoming connection's bindings, a repeat start from the node's own contract.
 */
export type ConnectedNodeAction = 'start' | 'restart';

export interface ConnectedNodeProjection {
  readonly nodeId: string;
  readonly pipelineId: string;
  readonly state: ConnectedNodeState;
  /** Empty when nothing is legal for this node right now — the common case. */
  readonly actions: readonly ConnectedNodeAction[];
  /** How many child runs this node has had (FR-002a); attempts only grow. */
  readonly attemptCount: number;
  /** The most recent attempt's queue item, so the view can reuse the existing Run surfaces (FR-056). */
  readonly latestQueueItemId?: string;
}

/**
 * The read model of one connected run.
 *
 * The same shape travels on the snapshot and on a refusal, so the view has one
 * renderer rather than two, and a view built on a superseded snapshot corrects
 * itself from the answer it just received (FR-045).
 *
 * The union of every node's `actions` **is** the run's legal action set; it is
 * not carried a second time, because a second copy is a second thing to keep
 * consistent.
 */
export interface ConnectedRunProjection {
  readonly connectedRunId: string;
  readonly workflowId: string;
  /** The compare-and-set token to echo back on the next continuation (FR-046). */
  readonly revision: number;
  /** True until the aggregate and every referenced child run have loaded (FR-058). */
  readonly hydrating: boolean;
  readonly nodes: readonly ConnectedNodeProjection[];
}

// -- CMD_LAUNCH_WORKFLOW -----------------------------------------------------

/**
 * Start a connected run at an allowed starting node (FR-010, FR-011).
 *
 * No `expectedRevision`: there is no connected run yet to be stale against.
 */
export interface LaunchWorkflowPayload {
  readonly workflowId: string;
  readonly startNodeId: string;
  /** The starting node's Pipeline contract, composed by the operator. */
  readonly request: RunRequest;
  /**
   * Feature 092 (T080, FR-041) — which queue the run binds to, for its whole
   * life. Additive and optional: absent means the default queue, which is what
   * every pre-092 launch meant.
   *
   * Only the launch carries it. There is no counterpart on
   * `ContinueWorkflowPayload`, because the binding is fixed at start and a
   * continuation that could name a queue would be a rebind.
   */
  readonly queueId?: string;
}

export interface LaunchWorkflowCommand extends CommandBase<typeof CMD_LAUNCH_WORKFLOW> {
  readonly payload: LaunchWorkflowPayload;
}

/**
 * Why a start was refused for a reason that is neither a field nor the queue.
 *
 * Kept as one family across both commands because the operator's next action is
 * the same in every arm: fix the definition, or open a folder. A field problem
 * is fixed in the composer they are looking at, and a queue problem by waiting.
 */
export type WorkflowDefinitionRefusal =
  /** The identifier did not resolve against the effective catalog (FR-013). */
  | 'workflow-not-found'
  /** It resolved, but the graph is invalid or a node's Pipeline does not resolve (FR-013). */
  | 'workflow-invalid'
  /** The named node is not in the Workflow's `startNodeIds` (FR-011). */
  | 'node-not-startable'
  /** The request names a Pipeline other than the one the node names. */
  | 'pipeline-mismatch'
  /** No folder is open, so a declared output has nowhere to be written. */
  | 'no-workspace-root';

/**
 * `started` rather than `enqueued`, because two things happened: the aggregate
 * came into being and its first child was queued.
 */
export type LaunchWorkflowResult =
  | {
      readonly outcome: 'started';
      readonly connectedRunId: string;
      readonly revision: number;
      readonly queueItemId: string;
    }
  | { readonly outcome: 'rejected-definition'; readonly reason: WorkflowDefinitionRefusal }
  | { readonly outcome: 'rejected-validation'; readonly errors: readonly RunRequestFieldError[] }
  | {
      readonly outcome: 'rejected-queue';
      readonly reason: 'queue-refused';
      readonly detail?: string;
    };

export type LaunchWorkflowOutcome = LaunchWorkflowResult['outcome'];

// -- CMD_CONTINUE_WORKFLOW ---------------------------------------------------

/**
 * Start an eligible successor, or re-start a node whose most recent attempt is
 * terminal (FR-016).
 *
 * `request` is what the operator submitted — never the prefill, which the host
 * does not receive and never trusts (FR-039). The payload asserts nothing about
 * why the node is legal; the host recomputes eligibility itself.
 */
export interface ContinueWorkflowPayload {
  readonly connectedRunId: string;
  /** The revision the operator's view was rendered from (FR-046). */
  readonly expectedRevision: number;
  readonly nodeId: string;
  readonly request: RunRequest;
}

export interface ContinueWorkflowCommand extends CommandBase<typeof CMD_CONTINUE_WORKFLOW> {
  readonly payload: ContinueWorkflowPayload;
}

/**
 * Why a continuation was refused by the run's own state. `child-not-terminal`
 * states FR-044 as it is written: *while any child Pipeline Run is
 * non-terminal*.
 */
export type ConnectedRunStateRefusal = 'child-not-terminal' | 'node-not-eligible';

/**
 * Seven arms. `rejected-stale` and `rejected-state` both carry the projection
 * (FR-045); the definition and validation arms do not, because neither says
 * anything about the run's state that the caller's snapshot got wrong.
 */
export type ContinueWorkflowResult =
  | { readonly outcome: 'started'; readonly revision: number; readonly queueItemId: string }
  | { readonly outcome: 'rejected-run'; readonly reason: 'run-not-found' }
  | { readonly outcome: 'rejected-stale'; readonly projection: ConnectedRunProjection }
  | {
      readonly outcome: 'rejected-state';
      readonly reason: ConnectedRunStateRefusal;
      readonly projection: ConnectedRunProjection;
    }
  | {
      readonly outcome: 'rejected-definition';
      readonly reason: Extract<
        WorkflowDefinitionRefusal,
        'pipeline-mismatch' | 'no-workspace-root'
      >;
    }
  | { readonly outcome: 'rejected-validation'; readonly errors: readonly RunRequestFieldError[] }
  | {
      readonly outcome: 'rejected-queue';
      readonly reason: 'queue-refused';
      readonly detail?: string;
    };

export type ContinueWorkflowOutcome = ContinueWorkflowResult['outcome'];

// -- Payload predicates ------------------------------------------------------
//
// These live here rather than inline in the barrel because they need none of
// the barrel's runtime values — only the discriminator guards do, which is why
// those stay there. Field-level rules are not their job: `validateRunRequest()`
// owns them and reports every failing field at once (FR-014), which a boolean
// predicate cannot do.
//
// Feature 102 (T039, FR-023) — what *is* their job is the transport contract,
// and they used to state a weaker one than `validators/workflow-run.ts` does for
// the identical message: required keys present, everything else waved through.
// So a submitted `catalogVersion` was refused at ingress and accepted here. Both
// now apply the same allowlists and the same nested `validRunRequest`, which is
// the only arrangement in which "refused" is a property of the boundary rather
// than of which door you happened to knock on.

/** A connected run identifier is host-minted, so this is a sanity bound, not a contract. */
const RUN_ID_MAX = 128;
const ID_MAX = 64;

function boundedId(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

export function isLaunchWorkflowPayload(payload: unknown): payload is LaunchWorkflowPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  return (
    !hasUnexpectedKeys(value, ['workflowId', 'startNodeId', 'request', 'queueId']) &&
    boundedId(value.workflowId, ID_MAX) &&
    boundedId(value.startNodeId, ID_MAX) &&
    (value.queueId === undefined || boundedId(value.queueId, QUEUE_ID_MAX)) &&
    validRunRequest(value.request)
  );
}

export function isContinueWorkflowPayload(payload: unknown): payload is ContinueWorkflowPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  return (
    !hasUnexpectedKeys(value, ['connectedRunId', 'expectedRevision', 'nodeId', 'request']) &&
    boundedId(value.connectedRunId, RUN_ID_MAX) &&
    // Bounded below and not above, matching the ingress validator: a revision the
    // store has moved past is gate 2's `rejected-stale`, not a transport defect.
    Number.isInteger(value.expectedRevision) &&
    (value.expectedRevision as number) >= 0 &&
    boundedId(value.nodeId, ID_MAX) &&
    validRunRequest(value.request)
  );
}
