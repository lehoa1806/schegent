/**
 * FR-R6-F02 — Shared memory and storage contracts: C1 current-record identity
 * mapping and C3 observation quality, deduplication, corrections, monetary
 * summation, and monotonic/wall-clock ordering (FR-001, FR-004..FR-006, FR-022).
 *
 * Zero `vscode` imports (SC-009, docs/hard-rules.md rule 13).
 */

import { createHash } from 'node:crypto';
import type { ExecutionFence } from '../control-ledger';
import {
  SHARED_STORAGE_CONTRACT_VERSION,
  buildSharedContractRefusal,
  rejectUnknownInputFields,
  validateSharedIdentifier,
  type StorageBoundaryOutcome
} from './inventories';

export type SharedIdentityKey =
  | 'workspaceId'
  | 'queueId'
  | 'rootExecutionId'
  | 'invocationId'
  | 'occurrenceNodePath'
  | 'attemptId'
  | 'providerSessionId'
  | 'observationId'
  | 'artifactId'
  | 'handoffId';

export type MissingAttributionReason =
  | 'not-recorded-in-legacy-schema'
  | 'capture-disabled'
  | 'provider-session-unreported'
  | 'pre-attempt-admission';

export interface SharedExecutionIdentity {
  readonly schemaVersion: typeof SHARED_STORAGE_CONTRACT_VERSION;
  readonly workspaceId: string;
  readonly queueId: string;
  readonly rootExecutionId: string;
  readonly invocationId?: string | undefined;
  readonly occurrenceNodePath?: string | undefined;
  readonly occurrenceIndex?: number | undefined;
  readonly attemptId?: string | undefined;
  readonly attemptOrdinal?: number | undefined;
  readonly executionFence?: ExecutionFence | undefined;
  readonly providerSessionId?: string | undefined;
  readonly providerAccountAlias?: string | undefined;
  readonly modelId?: string | undefined;
  readonly observationId?: string | undefined;
  readonly artifactId?: string | undefined;
  readonly handoffId?: string | undefined;
  readonly knownIdentities: readonly SharedIdentityKey[];
  readonly missingIdentityReasons: Readonly<Record<string, MissingAttributionReason>>;
  readonly identifierAliases: Readonly<Record<string, string>>;
}

export type SupportedRecordSourceShape =
  | {
      readonly recordKind: 'control-attempt';
      readonly workspaceId: string;
      readonly queueId: string;
      readonly rootRunId: string;
      readonly frameId: string;
      readonly nodePath: string;
      readonly occurrenceIndex: number;
      readonly attemptId: string;
      readonly attemptOrdinal: number;
      readonly fence: ExecutionFence;
      readonly providerSessionId?: string | undefined;
      readonly providerAccountAlias?: string | undefined;
      readonly modelId?: string | undefined;
      readonly allowLegacyAlias?: boolean | undefined;
    }
  | {
      readonly recordKind: 'foreach-slot-attempt';
      readonly workspaceId: string;
      readonly queueId: string;
      readonly rootRunId: string;
      readonly frameId: string;
      readonly nodePath: string;
      readonly slotIndex: number;
      readonly itemValue: unknown;
      readonly attemptId: string;
      readonly attemptOrdinal: number;
      readonly fence: ExecutionFence;
    }
  | {
      readonly recordKind: 'legacy-metrics-phase';
      readonly workspaceId: string;
      readonly queueId: string;
      readonly runId: string;
      readonly phaseType: string;
      readonly iteration: number;
      readonly attemptId?: string | undefined;
      readonly modelId?: string | undefined;
      readonly providerSessionId?: string | undefined;
      readonly allowLegacyAlias?: boolean | undefined;
    }
  | {
      readonly recordKind: 'recovery-envelope';
      readonly workspaceId: string;
      readonly queueId: string;
      readonly rootRunId: string;
      readonly invocationId: string;
      readonly previousAttemptId?: string | undefined;
      readonly artifactRef?: string | undefined;
    };

