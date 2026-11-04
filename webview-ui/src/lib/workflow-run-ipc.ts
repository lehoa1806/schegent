// Feature 088 (T041) — the single webview call site for the connected-run family.
//
// Two commands, one module, because they are one family: `CMD_LAUNCH_WORKFLOW`
// starts a connected run at an allowed node and `CMD_CONTINUE_WORKFLOW` starts an
// eligible successor of one that already exists. Components route through here
// rather than calling `postCommand` inline, so each payload shape is declared once
// and the family stays greppable. `tests/lint/no-inline-workflow-run-ipc.test.ts`
// enforces it, matching the run-launcher, metrics, phase-log, backend-ping, and
// process-YAML families.
//
// Nothing here interprets a request or a refusal. The composer builds the payload,
// these helpers put it on the wire verbatim, and the host owns every rule:
// `validateRunRequest()` for fields, the launcher's gates for the definition, and
// the compare-and-set for staleness. A webview-side pre-check would be a second
// oracle that disagrees with the authoritative one the moment either moves — which
// is why an incomplete composition is submittable and the refusal is the feedback
// (FR-045).

import {
  CMD_CONTINUE_WORKFLOW,
  CMD_LAUNCH_WORKFLOW,
  type CommandType,
  type ContinueWorkflowPayload,
  type ContinueWorkflowResult,
  type LaunchWorkflowPayload,
  type LaunchWorkflowResult,
  type WorkflowControlAction
} from './messages';
import { postCommand } from './vscode-api';
import { sendIntent, type IntentWaitOptions } from './intent-ledger';
import type { AckResult } from './snapshot-store.svelte';

const ACK_TIMEOUT_MS = 5000;

/**
 * What the view renders when the host says nothing at all, or answers with
 * something this family cannot render.
 *
 * A `rejected-queue` rather than a new outcome, so the wire union stays the
 * contract's (`src/contracts/sidebar-ipc/workflow-run.ts`) and the view has one
 * refusal family rather than two. `detail` distinguishes it for the operator,
 * whose next action — retry — is the same as for any other queue-side refusal.
 * Both commands share the shape because both declare the same arm.
 */
type QueueRefusal = Extract<LaunchWorkflowResult, { outcome: 'rejected-queue' }>;

/**
 * FR-R4-F05 (I5, O3, FR-024) — the wait ran out before the host answered. This is NOT a queue
 * refusal: the host may still start the run, so the outcome is not yet known. It used to be
 * a `rejected-queue` with the detail `no-host-response`, which the views rendered as "the
 * queue refused this run". A module-local outcome, so the wire union stays the contract's.
 */
export type NotYetKnown = { readonly outcome: 'not-yet-known' };

const NOT_YET_KNOWN: NotYetKnown = Object.freeze({ outcome: 'not-yet-known' });

const UNUSABLE_ACK_RESULT: QueueRefusal = {
  outcome: 'rejected-queue',
  reason: 'queue-refused',
  detail: 'unusable-host-response'
};

const LAUNCH_OUTCOMES: ReadonlySet<string> = new Set<LaunchWorkflowResult['outcome']>([
  'started',
  'rejected-definition',
  'rejected-validation',
  'rejected-queue'
]);

const CONTINUE_OUTCOMES: ReadonlySet<string> = new Set<ContinueWorkflowResult['outcome']>([
  'started',
  'rejected-run',
  'rejected-stale',
  'rejected-state',
  'rejected-definition',
  'rejected-validation',
  'rejected-queue'
]);

/**
 * An ack whose `result` is not a recognizable outcome of the command that was sent
 * cannot be rendered, so it is reported as a refusal rather than shown as an empty
 * acceptance. Both handlers always attach the full result — on the started path and
 * on every refused one — so a missing or unknown `outcome` means the ack did not
 * come from that handler at all.
 */
function isKnownResult(value: unknown, known: ReadonlySet<string>): boolean {
  if (value === null || typeof value !== 'object') return false;
  const outcome = (value as { outcome?: unknown }).outcome;
  return typeof outcome === 'string' && known.has(outcome);
}

