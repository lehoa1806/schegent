// FR-R3-010 (T410/T411) — history evidence drill-down IPC helper. The SINGLE
// call site for `CMD_RESOLVE_AUDIT_POINTER`. Mirrors `metrics-ipc.ts`, which in
// turn mirrors `phase-log-ipc.ts`'s `correlatedRequest` pattern.
//
// Components MUST NOT import `CMD_RESOLVE_AUDIT_POINTER` or call `postCommand`
// for it directly — they route through `resolveAuditPointer()` below. The
// drill-down is read-only, so it takes no `useConfirm` gate.
//
// There is no push counterpart: the host answers once, on the ack. Evidence is
// a completed Run's, so there is nothing to stream.

import {
  CMD_RESOLVE_AUDIT_POINTER,
  type ResolveAuditPointerResponse
} from './messages';
import { postCommand } from './vscode-api';
import { snapshotStore } from './snapshot-store.svelte';
import { isValidResolveAuditPointerResponse } from '../../../src/contracts/runtime-validators';

const ACK_TIMEOUT_MS = 5000;

/**
 * The helper resolves with the host's own union, unchanged — including its
 * three "no evidence" arms.
 *
 * Collapsing `evidence-expired` / `no-evidence-recorded` / `unaddressable` into
 * a failure here would undo T411 before the renderer ever saw them: those are
 * true answers about a Run whose evidence aged out, was never written, or was
 * addressed by a pointer an older build wrote. Only a rejected ack, a
 * malformed result, and the timeout become `failure`, and each of those really
 * is a case where the webview does not know.
 */
export type ResolveAuditPointerResult = ResolveAuditPointerResponse;

export function resolveAuditPointer(runId: string): Promise<ResolveAuditPointerResult> {
  return correlatedRequest<ResolveAuditPointerResult>(
    () => postCommand(CMD_RESOLVE_AUDIT_POINTER, { runId }).correlationId,
    (ack) => {
      // The host acks the three "no evidence" arms as `accepted` on purpose —
      // see `cmd-resolve-audit-pointer.ts`. Reading the status alone would put
      // them back on the error path this helper exists to keep them off.
      if (ack.status === 'accepted' && isValidResolveAuditPointerResponse(ack.result)) {
        return ack.result;
      }
      if (isValidResolveAuditPointerResponse(ack.result) && ack.result.outcome === 'failure') {
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
// convention (`phase-log-ipc.ts`, `metrics-ipc.ts`).
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
