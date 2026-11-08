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

import type { ExecutionDecisionObservation } from '../execution-decision-observation';
import type { CMD_CONTINUE_WORKFLOW, CMD_LAUNCH_WORKFLOW, CommandBase } from '../sidebar-ipc';
import type { RunRequest, RunRequestFieldError } from '../run-request';
import {
  CANDIDATE_AVAILABILITY_POLICIES,
  MAX_CANDIDATES_PER_BLOCK,
  MAX_MONITORING_WINDOW_MS,
  MIN_CANDIDATES_PER_BLOCK,
  MIN_MONITORING_WINDOW_MS,
  type CandidateAvailabilityPolicy
} from '../workflow-controls';
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

export type WorkflowControlAction =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'retry-phase'
  | 'retry-invocation'
  | 'continue-handoff';

export const WORKFLOW_CONTROL_ACTIONS: readonly WorkflowControlAction[] = Object.freeze([
  'pause',
  'resume',
  'cancel',
  'retry-phase',
  'retry-invocation',
  'continue-handoff'
]);

// -- FR-R5-F31 (SPEC-09, D8) — Versioned candidate/workflow control contracts --

export const CONTROL_COMMAND_VERSION = 1 as const;

export const CONTROL_ACTION_KINDS = Object.freeze([
  'check-now',
  'try-now',
  'select-candidate',
  'set-policy',
  'set-allowed-candidates',
  'renew-monitoring',
  'pause',
  'resume',
  'cancel'
] as const);

export type ControlActionKind = (typeof CONTROL_ACTION_KINDS)[number];

export type ControlAction =
  | { readonly kind: 'check-now'; readonly candidateId?: string }
  | { readonly kind: 'try-now'; readonly candidateId: string }
  | { readonly kind: 'select-candidate'; readonly candidateId: string }
  | {
      readonly kind: 'set-policy';
      readonly availabilityPolicy: CandidateAvailabilityPolicy;
    }
  | {
      readonly kind: 'set-allowed-candidates';
      readonly candidateIds: readonly string[];
    }
  | { readonly kind: 'renew-monitoring'; readonly durationMs: number }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'cancel' };

export interface ControlCommandEnvelope {
  readonly version: 1;
  readonly commandId: string;
  readonly rootRunId: string;
  readonly queueId: string;
  readonly invocationId: string;
  readonly expectedGeneration: number;
  readonly action: ControlAction;
}

export const CONTROL_COMMAND_REFUSAL_REASONS = Object.freeze([
  'stale-generation',
  'unknown-target',
  'illegal-state',
  'candidate-ineligible',
  'not-before',
  'check-rate-limited',
  'monitoring-expired',
  'trust-denied',
  'spend-limit-reached',
  'spend-unverifiable',
  'uncertain-effect',
  'unsupported-control-version',
  'invalid-command'
] as const);

export type ControlCommandRefusalReason =
  (typeof CONTROL_COMMAND_REFUSAL_REASONS)[number];

export interface ControlLegalActionEntry {
  readonly kind: ControlActionKind;
  readonly allowed: boolean;
  readonly reason?: ControlCommandRefusalReason;
  readonly candidateId?: string;
}

export interface ControlCandidateProjection {
  readonly candidateId: string;
  readonly nodeId: string;
  readonly backend: string;
  readonly priority: number;
  readonly authoredOrder: number;
  readonly attemptsUsed: number;
  readonly maxAttempts: number;
  readonly eligibility: 'eligible' | 'intervention' | 'retired';
  readonly retirementReason?: 'attempts-exhausted' | 'permanent-failure';
  readonly policyExcluded: boolean;
  readonly availabilityStatus?: string;
  readonly availabilitySource?: string;
  readonly fresh?: boolean;
  readonly resetAt?: number;
  readonly nextCheckAt?: number;
  readonly notBefore?: number;
  readonly phaseId?: string;
  readonly phaseName?: string;
  readonly instructionSummary?: string;
  readonly operatorKind?: string;
  readonly quotaIdentity?: string;
  readonly permitWaitPosition?: number;
}

