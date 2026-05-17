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

import { CMD_SET_PHASE_BREAKPOINT, CMD_CLEAR_PHASE_BREAKPOINT } from './messages';
import { postCommand } from './vscode-api';
import { snapshotStore } from './snapshot-store.svelte';

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
  phaseId: string
): Promise<BreakpointResult> {
  return correlatedRequest(() =>
    postCommand(CMD_SET_PHASE_BREAKPOINT, { runId, phaseId }).correlationId
  );
}

/**
 * Clear a previously-armed breakpoint. The controller emits the
 * `phase-breakpoint-cleared { cause: 'operator' }` audit event.
 */
export function clearPhaseBreakpoint(
  runId: string,
  phaseId: string
): Promise<BreakpointResult> {
  return correlatedRequest(() =>
    postCommand(CMD_CLEAR_PHASE_BREAKPOINT, { runId, phaseId }).correlationId
  );
}

function correlatedRequest(post: () => string): Promise<BreakpointResult> {
  return new Promise<BreakpointResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finalise = (result: BreakpointResult): void => {
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
