// Feature 030 (US2, T033) — reorder IPC helper. The SINGLE call site
// for `CMD_REORDER_TASK`, `CMD_MOVE_QUEUE_ITEM_UP`, and
// `CMD_MOVE_QUEUE_ITEM_DOWN` in the webview. Mirrors the pattern from
// `phase-breakpoint-ipc.ts`, `save-general-settings.ts`, and
// `phase-log-ipc.ts`.
//
// Webview components MUST NOT import the underlying CMD_ constants
// directly — they route through this module. The lint regression at
// `tests/lint/no-inline-reorder-ipc.test.ts` fails the build on any
// drift; the allowlist of legitimate importers is pinned in that test.
//
// Behavior (per command):
//   1. Post the command (host generates correlationId via postCommand).
//   2. Mark the correlationId pending in the snapshot store.
//   3. Register a one-shot ack listener.
//   4. On ack, resolve { status: 'accepted' | 'rejected', reason? }.
//   5. On 5-second timeout, resolve { status: 'rejected',
//      reason: 'timeout' } so the UI can surface a recovery affordance.
//   6. Concurrent calls never cross-resolve — correlation by id.

import {
  CMD_REORDER_TASK,
  CMD_MOVE_QUEUE_ITEM_UP,
  CMD_MOVE_QUEUE_ITEM_DOWN
} from './messages';
import { postCommand } from './vscode-api';
import { snapshotStore } from './snapshot-store.svelte';

const ACK_TIMEOUT_MS = 5000;

export type ReorderResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected'; readonly reason: string };

/**
 * Drag-and-drop reorder: move `taskId` to `newPosition` within the
 * unified pending list. The host validates the (taskId, newPosition)
 * tuple against the current snapshot before mutating state.
 */
export function postReorderTask(
  taskId: string,
  newPosition: number
): Promise<ReorderResult> {
  return correlatedRequest(
    () => postCommand(CMD_REORDER_TASK, { taskId, newPosition }).correlationId
  );
}

/**
 * Arrow-driven move: move `taskId` up one position in the unified
 * pending list. Equivalent to `postReorderTask(taskId, currentPos - 1)`,
 * but the host resolves the current pending position so the caller
 * does not need to re-read the snapshot.
 */
export function postMoveItemUp(taskId: string): Promise<ReorderResult> {
  return correlatedRequest(
    () => postCommand(CMD_MOVE_QUEUE_ITEM_UP, { id: taskId }).correlationId
  );
}

/**
 * Arrow-driven move: move `taskId` down one position in the unified
 * pending list. See `postMoveItemUp` for semantics.
 */
export function postMoveItemDown(taskId: string): Promise<ReorderResult> {
  return correlatedRequest(
    () => postCommand(CMD_MOVE_QUEUE_ITEM_DOWN, { id: taskId }).correlationId
  );
}

function correlatedRequest(post: () => string): Promise<ReorderResult> {
  return new Promise<ReorderResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finalise = (result: ReorderResult): void => {
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
      if (ack.status === 'accepted') {
        finalise({ status: 'accepted' });
      } else {
        finalise({ status: 'rejected', reason: ack.reason ?? 'rejected' });
      }
    });

    timer = setTimeout(() => {
      finalise({ status: 'rejected', reason: 'timeout' });
    }, ACK_TIMEOUT_MS);
  });
}
