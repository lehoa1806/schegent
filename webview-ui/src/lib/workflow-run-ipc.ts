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
  type ContinueWorkflowPayload,
  type ContinueWorkflowResult,
  type LaunchWorkflowPayload,
  type LaunchWorkflowResult
} from './messages';
import { postCommand } from './vscode-api';
import { snapshotStore } from './snapshot-store.svelte';

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

const TIMEOUT_RESULT: QueueRefusal = {
  outcome: 'rejected-queue',
  reason: 'queue-refused',
  detail: 'no-host-response'
};

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
 * The promise always settles: host silence past five seconds resolves as the
 * timeout refusal above, which is what lets a composer's `finally` restore an
 * editable form without a second unwinding path.
 *
 * `post` is a thunk rather than a `(type, payload)` pair so each exported helper
 * keeps `postCommand`'s command-to-payload typing instead of widening it here. It
 * runs synchronously inside the Promise executor, before the listener is attached,
 * so two submissions cannot cross-resolve — the established idiom.
 */
function awaitResult<R>(post: () => { correlationId: string }, known: ReadonlySet<string>): Promise<R> {
  return new Promise<R>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finalise = (result: R): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (unsubscribe !== null) {
        try {
          unsubscribe();
        } catch {
          // one-shot listener errors must not leak
        }
        unsubscribe = null;
      }
      resolve(result);
    };

    const { correlationId } = post();

    snapshotStore.markPending(correlationId);
    unsubscribe = snapshotStore.onceAck(correlationId, (ack) => {
      finalise(
        isKnownResult(ack.result, known)
          ? (ack.result as R)
          : (UNUSABLE_ACK_RESULT as unknown as R)
      );
    });

    timer = setTimeout(() => {
      finalise(TIMEOUT_RESULT as unknown as R);
    }, ACK_TIMEOUT_MS);
  });
}

/** Start a connected run at one of its Workflow's allowed starting nodes (FR-010, FR-011). */
export function launchWorkflow(payload: LaunchWorkflowPayload): Promise<LaunchWorkflowResult> {
  return awaitResult<LaunchWorkflowResult>(
    () => postCommand(CMD_LAUNCH_WORKFLOW, payload),
    LAUNCH_OUTCOMES
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
  payload: ContinueWorkflowPayload
): Promise<ContinueWorkflowResult> {
  return awaitResult<ContinueWorkflowResult>(
    () => postCommand(CMD_CONTINUE_WORKFLOW, payload),
    CONTINUE_OUTCOMES
  );
}
