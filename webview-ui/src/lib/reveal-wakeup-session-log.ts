// Feature 031 T050 — wake-up session-log REVEAL IPC helper. The SINGLE
// call site for `CMD_REVEAL_WAKEUP_SESSION_LOG` on the webview side.
// Mirrors the pattern from `save-general-settings.ts` /
// `save-wakeup-settings.ts` / `phase-log-ipc.ts` /
// `wakeup-session-log-ipc.ts` per CLAUDE.md hard rule discipline.
//
// Webview components MUST NOT import the underlying CMD_ constant
// directly — they route through this module. The lint regression at
// `tests/lint/no-inline-reveal-wakeup-session-log.test.ts` fails the
// build on any drift.
//
// Wire-format contract:
//   * Request payload is intentionally EMPTY. The webview supplies NO
//     operator-controllable string (no path, no correlation id, nothing).
//     The host owns the path composition and applies its own
//     primary-host gate.
//   * Response shape: typed `RevealWakeupSessionLogResponse` from
//     `src/contracts/sidebar-ipc.ts`. The helper resolves it verbatim.
//
// Synthetic outcomes:
//   * `'timeout'` — synthesized after 5 seconds without any ack.

import { CMD_REVEAL_WAKEUP_SESSION_LOG } from './messages';
import { postCommand } from './vscode-api';
import { snapshotStore } from './snapshot-store.svelte';

const ACK_TIMEOUT_MS = 5000;

/**
 * Wire-format response from the host. Mirrors
 * `RevealWakeupSessionLogResponse` in `src/contracts/sidebar-ipc.ts`.
 * Structural subset declared locally so the bundled webview has zero
 * runtime dependency on the host's TypeScript-only `type` re-exports.
 */
export type RevealWakeupSessionLogResult =
  | { readonly status: 'success' }
  | {
      readonly status: 'rejected';
      readonly reason:
        | 'not-primary-host'
        | 'session-log-unavailable'
        | 'reveal-failed'
        | 'timeout'
        | 'unknown-error';
    };

export type PostMessageFn = (message: unknown) => void;

/**
 * Request the host open the OS file manager at the on-disk
 * `session.log` file. The path is host-resolved — the webview NEVER
 * supplies one.
 *
 * @param postMessage - injected `postMessage` for unit tests; in
 *                      production defaults to the VS Code webview
 *                      host's `postMessage`.
 */
export function revealWakeupSessionLog(
  postMessage?: PostMessageFn
): Promise<RevealWakeupSessionLogResult> {
  return new Promise<RevealWakeupSessionLogResult>((resolve) => {
    const envelopeCorrelationId = freshUuidV4();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finalise = (result: RevealWakeupSessionLogResult): void => {
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
          // one-shot listener errors must not leak past the helper
        }
        unsubscribe = null;
      }
      resolve(result);
    };

    snapshotStore.markPending(envelopeCorrelationId);
    unsubscribe = snapshotStore.onceAck(envelopeCorrelationId, (ack) => {
      const result = ack.result as RevealWakeupSessionLogResult | undefined;
      if (
        result
        && (result.status === 'success' || result.status === 'rejected')
      ) {
        finalise(result);
        return;
      }
      // Defensive fallback — the host should always provide a typed
      // result; synthesize closed-vocabulary rejection on shape
      // mismatch.
      finalise({ status: 'rejected', reason: 'unknown-error' });
    });

    if (postMessage) {
      postMessage({
        type: CMD_REVEAL_WAKEUP_SESSION_LOG,
        correlationId: envelopeCorrelationId,
        payload: {}
      });
    } else {
      postCommand(CMD_REVEAL_WAKEUP_SESSION_LOG, undefined, {
        correlationId: envelopeCorrelationId
      });
    }

    timer = setTimeout(() => {
      finalise({ status: 'rejected', reason: 'timeout' });
    }, ACK_TIMEOUT_MS);
  });
}

/**
 * Generate a canonical RFC 4122 UUIDv4 (lowercase hex, version=4,
 * variant in 8-b). Same shape as the host's `uuidv4` helper.
 */
function freshUuidV4(): string {
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
