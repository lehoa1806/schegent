import { CMD_SAVE_MODELS } from './messages';
import { saveCatalogCommand, type SaveCatalogResult } from './save-catalog-command';
import { postCommand } from './vscode-api';
import { snapshotStore } from './snapshot-store.svelte';

export type SaveModelsResult = SaveCatalogResult;

export function saveModels(
  models: Record<string, readonly string[]>,
  postMessage?: (msg: unknown) => void
): Promise<SaveModelsResult> {
  return saveCatalogCommand(CMD_SAVE_MODELS, { models }, postMessage);
}

const IMPORT_ACK_TIMEOUT_MS = 5000;

/**
 * Feature 096 T023 — the import-confirm call site of `CMD_SAVE_MODELS`
 * (contracts/model-catalog-exchange.md §4). Kept separate from `saveModels`
 * above rather than widening that function's signature: the manual add/remove
 * path (its one production caller, `PipelineBuilder.svelte`) sends the whole
 * catalog unconditionally and reads nothing back, while this path sends only
 * the proposed delta, carries `expectedRevision`/`mutation`, and needs the
 * structured `ack.result` — `currentRevision` on a `stale-catalog` rejection,
 * `revision`/`mutation` on acceptance — that `saveCatalogCommand` discards.
 *
 * Structurally identical to `savePipelines`/`saveWorkflows` for that reason:
 * UUIDv4 correlation, `snapshotStore.markPending`, a one-shot ack listener,
 * and a 5-second timeout so the caller can surface a recovery affordance
 * instead of hanging.
 */
export interface SaveModelsImportRequest {
  readonly models: Record<string, readonly string[]>;
  readonly expectedRevision: string;
  readonly mutation: { readonly kind: 'import-package' };
}

export type SaveModelsImportResult =
  | { readonly status: 'accepted'; readonly result?: unknown }
  | { readonly status: 'rejected'; readonly reason: string; readonly result?: unknown };

export function saveModelsImport(
  request: SaveModelsImportRequest,
  postMessage?: (msg: unknown) => void
): Promise<SaveModelsImportResult> {
  return new Promise<SaveModelsImportResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finalise = (result: SaveModelsImportResult): void => {
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
      postMessage({ type: CMD_SAVE_MODELS, correlationId, payload: request });
    } else {
      const posted = postCommand(CMD_SAVE_MODELS, request);
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
    }, IMPORT_ACK_TIMEOUT_MS);
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