export function mapCurrentRecordToSharedIdentity(
  source: SupportedRecordSourceShape
): StorageBoundaryOutcome<SharedExecutionIdentity> {
  const aliases: Record<string, string> = {};
  const missing: Record<string, MissingAttributionReason> = {};
  const known: SharedIdentityKey[] = [];
  const allowLegacy = 'allowLegacyAlias' in source ? source.allowLegacyAlias === true : false;

  const checkId = (val: string, field: SharedIdentityKey): StorageBoundaryOutcome<string> => {
    const res = validateSharedIdentifier(val, field, { allowLegacyAlias: allowLegacy });
    if (res.status !== 'accepted') return res;
    if (res.value.aliased && res.value.originalId !== undefined) {
      aliases[res.value.id] = res.value.originalId;
    }
    if (!known.includes(field)) {
      known.push(field);
    }
    return { status: 'accepted', value: res.value.id };
  };

  const wsRes = checkId(source.workspaceId, 'workspaceId');
  if (wsRes.status !== 'accepted') return wsRes;
  const qRes = checkId(source.queueId, 'queueId');
  if (qRes.status !== 'accepted') return qRes;

  if (source.recordKind === 'control-attempt' || source.recordKind === 'foreach-slot-attempt') {
    const rootRes = checkId(source.rootRunId, 'rootExecutionId');
    if (rootRes.status !== 'accepted') return rootRes;
    const invRes = checkId(source.frameId, 'invocationId');
    if (invRes.status !== 'accepted') return invRes;
    const pathRes = checkId(source.nodePath, 'occurrenceNodePath');
    if (pathRes.status !== 'accepted') return pathRes;
    const attRes = checkId(source.attemptId, 'attemptId');
    if (attRes.status !== 'accepted') return attRes;

    const occurrenceIndex =
      source.recordKind === 'foreach-slot-attempt' ? source.slotIndex : source.occurrenceIndex;
    let providerSessionId: string | undefined;
    if (source.recordKind === 'control-attempt' && source.providerSessionId !== undefined) {
      const psRes = checkId(source.providerSessionId, 'providerSessionId');
      if (psRes.status !== 'accepted') return psRes;
      providerSessionId = psRes.value;
    } else {
      missing.providerSessionId = 'provider-session-unreported';
    }

    return {
      status: 'accepted',
      value: {
        schemaVersion: SHARED_STORAGE_CONTRACT_VERSION,
        workspaceId: wsRes.value,
        queueId: qRes.value,
        rootExecutionId: rootRes.value,
        invocationId: invRes.value,
        occurrenceNodePath: pathRes.value,
        occurrenceIndex,
        attemptId: attRes.value,
        attemptOrdinal: source.attemptOrdinal,
        executionFence: source.fence,
        ...(providerSessionId !== undefined ? { providerSessionId } : {}),
        ...(source.recordKind === 'control-attempt' && source.providerAccountAlias !== undefined
          ? { providerAccountAlias: source.providerAccountAlias }
          : {}),
        ...(source.recordKind === 'control-attempt' && source.modelId !== undefined
          ? { modelId: source.modelId }
          : {}),
        knownIdentities: known,
        missingIdentityReasons: missing,
        identifierAliases: aliases
      }
    };
  }

  if (source.recordKind === 'legacy-metrics-phase') {
    const rootRes = checkId(source.runId, 'rootExecutionId');
    if (rootRes.status !== 'accepted') return rootRes;
    const pathRes = checkId(source.phaseType, 'occurrenceNodePath');
    if (pathRes.status !== 'accepted') return pathRes;

    let attemptId: string | undefined;
    if (source.attemptId !== undefined) {
      const attRes = checkId(source.attemptId, 'attemptId');
      if (attRes.status !== 'accepted') return attRes;
      attemptId = attRes.value;
    } else {
      missing.attemptId = 'not-recorded-in-legacy-schema';
    }
    missing.invocationId = 'not-recorded-in-legacy-schema';
    if (source.modelId === undefined) {
      missing.modelId = 'not-recorded-in-legacy-schema';
    }
    if (source.providerSessionId === undefined) {
      missing.providerSessionId = 'not-recorded-in-legacy-schema';
    }

    return {
      status: 'accepted',
      value: {
        schemaVersion: SHARED_STORAGE_CONTRACT_VERSION,
        workspaceId: wsRes.value,
        queueId: qRes.value,
        rootExecutionId: rootRes.value,
        occurrenceNodePath: pathRes.value,
        occurrenceIndex: source.iteration,
        ...(attemptId !== undefined ? { attemptId } : {}),
        ...(source.modelId !== undefined ? { modelId: source.modelId } : {}),
        ...(source.providerSessionId !== undefined
          ? { providerSessionId: source.providerSessionId }
          : {}),
        knownIdentities: known,
        missingIdentityReasons: missing,
        identifierAliases: aliases
      }
    };
  }

  const rootRes = checkId(source.rootRunId, 'rootExecutionId');
  if (rootRes.status !== 'accepted') return rootRes;
  const invRes = checkId(source.invocationId, 'invocationId');
  if (invRes.status !== 'accepted') return invRes;
  let attemptId: string | undefined;
  if (source.previousAttemptId !== undefined) {
    const attRes = checkId(source.previousAttemptId, 'attemptId');
    if (attRes.status !== 'accepted') return attRes;
    attemptId = attRes.value;
  } else {
    missing.attemptId = 'pre-attempt-admission';
  }
  let artifactId: string | undefined;
  if (source.artifactRef !== undefined) {
    const artRes = checkId(source.artifactRef, 'artifactId');
    if (artRes.status !== 'accepted') return artRes;
    artifactId = artRes.value;
  }

  return {
    status: 'accepted',
    value: {
      schemaVersion: SHARED_STORAGE_CONTRACT_VERSION,
      workspaceId: wsRes.value,
      queueId: qRes.value,
      rootExecutionId: rootRes.value,
      invocationId: invRes.value,
      ...(attemptId !== undefined ? { attemptId } : {}),
      ...(artifactId !== undefined ? { artifactId } : {}),
      knownIdentities: known,
      missingIdentityReasons: missing,
      identifierAliases: aliases
    }
  };
}

