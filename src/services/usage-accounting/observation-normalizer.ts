/**
 * FR-R6-F06 (FR-001..005, FR-016, FR-021, research R4, R6, R11, R13) — one observation,
 * validated and normalized before it touches the store.
 *
 * Pure: no I/O and no clock reads. The store supplies the ingest time. The result is either a
 * refusal, with the gap to count, or a normalized observation with its content digest and
 * dedup key. Refusal details name a field or a count, never a payload value.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { createHash } from 'node:crypto';
import {
  type UsageObservationInput,
  acceptUsageObservation,
  createObservationLedgerState,
  isValidWallClockInstant
} from '../../contracts/shared-memory-storage/identity-and-observations';
import { SHARED_STORAGE_CONTRACT_VERSION } from '../../contracts/shared-memory-storage/inventories';
import {
  type AccountingBounds,
  type AccountingRefusalCode,
  type CacheRelation,
  type CounterScope,
  type GapKind,
  type Measure,
  type Provenance,
  type SourceKind,
  CACHE_RELATIONS,
  CLOCK_ANOMALY_TOLERANCE_MS,
  COUNTER_SCOPES,
  COUNT_MEASURES,
  GAP_KINDS,
  MEASURES,
  PROVENANCE_VALUES,
  SOURCE_KINDS,
  TELEMETRY_EXPORT_NAMESPACE_PATTERN,
  TELEMETRY_EXPORT_SOURCE
} from '../../contracts/usage-accounting/accounting-types';
import { type DimensionName, sanitizeDimension } from './dimension-sanitizer';
import { isCreditUnit, isCurrencyCode, parseCount, parseDecimalMicros } from './exact-quantities';

const PRODUCER_NAMESPACE = /^[a-z][a-z0-9._/-]{0,63}$/;
const ADAPTER_VERSION = /^[a-z0-9][a-z0-9._/-]{0,63}$/;
export const REASON_CODE = /^[a-z][a-z0-9-]{0,63}$/;
const PRICING_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SOURCE_IDENTITY_MAX_BYTES = 256;
const DEFAULT_UNKNOWN_REASON = 'not-reported';
const MS_PER_DAY = 86_400_000;
const CACHE_MEASURES: ReadonlySet<Measure> = new Set<Measure>(['cache_read_tokens', 'cache_creation_tokens']);

export interface AccountingMeasureInput {
  readonly measure: Measure;
  /** Counts: an integer. Money and credits: decimal text, at most 6 fractional digits. `null` is unknown. */
  readonly quantity: bigint | number | string | null;
  readonly unit: string;
  readonly provenance: Provenance;
  readonly completeness?: 'known' | 'partial' | 'unknown' | undefined;
  readonly cacheRelation?: CacheRelation | undefined;
  readonly pricingVersion?: string | undefined;
  readonly unknownReason?: string | undefined;
}

export interface AccountingDimensionsInput {
  readonly backend?: string | null | undefined;
  readonly modelRequested?: string | null | undefined;
  readonly modelReported?: string | null | undefined;
  readonly providerSessionId?: string | null | undefined;
  readonly workflowRevision?: string | null | undefined;
  readonly phaseId?: string | null | undefined;
}

/** The input of `ingestObservation`: the F02 identity fields plus measures and source metadata. */
export interface AccountingObservationInput {
  readonly producerNamespace: string;
  readonly source: string;
  readonly sourceKind: SourceKind;
  /** Deterministic derivation key. `null` means unanchored: the row is held unattributed. */
  readonly sourceIdentity: string | null;
  readonly observationRevision?: number | undefined;
  readonly rootId: string | null;
  readonly attemptId: string | null;
  readonly invocationOrdinal?: number | undefined;
  readonly counterScope: CounterScope;
  readonly adapterVersion: string;
  readonly dimensions?: AccountingDimensionsInput | undefined;
  readonly eventUtc: string;
  readonly observedUtc: string;
  readonly measures: readonly AccountingMeasureInput[];
  /** Forces a non-counted disposition; otherwise it follows from the anchors. */
  readonly disposition?: 'unattributed' | 'historical' | undefined;
  readonly uncertaintyReason?: GapKind | undefined;
}

