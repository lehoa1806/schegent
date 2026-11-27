// FR-R3-071 (feature 152) — history description resolution IPC helper. The
// SINGLE call site for `CMD_RESOLVE_HISTORY_DESCRIPTION`.
//
// Components MUST NOT import the command constant or call `postCommand` for it
// directly — they route through `resolveHistoryDescription()` below. Read-only,
// so it takes no `useConfirm` gate, exactly like `history-evidence-ipc.ts`,
// which this mirrors.
//
// There is no push counterpart: the host answers once, on the ack. A completed
// Run's description does not change, so there is nothing to stream.

import {
  CMD_RESOLVE_HISTORY_DESCRIPTION,
  type ResolveHistoryDescriptionResponse
} from './messages';
import { postCommand } from './vscode-api';
import { snapshotStore } from './snapshot-store.svelte';
import { isValidResolveHistoryDescriptionResponse } from '../../../src/contracts/runtime-validators';

const ACK_TIMEOUT_MS = 5000;

/**
 * The helper resolves with the host's own union, unchanged.
 *
 * `missing` and `unreadable` stay distinct from `failure`: they are answers
 * about a Run whose sidecar was swept or could not be read, and the panel
 * renders them by keeping the preview it already shows. Only a rejected ack, a
 * malformed result, and the timeout become `failure` — each of those really is
 * a case where the webview does not know.
 */
export type ResolveHistoryDescriptionResult = ResolveHistoryDescriptionResponse;

export function resolveHistoryDescription(
  runId: string
): Promise<ResolveHistoryDescriptionResult> {
  return correlatedRequest<ResolveHistoryDescriptionResult>(
    () => postCommand(CMD_RESOLVE_HISTORY_DESCRIPTION, { runId }).correlationId,
    (ack) => {
      // The host acks `missing`/`unreadable` as `accepted` on purpose — see
      // `cmd-resolve-history-description.ts`. Reading the status alone would
      // put a true answer back on the error path.
      if (ack.status === 'accepted' && isValidResolveHistoryDescriptionResponse(ack.result)) {
        return ack.result;
      }
      if (
        isValidResolveHistoryDescriptionResponse(ack.result) &&
        ack.result.outcome === 'failure'
      ) {
        return ack.result;
      }
      return { outcome: 'failure', reason: 'internal-error' };
    },
    { outcome: 'failure', reason: 'internal-error' }
  );
}

// Shared ack-correlation primitive: post a command, register a one-shot ack
// listener, and resolve via the supplied projection. On 5-second timeout,
// resolves with the supplied fallback. The post-and-correlate sequence runs
// synchronously inside the Promise executor so concurrent calls never
// cross-resolve. Duplicated per file per this codebase's existing IPC-helper
// convention (`phase-log-ipc.ts`, `metrics-ipc.ts`, `history-evidence-ipc.ts`).
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