export const OBSERVATION_PROVENANCE_VALUES = ['observed', 'derived', 'estimated'] as const;
export type ObservationProvenance = (typeof OBSERVATION_PROVENANCE_VALUES)[number];

export const MEASURE_COMPLETENESS_VALUES = ['known', 'partial', 'unknown', 'conflicting'] as const;
export type MeasureCompleteness = (typeof MEASURE_COMPLETENESS_VALUES)[number];

export const UNAVAILABLE_REASON_CODES = [
  'capture-disabled',
  'unsupported',
  'expired',
  'missing-attribution',
  'unattributed-session-baseline'
] as const;
export type UnavailableReasonCode = (typeof UNAVAILABLE_REASON_CODES)[number];

export const ARTIFACT_AVAILABILITY_STATES = [
  'present',
  'pending',
  'missing',
  'expired',
  'deleted',
  'corrupt',
  'unverified'
] as const;
export type ArtifactAvailabilityState = (typeof ARTIFACT_AVAILABILITY_STATES)[number];

export interface ObservationQuality {
  readonly provenance: ObservationProvenance;
  readonly completeness: MeasureCompleteness;
  readonly unavailableReason?: UnavailableReasonCode | undefined;
  readonly expiryCutoffUtc?: string | undefined;
}

export interface MonetaryObservationValue {
  readonly amountDecimal: string;
  readonly unit: string;
  readonly unitKind: 'currency' | 'nonmonetary-credits';
  readonly origin: 'provider-billed' | 'token-estimated' | 'legacy-float';
  readonly pricingVersion?: string | undefined;
  readonly legacyRecordedPrecisionDigits?: number | undefined;
}

/** How a cache counter relates to input tokens: inside it, beside it, or not known. */
export const USAGE_CACHE_RELATIONS = Object.freeze(['subset-of-input', 'disjoint', 'unknown'] as const);
export type UsageCacheRelation = (typeof USAGE_CACHE_RELATIONS)[number];

export interface UsageObservationInput {
  readonly schemaVersion: number;
  readonly workspaceId: string;
  readonly queueId: string;
  readonly rootExecutionId: string;
  readonly invocationId?: string | undefined;
  readonly occurrenceNodePath?: string | undefined;
  readonly occurrenceIndex?: number | undefined;
  readonly attemptId: string;
  readonly attemptOrdinal?: number | undefined;
  readonly producerNamespace: string;
  readonly producerObservationId?: string | undefined;
  readonly deterministicDerivationKey?: string | undefined;
  readonly isCrossRestartRedelivery?: boolean | undefined;
  readonly source: string;
  readonly sourceVersion?: string | undefined;
  readonly observationTimeUtc: string;
  readonly eventTimeUtc?: string | undefined;
  readonly counterScope: 'attempt-incremental' | 'session-cumulative' | 'acp-context-occupancy';
  readonly hasQualifiedSessionBaseline?: boolean | undefined;
  readonly inputTokens?: bigint | number | string | null | undefined;
  readonly outputTokens?: bigint | number | string | null | undefined;
  /** FR-R6-F06 (research R2): distinct cache counters, never folded into input. */
  readonly cacheReadTokens?: bigint | number | string | null | undefined;
  readonly cacheCreationTokens?: bigint | number | string | null | undefined;
  readonly cacheRelation?: UsageCacheRelation | undefined;
  readonly monetary?: MonetaryObservationValue | null | undefined;
  readonly modelId?: string | undefined;
  readonly providerSessionId?: string | undefined;
  readonly quality: ObservationQuality;
}