/**
 * Correlate one already-posted command with its ack.
 *
 * The promise always settles: host silence past five seconds resolves as
 * `not-yet-known`, which is what lets a composer's `finally` restore an
 * editable form without a second unwinding path.
 *
 * FR-R4-F05 (I4) — it sends through the intent ledger, so an identical retry of an
 * unresolved launch or continuation reuses its identity and payload (the continuation's
 * `expectedRevision` is part of the payload, and is still its own idempotency check).
 * `post` takes the identity the ledger minted, so each exported helper keeps
 * `postCommand`'s command-to-payload typing.
 *
 * `fallbacks` are passed in rather than read from the module constants, so each
 * exported helper proves at its own call site that the shared refusal really is a
 * member of *its* result union. Reading them here would need `as unknown as R` —
 * a cast that keeps compiling if either command's `rejected-queue` arm gains a
 * field, leaving the view rendering a refusal the contract no longer declares.
 * The one remaining cast is on `ack.result`, which arrives as `unknown` and is
 * narrowed by `isKnownResult` immediately above it.
 */
function awaitResult<R, P>(
  type: CommandType,
  payload: P,
  post: (correlationId: string, payload: P) => void,
  known: ReadonlySet<string>,
  fallbacks: { readonly unusable: R },
  options: IntentWaitOptions<R | NotYetKnown> = {}
): Promise<R | NotYetKnown> {
  const toResult = (ack: AckResult): R =>
    isKnownResult(ack.result, known) ? (ack.result as R) : fallbacks.unusable;
  const { onLateOutcome } = options;
  return sendIntent({
    type,
    payload,
    post,
    timeoutMs: ACK_TIMEOUT_MS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(onLateOutcome === undefined ? {} : { onLateOutcome: (ack: AckResult) => onLateOutcome(toResult(ack)) })
  }).then((result): R | NotYetKnown => {
    if (result.kind === 'ack') return toResult(result.ack);
    return NOT_YET_KNOWN;
  });
}

/** Start a connected run at one of its Workflow's allowed starting nodes (FR-010, FR-011). */
export function launchWorkflow(
  payload: LaunchWorkflowPayload,
  options?: IntentWaitOptions<LaunchWorkflowResult | NotYetKnown>
): Promise<LaunchWorkflowResult | NotYetKnown> {
  return awaitResult<LaunchWorkflowResult, LaunchWorkflowPayload>(
    CMD_LAUNCH_WORKFLOW,
    payload,
    (correlationId, stored) => {
      postCommand(CMD_LAUNCH_WORKFLOW, stored, { correlationId });
    },
    LAUNCH_OUTCOMES,
    { unusable: UNUSABLE_ACK_RESULT },
    options
  );
}

/**
 * Start an eligible successor, or repeat a node whose latest attempt is terminal
 * (FR-016).
 *
 * `expectedRevision` is the revision the operator's view was rendered from
 * (FR-046); the caller reads it off the projection it is rendering and never
 * invents one, because a guessed revision defeats the compare-and-set that is this
 * family's only idempotency mechanism (FR-047).
 */
export function continueWorkflow(
  payload: ContinueWorkflowPayload,
  options?: IntentWaitOptions<ContinueWorkflowResult | NotYetKnown>
): Promise<ContinueWorkflowResult | NotYetKnown> {
  return awaitResult<ContinueWorkflowResult, ContinueWorkflowPayload>(
    CMD_CONTINUE_WORKFLOW,
    payload,
    (correlationId, stored) => {
      postCommand(CMD_CONTINUE_WORKFLOW, stored, { correlationId });
    },
    CONTINUE_OUTCOMES,
    { unusable: UNUSABLE_ACK_RESULT },
    options
  );
}

export interface ControlWorkflowRunInput {
  readonly connectedRunId: string;
  readonly expectedRevision: number;
  readonly invocationId: string;
  readonly operation: WorkflowControlAction;
  readonly nodeId?: string;
  readonly commandId?: string;
}

/**
 * Dispatch an invocation-scoped control action (`pause`, `resume`, `cancel`,
 * `retry-phase`, `retry-invocation`, `continue-handoff`) for a composable
 * Workflow run (FR-R5-F06-T05).
 */
export function controlWorkflowRun(
  input: ControlWorkflowRunInput,
  options?: IntentWaitOptions<ContinueWorkflowResult | NotYetKnown>
): Promise<ContinueWorkflowResult | NotYetKnown> {
  const nodeId = input.nodeId ?? 'root';
  return continueWorkflow(
    {
      connectedRunId: input.connectedRunId,
      expectedRevision: input.expectedRevision,
      nodeId,
      invocationId: input.invocationId,
      operation: input.operation,
      ...(input.commandId !== undefined ? { commandId: input.commandId } : {}),
      request: {
        pipelineId: nodeId,
        inputs: [],
        supplemental: [],
        outputs: []
      }
    },
    options
  );
}
