import type { PhaseOutcome } from './phase';
import type { InvocationResult } from '../parser/stdout-parser';
import type { TerminationReason } from '../state/workflow-run';

/**
 * Feature 057 Track 3 — pure result-classification module extracted
 * from `phase-runner.ts`. No `vscode`, no `fs`, no `Date.now()`, no
 * audit emission. Same inputs → same output. The runner shell wraps
 * the pure outputs with the controller-side concerns (audit writes,
 * sanitization, transcript writes).
 */

/**
 * Maximum byte length of the stdout / stderr summary the runner
 * propagates to the controller through `PhaseRunOutput`. The downstream
 * audit-log writer (sanitization boundary) handles redaction; the
 * truncate keeps the summary cheap to log and small enough to keep
 * audit payloads bounded.
 */
export const STDOUT_SUMMARY_LIMIT = 4 * 1024;
export const OUTPUT_TRUNCATED_WARNING = 'output-truncated-unclassifiable';

/**
 * Truncate a stdout/stderr buffer to `STDOUT_SUMMARY_LIMIT` bytes. Pure
 * function; redaction happens at the audit boundary via
 * `logger.sanitize` on the caller side.
 */
export function summarize(text: string): string {
  return text.slice(0, STDOUT_SUMMARY_LIMIT);
}

/**
 * A retained head/tail cannot prove its discarded middle held no API error.
 * Never advance on any parser result when either source buffer is incomplete.
 *
 * "Never advance" is deliberately weaker than "fail the run" — see
 * `mapOutcome`. Fatal signatures are covered regardless of retention by
 * `lib/incremental-fatal-scanner.ts`.
 */
export function failClosedOnTruncatedOutput(
  result: InvocationResult,
  truncated: boolean
): InvocationResult {
  if (!truncated) return result;
  // Feature 107 (FR-032) — read `warnings` from whichever variant carries it.
  // This read was `kind === 'malformed' ? ... : []`, which was exhaustive when
  // only that variant had the field; it now silently discards the constitution
  // warnings on every other path, including the out-of-region token report.
  const existingWarnings = result.kind === 'rate_limited' ? [] : result.warnings ?? [];
  if (existingWarnings.includes(OUTPUT_TRUNCATED_WARNING)) return result;
  return {
    kind: 'malformed',
    warnings: [...existingWarnings, OUTPUT_TRUNCATED_WARNING],
    auditEntry: result.auditEntry,
    ...(result.kind === 'malformed' && result.fatalCause ? { fatalCause: result.fatalCause } : {}),
    ...(result.kind === 'malformed' && result.fatalSource ? { fatalSource: result.fatalSource } : {})
  };
}
export function mapOutcome(result: InvocationResult, exitCode: number | null): PhaseOutcome {
  switch (result.kind) {
    case 'clean':
      return 'clean';
    case 'open_questions':
    case 'remaining_issues':
      return 'issues_remain';
    case 'rate_limited':
      return 'rate_limited';
    // Feature 011 — T019: parser-classified transient error maps to the
    // controller's delayed-retry path via PhaseOutcome.transient_error.
    case 'transient_error':
      return 'transient_error';
    case 'malformed':
      // Feature 010 FR-004: a fatal-classification result terminates the
      // phase on the current invocation regardless of exit code.
      if (result.fatalCause) return 'failed';
      // Truncation returned 'failed' until 2026-08-16, conflating "could not
      // classify" with "failed" — run-terminal on a required phase, for output
      // volume alone. 'transient_error' halts too, but without ending the run.
      if (result.warnings.includes(OUTPUT_TRUNCATED_WARNING)) return 'transient_error';
      return exitCode !== null && exitCode !== 0 ? 'failed' : 'issues_remain';
  }
}

export function mapTerminationReason(
  result: InvocationResult,
  exitCode: number | null
): TerminationReason {
  switch (result.kind) {
    case 'clean':
      return 'token';
    case 'open_questions':
      return 'open_questions';
    case 'remaining_issues':
      return 'remaining_issues';
    case 'rate_limited':
      return 'rate_limit';
    case 'transient_error':
      // Feature 011 — surface as 'error' for the persisted TerminationReason
      // (the queue/history pipeline treats this the same as a generic error;
      // the controller's pendingRetryCause is the load-bearing distinguisher).
      return 'error';
    case 'malformed':
      // Still one arm: 'transient_error' reports 'error' too, so only the
      // outcome diverged.
      if (result.fatalCause || result.warnings.includes(OUTPUT_TRUNCATED_WARNING)) {
        return 'error';
      }
      return exitCode !== null && exitCode !== 0 ? 'error' : 'remaining_issues';
  }
}
