/**
 * FR-R6-F14 (FR-005, FR-010, FR-012, FR-013; NFR-002; research R6) — what one delivery result
 * means, and whether another attempt may start. Pure: no clock, no timer, no request.
 *
 * Only HTTP 200 is success in OTLP/HTTP (opentelemetry-proto 1.7.0). A partial success is a
 * 200 and is never retried; its rejected count is kept as a number and its message is dropped.
 * Nothing else of a response body is kept.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import {
  TELEMETRY_EXPORT_BOUNDS,
  type DeliveryErrorClass,
  type TransportFailureClass,
  type TransportResult
} from '../../contracts/telemetry-export';

export type ResponseAnomaly = Extract<DeliveryErrorClass, 'response-malformed' | 'response-oversized'>;
export type RetryableErrorClass = Extract<DeliveryErrorClass, 'network' | 'tls' | 'deadline' | 'http-retryable'>;

export type DeliveryClassification =
  | { readonly outcome: 'acknowledged'; readonly rejectedDataPoints: number; readonly anomaly: ResponseAnomaly | null }
  | { readonly outcome: 'retry'; readonly errorClass: RetryableErrorClass; readonly retryAfterMs: number | null }
  | { readonly outcome: 'rejected'; readonly errorClass: 'http-rejected' }
  | { readonly outcome: 'redirect-refused' };

export interface RetryState {
  /** Attempts made so far for this batch; 1 after the first one failed. */
  readonly attemptsMade: number;
  readonly firstAttemptAt: number;
  readonly now: number;
  /** The destination's `Retry-After`, when it sent one on a 429 or a 503. */
  readonly retryAfterMs: number | null;
  /** A value in `[0, 1)`. */
  readonly random: () => number;
}

export type RetryDecision = { readonly kind: 'retry'; readonly delayMs: number } | { readonly kind: 'exhausted' };

const HTTP_OK = 200;
const REDIRECT_FIRST = 300;
const REDIRECT_LAST = 399;
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504]);
/** The statuses on which `Retry-After` is honoured. */
const RETRY_AFTER_STATUS: ReadonlySet<number> = new Set([429, 503]);
const MS_PER_SECOND = 1_000;
/** A rejected count as decimal text: short enough to be a safe integer. */
const COUNT_TEXT = /^(0|[1-9][0-9]{0,15})$/;
const JITTER_FLOOR = 0.5;
const FAILURE_CLASSES: ReadonlySet<unknown> = new Set<TransportFailureClass>(['network', 'tls', 'deadline', 'aborted']);

const MALFORMED: DeliveryClassification = Object.freeze({ outcome: 'acknowledged', rejectedDataPoints: 0, anomaly: 'response-malformed' });
const OVERSIZED: DeliveryClassification = Object.freeze({ outcome: 'acknowledged', rejectedDataPoints: 0, anomaly: 'response-oversized' });
const REJECTED: DeliveryClassification = Object.freeze({ outcome: 'rejected', errorClass: 'http-rejected' });
const REDIRECT_REFUSED: DeliveryClassification = Object.freeze({ outcome: 'redirect-refused' });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** The count, or `undefined` when the field is present and is not a count. */
function rejectedCountOf(raw: unknown): number | undefined {
  if (raw === undefined) return 0;
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined;
  if (typeof raw === 'string' && COUNT_TEXT.test(raw)) return Number(raw);
  return undefined;
}

function classifyOk(body: Uint8Array, bodyTruncated: boolean): DeliveryClassification {
  if (bodyTruncated) return OVERSIZED;
  const parsed = parseJson(body);
  if (!isRecord(parsed)) return MALFORMED;
  const partial = parsed.partialSuccess;
  if (partial === undefined) return { outcome: 'acknowledged', rejectedDataPoints: 0, anomaly: null };
  if (!isRecord(partial)) return MALFORMED;
  const rejectedDataPoints = rejectedCountOf(partial.rejectedDataPoints);
  if (rejectedDataPoints === undefined) return MALFORMED;
  return { outcome: 'acknowledged', rejectedDataPoints, anomaly: null };
}

/** A send that did not complete, or whose result is outside the closed type. */
export const CONNECTION_LOST: TransportResult = Object.freeze({ kind: 'failure', errorClass: 'network' });

function isWait(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

/**
 * Whether a value is a transport result. The transport is the one port that carries what a
 * remote party sent, so a value outside the closed type is never classified: its class would
 * reach a receipt and the health view as given.
 */
export function isTransportResult(value: unknown): value is TransportResult {
  if (!isRecord(value)) return false;
  if (value.kind === 'failure') return FAILURE_CLASSES.has(value.errorClass);
  if (value.kind !== 'response') return false;
  const { statusCode } = value;
  return (
    typeof statusCode === 'number' &&
    Number.isInteger(statusCode) &&
    statusCode >= 0 &&
    isWait(value.retryAfterSeconds) &&
    value.body instanceof Uint8Array &&
    typeof value.bodyTruncated === 'boolean'
  );
}

/** Classifies one transport result. Never throws. */
export function classifyDelivery(result: TransportResult): DeliveryClassification {
  if (result.kind === 'failure') {
    // `aborted` only arises when the exporter itself ended the request, and it ignores the
    // result then; as a class it is a connection that did not complete.
    const errorClass = result.errorClass === 'aborted' ? 'network' : result.errorClass;
    return { outcome: 'retry', errorClass, retryAfterMs: null };
  }
  const { statusCode } = result;
  if (statusCode === HTTP_OK) return classifyOk(result.body, result.bodyTruncated);
  if (statusCode >= REDIRECT_FIRST && statusCode <= REDIRECT_LAST) return REDIRECT_REFUSED;
  if (!RETRYABLE_STATUS.has(statusCode)) return REJECTED;
  const honoured = RETRY_AFTER_STATUS.has(statusCode) && result.retryAfterSeconds !== null;
  return {
    outcome: 'retry',
    errorClass: 'http-retryable',
    retryAfterMs: honoured ? result.retryAfterSeconds * MS_PER_SECOND : null
  };
}

/** The share of the full delay to wait: `[0.5, 1]`; a value outside `[0, 1)` gives the full delay. */
function jitterOf(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) return 1;
  return JITTER_FLOOR + value * (1 - JITTER_FLOOR);
}

/**
 * The delay before the next attempt, or `exhausted` when five retries were made or when the
 * delay and one more request would end after the retry budget. A longer `Retry-After` replaces
 * the delay, so a destination asking for more than the budget ends the batch without a wait.
 */
export function nextRetry(state: RetryState): RetryDecision {
  const bounds = TELEMETRY_EXPORT_BOUNDS;
  if (state.attemptsMade > bounds.retriesMax) return { kind: 'exhausted' };
  const fullDelayMs = bounds.retryBaseDelayMs * 2 ** (Math.max(state.attemptsMade, 1) - 1);
  const backoffMs = fullDelayMs * jitterOf(state.random);
  const asked = state.retryAfterMs;
  const delayMs = asked !== null && Number.isFinite(asked) && asked > backoffMs ? asked : backoffMs;
  const lastAttemptEnd = state.now + delayMs + bounds.requestDeadlineMs;
  if (lastAttemptEnd > state.firstAttemptAt + bounds.retryBudgetMs) return { kind: 'exhausted' };
  return { kind: 'retry', delayMs };
}
