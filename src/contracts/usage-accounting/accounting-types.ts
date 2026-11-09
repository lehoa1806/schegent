/**
 * FR-R6-F06 — the vocabularies, bounds and result shapes of usage accounting.
 *
 * Pure types and frozen constants only. The SQLite migration spells the same value lists
 * literally (its checksum covers the DDL text); `accounting-schema.test.ts` asserts the two
 * still agree.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

export const MEASURES = Object.freeze([
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'cost',
  'credits',
  'context_used',
  'context_size'
] as const);
export type Measure = (typeof MEASURES)[number];

/** Measures counted in unit `count`. */
export const COUNT_MEASURES: ReadonlySet<Measure> = new Set<Measure>([
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'context_used',
  'context_size'
]);

/** Occupancy measures are reported as the latest value, never summed. */
export const OCCUPANCY_MEASURES: ReadonlySet<Measure> = new Set<Measure>([
  'context_used',
  'context_size'
]);

export const COMPLETENESS_VALUES = Object.freeze([
  'known',
  'partial',
  'unknown',
  'conflicting'
] as const);
export type Completeness = (typeof COMPLETENESS_VALUES)[number];

export const PROVENANCE_VALUES = Object.freeze(['provider-reported', 'derived', 'estimated'] as const);
export type Provenance = (typeof PROVENANCE_VALUES)[number];

export const CACHE_RELATIONS = Object.freeze(['subset-of-input', 'disjoint', 'unknown'] as const);
export type CacheRelation = (typeof CACHE_RELATIONS)[number];

export const COUNTER_SCOPES = Object.freeze([
  'invocation-delta',
  'session-cumulative',
  'acp-context-occupancy',
  'legacy-run-total'
] as const);
export type CounterScope = (typeof COUNTER_SCOPES)[number];

export const DISPOSITIONS = Object.freeze([
  'accepted',
  'corroborating',
  'conflicting',
  'superseded',
  'unattributed',
  'historical',
  'correction'
] as const);
export type Disposition = (typeof DISPOSITIONS)[number];

/** `'duplicate'` is a result-only value: a replay with the same digest stores no row. */
export type IngestDisposition = Disposition | 'duplicate';

export const SOURCE_KINDS = Object.freeze([
  'phase-end',
  'acp-usage-update',
  'correction',
  'fixture'
] as const);
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const ATTEMPT_OUTCOMES = Object.freeze([
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'superseded',
  'unknown'
] as const);
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/** The terminal outcomes a root transition may record. */
export const ROOT_OUTCOMES = Object.freeze([
  'succeeded',
  'failed',
  'cancelled',
  'interrupted'
] as const);
export type RootOutcome = (typeof ROOT_OUTCOMES)[number];

export const REVISION_CAUSES = Object.freeze([
  'ingest',
  'correction',
  'outcome',
  'rebuild',
  'policy',
  'legacy-import'
] as const);
export type RevisionCause = (typeof REVISION_CAUSES)[number];

export const INTENT_STATES = Object.freeze(['pending', 'applied'] as const);
export type IntentState = (typeof INTENT_STATES)[number];

export const EPOCH_STATES = Object.freeze(['importing', 'complete'] as const);
export type EpochState = (typeof EPOCH_STATES)[number];

export const RECONCILIATIONS = Object.freeze(['matched', 'mismatch', 'empty'] as const);
export type Reconciliation = (typeof RECONCILIATIONS)[number];

export const GAP_KINDS = Object.freeze([
  'invalid-counter',
  'dimension-excluded',
  'unattributed-limit',
  'admission-overflow',
  'ingest-failed',
  'projection-failed',
  'expired-source',
  'telemetry-echo',
  'cumulative-reset',
  'unattributed-session-baseline',
  'observation-too-large',
  'correction-refused'
] as const);
export type GapKind = (typeof GAP_KINDS)[number];

export const CORRECTION_ACTORS = Object.freeze(['operator', 'provider'] as const);
export type CorrectionActor = (typeof CORRECTION_ACTORS)[number];

export const ACCOUNTING_REFUSAL_CODES = Object.freeze([
  'invalid-observation',
  'invalid-counter',
  'observation-too-large',
  'telemetry-echo',
  'expired-source',
  'unattributed-limit',
  'projection-backlog-full',
  'store-full',
  'legacy-epoch-overlap',
  'unknown-attempt',
  'beyond-correction-horizon',
  'correction-limit',
  'invalid-correction',
  'invalid-query',
  'revision-compacted',
  'aggregate-overflow',
  'response-too-large',
  'deadline-exceeded',
  'store-unavailable',
  'store-error'
] as const);
export type AccountingRefusalCode = (typeof ACCOUNTING_REFUSAL_CODES)[number];

export interface AccountingRefusal {
  readonly code: AccountingRefusalCode;
  /** Sanitized detail only: counts, enum values or a field name. Never a payload value. */
  readonly detail?: string;
}

export type AccountingResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: AccountingRefusal };

export interface AccountingBounds {
  readonly maxRetainedObservations: number;
  readonly maxUnattributed: number;
  readonly maxPendingIntents: number;
  readonly maxCorrectionsPerContribution: number;
  readonly maxGapKeys: number;
  readonly admissionQueue: number;
  readonly maxQueryLimit: number;
  readonly maxResponseBytes: number;
  readonly queryDeadlineMs: number;
  readonly horizonDays: number;
  readonly maxObservationBytes: number;
  readonly maxObservationFields: number;
  readonly maxDimensionBytes: number;
}

export const DEFAULT_ACCOUNTING_BOUNDS: AccountingBounds = Object.freeze({
  maxRetainedObservations: 1_000_000,
  maxUnattributed: 10_000,
  maxPendingIntents: 10_000,
  maxCorrectionsPerContribution: 64,
  maxGapKeys: 10_000,
  admissionQueue: 256,
  maxQueryLimit: 200,
  maxResponseBytes: 1_048_576,
  queryDeadlineMs: 5_000,
  horizonDays: 90,
  maxObservationBytes: 16_384,
  maxObservationFields: 32,
  maxDimensionBytes: 256
});

export const ACCOUNTING_POLICY_VERSION = 1 as const;
export const ACCOUNTING_CALCULATION_VERSION = 1 as const;
export const ACCOUNTING_NORMALIZATION_VERSION = 1 as const;

export const PHASE_END_PRODUCER_NAMESPACE = 'schegent.phase-end/1' as const;
export const ACP_USAGE_PRODUCER_NAMESPACE = 'schegent.acp-usage/1' as const;

/** Outbound telemetry copies carry this namespace and must never re-enter (F06-AC-03). */
export const TELEMETRY_EXPORT_NAMESPACE_PATTERN = /^schegent\.export(\.|\/)/;
export const TELEMETRY_EXPORT_SOURCE = 'telemetry-export' as const;

/** An event time this far after the ingest time marks a clock anomaly (FR-002). */
export const CLOCK_ANOMALY_TOLERANCE_MS = 5 * 60 * 1000;
