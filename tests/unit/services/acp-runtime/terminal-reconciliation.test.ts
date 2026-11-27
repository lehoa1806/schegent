import { describe, expect, it } from 'vitest';
import {
  BRIDGE_ERROR_PREFIXES,
  BRIDGE_RPC_ERROR_CODES,
  classifyBridgeErrorCode,
  classifyBridgeErrorStatus,
  formatBridgeErrorMessage,
  reconcileBridgeTurnOutcome,
  rpcCodeForBridgeErrorStatus,
  warningCodeForReconciliation,
  type BridgeTurnReconciliationInput
} from '../../../../src/services/acp-runtime/terminal-reconciliation';
import {
  applyPhaseTerminalReconciliation,
  evaluatePhaseTerminalReconciliation
} from '../../../../src/controller/phase-terminal-reconciliation';
import { MONITOR_STALL_THRESHOLD_MS } from '../../../../src/contracts/monitor-events';
import {
  ACP_MIN_SINK_STALL_WATCHDOG_MS,
  mergeLiveUsageObservation,
  reconcileAcpPromptOutcome
} from '../../../../src/runner/acp-runner-stream-helpers';
import type { InvocationResult } from '../../../../src/parser/stdout-parser';

function baseInput(
  overrides: Partial<BridgeTurnReconciliationInput> = {}
): BridgeTurnReconciliationInput {
  return {
    backend: 'claude',
    rejectDuplicateSuccessRecords: false,
    isNativeReview: false,
    isSecurityReview: false,
    cancelled: false,
    exit: { code: 0, signal: null, launchFailed: false },
    terminalEvents: [{ kind: 'success', stopReason: 'end_turn' }],
    streamErrorText: null,
    lineOverflowed: false,
    pendingBacklogOverflowed: false,
    ...overrides
  };
}

describe('reconcileBridgeTurnOutcome (FR-R8-02 / 02-04)', () => {
  it('completes cleanly when exit is 0 with a single matching terminal success record', () => {
    expect(reconcileBridgeTurnOutcome(baseInput())).toEqual({
      outcome: 'completed',
      stopReason: 'end_turn'
    });
  });

  it('preserves real cancellation as cancelled even if exit code is non-zero or terminal record is absent', () => {
    expect(
      reconcileBridgeTurnOutcome(
        baseInput({
          cancelled: true,
          exit: { code: null, signal: 'SIGTERM', launchFailed: false },
          terminalEvents: []
        })
      )
    ).toEqual({ outcome: 'cancelled', stopReason: 'cancelled' });
  });

  it('never synthesizes end_turn when exit is 0 without a backend terminal record', () => {
    const decision = reconcileBridgeTurnOutcome(baseInput({ terminalEvents: [] }));
    expect(decision.outcome).toBe('error');
    if (decision.outcome === 'error') {
      expect(decision.status).toBe('missing-terminal-record');
      expect(decision.message.startsWith(BRIDGE_ERROR_PREFIXES.missingTerminalRecord)).toBe(true);
      expect(classifyBridgeErrorStatus(decision.message)).toBe('missing-terminal-record');
      expect(warningCodeForReconciliation(decision.status)).toBe('acp-missing-terminal-record');
    }
  });

  it('rejects non-zero exit or signal after a terminal success record as contradictory-exit', () => {
    const exits = [
      { code: 1, signal: null, launchFailed: false },
      { code: null, signal: 'SIGKILL' as const, launchFailed: false }
    ];
    for (const exit of exits) {
      const decision = reconcileBridgeTurnOutcome(baseInput({ exit }));
      expect(decision.outcome).toBe('error');
      if (decision.outcome === 'error') {
        expect(decision.status).toBe('contradictory-exit');
        expect(classifyBridgeErrorStatus(decision.message)).toBe('contradictory-exit');
        expect(warningCodeForReconciliation(decision.status)).toBe('acp-contradictory-exit');
      }
    }
  });

  it('rejects duplicate Codex turn.completed records, mixed error+success, and conflicting stopReasons', () => {
    const dupCodex = reconcileBridgeTurnOutcome(
      baseInput({
        backend: 'codex',
        rejectDuplicateSuccessRecords: true,
        terminalEvents: [
          { kind: 'success', stopReason: 'end_turn' },
          { kind: 'success', stopReason: 'end_turn' }
        ]
      })
    );
    expect(dupCodex.outcome).toBe('error');
    if (dupCodex.outcome === 'error') {
      expect(dupCodex.status).toBe('contradictory-terminal-record');
    }

    const mixed = reconcileBridgeTurnOutcome(
      baseInput({
        terminalEvents: [
          { kind: 'success', stopReason: 'end_turn' },
          { kind: 'error', message: 'boom' }
        ]
      })
    );
    expect(mixed.outcome).toBe('error');
    if (mixed.outcome === 'error') {
      expect(mixed.status).toBe('contradictory-terminal-record');
    }

    const conflictingStop = reconcileBridgeTurnOutcome(
      baseInput({
        terminalEvents: [
          { kind: 'success', stopReason: 'end_turn' },
          { kind: 'success', stopReason: 'refusal' }
        ]
      })
    );
    expect(conflictingStop.outcome).toBe('error');
    if (conflictingStop.outcome === 'error') {
      expect(conflictingStop.status).toBe('contradictory-terminal-record');
    }
  });

  it('fails closed on line overflow, pending stdout backlog overflow, backend error, and process failure without terminal', () => {
    const lineOverflow = reconcileBridgeTurnOutcome(baseInput({ lineOverflowed: true }));
    expect(lineOverflow.outcome).toBe('error');
    if (lineOverflow.outcome === 'error') {
      expect(lineOverflow.status).toBe('stream-overflow');
    }

    const backlogOverflow = reconcileBridgeTurnOutcome(
      baseInput({ pendingBacklogOverflowed: true })
    );
    expect(backlogOverflow.outcome).toBe('error');
    if (backlogOverflow.outcome === 'error') {
      expect(backlogOverflow.status).toBe('stream-overflow');
    }

    const backendErr = reconcileBridgeTurnOutcome(
      baseInput({ terminalEvents: [{ kind: 'error', message: 'api error' }] })
    );
    expect(backendErr.outcome).toBe('error');
    if (backendErr.outcome === 'error') {
      expect(backendErr.status).toBe('backend-reported-error');
    }

    const failedNoTerminal = reconcileBridgeTurnOutcome(
      baseInput({
        exit: { code: 2, signal: null, launchFailed: false },
        terminalEvents: []
      })
    );
    expect(failedNoTerminal.outcome).toBe('error');
    if (failedNoTerminal.outcome === 'error') {
      expect(failedNoTerminal.status).toBe('process-failed-without-terminal-record');
    }

    expect(
      classifyBridgeErrorStatus(formatBridgeErrorMessage('stream-overflow', 'exceeded'))
    ).toBe('stream-overflow');
    expect(rpcCodeForBridgeErrorStatus('stream-overflow')).toBe(BRIDGE_RPC_ERROR_CODES.streamOverflow);
    expect(classifyBridgeErrorCode(BRIDGE_RPC_ERROR_CODES.streamOverflow)).toBe('stream-overflow');
    expect(classifyBridgeErrorCode(BRIDGE_RPC_ERROR_CODES.missingTerminalRecord)).toBe('missing-terminal-record');
    expect(classifyBridgeErrorCode(BRIDGE_RPC_ERROR_CODES.contradictoryExit)).toBe('contradictory-exit');
    expect(classifyBridgeErrorCode(BRIDGE_RPC_ERROR_CODES.contradictoryTerminalRecord)).toBe(
      'contradictory-terminal-record'
    );
    expect(classifyBridgeErrorCode(BRIDGE_RPC_ERROR_CODES.backendReportedError)).toBe('backend-reported-error');
    expect(classifyBridgeErrorCode(BRIDGE_RPC_ERROR_CODES.processFailedWithoutTerminalRecord)).toBe(
      'process-failed-without-terminal-record'
    );
    expect(classifyBridgeErrorCode(-32603)).toBe('rejected');
  });
});