export interface NormalizedMeasure {
  readonly measure: Measure;
  readonly quantity: bigint | null;
  readonly unit: string;
  readonly reportedScale: number | null;
  readonly completeness: 'known' | 'partial' | 'unknown';
  readonly provenance: Provenance;
  readonly cacheRelation: CacheRelation | null;
  readonly pricingVersion: string | null;
  readonly unknownReason: string | null;
}

export interface NormalizedDimensions {
  readonly backend: string | null;
  readonly modelRequested: string | null;
  readonly modelReported: string | null;
  readonly providerSessionRef: string | null;
  readonly workflowRevision: string | null;
  readonly phaseId: string | null;
}

export interface NormalizedObservation {
  readonly producerNamespace: string;
  readonly sourceKind: SourceKind;
  readonly sourceIdentity: string | null;
  readonly observationRevision: number;
  readonly rootId: string | null;
  readonly attemptId: string | null;
  readonly invocationOrdinal: number | null;
  readonly counterScope: CounterScope;
  readonly adapterVersion: string;
  readonly dimensions: NormalizedDimensions;
  /** Dimension names whose raw value was excluded; each counts a `dimension-excluded` gap. */
  readonly excludedDimensions: readonly string[];
  readonly eventUtc: string;
  readonly observedUtc: string;
  readonly clockAnomaly: boolean;
  readonly measures: readonly NormalizedMeasure[];
  readonly disposition: 'attributed' | 'unattributed' | 'historical';
  readonly uncertaintyReason: GapKind | null;
  readonly contentDigest: string;
  /** NULL when unanchored (no source identity). */
  readonly dedupKey: string | null;
}

export interface NormalizationRefusal {
  readonly code: AccountingRefusalCode;
  readonly detail?: string;
  /** The gap to count with the refusal, when the refusal is a counted loss. */
  readonly gap?: GapKind;
}

export type NormalizationResult =
  | { readonly ok: true; readonly observation: NormalizedObservation }
  | { readonly ok: false; readonly refusal: NormalizationRefusal };

export interface NormalizationContext {
  readonly workspaceId: string;
  readonly nowUtc: string;
  readonly bounds: AccountingBounds;
}

function refuse(code: AccountingRefusalCode, detail?: string, gap?: GapKind): NormalizationResult {
  return { ok: false, refusal: { code, ...(detail !== undefined ? { detail } : {}), ...(gap !== undefined ? { gap } : {}) } };
}

function bigintSafeJson(value: unknown): string {
  // `JSON.stringify` returns `undefined` for `undefined` input, whatever its declared type says.
  const text = JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item
  ) as string | undefined;
  return text ?? '';
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A wall-clock instant written in UTC with a `Z` suffix. */
export function isUtcInstant(value: unknown): value is string {
  return isValidWallClockInstant(value) && value.endsWith('Z');
}

function countFields(input: AccountingObservationInput): number {
  const topLevel = Object.keys(input).length;
  const rawDimensions: unknown = input.dimensions;
  const dimensions = typeof rawDimensions === 'object' && rawDimensions !== null ? Object.keys(rawDimensions).length : 0;
  const measures = Array.isArray(input.measures) ? input.measures.length : 0;
  return topLevel + dimensions + measures;
}

function isTelemetryEcho(input: AccountingObservationInput): boolean {
  const namespace = typeof input.producerNamespace === 'string' ? input.producerNamespace : '';
  return TELEMETRY_EXPORT_NAMESPACE_PATTERN.test(namespace) || input.source === TELEMETRY_EXPORT_SOURCE;
}

