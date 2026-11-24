/**
 * FR-R8-02 (02-04) — pure CLI exit vs backend terminal-record reconciliation truth table.
 *
 * Ensures a clean supported turn can advance once, real cancellation stays cancelled, and any
 * failed, absent-terminal, duplicated-contradictory, refusal, stream-overflow, or uncertain turn
 * is never synthesized into `end_turn` success.
 *
 * Zero `vscode` or `child_process` imports.
 */
import type { AcpStopReason } from '../../contracts/acp-runtime';
import type { BridgedBackendKind } from './bridges/acp-stdio-bridge';
import type { ManagedCliExit } from './stdio-transport';

export type BridgeStopReason = 'end_turn' | 'max_tokens' | 'refusal';

export type BridgeTerminalEvent =
  | { readonly kind: 'success'; readonly stopReason: BridgeStopReason }
  | { readonly kind: 'error'; readonly message: string };

export type TerminalReconciliationStatus =
  | 'clean'
  | 'cancelled'
  | 'refusal'
  | 'missing-terminal-record'
  | 'contradictory-exit'
  | 'contradictory-terminal-record'
  | 'backend-reported-error'
  | 'process-failed-without-terminal-record'
  | 'stream-overflow'
  | 'uncertain'
  | 'rejected'
  | 'refused'
  | 'not-dispatched';

export interface AcpTerminalReconciliation {
  readonly status: TerminalReconciliationStatus;
  readonly stopReason?: AcpStopReason;
  readonly processExitCode?: number | null;
  readonly processSignal?: string | null;
  readonly warningCode?: string;
}

export interface BridgeTurnReconciliationInput {
  readonly backend: BridgedBackendKind;
  readonly rejectDuplicateSuccessRecords?: boolean;
  readonly isNativeReview: boolean;
  readonly isSecurityReview: boolean;
  readonly cancelled: boolean;
  readonly exit: ManagedCliExit;
  readonly terminalEvents: readonly BridgeTerminalEvent[];
  readonly streamErrorText: string | null;
  readonly lineOverflowed: boolean;
  readonly pendingBacklogOverflowed: boolean;
}

export type BridgeTurnReconciliationDecision =
  | { readonly outcome: 'cancelled'; readonly stopReason: 'cancelled' }
  | { readonly outcome: 'completed'; readonly stopReason: BridgeStopReason }
  | {
      readonly outcome: 'error';
      readonly status: Exclude<TerminalReconciliationStatus, 'clean' | 'cancelled' | 'refusal'>;
      readonly message: string;
    };

/** Stable RPC error message prefixes parsed by `AcpBackedRunner` into structured reconciliation codes. */
export const BRIDGE_ERROR_PREFIXES = Object.freeze({
  missingTerminalRecord: 'ACP_BRIDGE_MISSING_TERMINAL_RECORD',
  contradictoryExit: 'ACP_BRIDGE_CONTRADICTORY_EXIT',
  contradictoryTerminalRecord: 'ACP_BRIDGE_CONTRADICTORY_TERMINAL_RECORD',
  backendReportedError: 'ACP_BRIDGE_BACKEND_ERROR',
  processFailedWithoutTerminalRecord: 'ACP_BRIDGE_PROCESS_FAILED',
  streamOverflow: 'ACP_BRIDGE_STREAM_OVERFLOW',
  launchFailed: 'ACP_BRIDGE_LAUNCH_FAILED'
} as const);

export function formatBridgeErrorMessage(
  status: Exclude<TerminalReconciliationStatus, 'clean' | 'cancelled' | 'refusal'>,
  detail: string
): string {
  switch (status) {
    case 'missing-terminal-record':
      return `${BRIDGE_ERROR_PREFIXES.missingTerminalRecord}: ${detail}`;
    case 'contradictory-exit':
      return `${BRIDGE_ERROR_PREFIXES.contradictoryExit}: ${detail}`;
    case 'contradictory-terminal-record':
      return `${BRIDGE_ERROR_PREFIXES.contradictoryTerminalRecord}: ${detail}`;
    case 'backend-reported-error':
      return `${BRIDGE_ERROR_PREFIXES.backendReportedError}: ${detail}`;
    case 'process-failed-without-terminal-record':
      return `${BRIDGE_ERROR_PREFIXES.processFailedWithoutTerminalRecord}: ${detail}`;
    case 'stream-overflow':
      return `${BRIDGE_ERROR_PREFIXES.streamOverflow}: ${detail}`;
    default:
      return `${BRIDGE_ERROR_PREFIXES.launchFailed}: ${detail}`;
  }
}

export function classifyBridgeErrorStatus(
  message: string | undefined
): Exclude<TerminalReconciliationStatus, 'clean' | 'cancelled' | 'refusal'> {
  if (typeof message !== 'string') return 'rejected';
  if (message.startsWith(BRIDGE_ERROR_PREFIXES.missingTerminalRecord)) return 'missing-terminal-record';
  if (message.startsWith(BRIDGE_ERROR_PREFIXES.contradictoryExit)) return 'contradictory-exit';
  if (message.startsWith(BRIDGE_ERROR_PREFIXES.contradictoryTerminalRecord)) return 'contradictory-terminal-record';
  if (message.startsWith(BRIDGE_ERROR_PREFIXES.backendReportedError)) return 'backend-reported-error';
  if (message.startsWith(BRIDGE_ERROR_PREFIXES.processFailedWithoutTerminalRecord)) {
    return 'process-failed-without-terminal-record';
  }
  if (message.startsWith(BRIDGE_ERROR_PREFIXES.streamOverflow)) return 'stream-overflow';
  return 'rejected';
}

