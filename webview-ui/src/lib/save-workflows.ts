// Feature 083 (US1, T034) — shared saveWorkflows helper.
//
// This is the ONE call site for CMD_SAVE_WORKFLOWS in the webview, pinned by
// `tests/lint/no-inline-save-catalog.test.ts`. Contract:
//   specs/083-workflow-graph-builder/contracts/save-workflows-ipc.md
//
// Structurally identical to `save-pipelines.ts` (FR-034): UUIDv4 correlation,
// `snapshotStore.markPending`, a one-shot ack listener, a 5-second timeout, and
// no cross-resolution between concurrent saves. It does not share
// `save-catalog-command.ts` because that helper discards `ack.result`, and a
// `stale-catalog` or `workflow-validation` rejection carries the structured
// recovery payload the Builder needs to anchor host defects to a field path.
//
// The request is forwarded verbatim. Authored node and connection order is part
// of the payload's meaning (FR-049), so nothing here sorts, dedupes, or
// normalizes the graph — the host validator is the only thing entitled to
// reject it.

import { CMD_SAVE_WORKFLOWS } from './messages';
import type {
  WorkflowCatalogMutation,
  WorkflowConnection,
  WorkflowNode,
  WritableWorkflowDefinitionScope
} from './snapshot-types';
import { postCommand } from './vscode-api';
import { snapshotStore } from './snapshot-store.svelte';

const ACK_TIMEOUT_MS = 5000;

/**
 * An authored row as the Builder emits it. Unlike a Pipeline row there is no
 * legacy key form to accommodate: `schegent.workflows` is new in this feature,
 * so `workflowId` is the only identity spelling.
 */
export interface SaveWorkflowRow {
  readonly workflowId: string;
  readonly name: string;
  readonly description?: string;
  readonly version: number;
  readonly nodes: readonly WorkflowNode[];
  readonly connections: readonly WorkflowConnection[];
  readonly startNodeIds: readonly string[];
}

export type SaveWorkflowsMutation = WorkflowCatalogMutation;

export interface SaveWorkflowsRequest {
  readonly scope: WritableWorkflowDefinitionScope;
  readonly expectedRevision: string;
  readonly mutation: SaveWorkflowsMutation;
  readonly workflows: readonly SaveWorkflowRow[];
}

export type SaveWorkflowsResult =
  | { readonly status: 'accepted'; readonly result?: unknown }
  | { readonly status: 'rejected'; readonly reason: string; readonly result?: unknown };

/**
 * Persist one complete `schegent.workflows` layer via the CMD_SAVE_WORKFLOWS
 * IPC. Resolves with the host's ack, or with
 * `{ status: 'rejected', reason: 'timeout' }` after 5 seconds of silence so the
 * UI can surface a recovery affordance instead of hanging.
 *
 * @param request      Scope, the revision the draft was based on, the mutation
 *                     intent, and the full layer snapshot (all-or-nothing save).
 * @param postMessage  Optional injection point for tests. When omitted, the
 *                     helper uses the standard `postCommand` path so the
 *                     envelope is observable by the snapshot store and the
 *                     VS Code webview message bus.
 */
export function saveWorkflows(
  request: SaveWorkflowsRequest,
  postMessage?: (msg: unknown) => void
): Promise<SaveWorkflowsResult> {
  return new Promise<SaveWorkflowsResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finalise = (result: SaveWorkflowsResult): void => {
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
          // unsubscribe errors must not leak; the listener is one-shot.
        }
        unsubscribe = null;
      }
      resolve(result);
    };

    let correlationId: string;
    if (postMessage) {
      correlationId = uuidv4();
      postMessage({ type: CMD_SAVE_WORKFLOWS, correlationId, payload: request });
    } else {
      const posted = postCommand(CMD_SAVE_WORKFLOWS, request);
      correlationId = posted.correlationId;
    }

    snapshotStore.markPending(correlationId);
    unsubscribe = snapshotStore.onceAck(correlationId, (ack) => {
      if (ack.status === 'accepted') {
        finalise({ status: 'accepted', ...(ack.result !== undefined ? { result: ack.result } : {}) });
      } else {
        finalise({
          status: 'rejected',
          reason: ack.reason ?? 'rejected',
          ...(ack.result !== undefined ? { result: ack.result } : {})
        });
      }
    });

    timer = setTimeout(() => {
      finalise({ status: 'rejected', reason: 'timeout' });
    }, ACK_TIMEOUT_MS);
  });
}

function uuidv4(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