const F02_COUNTER_SCOPE: Readonly<Record<CounterScope, UsageObservationInput['counterScope']>> = Object.freeze({
  'invocation-delta': 'attempt-incremental',
  'session-cumulative': 'session-cumulative',
  'acp-context-occupancy': 'acp-context-occupancy',
  'legacy-run-total': 'attempt-incremental'
});

const F02_FIELD_NAMES: Readonly<Record<string, string>> = Object.freeze({
  rootExecutionId: 'rootId',
  queueId: 'rootId',
  observationTimeUtc: 'observedUtc',
  eventTimeUtc: 'eventUtc'
});

/** The identity and time fields go through the F02 boundary validator, with placeholders for absent anchors. */
function validateThroughF02(input: AccountingObservationInput, workspaceId: string): string | undefined {
  const rootId = input.rootId ?? 'unattributed';
  const synthetic: UsageObservationInput = {
    schemaVersion: SHARED_STORAGE_CONTRACT_VERSION,
    workspaceId,
    queueId: rootId,
    rootExecutionId: rootId,
    attemptId: input.attemptId ?? 'unattributed',
    producerNamespace: input.producerNamespace,
    source: input.source,
    observationTimeUtc: input.observedUtc,
    eventTimeUtc: input.eventUtc,
    counterScope: F02_COUNTER_SCOPE[input.counterScope],
    quality: { provenance: 'observed', completeness: 'known' }
  };
  const outcome = acceptUsageObservation(createObservationLedgerState(), synthetic);
  if (outcome.status === 'accepted') return undefined;
  const field = outcome.error.field ?? 'observation';
  return F02_FIELD_NAMES[field] ?? field;
}

function validateEnvelope(input: AccountingObservationInput, ctx: NormalizationContext): string | undefined {
  if (typeof input.producerNamespace !== 'string' || !PRODUCER_NAMESPACE.test(input.producerNamespace)) return 'producerNamespace';
  if (!(SOURCE_KINDS as readonly string[]).includes(input.sourceKind)) return 'sourceKind';
  if (!(COUNTER_SCOPES as readonly string[]).includes(input.counterScope)) return 'counterScope';
  if (typeof input.adapterVersion !== 'string' || !ADAPTER_VERSION.test(input.adapterVersion)) return 'adapterVersion';
  if (input.sourceIdentity !== null) {
    if (typeof input.sourceIdentity !== 'string' || input.sourceIdentity.length === 0) return 'sourceIdentity';
    if (Buffer.byteLength(input.sourceIdentity, 'utf8') > SOURCE_IDENTITY_MAX_BYTES) return 'sourceIdentity';
  }
  const revision = input.observationRevision ?? 1;
  if (!Number.isSafeInteger(revision) || revision < 1) return 'observationRevision';
  const ordinal = input.invocationOrdinal;
  if (ordinal !== undefined && (!Number.isSafeInteger(ordinal) || ordinal < 0)) return 'invocationOrdinal';
  if (!isUtcInstant(input.eventUtc)) return 'eventUtc';
  if (!isUtcInstant(input.observedUtc)) return 'observedUtc';
  const disposition: unknown = input.disposition;
  if (disposition !== undefined && disposition !== 'unattributed' && disposition !== 'historical') return 'disposition';
  if (input.uncertaintyReason !== undefined && !(GAP_KINDS as readonly string[]).includes(input.uncertaintyReason)) return 'uncertaintyReason';
  if (!Array.isArray(input.measures) || input.measures.length === 0) return 'measures';
  return validateThroughF02(input, ctx.workspaceId);
}

export function unitIsValid(measure: Measure, unit: unknown): boolean {
  if (typeof unit !== 'string') return false;
  if (COUNT_MEASURES.has(measure)) return unit === 'count';
  return measure === 'cost' ? isCurrencyCode(unit) : isCreditUnit(unit);
}

type MeasureResult = { readonly ok: true; readonly measure: NormalizedMeasure } | { readonly ok: false; readonly code: AccountingRefusalCode; readonly detail: string };