export function warningCodeForReconciliation(status: TerminalReconciliationStatus): string {
  switch (status) {
    case 'missing-terminal-record':
      return 'acp-missing-terminal-record';
    case 'contradictory-exit':
      return 'acp-contradictory-exit';
    case 'contradictory-terminal-record':
      return 'acp-contradictory-terminal-record';
    case 'refusal':
      return 'acp-turn-refusal';
    case 'stream-overflow':
      return 'acp-stream-overflow';
    case 'uncertain':
      return 'acp-turn-uncertain';
    default:
      return 'acp-terminal-reconciliation-failed';
  }
}

/**
 * Reconciles a bridged CLI child's process exit with every observed backend terminal record.
 * Never fabricates `end_turn` when a terminal record is absent, never ignores non-zero exit/signal
 * after a terminal record, and rejects contradictory or duplicate Codex terminal records.
 */
export function reconcileBridgeTurnOutcome(
  input: BridgeTurnReconciliationInput
): BridgeTurnReconciliationDecision {
  if (input.cancelled) {
    return { outcome: 'cancelled', stopReason: 'cancelled' };
  }

  if (input.exit.launchFailed) {
    const detail = input.isSecurityReview
      ? 'Codex Security executable failed to launch'
      : 'Backend executable failed to launch';
    return {
      outcome: 'error',
      status: 'rejected',
      message: formatBridgeErrorMessage('rejected', detail)
    };
  }

  if (input.pendingBacklogOverflowed || input.lineOverflowed) {
    const detail = input.isNativeReview
      ? 'Native reviewer output exceeded the line limit'
      : 'Backend output exceeded the ACP stream byte bound';
    return {
      outcome: 'error',
      status: 'stream-overflow',
      message: formatBridgeErrorMessage('stream-overflow', detail)
    };
  }

  const cleanExit = input.exit.code === 0 && input.exit.signal === null;
  const exitLabel =
    input.exit.signal !== null
      ? `signal ${input.exit.signal}`
      : `code ${String(input.exit.code ?? 'unknown')}`;

  const successEvents = input.terminalEvents.filter(
    (ev): ev is Extract<BridgeTerminalEvent, { readonly kind: 'success' }> => ev.kind === 'success'
  );
  const errorEvents = input.terminalEvents.filter(
    (ev): ev is Extract<BridgeTerminalEvent, { readonly kind: 'error' }> => ev.kind === 'error'
  );

  // Contradictory terminal records: error mixed with success, conflicting stop reasons, or
  // duplicate terminal success records when the backend protocol allows only one per turn.
  const distinctStopReasons = new Set(successEvents.map((ev) => ev.stopReason));
  const duplicateSuccess = input.rejectDuplicateSuccessRecords === true && successEvents.length > 1;
  if (
    (successEvents.length > 0 && errorEvents.length > 0) ||
    distinctStopReasons.size > 1 ||
    duplicateSuccess
  ) {
    return {
      outcome: 'error',
      status: 'contradictory-terminal-record',
      message: formatBridgeErrorMessage(
        'contradictory-terminal-record',
        `Backend emitted contradictory or duplicate terminal records (${input.backend})`
      )
    };
  }

  if (errorEvents.length > 0 || input.streamErrorText !== null) {
    const firstError = errorEvents.at(0);
    const detail =
      input.streamErrorText !== null
        ? input.streamErrorText
        : firstError !== undefined
          ? firstError.message
          : 'Backend reported an error';
    return {
      outcome: 'error',
      status: 'backend-reported-error',
      message: formatBridgeErrorMessage('backend-reported-error', detail)
    };
  }

  if (successEvents.length === 0) {
    if (cleanExit) {
      return {
        outcome: 'error',
        status: 'missing-terminal-record',
        message: formatBridgeErrorMessage(
          'missing-terminal-record',
          input.isNativeReview
            ? 'Native review exited cleanly without a terminal record'
            : `Backend (${input.backend}) exited 0 without a terminal record`
        )
      };
    }
    return {
      outcome: 'error',
      status: 'process-failed-without-terminal-record',
      message: formatBridgeErrorMessage(
        'process-failed-without-terminal-record',
        `Backend exited with ${exitLabel}`
      )
    };
  }

  const finalStopReason = successEvents[successEvents.length - 1]!.stopReason;
  if (!cleanExit) {
    return {
      outcome: 'error',
      status: 'contradictory-exit',
      message: formatBridgeErrorMessage(
        'contradictory-exit',
        `Backend emitted ${finalStopReason} but exited with ${exitLabel}`
      )
    };
  }

  if (input.isNativeReview && finalStopReason !== 'end_turn') {
    return {
      outcome: 'error',
      status: 'backend-reported-error',
      message: formatBridgeErrorMessage('backend-reported-error', 'Native review did not finish')
    };
  }

  return { outcome: 'completed', stopReason: finalStopReason };
}
