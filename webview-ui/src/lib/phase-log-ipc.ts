// Feature 020 — phase-log IPC helper. The SINGLE call site for the 3
// phase-log commands and the `MSG_PHASE_LOG_ENTRY` push subscription.
// Mirrors the pattern from `save-general-settings.ts`.
//
// Webview components MUST NOT import the underlying CMD_/MSG_
// constants directly — they route through this module. The lint
// regression at `tests/lint/no-inline-phase-log-ipc.test.ts` fails
// the build on any drift.
//
// Wire-format types are imported from the authoritative IPC contract
// (`src/contracts/sidebar-ipc`); runtime types come from the host
// service module (`src/services/phase-log/types`). The two unions are
// kept aligned (the `kind` union mirrors `PhaseLogDisplayEntryKind`).

import {
  CMD_OPEN_VERBOSE_SETTING,
  CMD_READ_PHASE_LOG,
  CMD_START_PHASE_LOG_TAIL,
  CMD_STOP_PHASE_LOG_TAIL,
  MSG_PHASE_LOG_ENTRY,
  type PhaseLogEntryPushMessage,
  type ReadPhaseLogResponse,
  type StartPhaseLogTailResponse,
  type StopPhaseLogTailResponse
} from './messages';
import { onHostMessage, postCommand } from './vscode-api';
import { snapshotStore } from './snapshot-store.svelte';
import type {
  PhaseLogDisplayEntry,
  PhaseLogReadResult,
  PhaseLogSelection,
  PhaseLogTailStartResult,
  PhaseLogTailStopResult
} from '../../../src/services/phase-log/types';

const ACK_TIMEOUT_MS = 5000;

export interface ReadPhaseLogRequest {
  readonly selection: PhaseLogSelection;
}

export interface StartPhaseLogTailRequest {
  readonly selection: PhaseLogSelection & { readonly iterationN: number };
}

export interface StopPhaseLogTailRequest {
  readonly sessionId: string;
}

export interface PhaseLogEntryPushPayload {
  readonly tailSessionId: string;
  readonly entrySeq: number;
  readonly entry: PhaseLogDisplayEntry;
}

// Read a phase-log iteration manifest. Resolves with the typed wire
// response on accepted ack, or a synthetic failure when the host
// rejects, the ack carries no result, or the 5-second timeout fires.
export function readPhaseLog(
  req: ReadPhaseLogRequest
): Promise<PhaseLogReadResult> {
  return correlatedRequest<PhaseLogReadResult>(
    () => postCommand(CMD_READ_PHASE_LOG, req).correlationId,
    (ack) => {
      const result = ack.result as ReadPhaseLogResponse | undefined;
      if (result && (result.outcome === 'success' || result.outcome === 'failure')) {
        return result as PhaseLogReadResult;
      }
      return {
        outcome: 'failure',
        reason: ack.reason === 'unknown-tuple' ? 'unknown-tuple' : 'internal-error'
      };
    },
    { outcome: 'failure', reason: 'internal-error' }
  );
}

export function startPhaseLogTail(
  req: StartPhaseLogTailRequest
): Promise<PhaseLogTailStartResult> {
  return correlatedRequest<PhaseLogTailStartResult>(
    () => postCommand(CMD_START_PHASE_LOG_TAIL, req).correlationId,
    (ack) => {
      const result = ack.result as StartPhaseLogTailResponse | undefined;
      if (result && (result.outcome === 'success' || result.outcome === 'failure')) {
        return result as PhaseLogTailStartResult;
      }
      return { outcome: 'failure', reason: 'internal-error' };
    },
    { outcome: 'failure', reason: 'internal-error' }
  );
}

export function stopPhaseLogTail(
  req: StopPhaseLogTailRequest
): Promise<PhaseLogTailStopResult> {
  return correlatedRequest<PhaseLogTailStopResult>(
    () => postCommand(CMD_STOP_PHASE_LOG_TAIL, req).correlationId,
    (ack) => {
      const result = ack.result as StopPhaseLogTailResponse | undefined;
      if (result && (result.outcome === 'success' || result.outcome === 'failure')) {
        return {
          outcome: result.outcome,
          sessionId: result.sessionId,
          reason: result.reason
        } as PhaseLogTailStopResult;
      }
      return {
        outcome: 'failure',
        sessionId: req.sessionId,
        reason: 'unknown-session'
      };
    },
    { outcome: 'failure', sessionId: req.sessionId, reason: 'internal-error' }
  );
}

// Open the VS Code Settings editor scoped to
// `schegent.logging.verbose`. Powers the empty-state guidance card's
// "Open Settings" CTA. Fire-and-forget — the operator still has to
// flip the toggle by hand.
export function openVerboseSetting(): void {
  postCommand(CMD_OPEN_VERBOSE_SETTING);
}

// Subscribe to host-pushed phase-log entries. The webview must drop
// pushes whose `tailSessionId` does not match the active session
// (defense against late delivery after navigate-away) — that filter
// lives in the store, not here; this helper only delivers the raw
// envelope to the callback.
export function subscribePhaseLogPush(
  cb: (payload: PhaseLogEntryPushPayload) => void
): () => void {
  return onHostMessage((msg) => {
    if (msg.type !== MSG_PHASE_LOG_ENTRY) return;
    const push = msg as PhaseLogEntryPushMessage;
    cb({
      tailSessionId: push.payload.tailSessionId,
      entrySeq: push.payload.entrySeq,
      entry: push.payload.entry as PhaseLogDisplayEntry
    });
  });
}

// Shared ack-correlation primitive: post a command, register a
// one-shot ack listener, and resolve via the supplied projection. On
// 5-second timeout, resolves with the supplied timeout fallback. The
// post-and-correlate sequence runs synchronously inside the Promise
// executor so concurrent calls never cross-resolve.
function correlatedRequest<T>(
  post: () => string,
  project: (ack: {
    readonly status: 'accepted' | 'rejected';
    readonly reason?: string;
    readonly result?: unknown;
  }) => T,
  onTimeout: T
): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finalise = (result: T): void => {
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
          // one-shot listener errors must not leak
        }
        unsubscribe = null;
      }
      resolve(result);
    };

    const correlationId = post();
    snapshotStore.markPending(correlationId);
    unsubscribe = snapshotStore.onceAck(correlationId, (ack) => {
      finalise(project(ack));
    });

    timer = setTimeout(() => {
      finalise(onTimeout);
    }, ACK_TIMEOUT_MS);
  });
}
