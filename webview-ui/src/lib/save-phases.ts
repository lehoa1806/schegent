// Feature 026 T012 — shared savePhases helper.
//
// This is the ONE call site for CMD_SAVE_PHASES in the webview. Every
// component that wants to persist the user-layer `schegent.phases`
// catalog routes through here. Contract:
//   specs/026-phase-effort-bugfix-pipeline/contracts/save-phases-ipc.md
//
// Behavior:
//   1. Generate a UUIDv4 correlationId.
//   2. Post CMD_SAVE_PHASES with payload { phases }.
//   3. Mark the correlationId pending in the snapshot store.
//   4. Register a one-shot ack listener.
//   5. On ack, resolve { status: 'accepted' | 'rejected', reason? }.
//   6. On 5-second timeout with no ack, resolve { status: 'rejected',
//      reason: 'timeout' } so the UI can surface a recovery affordance.
//   7. Concurrent saves never cross-resolve — correlation by id.
//
// The repo-grep regression at tests/lint/no-inline-save-phases.test.ts
// pins this file as the SOLE allowlisted call site for postCommand(
// CMD_SAVE_PHASES, …).

import { CMD_SAVE_PHASES } from './messages';
import type { PhaseDefinition } from './snapshot-types';
import { postCommand } from './vscode-api';
import { snapshotStore } from './snapshot-store.svelte';

const ACK_TIMEOUT_MS = 5000;

export interface SavePhaseRow {
  readonly id: string;
  readonly name: string;
  readonly instruction: string;
  readonly model?: string;
  readonly effort?: PhaseDefinition['effort'];
  readonly timeoutSeconds?: number;
  readonly retryCondition?: string;
}

export type SavePhasesResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected'; readonly reason: string };

/**
 * Persist the entire user-layer `schegent.phases` catalog via the
 * CMD_SAVE_PHASES IPC. Returns a Promise that resolves with the host's
 * ack (accepted) or rejection reason. Times out after 5 seconds with
 * `{ status: 'rejected', reason: 'timeout' }`.
 *
 * @param phases       The full catalog snapshot (all-or-nothing save).
 * @param postMessage  Optional injection point for tests. When omitted,
 *                     the helper uses the standard postCommand path so
 *                     the envelope is observable by the snapshot store
 *                     and the VS Code webview message bus.
 */
export function savePhases(
  phases: readonly SavePhaseRow[],
  postMessage?: (msg: unknown) => void
): Promise<SavePhasesResult> {
  return new Promise<SavePhasesResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finalise = (result: SavePhasesResult): void => {
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
      correlationId = uuidv4();
      const envelope = {
        type: CMD_SAVE_PHASES,
        correlationId,
        payload: { phases }
      };
      postMessage(envelope);
    } else {
      const posted = postCommand(CMD_SAVE_PHASES, { phases });
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
