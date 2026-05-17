import { CMD_WAKE_UP_NOW, type WakeUpNowResult } from './messages';
import { snapshotStore } from './snapshot-store.svelte';
import { postCommand } from './vscode-api';

const ACK_TIMEOUT_MS = 65_000;

export type WakeUpNowUiResult =
  | { readonly status: 'accepted'; readonly result: WakeUpNowResult }
  | { readonly status: 'rejected'; readonly reason: string };

export function wakeUpNow(
  postMessage?: (msg: unknown) => void
): Promise<WakeUpNowUiResult> {
  return new Promise<WakeUpNowUiResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finalise = (result: WakeUpNowUiResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (unsubscribe !== null) unsubscribe();
      resolve(result);
    };

    let correlationId: string;
    if (postMessage) {
      correlationId = uuidv4();
      postMessage({ type: CMD_WAKE_UP_NOW, correlationId, payload: {} });
    } else {
      correlationId = postCommand(CMD_WAKE_UP_NOW).correlationId;
    }

    snapshotStore.markPending(correlationId);
    unsubscribe = snapshotStore.onceAck(correlationId, (ack) => {
      if (ack.status === 'accepted') {
        finalise({
          status: 'accepted',
          result: normalizeResult(ack.result)
        });
      } else {
        finalise({ status: 'rejected', reason: ack.reason ?? 'rejected' });
      }
    });

    timer = setTimeout(() => {
      finalise({ status: 'rejected', reason: 'timeout' });
    }, ACK_TIMEOUT_MS);
  });
}

function normalizeResult(value: unknown): WakeUpNowResult {
  if (
    value
    && typeof value === 'object'
    && typeof (value as { outcome?: unknown }).outcome === 'string'
    && typeof (value as { message?: unknown }).message === 'string'
  ) {
    return value as WakeUpNowResult;
  }
  return { outcome: 'started', message: 'Wake up started', attempt: null };
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