export interface AcceptedUsageObservation {
  readonly schemaVersion: typeof SHARED_STORAGE_CONTRACT_VERSION;
  readonly observationId: string;
  readonly attemptId: string;
  readonly rootExecutionId: string;
  readonly queueId: string;
  readonly invocationId?: string | undefined;
  readonly occurrenceNodePath?: string | undefined;
  readonly occurrenceIndex?: number | undefined;
  readonly attemptOrdinal: number;
  readonly producerNamespace: string;
  readonly producerObservationId?: string | undefined;
  readonly replayQuality: 'durable-producer-id' | 'deterministic-derivation' | 'unavailable';
  readonly deduplicationStatus: 'accepted-new' | 'duplicate-ignored' | 'unresolved-duplicate';
  readonly acceptedSeq: number;
  readonly observationTimeUtc: string;
  readonly eventTimeUtc?: string | undefined;
  readonly attributionScope: 'attempt' | 'session-only' | 'non-billable-occupancy';
  readonly billableInputTokens: bigint | null;
  readonly billableOutputTokens: bigint | null;
  readonly exactInputTokensText: string | null;
  readonly exactOutputTokensText: string | null;
  /** FR-R6-F06 (research R2). Null when the source did not report the counter. */
  readonly cacheReadTokens: bigint | null;
  readonly cacheCreationTokens: bigint | null;
  readonly cacheRelation: UsageCacheRelation;
  readonly monetary: MonetaryObservationValue | null;
  readonly modelId?: string | undefined;
  readonly providerSessionId?: string | undefined;
  readonly missingAttributionReasons: Readonly<Record<string, MissingAttributionReason>>;
  readonly quality: ObservationQuality;
  readonly lifecycleState: 'accepted' | 'projected';
}

export interface UsageCorrectionInput {
  readonly schemaVersion: number;
  readonly correctionId: string;
  readonly replacesObservationId: string;
  readonly attemptId: string;
  readonly consumerId: string;
  readonly calculationVersion: string;
  readonly deltaInputTokens?: bigint | undefined;
  readonly deltaOutputTokens?: bigint | undefined;
  readonly replacementMonetary?: MonetaryObservationValue | null | undefined;
  readonly reason: string;
}

export interface AppliedCorrectionRecord {
  readonly correctionId: string;
  readonly replacesObservationId: string;
  readonly attemptId: string;
  readonly acceptedSeq: number;
  readonly status: 'applied' | 'duplicate-noop' | 'unresolved-compacted-target';
  readonly deltaInputTokens: bigint;
  readonly deltaOutputTokens: bigint;
}

export interface ObservationLedgerState {
  nextAcceptedSeq: number;
  readonly observationsById: Map<string, AcceptedUsageObservation>;
  readonly compactedObservationIdsWithTombstone: Set<string>;
  readonly compactedObservationIdsWithoutTombstone: Set<string>;
  readonly appliedCorrectionsByKey: Map<string, AppliedCorrectionRecord>;
  readonly auditHistoryLog: readonly string[];
}

export function createObservationLedgerState(
  initialAuditLog: readonly string[] = []
): ObservationLedgerState {
  return {
    nextAcceptedSeq: 1,
    observationsById: new Map(),
    compactedObservationIdsWithTombstone: new Set(),
    compactedObservationIdsWithoutTombstone: new Set(),
    appliedCorrectionsByKey: new Map(),
    auditHistoryLog: Object.freeze([...initialAuditLog])
  };
}

const UTC_OR_OFFSET_TIMESTAMP_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Upper bound on exact integer token text; far above any real counter, bounds BigInt parsing cost. */
const MAX_EXACT_TOKEN_DIGITS = 40;
/** Exact decimal monetary text: non-negative, at most 6 fractional digits (micro-unit precision). */
export const MONETARY_DECIMAL_PATTERN = /^\d{1,30}(?:\.\d{1,6})?$/;
const COUNTER_SCOPES: readonly UsageObservationInput['counterScope'][] = [
  'attempt-incremental',
  'session-cumulative',
  'acp-context-occupancy'
];

function deriveObservationId(parts: readonly string[]): string {
  // Hash an unambiguous encoding so ':' inside components can never collide two distinct facts.
  return `obs:${createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex')}`;
}

