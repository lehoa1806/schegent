/**
 * FR-R8-02 (02-04) — controller-level guard preventing contradictory, absent-terminal, refusal,
 * stream-overflow, or uncertain ACP turns from advancing a workflow even when earlier model text
 * contained a clean termination token.
 *
 * Extracted out of `phase-runner.ts` so `phase-runner.ts` stays within its strict LOC ceiling
 * (`phase-runner-loc-budget.test.ts`). Zero `vscode` imports.
 */
import type { RawInvocationOutput } from '../runner/invocation-result';
import type { InvocationResult } from '../parser/stdout-parser';
import { warningCodeForReconciliation } from '../services/acp-runtime/terminal-reconciliation';

export type PhaseTerminalReconciliationVerdict =
  | { readonly action: 'pass-through' }
  | { readonly action: 'cancel' }
  | {
      readonly action: 'fail-closed';
      readonly warningCode: string;
      readonly summaryWarning: string;
      readonly terminationReason: 'error';
    };

export interface AppliedPhaseTerminalReconciliation {
  readonly result: InvocationResult;
  readonly forceCancel: boolean;
  readonly forceFailed: boolean;
}

/**
 * Evaluates whether `raw.terminalReconciliation` forbids a phase from advancing.
 * Returns `'pass-through'` for clean turns, legacy direct-CLI invocations without ACP
 * reconciliation metadata, and rate-limit / fatal-signature classifications (which carry their own
 * dedicated failure/retry semantics).
 */
export function evaluatePhaseTerminalReconciliation(
  raw: Pick<RawInvocationOutput, 'terminalReconciliation' | 'killed' | 'exitCode'>,
  parsedResult: InvocationResult
): PhaseTerminalReconciliationVerdict {
  const rec = raw.terminalReconciliation;
  if (rec === undefined || rec.status === 'clean') {
    return { action: 'pass-through' };
  }
  if (rec.status === 'cancelled') {
    return { action: 'cancel' };
  }
  // Preserve dedicated rate-limit and fatal-signature classifications when they already matched.
  if (parsedResult.kind === 'rate_limited') {
    return { action: 'pass-through' };
  }
  if (parsedResult.kind === 'malformed' && parsedResult.fatalCause !== undefined) {
    return { action: 'pass-through' };
  }
  const warningCode = rec.warningCode ?? warningCodeForReconciliation(rec.status);
  return {
    action: 'fail-closed',
    warningCode,
    summaryWarning: `ACP terminal reconciliation failed (${rec.status})`,
    terminationReason: 'error'
  };
}

/**
 * Applies `evaluatePhaseTerminalReconciliation` onto the post-truncation `InvocationResult` so
 * `PhaseRunner` fails closed on non-clean ACP outcomes without duplicating audit-write arms.
 */
export function applyPhaseTerminalReconciliation(
  parsedResult: InvocationResult,
  raw: Pick<RawInvocationOutput, 'terminalReconciliation' | 'killed' | 'exitCode'>
): AppliedPhaseTerminalReconciliation {
  const verdict = evaluatePhaseTerminalReconciliation(raw, parsedResult);
  if (verdict.action === 'pass-through') {
    return { result: parsedResult, forceCancel: false, forceFailed: false };
  }
  if (verdict.action === 'cancel') {
    return { result: parsedResult, forceCancel: true, forceFailed: false };
  }
  const existingWarnings =
    parsedResult.kind === 'rate_limited' ? [] : (parsedResult.warnings ?? []);
  const warnings = existingWarnings.includes(verdict.warningCode)
    ? existingWarnings
    : [verdict.warningCode, ...existingWarnings];
  return {
    result: {
      kind: 'malformed',
      warnings,
      auditEntry: parsedResult.auditEntry
    },
    forceCancel: false,
    forceFailed: true
  };
}
