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
  type CommandType,
  type PhaseLogEntryPushMessage,
  type ReadPhaseLogResponse,
  type StartPhaseLogTailResponse,
  type StopPhaseLogTailResponse
} from './messages';
import { OUTCOME_NOT_YET_KNOWN_TEXT, boundaryRefusalText } from './boundary-refusal-text';
import { sendIntent, type IntentWaitOptions } from './intent-ledger';
import { onHostMessage, postCommand } from './vscode-api';
import type {
  PhaseLogDisplayEntry,
  PhaseLogReadResult,
  PhaseLogSelection,
  PhaseLogTailStartResult,
  PhaseLogTailStopResult
} from '../../../src/services/phase-log/types';

const ACK_TIMEOUT_MS = 5000;

/**
 * FR-R4-F05 (O1, O7) — a failure that was a REFUSAL (the router's gate, or a dispatch that
 * threw) carries the shared sentence for it. The three commands became gated, so a refused
 * window used to see every refusal as `internal-error` (or, for a stop, `unknown-session`),
 * which tells the operator nothing and names a fault that did not happen. `reason` keeps the
 * wire's closed union; this field is what a view shows.
 */
export type WithRefusalText<T> = T & { readonly refusalText?: string };

/**
 * FR-R4-F05 (I5, O3) — what a wait that ran out resolves to. The wire's `reason` stays
 * `internal-error` (the union is closed), but a timeout is not an internal error: the host may
 * still answer, so the text a view shows says the outcome is not yet known.
 */
const NOT_YET_KNOWN_FAILURE = {
  outcome: 'failure',
  reason: 'internal-error',
  refusalText: OUTCOME_NOT_YET_KNOWN_TEXT
} as const;

function refusalTextOf(ack: {
  readonly status: 'accepted' | 'rejected';
  readonly reason?: string;
}): { readonly refusalText: string } | Record<string, never> {
  if (ack.status !== 'rejected' || ack.reason === undefined) return {};
  // The module's own reasons are not refusals by the gate.
  if (ack.reason === 'unknown-tuple') return {};
  return { refusalText: boundaryRefusalText(ack.reason) };
}

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
  req: ReadPhaseLogRequest,
  wait?: IntentWaitOptions<WithRefusalText<PhaseLogReadResult>>
): Promise<WithRefusalText<PhaseLogReadResult>> {
  return correlatedRequest<WithRefusalText<PhaseLogReadResult>, ReadPhaseLogRequest>(
    CMD_READ_PHASE_LOG,
    req,
    (correlationId, payload) => {
      postCommand(CMD_READ_PHASE_LOG, payload, { correlationId });
    },
    (ack) => {
      const result = ack.result as ReadPhaseLogResponse | undefined;
      if (result && (result.outcome === 'success' || result.outcome === 'failure')) {
        return result as PhaseLogReadResult;
      }
      return {
        outcome: 'failure',
        reason: ack.reason === 'unknown-tuple' ? 'unknown-tuple' : 'internal-error',
        ...refusalTextOf(ack)
      };
    },
    NOT_YET_KNOWN_FAILURE,
    wait
  );
}

export function startPhaseLogTail(
  req: StartPhaseLogTailRequest
): Promise<WithRefusalText<PhaseLogTailStartResult>> {
  return correlatedRequest<WithRefusalText<PhaseLogTailStartResult>, StartPhaseLogTailRequest>(
    CMD_START_PHASE_LOG_TAIL,
    req,
    (correlationId, payload) => {
      postCommand(CMD_START_PHASE_LOG_TAIL, payload, { correlationId });
    },
    (ack) => {
      const result = ack.result as StartPhaseLogTailResponse | undefined;
      if (result && (result.outcome === 'success' || result.outcome === 'failure')) {
        return result as PhaseLogTailStartResult;
      }
      return { outcome: 'failure', reason: 'internal-error', ...refusalTextOf(ack) };
    },
    NOT_YET_KNOWN_FAILURE
  );
}

export function stopPhaseLogTail(
  req: StopPhaseLogTailRequest
): Promise<WithRefusalText<PhaseLogTailStopResult>> {
  return correlatedRequest<WithRefusalText<PhaseLogTailStopResult>, StopPhaseLogTailRequest>(
    CMD_STOP_PHASE_LOG_TAIL,
    req,
    (correlationId, payload) => {
      postCommand(CMD_STOP_PHASE_LOG_TAIL, payload, { correlationId });
    },
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
        reason: 'unknown-session',
        ...refusalTextOf(ack)
      };
    },
    {
      outcome: 'failure',
      sessionId: req.sessionId,
      reason: 'internal-error',
      refusalText: OUTCOME_NOT_YET_KNOWN_TEXT
    }
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

// Shared ack-correlation primitive. FR-R4-F05 (I4): it sends through the intent ledger, so an
// identical retry of an unresolved request reuses its identity and payload. On the 5-second
// timeout it resolves with the supplied fallback (the outcome is not yet known).
function correlatedRequest<T, P>(
  type: CommandType,
  payload: P,
  post: (correlationId: string, payload: P) => void,
  project: (ack: {
    readonly status: 'accepted' | 'rejected';
    readonly reason?: string;
    readonly result?: unknown;
  }) => T,
  onTimeout: T,
  wait: IntentWaitOptions<T> = {}
): Promise<T> {
  return sendIntent({
    type,
    payload,
    post,
    timeoutMs: ACK_TIMEOUT_MS,
    ...(wait.signal === undefined ? {} : { signal: wait.signal }),
    ...(wait.onLateOutcome === undefined
      ? {}
      : { onLateOutcome: (ack) => wait.onLateOutcome?.(project(ack)) })
  }).then((result) => (result.kind === 'ack' ? project(result.ack) : onTimeout));
}
