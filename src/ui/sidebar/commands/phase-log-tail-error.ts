import type { SanitizedLogger } from '../../../lib/logger';
import { historyErrorCode } from '../../../services/history/error-code';

/** Closed set of sidebar phase-log tail operations whose failures are logged. */
export type PhaseLogTailOperation = 'start' | 'ack' | 'stop';

const BOUNDED_TAIL_ERROR_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Extracts a strictly grammar-bounded error code from an unknown thrown value.
 *
 * Delegates extraction to `historyErrorCode(err)` (so filesystem paths and free-text
 * error messages are never read), then constrains the returned token to
 * `/^[A-Za-z0-9_.-]{1,64}$/` with `'unknown'` fallback so even a crafted path-bearing
 * `err.code` or custom error constructor name cannot reach the logger.
 */
export function boundedTailErrorCode(err: unknown): string {
  const candidate = historyErrorCode(err);
  return BOUNDED_TAIL_ERROR_CODE_RE.test(candidate) ? candidate : 'unknown';
}

/**
 * Logs a phase-log tail handler failure using only the closed operation name and
 * a strictly bounded error code — never `err.message` or `logger.sanitize(...)`.
 */
export function logPhaseLogTailFailure(
  logger: Pick<SanitizedLogger, 'warn'>,
  operation: PhaseLogTailOperation,
  err: unknown
): void {
  const errorCode = boundedTailErrorCode(err);
  logger.warn(`sidebar router: phase-log tail ${operation} failed: ${errorCode}`, {
    operation,
    errorCode
  });
}