function validateMonetaryValue(
  value: unknown,
  fieldName: string
): StorageBoundaryOutcome<MonetaryObservationValue | null> {
  if (value === null || value === undefined) {
    return { status: 'accepted', value: null };
  }
  const m = value as Partial<MonetaryObservationValue>;
  if (
    typeof value !== 'object' ||
    typeof m.amountDecimal !== 'string' ||
    !MONETARY_DECIMAL_PATTERN.test(m.amountDecimal) ||
    typeof m.unit !== 'string' ||
    m.unit.length === 0 ||
    m.unit.length > 32 ||
    (m.unitKind !== 'currency' && m.unitKind !== 'nonmonetary-credits') ||
    (m.origin !== 'provider-billed' && m.origin !== 'token-estimated' && m.origin !== 'legacy-float')
  ) {
    return buildSharedContractRefusal(
      'invalid-observation',
      'malformed-monetary-value',
      `Monetary field '${fieldName}' must carry a non-negative exact decimal (<= 6 fractional digits), unit, unitKind, and origin.`,
      fieldName
    );
  }
  return { status: 'accepted', value: value as MonetaryObservationValue };
}

function validateObservationQuality(value: unknown): StorageBoundaryOutcome<ObservationQuality> {
  const q = value as Partial<ObservationQuality> | null | undefined;
  if (
    typeof q !== 'object' ||
    q === null ||
    !(OBSERVATION_PROVENANCE_VALUES as readonly unknown[]).includes(q.provenance) ||
    !(MEASURE_COMPLETENESS_VALUES as readonly unknown[]).includes(q.completeness) ||
    (q.unavailableReason !== undefined &&
      !(UNAVAILABLE_REASON_CODES as readonly unknown[]).includes(q.unavailableReason)) ||
    (q.expiryCutoffUtc !== undefined && !isValidWallClockInstant(q.expiryCutoffUtc))
  ) {
    return buildSharedContractRefusal(
      'invalid-observation',
      'malformed-observation-quality',
      'quality must declare a known provenance, completeness, and optional reason/expiry cutoff.',
      'quality'
    );
  }
  return { status: 'accepted', value: q as ObservationQuality };
}

export function isValidWallClockInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    UTC_OR_OFFSET_TIMESTAMP_REGEX.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function parseExactTokenCount(
  raw: bigint | number | string | null | undefined,
  fieldName: string
): StorageBoundaryOutcome<bigint | null> {
  if (raw === null || raw === undefined) {
    return { status: 'accepted', value: null };
  }
  if (typeof raw === 'bigint') {
    if (raw < 0n) {
      return buildSharedContractRefusal(
        'invalid-observation',
        'negative-token-count',
        `Token field '${fieldName}' cannot be negative (${raw.toString()}).`,
        fieldName
      );
    }
    return { status: 'accepted', value: raw };
  }
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 0) {
      return buildSharedContractRefusal(
        'invalid-observation',
        'invalid-or-negative-token-count',
        `Token field '${fieldName}' must be a non-negative integer.`,
        fieldName
      );
    }
    if (!Number.isSafeInteger(raw)) {
      return buildSharedContractRefusal(
        'invalid-observation',
        'unsafe-number-token-count',
        `Token field '${fieldName}' exceeds Number.MAX_SAFE_INTEGER; supply bigint or exact decimal string to prevent rounding.`,
        fieldName
      );
    }
    return { status: 'accepted', value: BigInt(raw) };
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length > MAX_EXACT_TOKEN_DIGITS || !/^-?\d+$/.test(trimmed)) {
      return buildSharedContractRefusal(
        'invalid-observation',
        'malformed-token-count-string',
        `Token field '${fieldName}' must be an exact integer string of at most ${MAX_EXACT_TOKEN_DIGITS} digits.`,
        fieldName
      );
    }
    const parsed = BigInt(trimmed);
    if (parsed < 0n) {
      return buildSharedContractRefusal(
        'invalid-observation',
        'negative-token-count',
        `Token field '${fieldName}' cannot be negative (${parsed.toString()}).`,
        fieldName
      );
    }
    return { status: 'accepted', value: parsed };
  }
  return buildSharedContractRefusal(
    'invalid-observation',
    'invalid-token-count-type',
    `Token field '${fieldName}' has an unsupported type.`,
    fieldName
  );
}

const ALLOWED_OBSERVATION_INPUT_KEYS = new Set([
  'schemaVersion',
  'workspaceId',
  'queueId',
  'rootExecutionId',
  'invocationId',
  'occurrenceNodePath',
  'occurrenceIndex',
  'attemptId',
  'attemptOrdinal',
  'producerNamespace',
  'producerObservationId',
  'deterministicDerivationKey',
  'isCrossRestartRedelivery',
  'source',
  'sourceVersion',
  'observationTimeUtc',
  'eventTimeUtc',
  'counterScope',
  'hasQualifiedSessionBaseline',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'cacheRelation',
  'monetary',
  'modelId',
  'providerSessionId',
  'quality'
]);

