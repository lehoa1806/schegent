import { snapshotStore } from './snapshot-store.svelte';
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
  return new Promise<SaveCatalogResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finalise = (result: SaveCatalogResult): void => {
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
          // The listener is one-shot; cleanup errors should not leak to UI code.
        }
        unsubscribe = null;
      }
      resolve(result);
    };

    let correlationId: string;
    if (postMessage) {
      correlationId = uuidv4();
      postMessage({ type, correlationId, payload });
    } else {
      const posted = postCommand(type, payload);
      correlationId = posted.correlationId;
    }

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
