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
import { snapshotStore } from './snapshot-store.svelte';

const ACK_TIMEOUT_MS = 5000;

/**
 * What the composer renders when the host says nothing at all.
 *
 * It is a `rejected-queue` rather than a new outcome so the wire union stays the
 * contract's (`src/contracts/sidebar-ipc/run-launcher.ts`) and the composer has
 * one refusal family to render, not two. `detail` distinguishes it for the
 * operator, whose next action — retry — is the same as for any other queue-side
 * refusal.
 */
const TIMEOUT_RESULT: LaunchPipelineResult = {
  outcome: 'rejected-queue',
  reason: 'queue-refused',
  detail: 'no-host-response'
};

/** The host answered, but not with something this family can render. */
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
 * settles: host silence past five seconds resolves as the timeout refusal above,
 * which is what lets the composer's `finally` restore an editable form (FR-045)
 * without a second unwinding path.
 *
 * The post-and-correlate sequence runs synchronously inside the Promise executor
 * so two submissions cannot cross-resolve, per the established idiom.
 */
export function launchPipeline(request: RunRequest): Promise<LaunchPipelineResult> {
  return new Promise<LaunchPipelineResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finalise = (result: LaunchPipelineResult): void => {
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

    const { correlationId } = postCommand(CMD_LAUNCH_PIPELINE, { request });

    snapshotStore.markPending(correlationId);
    unsubscribe = snapshotStore.onceAck(correlationId, (ack) => {
      finalise(asLaunchResult(ack.result) ?? UNUSABLE_ACK_RESULT);
    });

    timer = setTimeout(() => {
      finalise(TIMEOUT_RESULT);
    }, ACK_TIMEOUT_MS);
  });
}
