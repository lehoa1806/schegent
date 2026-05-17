// Feature 012 T053 — shared saveGeneralSettings helper.
//
// This is the ONE call site for CMD_SAVE_GENERAL_SETTINGS in the
// webview. Every component that wants to persist general/scalar
// settings (cli.path, claude.autoCompactPctOverride, fatalSignatures,
// etc.) routes through here. Contract:
//   specs/012-claude-autocompact-override/contracts/dashboard-navigation.md
//
// Behavior:
//   1. Generate a UUIDv4 correlationId.
//   2. Post CMD_SAVE_GENERAL_SETTINGS with payload { updates }.
//   3. Mark the correlationId pending in the snapshot store.
//   4. Register a one-shot ack listener.
//   5. On ack, resolve { status: 'accepted' | 'rejected', reason? }.
//   6. On 5-second timeout with no ack, resolve { status: 'rejected',
//      reason: 'timeout' } so the UI can surface a recovery affordance.
//   7. Concurrent saves never cross-resolve — correlation by id.

import { CMD_SAVE_GENERAL_SETTINGS } from './messages';
import { postCommand } from './vscode-api';
import { snapshotStore } from './snapshot-store.svelte';

const ACK_TIMEOUT_MS = 5000;

export interface GeneralSettingsPayload {
  readonly 'cli.path'?: string;
  readonly 'logging.verbose'?: boolean;
  readonly 'loop.maxIterations'?: number;
  readonly 'invocation.timeoutSeconds'?: number;
  readonly 'watchdog.pollIntervalMinutes'?: number;
  readonly 'audit.rotation.sizeMB'?: number;
  readonly 'audit.rotation.maxAgeDays'?: number;
  readonly 'rules.injectPerPhase'?: boolean;
  readonly 'defaultPipelineId'?: string;
  readonly 'fatalSignatures'?: readonly string[];
  readonly 'claude.autoCompactPctOverride'?: number | null;
  // Feature 019 — runtime debug log sink controls.
  readonly 'logging.runtimeLogLevel'?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  readonly 'logging.runtimeLogFilePath'?: string;
}

export type SaveResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected'; readonly reason: string };

/**
 * Persist a batch of general-settings updates via the transactional
 * CMD_SAVE_GENERAL_SETTINGS IPC. Returns a Promise that resolves with
 * the host's ack (accepted) or rejection reason. Times out after 5
 * seconds with `{ status: 'rejected', reason: 'timeout' }`.
 *
 * @param updates   Partial map of dotted-key updates. `null` clears the
 *                  setting.
 * @param postMessage Optional injection point for tests. When omitted,
 *                  the helper uses the standard postCommand path so the
 *                  envelope is observable by the snapshot store and the
 *                  VS Code webview message bus.
 */
export function saveGeneralSettings(
  updates: GeneralSettingsPayload,
  postMessage?: (msg: unknown) => void
): Promise<SaveResult> {
  return new Promise<SaveResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finalise = (result: SaveResult): void => {
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
      // Test-injection path: build the envelope manually so the test
      // can observe the exact shape posted. Still routes through the
      // snapshot store for ack correlation parity with production.
      correlationId = uuidv4();
      const envelope = {
        type: CMD_SAVE_GENERAL_SETTINGS,
        correlationId,
        payload: { updates }
      };
      postMessage(envelope);
    } else {
      const posted = postCommand(CMD_SAVE_GENERAL_SETTINGS, {
        updates: updates as Readonly<Record<string, unknown>>
      });
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