export interface ControlProjection {
  readonly version: 1;
  readonly rootRunId: string;
  readonly queueId: string;
  readonly invocationId: string;
  readonly workflowId: string;
  readonly nodeId?: string;
  readonly generation: number;
  readonly frameKind:
    | 'root-workflow'
    | 'child-workflow'
    | 'candidate-block'
    | 'repeat'
    | 'for-each';
  readonly state: string;
  readonly availabilityPolicy?: CandidateAvailabilityPolicy;
  readonly selectedCandidateId?: string;
  readonly manualSelectionCandidateId?: string;
  readonly allowedCandidateIds?: readonly string[];
  readonly candidates?: readonly ControlCandidateProjection[];
  readonly attemptsUsed: number;
  readonly maxDispatches: number;
  readonly rootDispatchesUsed: number;
  readonly rootMaxDispatches: number;
  readonly enclosingIteration?: number;
  readonly enclosingMaxIterations?: number;
  readonly monitoringStartedAt?: number;
  readonly monitoringExpiresAt?: number;
  readonly monitoringRenewals?: number;
  readonly resultStatus?: string;
  readonly resultReason?: string;
  readonly recoveryCoverage?: 'complete' | 'partial' | 'unavailable';
  readonly effectCertainty?: 'safe' | 'uncertain' | 'unknown';
  readonly manifestTruncated?: boolean;
  readonly preexistingDirtyCount?: number;
  readonly spendMode: 'count-only' | 'strict-usd';
  readonly spendEnforcementQuality:
    | 'verified'
    | 'estimated'
    | 'unavailable'
    | 'count-only';
  readonly verifiedMicrousd?: number;
  readonly estimatedMicrousd?: number;
  readonly unpricedAttemptCount?: number;
  readonly maxMicrousd?: number;
  readonly activeAttemptOvershootNote?: string;
  readonly durableNotices?: readonly string[];
  readonly policyObservations?: readonly Readonly<
    Record<string, string | number | boolean>
  >[];
  readonly repeatProjection?: ConnectedRepeatNodeProjection;
  readonly forEachProjection?: ConnectedForEachNodeProjection;
  readonly legalActions: readonly ControlLegalActionEntry[];
  readonly evidenceRefs: readonly string[];
}

export interface ConnectedRepeatCompletedPassProjection {
  readonly iteration: number;
  readonly invocationId: string;
  readonly status: 'completed' | 'failed' | 'canceled';
  readonly resultRef?: string;
}

export interface ConnectedRepeatNodeProjection {
  readonly version?: 1;
  readonly kind?: 'repeat';
  readonly iteration: number;
  readonly currentPass?: number;
  readonly maxIterations: number;
  readonly conditionResult: 'true' | 'false' | 'unresolved' | 'not-evaluated';
  readonly currentChildInvocationId?: string | null;
  readonly onExhausted: 'pause' | 'fail';
  readonly exhaustionReason?: string;
  readonly carryEnvelopeRef?: string;
  readonly carryValues?: Readonly<Record<string, string | number | boolean>>;
  readonly leafAttemptCount: number;
  readonly rootDispatchesUsed?: number;
  readonly rootMaxDispatches?: number;
  readonly completedPasses: readonly ConnectedRepeatCompletedPassProjection[];
  readonly legalActions?: readonly ControlLegalActionEntry[];
}

export interface ConnectedForEachSlotProjection {
  readonly index: number;
  readonly itemKey: string;
  readonly invocationId?: string;
  readonly state: 'pending' | 'executing' | 'completed' | 'failed';
  readonly resultRef?: string;
  readonly error?: {
    readonly code: 'child-failed' | 'invalid-child-result' | 'dispatch-budget-exhausted';
    readonly message: string;
  };
}

export interface ConnectedForEachNodeProjection {
  readonly version: 1;
  readonly kind: 'for-each';
  readonly collectionRef?: string;
  readonly collectionSha256?: string;
  readonly itemCount: number;
  readonly currentIndex: number;
  readonly onItemError: 'stop' | 'continue';
  readonly hasErrors: boolean;
  readonly errorCount: number;
  readonly resultIndexRef?: string;
  readonly refusalCode?: string;
  readonly leafAttemptCount: number;
  readonly rootDispatchesUsed?: number;
  readonly rootMaxDispatches?: number;
  readonly slots: readonly ConnectedForEachSlotProjection[];
  readonly legalActions?: readonly ControlLegalActionEntry[];
}