function normalizeQuantity(item: AccountingMeasureInput): { quantity: bigint; reportedScale: number | null } | undefined {
  if (COUNT_MEASURES.has(item.measure)) {
    const count = parseCount(item.quantity);
    return count === undefined ? undefined : { quantity: count, reportedScale: null };
  }
  const money = parseDecimalMicros(item.quantity);
  return money === undefined ? undefined : { quantity: money.micros, reportedScale: money.reportedScale };
}

function normalizeMeasure(item: AccountingMeasureInput): MeasureResult {
  const invalid = (detail: string): MeasureResult => ({ ok: false, code: 'invalid-observation', detail });
  const raw: unknown = item;
  if (typeof raw !== 'object' || raw === null) return invalid('measures');
  if (!(MEASURES as readonly string[]).includes(item.measure)) return invalid('measure');
  if (!unitIsValid(item.measure, item.unit)) return invalid('unit');
  if (!(PROVENANCE_VALUES as readonly string[]).includes(item.provenance)) return invalid('provenance');
  const isCache = CACHE_MEASURES.has(item.measure);
  const cacheRelation = isCache ? (item.cacheRelation ?? 'unknown') : null;
  if (cacheRelation !== null && !(CACHE_RELATIONS as readonly string[]).includes(cacheRelation)) return invalid('cacheRelation');
  const pricingVersion = item.pricingVersion ?? null;
  if (pricingVersion !== null && (typeof pricingVersion !== 'string' || !PRICING_VERSION.test(pricingVersion))) return invalid('pricingVersion');
  if (pricingVersion === null && item.provenance === 'estimated' && item.measure === 'cost') return invalid('pricingVersion');

  if (item.quantity === null) {
    if (item.completeness !== undefined && item.completeness !== 'unknown') return invalid('completeness');
    const reason = item.unknownReason ?? DEFAULT_UNKNOWN_REASON;
    if (typeof reason !== 'string' || !REASON_CODE.test(reason)) return invalid('unknownReason');
    return {
      ok: true,
      measure: { measure: item.measure, quantity: null, unit: item.unit, reportedScale: null, completeness: 'unknown', provenance: item.provenance, cacheRelation, pricingVersion, unknownReason: reason }
    };
  }
  const completeness = item.completeness ?? 'known';
  if (completeness !== 'known' && completeness !== 'partial') return invalid('completeness');
  const parsed = normalizeQuantity(item);
  if (parsed === undefined) return { ok: false, code: 'invalid-counter', detail: item.measure };
  return {
    ok: true,
    measure: { measure: item.measure, quantity: parsed.quantity, unit: item.unit, reportedScale: parsed.reportedScale, completeness, provenance: item.provenance, cacheRelation, pricingVersion, unknownReason: null }
  };
}

function normalizeDimensions(raw: AccountingDimensionsInput | undefined): { dimensions: NormalizedDimensions; excluded: string[] } {
  const excluded: string[] = [];
  const pick = (field: keyof AccountingDimensionsInput, name: DimensionName): string | null => {
    const result = sanitizeDimension(name, raw?.[field]);
    if ('excluded' in result) {
      excluded.push(field);
      return null;
    }
    return result.value;
  };
  const dimensions: NormalizedDimensions = {
    backend: pick('backend', 'backend'),
    modelRequested: pick('modelRequested', 'model'),
    modelReported: pick('modelReported', 'model'),
    providerSessionRef: pick('providerSessionId', 'providerSession'),
    workflowRevision: pick('workflowRevision', 'workflowRevision'),
    phaseId: pick('phaseId', 'phaseId')
  };
  return { dimensions, excluded };
}

function resolveDisposition(input: AccountingObservationInput): NormalizedObservation['disposition'] {
  if (input.disposition !== undefined) return input.disposition;
  const anchored = input.sourceIdentity !== null && input.rootId !== null && input.attemptId !== null;
  return anchored ? 'attributed' : 'unattributed';
}

