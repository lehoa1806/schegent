import { saveCatalogCommand } from './save-catalog-command';
import { CMD_SAVE_MODELS } from './messages';
import { postCommand } from './vscode-api';
import { sendIntent, type IntentWaitOptions } from './intent-ledger';
import type { AckResult } from './snapshot-store.svelte';

export type SaveModelsResult =
  | { readonly status: 'accepted'; readonly revision?: string }
  | { readonly status: 'rejected'; readonly reason: string };

export async function saveModels(
  models: Record<string, readonly string[]>,
  expectedRevision: string,
  postMessage?: (msg: unknown) => void
): Promise<SaveModelsResult> {
  const ack = await saveCatalogCommand(CMD_SAVE_MODELS, { models, expectedRevision, mutation: { kind: 'manual-edit' } }, postMessage);
  if (ack.status === 'rejected') return ack;
  const result = ack.result;
  return typeof result === 'object' && result !== null && 'revision' in result && typeof result.revision === 'string'
    ? { status: 'accepted', revision: result.revision }
    : { status: 'accepted' };
}

const IMPORT_ACK_TIMEOUT_MS = 5000;

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
