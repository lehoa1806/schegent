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
  readonly 'invocation.idleTimeoutSeconds'?: number;
  readonly 'invocation.maxDurationSeconds'?: number;
  readonly 'watchdog.pollIntervalMinutes'?: number;
  readonly 'audit.rotation.sizeMB'?: number;
  readonly 'audit.rotation.maxAgeDays'?: number;
  readonly 'defaultPipelineId'?: string;
  readonly 'fatalSignatures'?: readonly string[];
  readonly 'claude.autoCompactPctOverride'?: number | null;
  // Feature 019 — runtime debug log sink controls.
  readonly 'logging.runtimeLogLevel'?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  readonly 'logging.runtimeLogFilePath'?: string;
  readonly 'logging.rawTranscriptMode'?: 'always' | 'errors-only' | 'off';
  // FR-R3-127 — both keys were already saveable: `GeneralSettingsTab.svelte`
  // posts them through this helper with a COMPUTED key, which TypeScript does not
  // check, and the host's `KEY_SPECS` has always accepted them. They were missing
  // from this interface only, so the one caller that names a key literally — the
  // privacy-profile apply — was the first to notice.
  readonly 'logging.sessionRetentionMaxAgeDays'?: number;
  readonly 'logging.sessionRetentionMaxBytes'?: number;
  // FR-R3-143 (T022) — six more the host has always accepted and this
  // interface never named, for exactly the reason recorded above: the tab
  // posts through a COMPUTED key. Same fix, applied to the rest of the gap
  // rather than to the two keys that happened to be noticed.
  readonly 'codex.path'?: string;
  readonly 'agy.path'?: string;
  readonly 'retry.maxAttempts'?: number;
  readonly 'retry.forceContinueOnCap'?: boolean;
  readonly 'logging.runtimeLogMaxBytes'?: number;
  readonly 'logging.runtimeLogMaxGenerations'?: number;
  // FR-R3-143 (T018) — and the six this feature admits to `KEY_SPECS`.
  readonly 'cli.inheritEnvironment'?: boolean;
  readonly 'cli.environmentMode'?: 'inherit' | 'minimal' | 'allowlist';
  readonly 'cli.environmentAllowlist'?: readonly string[];
  readonly 'backend.probeTimeoutSeconds'?: number;
  readonly 'ui.confirmations.enable'?: boolean;
  readonly 'multiRoot.suppressWarning'?: boolean;
}

/**
 * FR-R3-143 (T022) — the same keys at runtime, so a gate can compare this
 * surface against the host's `KEY_SPECS` instead of trusting that a reader
 * noticed. The interface above cannot be enumerated at runtime, and it drifted
 * from `KEY_SPECS` by six members before anything asked.
 *
 * Kept honest in BOTH directions by `PAYLOAD_KEYS_MATCH_INTERFACE` below: a key
 * here that the interface does not declare, or a member the interface declares
 * that is missing here, makes that alias `never` and fails the typecheck.
 * `save-general-settings.payload-parity.test.ts` then compares this list to
 * `KEY_SPECS`, which is the half a type cannot check across the boundary.
 */
export const GENERAL_SETTINGS_PAYLOAD_KEYS = [
  'cli.path',
  'codex.path',
  'agy.path',
  'logging.verbose',
  'loop.maxIterations',
  'invocation.idleTimeoutSeconds',
  'invocation.maxDurationSeconds',
  'watchdog.pollIntervalMinutes',
  'audit.rotation.sizeMB',
  'audit.rotation.maxAgeDays',
  'defaultPipelineId',
  'fatalSignatures',
  'claude.autoCompactPctOverride',
  'logging.runtimeLogLevel',
  'logging.runtimeLogFilePath',
  'logging.rawTranscriptMode',
  'logging.runtimeLogMaxBytes',
  'logging.runtimeLogMaxGenerations',
  'logging.sessionRetentionMaxAgeDays',
  'logging.sessionRetentionMaxBytes',
  'retry.maxAttempts',
  'retry.forceContinueOnCap',
  'cli.inheritEnvironment',
  'cli.environmentMode',
  'cli.environmentAllowlist',
  'backend.probeTimeoutSeconds',
  'ui.confirmations.enable',
  'multiRoot.suppressWarning'
] as const;

export type GeneralSettingsPayloadKey = (typeof GENERAL_SETTINGS_PAYLOAD_KEYS)[number];

type UnlistedPayloadMember = Exclude<keyof GeneralSettingsPayload, GeneralSettingsPayloadKey>;
type UndeclaredListedKey = Exclude<GeneralSettingsPayloadKey, keyof GeneralSettingsPayload>;

/** `never` — and therefore a type error on the constant below — if either set has a member the other lacks. */
type PayloadKeyParity = [UnlistedPayloadMember, UndeclaredListedKey] extends [never, never]
  ? true
  : never;

export const PAYLOAD_KEYS_MATCH_INTERFACE: PayloadKeyParity = true;

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
