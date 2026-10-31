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
  CMD_MOVE_QUEUE_ITEM_DOWN,
  type CommandType
} from './messages';
import { postCommand } from './vscode-api';
import { sendIntent, type IntentWaitOptions } from './intent-ledger';
import type { AckResult } from './snapshot-store.svelte';

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
  newPosition: number,
  wait?: IntentWaitOptions<ReorderResult>
): Promise<ReorderResult> {
  return correlatedRequest(CMD_REORDER_TASK, { taskId, newPosition }, (correlationId, payload) => {
    postCommand(CMD_REORDER_TASK, payload, { correlationId });
  }, wait);
}

/**
 * Arrow-driven move: move `taskId` up one position in the unified
 * pending list. Equivalent to `postReorderTask(taskId, currentPos - 1)`,
 * but the host resolves the current pending position so the caller
 * does not need to re-read the snapshot.
 */
export function postMoveItemUp(
  taskId: string,
  wait?: IntentWaitOptions<ReorderResult>
): Promise<ReorderResult> {
  return correlatedRequest(CMD_MOVE_QUEUE_ITEM_UP, { id: taskId }, (correlationId, payload) => {
    postCommand(CMD_MOVE_QUEUE_ITEM_UP, payload, { correlationId });
  }, wait);
}

/**
 * Arrow-driven move: move `taskId` down one position in the unified
 * pending list. See `postMoveItemUp` for semantics.
 */
export function postMoveItemDown(
  taskId: string,
  wait?: IntentWaitOptions<ReorderResult>
): Promise<ReorderResult> {
  return correlatedRequest(CMD_MOVE_QUEUE_ITEM_DOWN, { id: taskId }, (correlationId, payload) => {
    postCommand(CMD_MOVE_QUEUE_ITEM_DOWN, payload, { correlationId });
  }, wait);
}

// FR-R4-F05 (I4) — through the intent ledger: an identical retry of an unresolved reorder reuses
// its identity and payload, so the host moves the task once. A wait that outlives
// `ACK_TIMEOUT_MS` resolves `timeout` (the outcome is not yet known), as it always did; a
// caller that shows that text passes `wait`, and the late answer arrives through it (I6).
function correlatedRequest<P>(
  type: CommandType,
  payload: P,
  post: (correlationId: string, payload: P) => void,
  wait: IntentWaitOptions<ReorderResult> = {}
): Promise<ReorderResult> {
  return sendIntent({
    type,
    payload,
    post,
    timeoutMs: ACK_TIMEOUT_MS,
    ...(wait.signal === undefined ? {} : { signal: wait.signal }),
    ...(wait.onLateOutcome === undefined
      ? {}
      : { onLateOutcome: (ack: AckResult) => wait.onLateOutcome?.(toReorderResult(ack)) })
  }).then((result): ReorderResult =>
    result.kind === 'ack' ? toReorderResult(result.ack) : { status: 'rejected', reason: 'timeout' }
  );
}

function toReorderResult(ack: AckResult): ReorderResult {
  return ack.status === 'accepted'
    ? { status: 'accepted' }
    : { status: 'rejected', reason: ack.reason ?? 'rejected' };
}
