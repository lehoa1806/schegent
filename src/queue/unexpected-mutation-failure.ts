import { UNEXPLAINED_REJECTION_REASON } from '../contracts/command-outcome';
import { describeFailure } from '../lib/errors';
import type { SanitizedLogger } from '../lib/logger';

/**
 * FR-R4-F05 (FR-011; the brief's "never leak exception substrings to IPC") — the reason for a
 * queue mutation that failed in a way no typed refusal names.
 *
 * It used to be `err.message`. The reason travels to the sidebar acknowledgement and the
 * operator's refusal text, and a fault from the persistence layer names a path, so an
 * exception's text reached the webview. The reason is now the closed `operation-rejected`,
 * which the webview already words, and the detail goes to the log: `describeFailure`
 * sanitizes it first and bounds it after, so a secret straddling the bound is redacted
 * whole. A thrown value that is not an `Error` was already answered `operation-rejected`.
 */
export function unexpectedMutationFailureReason(
  logger: SanitizedLogger | null,
  thrown: unknown
): string {
  if (logger !== null) {
    logger.warn('queue-manager: unexpected mutation failure', {
      error: describeFailure(thrown, (value) => logger.sanitize(value))
    });
  }
  return UNEXPLAINED_REJECTION_REASON;
}
