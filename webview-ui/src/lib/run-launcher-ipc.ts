// Feature 087 (T049) — the single webview call site for `CMD_LAUNCH_PIPELINE`.
//
// Components in the composer route through here rather than calling
// `postCommand` inline, so the payload shape is declared once and the family
// stays greppable. `tests/lint/no-inline-run-launcher-ipc.test.ts` enforces it,
// matching the metrics, phase-log, backend-ping, and process-YAML families.
//
// Nothing here interprets the request. The composer builds a `RunRequest`, this
// helper puts it on the wire verbatim, and `validateRunRequest()` host-side owns
// every field rule — a webview-side pre-check would be a second oracle that
// disagrees with the authoritative one the moment either moves.

import { CMD_LAUNCH_PIPELINE, type LaunchPipelineResult } from './messages';
// The request types are imported from the contract module directly rather than
// widened into the IPC barrel's re-export list: the barrel sits one line under
// its LOC budget, and `start-mode.ts` and `metrics-ipc.ts` already take contract
// types this way.
import type { RunRequest } from '../../../src/contracts/run-request';
import { postCommand } from './vscode-api';
import { sendIntent, type IntentWaitOptions } from './intent-ledger';
import type { AckResult } from './snapshot-store.svelte';

const ACK_TIMEOUT_MS = 5000;

/**
 * FR-R4-F05 (I5, O3, FR-024) — the wait ran out before the host answered. This is NOT a queue
 * refusal: the host may still enqueue the run, so the outcome is not yet known. It used to be
 * the `rejected-queue` below with the detail `no-host-response`, which the composer rendered
 * as a refusal. A module-local outcome, so the wire union stays the contract's.
 */
export type NotYetKnown = { readonly outcome: 'not-yet-known' };

const NOT_YET_KNOWN: NotYetKnown = Object.freeze({ outcome: 'not-yet-known' });

/**
 * The host answered, but not with something this family can render. It is a `rejected-queue`
 * rather than a new outcome so the wire union stays the contract's
 * (`src/contracts/sidebar-ipc/run-launcher.ts`) and the composer has one refusal family to
 * render. `detail` distinguishes it for the operator.
 */
const UNUSABLE_ACK_RESULT: LaunchPipelineResult = {
  outcome: 'rejected-queue',
  reason: 'queue-refused',
  detail: 'unusable-host-response'
};

/**
 * An ack whose `result` is not a recognizable launch outcome cannot be rendered,
 * so it is reported as a refusal rather than shown as an empty acceptance. The
 * handler always attaches the full `LaunchPipelineResult` — on the accepted path
 * and on every rejected one — so a missing or unknown `outcome` means the ack did
 * not come from the launch handler at all.
 */
function asLaunchResult(value: unknown): LaunchPipelineResult | null {
  if (value === null || typeof value !== 'object') return null;
  const outcome = (value as { outcome?: unknown }).outcome;
  if (
    outcome !== 'enqueued' &&
    outcome !== 'rejected-validation' &&
    outcome !== 'rejected-definition' &&
    outcome !== 'rejected-queue'
  ) {
    return null;
  }
  return value as LaunchPipelineResult;
}

/**
 * Submit a composed request and resolve the host's verdict.
 *
 * Resolves the wire `LaunchPipelineResult` verbatim — the union is declared once,
 * in the contract, so there is no webview copy to drift. The promise always
 * settles: host silence past five seconds resolves as `not-yet-known`,
 * which is what lets the composer's `finally` restore an editable form (FR-045)
 * without a second unwinding path.
 *
 * The post-and-correlate sequence runs synchronously inside the Promise executor
 * so two submissions cannot cross-resolve, per the established idiom.
 *
 * Feature 103 (T069, FR-059) — `queueId` names which queue admits the enqueue.
 * Optional and omitted from the payload when absent, so a launch from Runs puts
 * exactly the bytes on the wire it always did and the host's one defaulting site
 * inside `scheduleOrEnqueue` still decides what "no queue named" means. This
 * mirrors `LaunchWorkflowPayload.queueId`, which has carried the same field on
 * the same terms since feature 092.
 */
export function launchPipeline(
  request: RunRequest,
  queueId?: string,
  options: IntentWaitOptions<LaunchPipelineResult | NotYetKnown> = {}
): Promise<LaunchPipelineResult | NotYetKnown> {
  // Spread rather than `queueId` so an absent one is an absent key. The ingress guard
  // allowlists the two names and rejects anything else; an explicit `undefined` survives
  // `Object.keys` and would be refused.
  const payload = { request, ...(queueId === undefined ? {} : { queueId }) };
  const toResult = (ack: AckResult): LaunchPipelineResult =>
    asLaunchResult(ack.result) ?? UNUSABLE_ACK_RESULT;
  const { onLateOutcome } = options;
  // FR-R4-F05 (I4) — through the intent ledger: an identical retry of an unresolved launch
  // reuses its identity and payload, so the host enqueues the run once.
  return sendIntent({
    type: CMD_LAUNCH_PIPELINE,
    payload,
    post: (correlationId, stored) => {
      postCommand(CMD_LAUNCH_PIPELINE, stored, { correlationId });
    },
    timeoutMs: ACK_TIMEOUT_MS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(onLateOutcome === undefined
      ? {}
      : { onLateOutcome: (ack: AckResult) => onLateOutcome(toResult(ack)) })
  }).then((result): LaunchPipelineResult | NotYetKnown =>
    result.kind === 'ack' ? toResult(result.ack) : NOT_YET_KNOWN
  );
}
