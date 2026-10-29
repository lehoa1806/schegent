// FR-R4-F15 (feature 243, contract P1) — failure record IPC helper. The SINGLE call site for
// `CMD_READ_FAILURE_RECORD`.
//
// Components MUST NOT import the command constant or call `postCommand` for it directly: they route
// through `readFailureRecord()` below. Read-only, so it takes no `useConfirm` gate (hard rule 30
// governs destructive actions only), exactly like `history-description-ipc.ts`, which this mirrors.
//
// There is no push counterpart: the host answers once, on the ack. Nothing here asks again; the panel
// asks each time its region opens, because a record the retention sweep removed since the last look
// must not be shown from a cache.

import {
  CMD_READ_FAILURE_RECORD,
  type ReadFailureRecordResponse
} from './messages';
import { postCommand } from './vscode-api';
import { snapshotStore } from './snapshot-store.svelte';
import { isValidReadFailureRecordResponse } from '../../../src/contracts/runtime-validators';

const ACK_TIMEOUT_MS = 5000;

/**
 * What the "Show last error" region is showing: nothing yet, one of the host's five answers, or the
 * fact that the webview does not know. `failed` is the single state for a rejected ack, an invalid
 * result and a timeout, and for the host's own `failure` arm: each of those really is a case where the
 * webview cannot say what the Run left.
 */
export type FailureRecordPanelState =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'answer';
      readonly answer: Exclude<ReadFailureRecordResponse, { readonly outcome: 'failure' }>;
    }
  | { readonly kind: 'failed' };

const INTERNAL_ERROR: ReadFailureRecordResponse = { outcome: 'failure', reason: 'internal-error' };

/**
 * Resolves with the host's own union, validated. The four answer arms ack as `accepted` on purpose (see
 * `cmd-read-failure-record.ts`), so the status alone is not the answer: a valid result is passed on
 * whatever the status, and anything else becomes the failure arm.
 */
export function readFailureRecord(queueId: string, taskId: string): Promise<ReadFailureRecordResponse> {
  return correlatedRequest<ReadFailureRecordResponse>(
    () => postCommand(CMD_READ_FAILURE_RECORD, { queueId, taskId }).correlationId,
    (ack) => (isValidReadFailureRecordResponse(ack.result) ? ack.result : INTERNAL_ERROR),
    INTERNAL_ERROR
  );
}

/** The state a resolved request puts the panel in. */
export function panelStateFor(response: ReadFailureRecordResponse): FailureRecordPanelState {
  return response.outcome === 'failure' ? { kind: 'failed' } : { kind: 'answer', answer: response };
}

// Shared ack-correlation primitive: post a command, register a one-shot ack listener, and resolve via
// the supplied projection. On 5-second timeout, resolves with the supplied fallback. The
// post-and-correlate sequence runs synchronously inside the Promise executor so concurrent calls never
// cross-resolve. Duplicated per file per this codebase's existing IPC-helper convention
// (`phase-log-ipc.ts`, `metrics-ipc.ts`, `history-evidence-ipc.ts`, `history-description-ipc.ts`).
function correlatedRequest<T>(
  post: () => string,
  project: (ack: {
    readonly status: 'accepted' | 'rejected';
    readonly reason?: string;
    readonly result?: unknown;
  }) => T,
  onTimeout: T
): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finalise = (result: T): void => {
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

    const correlationId = post();
    snapshotStore.markPending(correlationId);
    unsubscribe = snapshotStore.onceAck(correlationId, (ack) => {
      finalise(project(ack));
    });

    timer = setTimeout(() => {
      finalise(onTimeout);
    }, ACK_TIMEOUT_MS);
  });
}
