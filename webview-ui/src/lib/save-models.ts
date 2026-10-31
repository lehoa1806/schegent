import { CMD_SAVE_MODELS } from './messages';
import { saveCatalogCommand, type SaveCatalogResult } from './save-catalog-command';
import { postCommand } from './vscode-api';
import { sendIntent, type IntentWaitOptions } from './intent-ledger';
import type { AckResult } from './snapshot-store.svelte';

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
 * Structurally identical to the lifecycle senders in `catalog-lifecycle.ts` for
 * that reason: it sends through the intent ledger (an identical retry reuses its
 * identity), with a 5-second timeout so the caller can surface a recovery
 * affordance instead of hanging. It stays separate from them because the Model
 * Catalog is not a versioned catalog: it has no drafts, no versions, and no
 * lifecycle to run.
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
  postMessage?: (msg: unknown) => void,
  wait: IntentWaitOptions<SaveModelsImportResult> = {}
): Promise<SaveModelsImportResult> {
  // FR-R4-F05 (I4) — through the intent ledger, as `saveCatalogCommand` is. The expected
  // revision is part of the payload, so a retry of the SAME import is the same intent.
  return sendIntent({
    type: CMD_SAVE_MODELS,
    payload: request,
    post: (correlationId, stored) => {
      if (postMessage) postMessage({ type: CMD_SAVE_MODELS, correlationId, payload: stored });
      else postCommand(CMD_SAVE_MODELS, stored, { correlationId });
    },
    timeoutMs: IMPORT_ACK_TIMEOUT_MS,
    ...(wait.signal === undefined ? {} : { signal: wait.signal }),
    ...(wait.onLateOutcome === undefined
      ? {}
      : { onLateOutcome: (ack: AckResult) => wait.onLateOutcome?.(toImportResult(ack)) })
  }).then((result): SaveModelsImportResult =>
    result.kind === 'ack' ? toImportResult(result.ack) : { status: 'rejected', reason: 'timeout' }
  );
}

function toImportResult(ack: AckResult): SaveModelsImportResult {
  return ack.status === 'accepted'
    ? { status: 'accepted', ...(ack.result !== undefined ? { result: ack.result } : {}) }
    : {
        status: 'rejected',
        reason: ack.reason ?? 'rejected',
        ...(ack.result !== undefined ? { result: ack.result } : {})
      };
}
