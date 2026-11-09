// FR-R6-F05 (FR-021, contract surfaces-and-wiring.md §5) — storage details IPC helper. The SINGLE
// call site for `CMD_READ_STORAGE_DETAILS`.
//
// Components MUST NOT import the command constant or call `postCommand` for it directly: they route
// through `requestStorageDetails()` below. Read-only, so it takes no `useConfirm` gate (hard rule 30
// governs destructive actions only), exactly like `failure-record-ipc.ts`, which this mirrors.
//
// There is no push counterpart: the host answers once, on the ack, with the same `LifecycleResult`
// the headless API returns. A refusal acks `rejected` and still carries its result, so a valid result
// is passed on whatever the status, and anything else becomes the `unavailable` refusal.

import { CMD_READ_STORAGE_DETAILS, type ReadStorageDetailsResponse } from './messages';
import { postCommand } from './vscode-api';
import { snapshotStore } from './snapshot-store.svelte';
import { isValidReadStorageDetailsResponse } from '../../../src/contracts/runtime-validators';

const ACK_TIMEOUT_MS = 5000;

const UNAVAILABLE: ReadStorageDetailsResponse = {
  ok: false,
  refusal: { code: 'unavailable', message: 'storage details are unavailable' }
};

/** Storage pressure and one inventory page; pass the previous page's `nextCursor` for the next. */
export function requestStorageDetails(cursor?: string): Promise<ReadStorageDetailsResponse> {
  return correlatedRequest<ReadStorageDetailsResponse>(
    () => postCommand(CMD_READ_STORAGE_DETAILS, cursor === undefined ? {} : { cursor }).correlationId,
    (ack) => (isValidReadStorageDetailsResponse(ack.result) ? ack.result : UNAVAILABLE),
    UNAVAILABLE
  );
}

// Shared ack-correlation primitive: post a command, register a one-shot ack listener, and resolve via
// the supplied projection. On 5-second timeout, resolves with the supplied fallback. The
// post-and-correlate sequence runs synchronously inside the Promise executor so concurrent calls never
// cross-resolve. Duplicated per file per this codebase's existing IPC-helper convention
// (`failure-record-ipc.ts`, `history-evidence-ipc.ts`, `history-description-ipc.ts`).
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
