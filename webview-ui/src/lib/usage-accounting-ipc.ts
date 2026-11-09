// FR-R6-F06 (T030, contracts/surfaces-and-wiring.md section 5) — usage accounting IPC helper. The
// SINGLE call site for `CMD_READ_USAGE_ACCOUNTING`.
//
// Components MUST NOT import the command constant or call `postCommand` for it directly: they route
// through `requestUsageAccounting()` below. Read-only, so it takes no `useConfirm` gate (hard rule 30
// governs destructive actions only), exactly like `storage-details-ipc.ts`, which this mirrors. No
// view uses it yet; F11 owns the reporting surfaces.
//
// The host answers once, on the ack, with the same `AccountingResult` the headless API returns. A
// refusal acks `rejected` and still carries its result, so a valid result is passed on whatever the
// status, and anything else becomes the `store-unavailable` refusal.

import { CMD_READ_USAGE_ACCOUNTING, type ReadUsageAccountingResponse } from './messages';
import { postCommand } from './vscode-api';
import { snapshotStore } from './snapshot-store.svelte';
import { isValidReadUsageAccountingResponse } from '../../../src/contracts/runtime-validators';

const ACK_TIMEOUT_MS = 5000;

const STORE_UNAVAILABLE: ReadUsageAccountingResponse = { ok: false, refusal: { code: 'store-unavailable' } };

/** One revision-pinned accounting page; the host validates `query` exactly as the headless API does. */
export function requestUsageAccounting(query: unknown): Promise<ReadUsageAccountingResponse> {
  return correlatedRequest<ReadUsageAccountingResponse>(
    () => postCommand(CMD_READ_USAGE_ACCOUNTING, { query }).correlationId,
    (ack) => (isValidReadUsageAccountingResponse(ack.result) ? ack.result : STORE_UNAVAILABLE),
    STORE_UNAVAILABLE
  );
}

// Shared ack-correlation primitive: post a command, register a one-shot ack listener, and resolve via
// the supplied projection. On 5-second timeout, resolves with the supplied fallback. The
// post-and-correlate sequence happens synchronously inside the Promise executor so concurrent calls
// never cross-resolve. Duplicated per file per this codebase's existing IPC-helper convention
// (`storage-details-ipc.ts`, `failure-record-ipc.ts`, `history-evidence-ipc.ts`).
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