export function acceptUsageObservation(
  ledger: ObservationLedgerState,
  rawInput: unknown
): StorageBoundaryOutcome<AcceptedUsageObservation> {
  if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) {
    return buildSharedContractRefusal(
      'invalid-observation',
      'observation-not-an-object',
      'Observation input must be a JSON object.'
    );
  }
  const obj = rawInput as Record<string, unknown>;
  const unknownCheck = rejectUnknownInputFields(
    obj,
    ALLOWED_OBSERVATION_INPUT_KEYS,
    'UsageObservationInput'
  );
  if (unknownCheck.status !== 'accepted') return unknownCheck;

  const input = rawInput as UsageObservationInput;
  if (input.schemaVersion !== SHARED_STORAGE_CONTRACT_VERSION) {
    return buildSharedContractRefusal(
      'unsupported-version',
      'unsupported-observation-schema-version',
      `Unsupported observation schemaVersion '${String(input.schemaVersion)}'.`,
      'schemaVersion'
    );
  }

  for (const [field, val] of [
    ['workspaceId', input.workspaceId],
    ['queueId', input.queueId],
    ['rootExecutionId', input.rootExecutionId],
    ['attemptId', input.attemptId],
    ['producerNamespace', input.producerNamespace]
  ] as const) {
    const idCheck = validateSharedIdentifier(val, field);
    if (idCheck.status !== 'accepted') return idCheck;
  }
  for (const [field, val] of [
    ['invocationId', input.invocationId],
    ['occurrenceNodePath', input.occurrenceNodePath],
    ['providerSessionId', input.providerSessionId],
    ['modelId', input.modelId]
  ] as const) {
    if (val === undefined) continue;
    const idCheck = validateSharedIdentifier(val, field);
    if (idCheck.status !== 'accepted') return idCheck;
  }

  if (typeof input.source !== 'string' || input.source.length === 0 || input.source.length > 64) {
    return buildSharedContractRefusal(
      'invalid-observation',
      'invalid-observation-source',
      'source must be a non-empty string of at most 64 characters.',
      'source'
    );
  }
  if (!COUNTER_SCOPES.includes(input.counterScope)) {
    return buildSharedContractRefusal(
      'invalid-observation',
      'invalid-counter-scope',
      'counterScope must be attempt-incremental, session-cumulative, or acp-context-occupancy.',
      'counterScope'
    );
  }
  const qualityRes = validateObservationQuality(input.quality);
  if (qualityRes.status !== 'accepted') return qualityRes;
  const monetaryRes = validateMonetaryValue(input.monetary, 'monetary');
  if (monetaryRes.status !== 'accepted') return monetaryRes;

  if (!isValidWallClockInstant(input.observationTimeUtc)) {
    return buildSharedContractRefusal(
      'invalid-observation',
      'invalid-observation-time-utc',
      'observationTimeUtc must carry an explicit UTC (Z) or numeric offset RFC 3339 representation.',
      'observationTimeUtc'
    );
  }
  if (input.eventTimeUtc !== undefined && !isValidWallClockInstant(input.eventTimeUtc)) {
    return buildSharedContractRefusal(
      'invalid-observation',
      'invalid-event-time-utc',
      'eventTimeUtc, when present, must carry an explicit UTC (Z) or numeric offset representation.',
      'eventTimeUtc'
    );
  }

  const inTokensRes = parseExactTokenCount(input.inputTokens, 'inputTokens');
  if (inTokensRes.status !== 'accepted') return inTokensRes;
  const outTokensRes = parseExactTokenCount(input.outputTokens, 'outputTokens');
  if (outTokensRes.status !== 'accepted') return outTokensRes;
  const cacheReadRes = parseExactTokenCount(input.cacheReadTokens, 'cacheReadTokens');
  if (cacheReadRes.status !== 'accepted') return cacheReadRes;
  const cacheCreationRes = parseExactTokenCount(input.cacheCreationTokens, 'cacheCreationTokens');
  if (cacheCreationRes.status !== 'accepted') return cacheCreationRes;
  if (
    input.cacheRelation !== undefined &&
    !(USAGE_CACHE_RELATIONS as readonly string[]).includes(input.cacheRelation)
  ) {
    return buildSharedContractRefusal(
      'invalid-observation',
      'unknown-cache-relation',
      'cacheRelation must be subset-of-input, disjoint or unknown.',
      'cacheRelation'
    );
  }

  let replayQuality: AcceptedUsageObservation['replayQuality'];
  let observationId: string;
  if (input.producerObservationId !== undefined && input.producerObservationId !== '') {
    const prodCheck = validateSharedIdentifier(
      input.producerObservationId,
      'producerObservationId'
    );
    if (prodCheck.status !== 'accepted') return prodCheck;
    replayQuality = 'durable-producer-id';
    observationId = deriveObservationId([
      input.attemptId,
      input.producerNamespace,
      'producer',
      prodCheck.value.id
    ]);
  } else if (
    input.deterministicDerivationKey !== undefined &&
    input.deterministicDerivationKey !== ''
  ) {
    const keyCheck = validateSharedIdentifier(
      input.deterministicDerivationKey,
      'deterministicDerivationKey'
    );
    if (keyCheck.status !== 'accepted') return keyCheck;
    replayQuality = 'deterministic-derivation';
    observationId = deriveObservationId([
      input.attemptId,
      input.producerNamespace,
      'derived',
      keyCheck.value.id
    ]);
  } else {
    replayQuality = 'unavailable';
    observationId = deriveObservationId([
      input.attemptId,
      input.producerNamespace,
      'unanchored',
      String(ledger.nextAcceptedSeq)
    ]);
  }

  const existing = ledger.observationsById.get(observationId);
  if (existing !== undefined) {
    return {
      status: 'accepted',
      value: {
        ...existing,
        deduplicationStatus: 'duplicate-ignored'
      }
    };
  }

  const isUnresolvedCrossRestart =
    replayQuality === 'unavailable' && input.isCrossRestartRedelivery === true;

  let attributionScope: AcceptedUsageObservation['attributionScope'] = 'attempt';
  let billableInput = inTokensRes.value;
  let billableOutput = outTokensRes.value;
  let effectiveQuality: ObservationQuality = {
    provenance: input.quality.provenance,
    completeness: input.quality.completeness,
    ...(input.quality.unavailableReason !== undefined
      ? { unavailableReason: input.quality.unavailableReason }
      : {}),
    ...(input.quality.expiryCutoffUtc !== undefined
      ? { expiryCutoffUtc: input.quality.expiryCutoffUtc }
      : {})
  };

  if (input.counterScope === 'acp-context-occupancy') {
    attributionScope = 'non-billable-occupancy';
    billableInput = null;
    billableOutput = null;
  } else if (
    input.counterScope === 'session-cumulative' &&
    input.hasQualifiedSessionBaseline !== true
  ) {
    attributionScope = 'session-only';
    billableInput = null;
    billableOutput = null;
    effectiveQuality = {
      provenance: effectiveQuality.provenance,
      completeness: 'unknown',
      unavailableReason: 'unattributed-session-baseline'
    };
  }

  if (isUnresolvedCrossRestart) {
    billableInput = null;
    billableOutput = null;
    effectiveQuality = {
      provenance: effectiveQuality.provenance,
      completeness: 'conflicting',
      unavailableReason: 'missing-attribution'
    };
  }

  const missingAttributionReasons: Record<string, MissingAttributionReason> = {};
  if (input.modelId === undefined) {
    missingAttributionReasons.modelId = 'not-recorded-in-legacy-schema';
  }
  if (input.providerSessionId === undefined) {
    missingAttributionReasons.providerSessionId = 'provider-session-unreported';
  }

  const accepted: AcceptedUsageObservation = {
    schemaVersion: SHARED_STORAGE_CONTRACT_VERSION,
    observationId,
    attemptId: input.attemptId,
    rootExecutionId: input.rootExecutionId,
    queueId: input.queueId,
    ...(input.invocationId !== undefined ? { invocationId: input.invocationId } : {}),
    ...(input.occurrenceNodePath !== undefined
      ? { occurrenceNodePath: input.occurrenceNodePath }
      : {}),
    ...(input.occurrenceIndex !== undefined ? { occurrenceIndex: input.occurrenceIndex } : {}),
    attemptOrdinal: input.attemptOrdinal ?? 1,
    producerNamespace: input.producerNamespace,
    ...(input.producerObservationId !== undefined
      ? { producerObservationId: input.producerObservationId }
      : {}),
    replayQuality,
    deduplicationStatus: isUnresolvedCrossRestart ? 'unresolved-duplicate' : 'accepted-new',
    acceptedSeq: ledger.nextAcceptedSeq++,
    observationTimeUtc: input.observationTimeUtc,
    ...(input.eventTimeUtc !== undefined ? { eventTimeUtc: input.eventTimeUtc } : {}),
    attributionScope,
    billableInputTokens: billableInput,
    billableOutputTokens: billableOutput,
    exactInputTokensText: billableInput !== null ? billableInput.toString() : null,
    exactOutputTokensText: billableOutput !== null ? billableOutput.toString() : null,
    cacheReadTokens: attributionScope === 'attempt' ? cacheReadRes.value : null,
    cacheCreationTokens: attributionScope === 'attempt' ? cacheCreationRes.value : null,
    cacheRelation: input.cacheRelation ?? 'unknown',
    monetary: monetaryRes.value,
    ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
    ...(input.providerSessionId !== undefined
      ? { providerSessionId: input.providerSessionId }
      : {}),
    missingAttributionReasons,
    quality: effectiveQuality,
    lifecycleState: 'accepted'
  };

  ledger.observationsById.set(observationId, accepted);
  return { status: 'accepted', value: accepted };
}

