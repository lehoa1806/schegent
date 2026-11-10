/**
 * FR-R6-F11 (FR-005) — the closed outcome of every reporting operation.
 *
 * `ok: true` is the `complete` outcome. Every query ends in exactly one of complete, cancelled,
 * expired, limited or failed, unless it is refused first. An expected condition is a value, never
 * a throw. Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

export const REFUSAL_REASONS = Object.freeze([
  'invalid-query',
  'unsupported-dimension',
  'invalid-cursor',
  'query-busy',
  'query-limited',
  'report-lease-limit',
  'workspace-untrusted',
  'export-busy',
  'destination-not-local-file',
  'destination-in-evidence-store',
  'destination-unresolvable',
  'destination-exists',
  'unknown-root',
  'unknown-saved-report',
  'accounting-unavailable'
] as const);
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export const LIMIT_REASONS = Object.freeze([
  'snapshot-rows',
  'working-data',
  'deadline-exceeded',
  'export-rows',
  'export-bytes',
  'export-time'
] as const);
export type LimitReason = (typeof LIMIT_REASONS)[number];

export const FAILURE_REASONS = Object.freeze([
  'source-read-failed',
  'accounting-revision-unavailable',
  'write-failed',
  'publish-failed',
  'manifest-publish-failed',
  'host-stopped'
] as const);
export type FailureReason = (typeof FAILURE_REASONS)[number];

export type ReportFailure =
  | { readonly ok: false; readonly outcome: 'cancelled' }
  | { readonly ok: false; readonly outcome: 'expired'; readonly instruction: 'restart-report-query' }
  | { readonly ok: false; readonly outcome: 'limited'; readonly limit: LimitReason }
  | { readonly ok: false; readonly outcome: 'failed'; readonly reason: FailureReason }
  | { readonly ok: false; readonly outcome: 'refused'; readonly reason: RefusalReason };

export type ReportResult<T> = { readonly ok: true; readonly value: T } | ReportFailure;

export function reportOk<T>(value: T): ReportResult<T> {
  return { ok: true, value };
}

export function reportRefused(reason: RefusalReason): ReportFailure {
  return { ok: false, outcome: 'refused', reason };
}

export function reportLimited(limit: LimitReason): ReportFailure {
  return { ok: false, outcome: 'limited', limit };
}

export function reportFailed(reason: FailureReason): ReportFailure {
  return { ok: false, outcome: 'failed', reason };
}

export function reportExpired(): ReportFailure {
  return { ok: false, outcome: 'expired', instruction: 'restart-report-query' };
}

export function reportCancelled(): ReportFailure {
  return { ok: false, outcome: 'cancelled' };
}

/** Progress of a long operation (research R13). Never holds a value, label or path. */
export interface ReportProgress {
  readonly phase: 'admitting' | 'capturing' | 'aggregating' | 'writing' | 'publishing';
  readonly rowsDone: number;
  readonly rowsTotal?: number;
  readonly elapsedMs: number;
}

export type ReportProgressListener = (progress: ReportProgress) => void;
