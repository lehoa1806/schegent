// Feature 082 (US1, T028) — shared savePipelines helper.
//
// This is the ONE call site for CMD_SAVE_PIPELINES in the webview, pinned by
// `tests/lint/no-inline-save-catalog.test.ts`. Contract:
//   specs/082-pipeline-contracts-builder/contracts/save-pipelines-ipc.md
//
// Structurally identical to `save-phases.ts`: UUIDv4 correlation,
// `snapshotStore.markPending`, a one-shot ack listener, a 5-second timeout, and
// no cross-resolution between concurrent saves. It does not share
// `save-catalog-command.ts` because that helper discards `ack.result`, and both
// catalog saves need the structured recovery payload a `stale-catalog` or
// `pipeline-validation` rejection carries back.
//
// The request is forwarded verbatim. The pre-082 helper posted `{ pipelines }`
// and dropped every authored contract field on the floor; nothing here reshapes
// the payload, so ports, bindings, and execution defaults reach the host intact.

import { CMD_SAVE_PIPELINES } from './messages';
import type {
  PhaseBinding,
  PipelineCatalogMutation,
  PipelineExecutionDefaults,
  PipelineInputPort,
  PipelineOutputPort
} from './snapshot-types';
import { postCommand } from './vscode-api';
import { snapshotStore } from './snapshot-store.svelte';

const ACK_TIMEOUT_MS = 5000;

/**
 * An authored row as the Builder emits it. Both the portable key form
 * (`pipelineId` / `phaseIds`) and the legacy authored form (`id` / `phases`)
 * are accepted by the host validator, so the row type carries both; the host
 * rejects a row that supplies neither.
 */
export interface SavePipelineRow {
  readonly id?: string;
  readonly pipelineId?: string;
  readonly name: string;
  readonly description?: string;
  readonly version: number;
  readonly phases?: readonly string[];
  readonly phaseIds?: readonly string[];
  readonly inputs?: readonly PipelineInputPort[];
  readonly outputs?: readonly PipelineOutputPort[];
  readonly bindings?: readonly PhaseBinding[];
  readonly executionDefaults?: PipelineExecutionDefaults;
  readonly recommendedNext?: readonly string[];
}

export type SavePipelinesMutation = PipelineCatalogMutation;

export interface SavePipelinesRequest {
  readonly expectedRevision: string;
  readonly mutation: SavePipelinesMutation;
  readonly pipelines: readonly SavePipelineRow[];
}

export type SavePipelinesResult =
  | { readonly status: 'accepted'; readonly result?: unknown }
  | { readonly status: 'rejected'; readonly reason: string; readonly result?: unknown };

/**
 * Persist the complete Pipeline catalog via the CMD_SAVE_PIPELINES
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
export function savePipelines(
  request: SavePipelinesRequest,
  postMessage?: (msg: unknown) => void
): Promise<SavePipelinesResult> {
  return new Promise<SavePipelinesResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finalise = (result: SavePipelinesResult): void => {
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
      postMessage({ type: CMD_SAVE_PIPELINES, correlationId, payload: request });
    } else {
      const posted = postCommand(CMD_SAVE_PIPELINES, request);
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