/** SHA-256 of (namespace, source identity, attempt, observation revision); NULL when unanchored. */
export function computeDedupKey(namespace: string, sourceIdentity: string | null, attemptId: string | null, revision: number): string | null {
  if (sourceIdentity === null) return null;
  return sha256Hex(JSON.stringify(['accounting-dedup/1', namespace, sourceIdentity, attemptId ?? '', revision]));
}

function computeContentDigest(observation: Omit<NormalizedObservation, 'contentDigest' | 'dedupKey' | 'observationRevision' | 'clockAnomaly'>): string {
  const measures = [...observation.measures].sort((left, right) => (left.measure < right.measure ? -1 : left.measure > right.measure ? 1 : 0));
  return sha256Hex(
    bigintSafeJson([
      'accounting-content/1',
      observation.producerNamespace,
      observation.sourceKind,
      observation.sourceIdentity,
      observation.rootId,
      observation.attemptId,
      observation.invocationOrdinal,
      observation.counterScope,
      observation.adapterVersion,
      observation.dimensions,
      observation.eventUtc,
      // Not `observedUtc`: it records when this host received the row, so a redelivery of the
      // same source row (a restart replay) would otherwise read as a conflicting revision.
      observation.disposition,
      observation.uncertaintyReason,
      measures
    ])
  );
}

/** Validates and normalizes one observation. Never throws for a malformed input. */
export function normalizeObservation(input: AccountingObservationInput, ctx: NormalizationContext): NormalizationResult {
  const raw: unknown = input;
  if (typeof raw !== 'object' || raw === null) return refuse('invalid-observation', 'observation');
  if (isTelemetryEcho(input)) return refuse('telemetry-echo', undefined, 'telemetry-echo');
  const encoded = bigintSafeJson(input);
  if (Buffer.byteLength(encoded, 'utf8') > ctx.bounds.maxObservationBytes || countFields(input) > ctx.bounds.maxObservationFields) {
    return refuse('observation-too-large', undefined, 'observation-too-large');
  }
  const invalidField = validateEnvelope(input, ctx);
  if (invalidField !== undefined) return refuse('invalid-observation', invalidField);

  const measures: NormalizedMeasure[] = [];
  const seen = new Set<string>();
  for (const item of input.measures) {
    const result = normalizeMeasure(item);
    if (!result.ok) return refuse(result.code, result.detail, result.code === 'invalid-counter' ? 'invalid-counter' : undefined);
    if (seen.has(result.measure.measure)) return refuse('invalid-observation', 'measures');
    seen.add(result.measure.measure);
    measures.push(result.measure);
  }

  const nowMs = Date.parse(ctx.nowUtc);
  const eventMs = Date.parse(input.eventUtc);
  if (eventMs < nowMs - ctx.bounds.horizonDays * MS_PER_DAY) return refuse('expired-source', undefined, 'expired-source');

  const { dimensions, excluded } = normalizeDimensions(input.dimensions);
  const observationRevision = input.observationRevision ?? 1;
  const base = {
    producerNamespace: input.producerNamespace,
    sourceKind: input.sourceKind,
    sourceIdentity: input.sourceIdentity,
    rootId: input.rootId,
    attemptId: input.attemptId,
    invocationOrdinal: input.invocationOrdinal ?? null,
    counterScope: input.counterScope,
    adapterVersion: input.adapterVersion,
    dimensions,
    excludedDimensions: excluded,
    eventUtc: input.eventUtc,
    observedUtc: input.observedUtc,
    measures,
    disposition: resolveDisposition(input),
    uncertaintyReason: input.uncertaintyReason ?? null
  };
  return {
    ok: true,
    observation: {
      ...base,
      observationRevision,
      clockAnomaly: eventMs > nowMs + CLOCK_ANOMALY_TOLERANCE_MS,
      contentDigest: computeContentDigest(base),
      dedupKey: computeDedupKey(input.producerNamespace, input.sourceIdentity, input.attemptId, observationRevision)
    }
  };
}
