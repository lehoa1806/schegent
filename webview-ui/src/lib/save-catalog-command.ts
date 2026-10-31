import { sendIntent } from './intent-ledger';
import type { SidebarCommand } from './messages';
import { postCommand } from './vscode-api';

const ACK_TIMEOUT_MS = 5000;

export type SaveCatalogResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected'; readonly reason: string };

export function saveCatalogCommand<C extends SidebarCommand>(
  type: C['type'],
  payload: C extends { payload: infer P } ? P : undefined,
  postMessage?: (msg: unknown) => void
): Promise<SaveCatalogResult> {
  // FR-R4-F05 (I4) — sent through the intent ledger: an identical retry of an unresolved save
  // reuses its identity and payload, and the host applies it once. A wait that outlives
  // `ACK_TIMEOUT_MS` resolves `timeout` (the outcome is not yet known), as it always did.
  return sendIntent({
    type,
    payload,
    post: (correlationId, stored) => {
      if (postMessage) postMessage({ type, correlationId, payload: stored });
      else postCommand(type, stored, { correlationId });
    },
    timeoutMs: ACK_TIMEOUT_MS
  }).then((result): SaveCatalogResult => {
    if (result.kind !== 'ack') return { status: 'rejected', reason: 'timeout' };
    return result.ack.status === 'accepted'
      ? { status: 'accepted' }
      : { status: 'rejected', reason: result.ack.reason ?? 'rejected' };
  });
}
