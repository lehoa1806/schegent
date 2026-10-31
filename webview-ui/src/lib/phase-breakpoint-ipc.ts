// Feature 028 US2 — phase-breakpoint IPC helper. The SINGLE call site
// for `CMD_SET_PHASE_BREAKPOINT` and `CMD_CLEAR_PHASE_BREAKPOINT` in
// the webview. Mirrors the pattern from `save-general-settings.ts` and
// `phase-log-ipc.ts`.
//
// Webview components MUST NOT import the underlying CMD_ constants
// directly — they route through this module. The lint regression at
// `tests/lint/no-inline-phase-breakpoint-ipc.test.ts` fails the build
// on any drift.
//
// Behavior:
//   1. Post the command (host generates correlationId via postCommand).
//   2. Mark the correlationId pending in the snapshot store.
//   3. Register a one-shot ack listener.
//   4. On ack, resolve { status: 'accepted' | 'rejected', reason? }.
//   5. On 5-second timeout, resolve { status: 'rejected',
//      reason: 'timeout' } so the UI can surface a recovery affordance.
//   6. Concurrent calls never cross-resolve — correlation by id.
//
// Feature 093 (FR-018 / T080) — both commands carry the `queueId` of the Run
// the breakpoint belongs to. `runId` alone no longer identifies a Run to the
// host, because the Run record is keyed by queue.

import {
  CMD_SET_PHASE_BREAKPOINT,
  CMD_CLEAR_PHASE_BREAKPOINT,
  type CommandType
} from './messages';
import { postCommand } from './vscode-api';
import { sendIntent } from './intent-ledger';

const ACK_TIMEOUT_MS = 5000;

export type BreakpointResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected'; readonly reason: string };

/**
 * Arm a one-shot future-phase breakpoint. The host re-validates the
 * (runId, phaseId) tuple against the run's immutable pipeline snapshot
 * before mutating `WorkflowRun.phaseBreakpoints`.
 */
export function setPhaseBreakpoint(
  runId: string,
  phaseId: string,
  queueId: string
): Promise<BreakpointResult> {
  return correlatedRequest(
    CMD_SET_PHASE_BREAKPOINT,
    { queueId, runId, phaseId },
    (correlationId, payload) => {
      postCommand(CMD_SET_PHASE_BREAKPOINT, payload, { correlationId });
    }
  );
}

/**
 * Clear a previously-armed breakpoint. The controller emits the
 * `phase-breakpoint-cleared { cause: 'operator' }` audit event.
 */
export function clearPhaseBreakpoint(
  runId: string,
  phaseId: string,
  queueId: string
): Promise<BreakpointResult> {
  return correlatedRequest(
    CMD_CLEAR_PHASE_BREAKPOINT,
    { queueId, runId, phaseId },
    (correlationId, payload) => {
      postCommand(CMD_CLEAR_PHASE_BREAKPOINT, payload, { correlationId });
    }
  );
}

// FR-R4-F05 (I4) — through the intent ledger: an identical retry of an unresolved breakpoint
// change reuses its identity and payload. A wait that outlives `ACK_TIMEOUT_MS` resolves
// `timeout` (the outcome is not yet known), as it always did.
function correlatedRequest<P>(
  type: CommandType,
  payload: P,
  post: (correlationId: string, payload: P) => void
): Promise<BreakpointResult> {
  return sendIntent({ type, payload, post, timeoutMs: ACK_TIMEOUT_MS }).then(
    (result): BreakpointResult => {
      if (result.kind !== 'ack') return { status: 'rejected', reason: 'timeout' };
      return result.ack.status === 'accepted'
        ? { status: 'accepted' }
        : { status: 'rejected', reason: result.ack.reason ?? 'rejected' };
    }
  );
}
