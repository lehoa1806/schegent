// Feature 031 T037 — wake-up session-log IPC helper. The SINGLE call
// site for `CMD_READ_WAKEUP_SESSION_LOG` on the webview side. Mirrors
// the pattern from `save-general-settings.ts` /
// `save-wakeup-settings.ts` / `phase-log-ipc.ts` per CLAUDE.md hard
// rule discipline.
//
// Webview components MUST NOT import the underlying CMD_ constant
// directly — they route through this module. The lint regression at
// `tests/lint/no-inline-read-wakeup-session-log.test.ts` fails the
// build on any drift.
//
// Resolution shape: this helper resolves the typed
// `ReadWakeupSessionLogResponse` (the wire format from
// `src/contracts/sidebar-ipc.ts`) verbatim — the helper does NOT
// re-shape the host's response. The only synthetic outcomes the helper
// adds are:
//
//   (a) `'invalid-correlation-id'` — client-side short-circuit, the
//       envelope NEVER reaches `postMessage`. Defense in depth (the
//       host validates again).
//   (b) `'timeout'`               — synthesized after 5 seconds without
//       any ack. The host rejection vocabulary does not carry
//       `'timeout'` because the host either acks (accepted/rejected)
//       or it doesn't ack at all; the helper turns the silence into a
//       retryable rejection so the UI can render an error state.

import { CMD_READ_WAKEUP_SESSION_LOG } from './messages';
import { postCommand } from './vscode-api';
import { snapshotStore } from './snapshot-store.svelte';

const ACK_TIMEOUT_MS = 5000;

/** Canonical RFC 4122 UUIDv4 — 36 chars, lowercase hex, version=4, variant in 8-b. */
const UUIDV4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Wire-format response from the host. Mirrors
 * `ReadWakeupSessionLogResponse` in `src/contracts/sidebar-ipc.ts`. We
 * re-declare a structural subset here so the helper has zero runtime
 * dependency on the host's TypeScript-only `type` re-exports (the
 * Vite-bundled webview erases types at build time but the structural
 * declaration is enough for the helper).
 */
export type ReadWakeupSessionLogResult =
  | {
      readonly status: 'success';
      readonly correlationId: string;
      readonly capturedAtMs: number;
      readonly trigger: 'scheduled' | 'manual';
      readonly model: string;
      readonly outcome: 'succeeded' | 'failed';
      readonly body: string;
      readonly bodyTruncated: boolean;
      readonly fullBlockBytesOnDisk: number;
    }
  | {
      readonly status: 'rejected';
      readonly reason:
        | 'not-primary-host'
        | 'invalid-correlation-id'
        | 'unknown-correlation-id'
        | 'session-log-unavailable'
        | 'unknown-error'
        | 'timeout';
    };

export type PostMessageFn = (message: unknown) => void;

/**
 * Send the read request to the host and resolve the typed response.
 *
 * @param correlationId - the invocation id (NOT the request envelope id)
 * @param postMessage   - injected `postMessage` for unit tests; in
 *                        production defaults to the VS Code webview
 *                        host's `postMessage`. The test in
 *                        `wakeup-session-log-ipc.test.ts` (T030)
 *                        injects a spy so it can introspect the
 *                        envelope without spinning up a real host.
 *
 * The envelope correlationId is FRESH per call (a UUIDv4 generated
 * client-side) and is DISTINCT from the body `correlationId` (the
 * invocation id). The ack pattern uses the envelope id to route the
 * one-shot ack listener; the body id is the row-being-read.
 */
export function readWakeupSessionLog(
  correlationId: string,
  postMessage?: PostMessageFn
): Promise<ReadWakeupSessionLogResult> {
  // Client-side UUIDv4 shape gate. The host re-validates as defense in
  // depth (see the dispatcher at `src/ui/sidebar/message-router.ts`
  // T036). Short-circuiting here avoids a pointless round-trip and
  // gives the UI a synchronous failure path for malformed input.
  if (!UUIDV4_RE.test(correlationId)) {
    return Promise.resolve({
      status: 'rejected',
      reason: 'invalid-correlation-id'
    });
  }

  return new Promise<ReadWakeupSessionLogResult>((resolve) => {
    const envelopeCorrelationId = freshUuidV4();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finalise = (result: ReadWakeupSessionLogResult): void => {
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
      // The host's wire format carries the typed response in
      // `ack.result`; the `status` + `reason` fields are the legacy
      // ack channel. Both are populated on rejection (the helper
      // prefers `ack.result` when present, falling back to a
      // synthesized rejection on shape mismatch).
      const result = ack.result as ReadWakeupSessionLogResult | undefined;
      if (
        result
        && (result.status === 'success' || result.status === 'rejected')
      ) {
        finalise(result);
        return;
      }
      // Defensive fallback — the host should always provide a typed
      // result, but if the ack arrives without one, synthesize a
      // closed-vocabulary rejection so the UI never sees a
      // partially-typed payload.
      finalise({ status: 'rejected', reason: 'unknown-error' });
    });

    if (postMessage) {
      postMessage({
        type: CMD_READ_WAKEUP_SESSION_LOG,
        correlationId: envelopeCorrelationId,
        payload: { correlationId }
      });
    } else {
      postCommand(CMD_READ_WAKEUP_SESSION_LOG, { correlationId }, { correlationId: envelopeCorrelationId });
    }

    timer = setTimeout(() => {
      finalise({ status: 'rejected', reason: 'timeout' });
    }, ACK_TIMEOUT_MS);
  });
}

/**
 * Generate a canonical RFC 4122 UUIDv4 (lowercase hex, version=4,
 * variant in 8-b). Mirrors the host-side `uuidv4` helper in
 * `vscode-api.ts` so envelope ids are structurally identical to those
 * produced by `postCommand`.
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