export function applyUsageCorrection(
  ledger: ObservationLedgerState,
  input: UsageCorrectionInput
): StorageBoundaryOutcome<AppliedCorrectionRecord> {
  if (input.schemaVersion !== SHARED_STORAGE_CONTRACT_VERSION) {
    return buildSharedContractRefusal(
      'unsupported-version',
      'unsupported-correction-schema-version',
      `Unsupported correction schemaVersion '${String(input.schemaVersion)}'.`,
      'schemaVersion'
    );
  }
  const idRes = validateSharedIdentifier(input.correctionId, 'correctionId');
  if (idRes.status !== 'accepted') return idRes;
  for (const [field, val] of [
    ['replacesObservationId', input.replacesObservationId],
    ['attemptId', input.attemptId],
    ['consumerId', input.consumerId],
    ['calculationVersion', input.calculationVersion]
  ] as const) {
    const check = validateSharedIdentifier(val, field);
    if (check.status !== 'accepted') return check;
  }
  for (const [field, val] of [
    ['deltaInputTokens', input.deltaInputTokens],
    ['deltaOutputTokens', input.deltaOutputTokens]
  ] as const) {
    if (val !== undefined && typeof val !== 'bigint') {
      return buildSharedContractRefusal(
        'invalid-observation',
        'invalid-correction-delta',
        `Correction field '${field}' must be an exact bigint delta.`,
        field
      );
    }
  }

  const appKey = JSON.stringify([input.consumerId, input.calculationVersion, input.correctionId]);
  const prior = ledger.appliedCorrectionsByKey.get(appKey);
  if (prior !== undefined) {
    return {
      status: 'accepted',
      value: {
        ...prior,
        status: 'duplicate-noop'
      }
    };
  }

  if (ledger.compactedObservationIdsWithoutTombstone.has(input.replacesObservationId)) {
    const unresolved: AppliedCorrectionRecord = {
      correctionId: input.correctionId,
      replacesObservationId: input.replacesObservationId,
      attemptId: input.attemptId,
      acceptedSeq: ledger.nextAcceptedSeq++,
      status: 'unresolved-compacted-target',
      deltaInputTokens: 0n,
      deltaOutputTokens: 0n
    };
    ledger.appliedCorrectionsByKey.set(appKey, unresolved);
    return { status: 'accepted', value: unresolved };
  }

  const targetExists =
    ledger.observationsById.has(input.replacesObservationId) ||
    ledger.compactedObservationIdsWithTombstone.has(input.replacesObservationId);
  if (!targetExists) {
    return buildSharedContractRefusal(
      'invalid-observation',
      'correction-target-observation-not-found',
      `Correction '${input.correctionId}' references unknown observation '${input.replacesObservationId}'.`,
      'replacesObservationId'
    );
  }
  const target = ledger.observationsById.get(input.replacesObservationId);
  if (target !== undefined && target.attemptId !== input.attemptId) {
    return buildSharedContractRefusal(
      'identity-mismatch',
      'correction-attempt-mismatch',
      `Correction '${input.correctionId}' names an attempt that does not own observation '${input.replacesObservationId}'.`,
      'attemptId'
    );
  }

  const applied: AppliedCorrectionRecord = {
    correctionId: input.correctionId,
    replacesObservationId: input.replacesObservationId,
    attemptId: input.attemptId,
    acceptedSeq: ledger.nextAcceptedSeq++,
    status: 'applied',
    deltaInputTokens: input.deltaInputTokens ?? 0n,
    deltaOutputTokens: input.deltaOutputTokens ?? 0n
  };
  ledger.appliedCorrectionsByKey.set(appKey, applied);
  return { status: 'accepted', value: applied };
}