export interface ControlCommandAcknowledgement {
  readonly version: 1;
  readonly commandId: string;
  readonly outcome: 'accepted' | 'refused';
  readonly generation: number;
  readonly reason?: ControlCommandRefusalReason;
  readonly projection?: ControlProjection;
}

export interface ConnectedInvocationAttemptProjection {
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly nodeId: string;
  readonly nodeKind: 'phase' | 'workflow';
  readonly status: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly queueItemId?: string;
  readonly childInvocationId?: string;
  readonly failureCode?: string;
}

export interface ConnectedPendingHandoffProjection {
  readonly fromNodeId: string;
  readonly toNodeId: string | null;
  readonly connectionId?: string;
  readonly boundInputPortIds: readonly string[];
}

export interface ConnectedInvocationProjection {
  readonly invocationId: string;
  readonly parentInvocationId: string | null;
  readonly workflowId: string;
  readonly workflowName?: string;
  readonly frozenVersionId?: string;
  readonly depth: number;
  readonly nodePath: string;
  readonly status: string;
  readonly currentNodeId: string | null;
  readonly activeAttemptId: string | null;
  readonly activeAttemptIndex: number | null;
  readonly allowedActions: readonly WorkflowControlAction[];
  readonly waitingReason: string | null;
  readonly pauseCause: string | null;
  readonly pauseExplanation?: string | null;
  readonly pauseGuidance?: string | null;
  readonly failureReason: string | null;
  readonly pendingRetryAt: number | null;
  readonly pendingRetryCause: string | null;
  readonly pendingHandoff?: ConnectedPendingHandoffProjection | null;
  readonly outputPortIds: readonly string[];
  readonly attempts: readonly ConnectedInvocationAttemptProjection[];
  readonly controlProjection?: ControlProjection;
}

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
  readonly nodeKind?: 'phase' | 'workflow' | 'pipeline';
  readonly label?: string;
  readonly frozenVersionId?: string;
  readonly childInvocationIds?: readonly string[];
  readonly decisionObservation?: ExecutionDecisionObservation;
  readonly repeatProjection?: ConnectedRepeatNodeProjection;
  readonly forEachProjection?: ConnectedForEachNodeProjection;
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
  readonly queueId?: string;
  readonly status?: string;
  readonly rootInvocationId?: string;
  readonly activeInvocationId?: string;
  readonly rootAllowedActions?: readonly WorkflowControlAction[];
  readonly recoveryDisposition?: {
    readonly status: string;
    readonly reason: string;
    readonly targetInvocationId: string;
    readonly targetAttemptId?: string;
  } | null;
  readonly invocations?: readonly ConnectedInvocationProjection[];
  readonly decisionObservations?: readonly ExecutionDecisionObservation[];
  readonly controlProjection?: ControlProjection;
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
  /** Optional target invocation and control operation for composable Workflow runs (FR-R5-F06). */
  readonly invocationId?: string;
  readonly operation?: WorkflowControlAction;
  readonly commandId?: string;
  /** FR-R5-F31 (SPEC-09, D8) — version-1 candidate/workflow control command envelope. */
  readonly controlCommand?: ControlCommandEnvelope;
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
 * Eight arms (`control-acknowledged` added in FR-R5-F31 for version-1 D8 control commands).
 * `rejected-stale` and `rejected-state` both carry the projection
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
    }
  | {
      readonly outcome: 'control-acknowledged';
      readonly acknowledgement: ControlCommandAcknowledgement;
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

/**
 * The bound on the two ids of a control that derive from a nested invocation: the
 * `invocationId` it targets and the `commandId` the UI builds around it
 * (`${connectedRunId}:${invocationId}:${action}:${revision}`).
 *
 * `RUN_ID_MAX` cannot hold these. A child invocation id is
 * `${parentInvocationId}:${callNodeId}:${parentAttemptId}` and the parent attempt id
 * itself starts with the parent invocation id, so each level of nesting a little more
 * than doubles the length: 41 characters at the root (a 36-character `randomUUID()` plus
 * `:root`), 135 one level down, and about 24,000 at `MAX_WORKFLOW_NESTING_DEPTH` (8)
 * with 20-character node ids, about 46,500 with 64-character ones. Under 128 even the
 * first child's `commandId` is refused, which made every control on a nested
 * invocation `invalid-payload`.
 *
 * 65,536 holds the deepest legal id with room to spare and is still a sanity bound:
 * anything longer is refused at ingress. `tests/contract/continue-workflow.test.ts`
 * mints the deepest legal id with the real factory and asserts it fits, so a change to
 * the id format cannot silently outgrow this.
 */
export const CONTROL_ID_MAX = 65_536;

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTHORED_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const QUEUE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isValidAuthoredControlId(value: unknown): value is string {
  return typeof value === 'string' && AUTHORED_ID_RE.test(value);
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export type ControlCommandEnvelopeValidationResult =
  | { readonly ok: true; readonly envelope: ControlCommandEnvelope }
  | {
      readonly ok: false;
      readonly reason: 'unsupported-control-version' | 'invalid-command';
      readonly commandId?: string;
    };

export function validateControlCommandEnvelope(
  value: unknown
): ControlCommandEnvelopeValidationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'invalid-command' };
  }
  const obj = value as Record<string, unknown>;
  const rawCommandId = typeof obj.commandId === 'string' ? obj.commandId : undefined;

  if (typeof obj.version === 'number' && Number.isSafeInteger(obj.version)) {
    if (obj.version !== CONTROL_COMMAND_VERSION) {
      return {
        ok: false,
        reason: 'unsupported-control-version',
        ...(rawCommandId !== undefined ? { commandId: rawCommandId } : {})
      };
    }
  } else {
    return {
      ok: false,
      reason: 'invalid-command',
      ...(rawCommandId !== undefined ? { commandId: rawCommandId } : {})
    };
  }

  if (
    hasUnexpectedKeys(obj, [
      'version',
      'commandId',
      'rootRunId',
      'queueId',
      'invocationId',
      'expectedGeneration',
      'action'
    ]) ||
    !isValidUuid(obj.commandId) ||
    !boundedId(obj.rootRunId, RUN_ID_MAX) ||
    hasControlChar(obj.rootRunId) ||
    typeof obj.queueId !== 'string' ||
    !QUEUE_ID_RE.test(obj.queueId) ||
    !isValidUuid(obj.invocationId) ||
    typeof obj.expectedGeneration !== 'number' ||
    !Number.isSafeInteger(obj.expectedGeneration) ||
    obj.expectedGeneration < 0 ||
    !obj.action ||
    typeof obj.action !== 'object' ||
    Array.isArray(obj.action)
  ) {
    return {
      ok: false,
      reason: 'invalid-command',
      ...(rawCommandId !== undefined ? { commandId: rawCommandId } : {})
    };
  }

  const actionObj = obj.action as Record<string, unknown>;
  const kind = actionObj.kind;
  if (typeof kind !== 'string' || !(CONTROL_ACTION_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: 'invalid-command', commandId: obj.commandId };
  }

  let validatedAction: ControlAction;
  switch (kind as ControlActionKind) {
    case 'check-now': {
      if (hasUnexpectedKeys(actionObj, ['kind', 'candidateId'])) {
        return { ok: false, reason: 'invalid-command', commandId: obj.commandId };
      }
      if ('candidateId' in actionObj) {
        if (
          actionObj.candidateId !== undefined &&
          !isValidAuthoredControlId(actionObj.candidateId)
        ) {
          return { ok: false, reason: 'invalid-command', commandId: obj.commandId };
        }
      }
      validatedAction = Object.freeze({
        kind: 'check-now',
        ...(actionObj.candidateId !== undefined
          ? { candidateId: actionObj.candidateId as string }
          : {})
      });
      break;
    }
    case 'try-now':
    case 'select-candidate': {
      if (
        hasUnexpectedKeys(actionObj, ['kind', 'candidateId']) ||
        !isValidAuthoredControlId(actionObj.candidateId)
      ) {
        return { ok: false, reason: 'invalid-command', commandId: obj.commandId };
      }
      validatedAction =
        kind === 'try-now'
          ? Object.freeze({
              kind: 'try-now' as const,
              candidateId: actionObj.candidateId
            })
          : Object.freeze({
              kind: 'select-candidate' as const,
              candidateId: actionObj.candidateId
            });
      break;
    }
    case 'set-policy': {
      if (
        hasUnexpectedKeys(actionObj, ['kind', 'availabilityPolicy']) ||
        typeof actionObj.availabilityPolicy !== 'string' ||
        !(CANDIDATE_AVAILABILITY_POLICIES as readonly string[]).includes(
          actionObj.availabilityPolicy
        )
      ) {
        return { ok: false, reason: 'invalid-command', commandId: obj.commandId };
      }
      validatedAction = Object.freeze({
        kind: 'set-policy',
        availabilityPolicy: actionObj.availabilityPolicy as CandidateAvailabilityPolicy
      });
      break;
    }
    case 'set-allowed-candidates': {
      if (
        hasUnexpectedKeys(actionObj, ['kind', 'candidateIds']) ||
        !Array.isArray(actionObj.candidateIds) ||
        actionObj.candidateIds.length < MIN_CANDIDATES_PER_BLOCK ||
        actionObj.candidateIds.length > MAX_CANDIDATES_PER_BLOCK ||
        !actionObj.candidateIds.every((id) => isValidAuthoredControlId(id)) ||
        new Set(actionObj.candidateIds).size !== actionObj.candidateIds.length
      ) {
        return { ok: false, reason: 'invalid-command', commandId: obj.commandId };
      }
      validatedAction = Object.freeze({
        kind: 'set-allowed-candidates',
        candidateIds: Object.freeze([...(actionObj.candidateIds as string[])])
      });
      break;
    }
    case 'renew-monitoring': {
      if (
        hasUnexpectedKeys(actionObj, ['kind', 'durationMs']) ||
        typeof actionObj.durationMs !== 'number' ||
        !Number.isSafeInteger(actionObj.durationMs) ||
        actionObj.durationMs < MIN_MONITORING_WINDOW_MS ||
        actionObj.durationMs > MAX_MONITORING_WINDOW_MS
      ) {
        return { ok: false, reason: 'invalid-command', commandId: obj.commandId };
      }
      validatedAction = Object.freeze({
        kind: 'renew-monitoring',
        durationMs: actionObj.durationMs
      });
      break;
    }
    case 'pause':
    case 'resume':
    case 'cancel': {
      if (hasUnexpectedKeys(actionObj, ['kind'])) {
        return { ok: false, reason: 'invalid-command', commandId: obj.commandId };
      }
      validatedAction =
        kind === 'pause'
          ? Object.freeze({ kind: 'pause' as const })
          : kind === 'resume'
            ? Object.freeze({ kind: 'resume' as const })
            : Object.freeze({ kind: 'cancel' as const });
      break;
    }
  }

  return {
    ok: true,
    envelope: Object.freeze({
      version: 1,
      commandId: obj.commandId,
      rootRunId: obj.rootRunId,
      queueId: obj.queueId,
      invocationId: obj.invocationId,
      expectedGeneration: obj.expectedGeneration,
      action: validatedAction
    })
  };
}

