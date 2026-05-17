// Feature 014 T027 — shared saveWakeUpSettings helper.
//
// This is the ONE call site for CMD_SAVE_WAKEUP_SETTINGS in the
// webview. The lint regression at
// tests/lint/no-inline-save-wakeup-settings.test.ts pins this file as
// the only file allowed to mention the literal (CLAUDE.md hard rule).
//
// Behavior mirrors `save-general-settings.ts`:
//   1. Generate a UUIDv4 correlationId.
//   2. Post CMD_SAVE_WAKEUP_SETTINGS with the four-key payload.
//   3. Mark the correlationId pending in the snapshot store.
//   4. Register a one-shot ack listener.
//   5. On ack, resolve { status, reason? }.
//   6. On 5-second timeout, resolve { status: 'rejected', reason: 'timeout' }.
//
// Contract: specs/014-wake-up/contracts/wakeup-settings-ipc.md.

import { CMD_SAVE_WAKEUP_SETTINGS } from './messages';
import { postCommand } from './vscode-api';
import { snapshotStore } from './snapshot-store.svelte';

const ACK_TIMEOUT_MS = 5000;

export interface WakeUpSettingsPayload {
  readonly enabled: boolean;
  readonly schedulerType: 'chronological' | 'periodic';
  readonly chronologicalTime: string;
  readonly periodicInterval: string;
  /**
   * Feature 031 — operator's Claude model selection. Optional on the
   * wire for backwards compatibility; when omitted the host coerces
   * to the `'runner-default'` sentinel. The closed-registry membership
   * check + rejection-with-`invalid-model` happens host-side.
   */
  readonly model?: string;
}

export type SaveWakeUpSettingsResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected'; readonly reason: string };

/**
 * Persist the four `schegent.wakeUp.*` settings transactionally and
 * drive the OS-native daemon install/uninstall. Returns the host's
 * ack within 5 s or a `{ status: 'rejected', reason: 'timeout' }`.
 *
 * The reason string for rejections is rendered verbatim in the
 * settings UI — host MUST keep it free of paths/PII (the host
 * sanitization pipeline already does this for `daemon-install-failed`
 * suffixes).
 *
 * @param payload      The four-key wake-up settings record.
 * @param postMessage  Optional injection point for tests. When omitted,
 *                     routes through `postCommand` (production path).
 */
export function saveWakeUpSettings(
  payload: WakeUpSettingsPayload,
  postMessage?: (msg: unknown) => void
): Promise<SaveWakeUpSettingsResult> {
  return new Promise<SaveWakeUpSettingsResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finalise = (result: SaveWakeUpSettingsResult): void => {
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
          /* one-shot — swallow */
        }
        unsubscribe = null;
      }
      resolve(result);
    };

    let correlationId: string;
    if (postMessage) {
      correlationId = uuidv4();
      const envelope = {
        type: CMD_SAVE_WAKEUP_SETTINGS,
        correlationId,
        payload
      };
      postMessage(envelope);
    } else {
      const posted = postCommand(CMD_SAVE_WAKEUP_SETTINGS, payload);
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