describe('applyPhaseTerminalReconciliation (FR-R8-02 / 02-04)', () => {
  const cleanResult: InvocationResult = {
    kind: 'clean',
    warnings: [],
    auditEntry: null
  };

  it('passes through clean ACP turns and legacy direct-CLI runs without reconciliation metadata', () => {
    expect(
      applyPhaseTerminalReconciliation(cleanResult, { killed: false, exitCode: 0 })
    ).toEqual({ result: cleanResult, forceCancel: false, forceFailed: false });

    expect(
      applyPhaseTerminalReconciliation(cleanResult, {
        killed: false,
        exitCode: 0,
        terminalReconciliation: { status: 'clean', stopReason: 'end_turn' }
      })
    ).toEqual({ result: cleanResult, forceCancel: false, forceFailed: false });
  });

  it('forces cancellation arm on cancelled reconciliation even with exitCode 130', () => {
    const applied = applyPhaseTerminalReconciliation(cleanResult, {
      killed: true,
      exitCode: 130,
      terminalReconciliation: { status: 'cancelled', stopReason: 'cancelled' }
    });
    expect(applied.forceCancel).toBe(true);
    expect(applied.forceFailed).toBe(false);
  });

  it('fails closed on every non-clean reconciliation status even when model text parsed clean', () => {
    const statuses = [
      'refusal',
      'missing-terminal-record',
      'contradictory-exit',
      'contradictory-terminal-record',
      'backend-reported-error',
      'process-failed-without-terminal-record',
      'stream-overflow',
      'uncertain',
      'rejected',
      'refused',
      'not-dispatched'
    ] as const;

    for (const status of statuses) {
      const verdict = evaluatePhaseTerminalReconciliation(
        { killed: false, exitCode: 0, terminalReconciliation: { status } },
        cleanResult
      );
      expect(verdict.action).toBe('fail-closed');

      const applied = applyPhaseTerminalReconciliation(cleanResult, {
        killed: false,
        exitCode: 0,
        terminalReconciliation: { status }
      });
      expect(applied.forceFailed).toBe(true);
      expect(applied.forceCancel).toBe(false);
      expect(applied.result.kind).toBe('malformed');
      if (applied.result.kind === 'malformed') {
        expect(applied.result.warnings[0]).toBe(warningCodeForReconciliation(status));
      }
    }
  });

  it('preserves rate_limited and fatal-signature classifications', () => {
    const rateLimited: InvocationResult = {
      kind: 'rate_limited',
      cause: 'rate-limit',
      resetsAtMs: null,
      rateLimitMessage: 'rate limit',
      auditEntry: null
    };
    expect(
      evaluatePhaseTerminalReconciliation(
        {
          killed: false,
          exitCode: 1,
          terminalReconciliation: { status: 'backend-reported-error' }
        },
        rateLimited
      )
    ).toEqual({ action: 'pass-through' });

    const fatal: InvocationResult = {
      kind: 'malformed',
      warnings: [],
      auditEntry: null,
      fatalCause: 'auth-failed',
      fatalSource: 'built-in'
    };
      expect(
        evaluatePhaseTerminalReconciliation(
          {
            killed: false,
            exitCode: 1,
            terminalReconciliation: { status: 'process-failed-without-terminal-record' }
          },
          fatal
        )
      ).toEqual({ action: 'pass-through' });
  });

  it('reconciles pre-dispatch operator cancellation as cancelled, keeps agy billable tokens monotonic, and respects MONITOR_STALL_THRESHOLD_MS', () => {
    expect(ACP_MIN_SINK_STALL_WATCHDOG_MS).toBeGreaterThanOrEqual(MONITOR_STALL_THRESHOLD_MS);

    const refusedCancel = reconcileAcpPromptOutcome({
      outcome: { kind: 'refused', reason: 'connection-not-ready', detail: 'cancelled' },
      isNativeReview: false,
      isBridgeProfile: false,
      hasOpenWork: false,
      killed: true,
      timedOut: false,
      deadlineExceeded: false
    });
    expect(refusedCancel.exitCode).toBe(130);
    expect(refusedCancel.terminalReconciliation.status).toBe('cancelled');

    const notDispatchedCancel = reconcileAcpPromptOutcome({
      outcome: { kind: 'not-dispatched', reason: 'transport-closed' },
      isNativeReview: false,
      isBridgeProfile: false,
      hasOpenWork: false,
      killed: true,
      timedOut: false,
      deadlineExceeded: false
    });
    expect(notDispatchedCancel.exitCode).toBe(130);
    expect(notDispatchedCancel.terminalReconciliation.status).toBe('cancelled');

    // Native ACP abnormal process exit after `end_turn` fails closed as contradictory-exit.
    const nativeAbnormal = reconcileAcpPromptOutcome({
      outcome: { kind: 'completed', turnId: 't-native', stopReason: 'end_turn', hostValidationRequired: true },
      isNativeReview: false,
      isBridgeProfile: false,
      hasOpenWork: false,
      killed: false,
      timedOut: false,
      deadlineExceeded: false,
      nativeAbnormalExit: { code: 1, signal: null }
    });
    expect(nativeAbnormal.exitCode).toBe(1);
    expect(nativeAbnormal.acpTurnSettled).toBe(false);
    expect(nativeAbnormal.emitUsageLine).toBe(false);
    expect(nativeAbnormal.terminalReconciliation.status).toBe('contradictory-exit');
    expect(nativeAbnormal.warnings).toContain('acp-contradictory-exit');

    // Bridged async stdin EPIPE (`stdinDeliveryFailed`) fails closed even with exit 0 + success.
    const stdinBroken = reconcileBridgeTurnOutcome({
      backend: 'codex',
      isNativeReview: false,
      isSecurityReview: false,
      cancelled: false,
      exit: { code: 0, signal: null, launchFailed: false },
      terminalEvents: [{ kind: 'success', stopReason: 'end_turn' }],
      streamErrorText: null,
      lineOverflowed: false,
      pendingBacklogOverflowed: false,
      stdinDeliveryFailed: true
    });
    expect(stdinBroken.outcome).toBe('error');
    if (stdinBroken.outcome === 'error') {
      expect(stdinBroken.status).toBe('backend-reported-error');
    }

    const step1 = mergeLiveUsageObservation({
      kind: 'agy',
      currentTokens: null,
      currentClaudeCostUsd: undefined,
      observedTokens: { inputTokens: 250_000, outputTokens: 50_000 },
      observedCost: undefined
    });
    const step2 = mergeLiveUsageObservation({
      kind: 'agy',
      currentTokens: step1.billableTokens,
      currentClaudeCostUsd: step1.claudeCostUsd,
      observedTokens: { inputTokens: 1, outputTokens: 1 },
      observedCost: undefined
    });
    expect(step2.billableTokens).toEqual({ inputTokens: 250_000, outputTokens: 50_000 });
  });
});
