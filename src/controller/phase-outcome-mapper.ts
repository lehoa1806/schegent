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

/**
 * Truncate a stdout/stderr buffer to `STDOUT_SUMMARY_LIMIT` bytes. Pure
 * function; redaction happens at the audit boundary via
 * `logger.sanitize` on the caller side.
 */
export function summarize(text: string): string {
  return text.slice(0, STDOUT_SUMMARY_LIMIT);
}

/**
 * Feature 042 — surface `RawInvocationOutput.stdoutTruncated` /
 * `stderrTruncated` onto `phase-end` audit payloads, but only when the
 * flag is `true`. Omitting the field on `false` keeps the on-disk
 * payload shape identical to the legacy (pre-042) record for the
 * non-truncated common case.
 */
export function truncationFields(raw: {
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
}): Record<string, true> {
  const out: Record<string, true> = {};
  if (raw.stdoutTruncated === true) out.stdoutTruncated = true;
  if (raw.stderrTruncated === true) out.stderrTruncated = true;
  return out;
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
      if (result.fatalCause) return 'error';
      return exitCode !== null && exitCode !== 0 ? 'error' : 'remaining_issues';
  }
}