export function isControlCommandEnvelope(value: unknown): value is ControlCommandEnvelope {
  return validateControlCommandEnvelope(value).ok;
}

export function isContinueWorkflowPayload(payload: unknown): payload is ContinueWorkflowPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  return (
    !hasUnexpectedKeys(value, [
      'connectedRunId',
      'expectedRevision',
      'nodeId',
      'request',
      'invocationId',
      'operation',
      'commandId',
      'controlCommand'
    ]) &&
    boundedId(value.connectedRunId, RUN_ID_MAX) &&
    // Bounded below and not above, matching the ingress validator: a revision the
    // store has moved past is gate 2's `rejected-stale`, not a transport defect.
    Number.isInteger(value.expectedRevision) &&
    (value.expectedRevision as number) >= 0 &&
    boundedId(value.nodeId, ID_MAX) &&
    (value.invocationId === undefined || boundedId(value.invocationId, CONTROL_ID_MAX)) &&
    (value.operation === undefined ||
      (typeof value.operation === 'string' &&
        (WORKFLOW_CONTROL_ACTIONS as readonly string[]).includes(value.operation))) &&
    (value.commandId === undefined || boundedId(value.commandId, CONTROL_ID_MAX)) &&
    (value.controlCommand === undefined || isControlCommandEnvelope(value.controlCommand)) &&
    validRunRequest(value.request)
  );
}
