/**
 * FR-R5-F28 (SPEC-06, D1, D6, D7) — Backend availability adapter, observation,
 * check-schedule, and clock-reconciliation contracts.
 *
 * Pure contract module. Zero `vscode` imports.
 */

import { createHash } from 'node:crypto';
import type { BackendRunnerKind } from './backend-kinds';

export const BACKEND_AVAILABILITY_VERSION = 1 as const;

export const UNKNOWN_LOCAL_QUOTA_ID = 'unknown-local-quota' as const;
export const UNKNOWN_OBSERVATION_PREFIX = 'unknown/' as const;

export const MAX_QUOTA_IDS_PER_CANDIDATE = 4 as const;
export const MAX_QUOTA_ID_BYTES = 128 as const;

export const MIN_QUOTA_CAPACITY = 1 as const;
export const MAX_QUOTA_CAPACITY = 20 as const;

export const READY_OBSERVATION_TTL_MS = 30_000 as const;
export const AVAILABILITY_CHECK_TIMEOUT_MS = 10_000 as const;
export const MIN_RUNNER_IDLE_TIMEOUT_MS = 90_000 as const;
export const MAX_CONCURRENT_AVAILABILITY_CHECKS = 3 as const;
export const MIN_QUOTA_CHECK_INTERVAL_MS = 60_000 as const;
export const KNOWN_RESET_BUFFER_MS = 60_000 as const;

export const UNKNOWN_RESET_POLL_INTERVALS_MS = [
  60_000,
  120_000,
  300_000,
  900_000,
  1_800_000
] as const;

export const MAX_POLL_INDEX = 4 as const;
export const MAX_CHECK_JITTER_MS = 5_000 as const;

export const DEFAULT_MONITORING_WINDOW_MS = 86_400_000 as const;
export const MIN_MONITORING_WINDOW_MS = 60_000 as const;
export const MAX_MONITORING_WINDOW_MS = 172_800_000 as const;

export const CLOCK_DISCONTINUITY_THRESHOLD_MS = 5_000 as const;

export const QUOTA_IDENTITY_KINDS = ['qualified', 'unknown'] as const;
export type QuotaIdentityKind = (typeof QUOTA_IDENTITY_KINDS)[number];

export const QUOTA_STATUS_CHECK_SUPPORTS = ['supported', 'unsupported'] as const;
export type QuotaStatusCheckSupport = (typeof QUOTA_STATUS_CHECK_SUPPORTS)[number];

export const QUOTA_OBSERVATION_STATUSES = [
  'ready',
  'cooldown-known',
  'cooldown-unknown',
  'unreachable',
  'top-up-required',
  'check-unsupported'
] as const;
export type QuotaObservationStatus = (typeof QUOTA_OBSERVATION_STATUSES)[number];

export const QUOTA_OBSERVATION_SOURCES = [
  'qualified-status',
  'canonical-diagnostic',
  'counted-trial'
] as const;
export type QuotaObservationSource = (typeof QUOTA_OBSERVATION_SOURCES)[number];

export const AVAILABILITY_CHECK_STAGES = [
  'pending',
  'started',
  'settled',
  'uncertain'
] as const;
export type AvailabilityCheckStage = (typeof AVAILABILITY_CHECK_STAGES)[number];

export interface QuotaContext {
  readonly version: typeof BACKEND_AVAILABILITY_VERSION;
  readonly adapterId: string;
  readonly adapterVersion: typeof BACKEND_AVAILABILITY_VERSION;
  readonly quotaIds: readonly string[];
  readonly identity: QuotaIdentityKind;
  readonly statusCheck: QuotaStatusCheckSupport;
  readonly capacity?: number | undefined;
  readonly checkCostBoundMicrousd?: number | undefined;
}

export interface QuotaObservation {
  readonly observationId: string;
  readonly quotaId: string;
  readonly generation: number;
  readonly status: QuotaObservationStatus;
  readonly source: QuotaObservationSource;
  readonly observedAt: number;
  readonly observedMonotonicAt?: number | undefined;
  readonly hostEpoch: string;
  readonly resetAt?: number | undefined;
  readonly notBefore?: number | undefined;
  readonly nextCheckAt?: number | undefined;
  readonly pollIndex: number;
  readonly capacity: number;
}

export interface AvailabilityCheckOutcomeItem {
  readonly quotaId: string;
  readonly status: QuotaObservationStatus;
  readonly observedAt?: number | undefined;
  readonly resetAt?: number | undefined;
  readonly capacity?: number | undefined;
}

export interface AvailabilityAdapterCheckResponse {
  readonly version: typeof BACKEND_AVAILABILITY_VERSION;
  readonly adapterId: string;
  readonly outcomes: readonly AvailabilityCheckOutcomeItem[];
  readonly costMicrousd?: number | undefined;
  readonly costUncertain?: boolean | undefined;
}

export interface FrozenPhaseQuotaTarget {
  readonly id?: string | undefined;
  readonly phaseId?: string | undefined;
  readonly runner: BackendRunnerKind;
  readonly quotaProfileId?: string | undefined;
}

export interface BackendAvailabilityAdapter {
  readonly adapterId: string;
  readonly adapterVersion: typeof BACKEND_AVAILABILITY_VERSION;
  readonly backend: BackendRunnerKind;
  readonly statusCheck: QuotaStatusCheckSupport;
  resolveQuotaContext(frozenPhase: FrozenPhaseQuotaTarget): QuotaContext;
  checkAvailability?(
    context: QuotaContext,
    abortSignal: AbortSignal
  ): Promise<AvailabilityAdapterCheckResponse>;
}

export interface BackendAvailabilityValidationFailure {
  readonly ok: false;
  readonly code:
    | 'unsupported-availability-version'
    | 'invalid-quota-context'
    | 'invalid-quota-id'
    | 'invalid-quota-capacity'
    | 'invalid-quota-observation'
    | 'invalid-monitoring-window';
  readonly message: string;
}

export type QuotaContextValidationOutcome =
  | { readonly ok: true; readonly value: QuotaContext }
  | BackendAvailabilityValidationFailure;

export type QuotaObservationValidationOutcome =
  | { readonly ok: true; readonly value: QuotaObservation }
  | BackendAvailabilityValidationFailure;

const ALLOWED_QUOTA_CONTEXT_KEYS = new Set<string>([
  'version',
  'adapterId',
  'adapterVersion',
  'quotaIds',
  'identity',
  'statusCheck',
  'capacity',
  'checkCostBoundMicrousd'
]);

const ALLOWED_QUOTA_OBSERVATION_KEYS = new Set<string>([
  'observationId',
  'quotaId',
  'generation',
  'status',
  'source',
  'observedAt',
  'observedMonotonicAt',
  'hostEpoch',
  'resetAt',
  'notBefore',
  'nextCheckAt',
  'pollIndex',
  'capacity'
]);

/**
 * Rejects secret-like patterns, emails/account names (`@`), bearer tokens, or non-ASCII tokens.
 * Quota IDs must be 1..128 visible ASCII bytes (`0x21..0x7e`) without `@` or secret markers.
 */
const OPAQUE_ASCII_TOKEN_PATTERN = /^[\x21-\x3f\x41-\x7e]{1,128}$/;
const SECRET_MARKER_PATTERN = /(?:sk-|ghp_|xox[baprs]-|bearer|token=|password=|secret=|apikey=)/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isValidQuotaId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const byteLength = Buffer.byteLength(value, 'utf8');
  if (byteLength < 1 || byteLength > MAX_QUOTA_ID_BYTES) return false;
  if (!OPAQUE_ASCII_TOKEN_PATTERN.test(value)) return false;
  if (SECRET_MARKER_PATTERN.test(value)) return false;
  return true;
}

export function isValidObservationId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const byteLength = Buffer.byteLength(value, 'utf8');
  if (byteLength < 1 || byteLength > MAX_QUOTA_ID_BYTES * 2) return false;
  if (!/^[\x21-\x3f\x41-\x7e]+$/.test(value)) return false;
  if (SECRET_MARKER_PATTERN.test(value)) return false;
  return true;
}

export function buildUnknownObservationId(candidateOccurrenceId: string): string {
  return `${UNKNOWN_OBSERVATION_PREFIX}${candidateOccurrenceId}`;
}

export function resolveObservationIdsForContext(
  context: QuotaContext,
  candidateOccurrenceId: string
): readonly string[] {
  if (context.identity === 'unknown') {
    return Object.freeze([buildUnknownObservationId(candidateOccurrenceId)]);
  }
  return Object.freeze([...context.quotaIds]);
}

export function validateQuotaContext(raw: unknown): QuotaContextValidationOutcome {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      code: 'invalid-quota-context',
      message: 'QuotaContext must be a plain object.'
    };
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_QUOTA_CONTEXT_KEYS.has(key)) {
      return {
        ok: false,
        code: 'invalid-quota-context',
        message: `Unknown field '${key}' in QuotaContext.`
      };
    }
  }
  if (
    raw.version !== BACKEND_AVAILABILITY_VERSION ||
    raw.adapterVersion !== BACKEND_AVAILABILITY_VERSION
  ) {
    return {
      ok: false,
      code: 'unsupported-availability-version',
      message: `Unsupported QuotaContext version '${String(raw.version)}' or adapterVersion '${String(raw.adapterVersion)}'.`
    };
  }
  if (!isValidQuotaId(raw.adapterId)) {
    return {
      ok: false,
      code: 'invalid-quota-context',
      message: 'QuotaContext.adapterId must be a valid opaque ASCII token.'
    };
  }
  if (
    raw.identity !== 'qualified' &&
    raw.identity !== 'unknown'
  ) {
    return {
      ok: false,
      code: 'invalid-quota-context',
      message: `Invalid QuotaContext.identity '${String(raw.identity)}'.`
    };
  }
  if (
    raw.statusCheck !== 'supported' &&
    raw.statusCheck !== 'unsupported'
  ) {
    return {
      ok: false,
      code: 'invalid-quota-context',
      message: `Invalid QuotaContext.statusCheck '${String(raw.statusCheck)}'.`
    };
  }
  if (
    !Array.isArray(raw.quotaIds) ||
    raw.quotaIds.length < 1 ||
    raw.quotaIds.length > MAX_QUOTA_IDS_PER_CANDIDATE
  ) {
    return {
      ok: false,
      code: 'invalid-quota-id',
      message: `QuotaContext.quotaIds must contain 1..${MAX_QUOTA_IDS_PER_CANDIDATE} quota IDs.`
    };
  }
  const seen = new Set<string>();
  const quotaIds: string[] = [];
  for (const item of raw.quotaIds) {
    if (!isValidQuotaId(item) || seen.has(item)) {
      return {
        ok: false,
        code: 'invalid-quota-id',
        message: 'Each quotaId must be a unique nonsecret ASCII token <= 128 bytes.'
      };
    }
    seen.add(item);
    quotaIds.push(item);
  }

  let capacity: number | undefined;
  if (raw.capacity !== undefined) {
    if (
      typeof raw.capacity !== 'number' ||
      !Number.isSafeInteger(raw.capacity) ||
      raw.capacity < MIN_QUOTA_CAPACITY ||
      raw.capacity > MAX_QUOTA_CAPACITY
    ) {
      return {
        ok: false,
        code: 'invalid-quota-capacity',
        message: `QuotaContext.capacity must be an integer in ${MIN_QUOTA_CAPACITY}..${MAX_QUOTA_CAPACITY}.`
      };
    }
    capacity = raw.capacity;
  }

  if (raw.identity === 'unknown') {
    if (quotaIds.length !== 1 || quotaIds.at(0) !== UNKNOWN_LOCAL_QUOTA_ID) {
      return {
        ok: false,
        code: 'invalid-quota-id',
        message: `Unknown quota identity must map exclusively to '${UNKNOWN_LOCAL_QUOTA_ID}'.`
      };
    }
    if (capacity !== undefined && capacity !== 1) {
      return {
        ok: false,
        code: 'invalid-quota-capacity',
        message: 'Unknown quota identity must have capacity 1.'
      };
    }
  } else {
    if (quotaIds.includes(UNKNOWN_LOCAL_QUOTA_ID)) {
      return {
        ok: false,
        code: 'invalid-quota-id',
        message: `Qualified quota identity cannot use reserved '${UNKNOWN_LOCAL_QUOTA_ID}'.`
      };
    }
  }

  let checkCostBoundMicrousd: number | undefined;
  if (raw.checkCostBoundMicrousd !== undefined) {
    if (!isNonNegativeSafeInt(raw.checkCostBoundMicrousd)) {
      return {
        ok: false,
        code: 'invalid-quota-context',
        message: 'QuotaContext.checkCostBoundMicrousd must be a nonnegative safe integer.'
      };
    }
    checkCostBoundMicrousd = raw.checkCostBoundMicrousd;
  }

  return {
    ok: true,
    value: Object.freeze({
      version: BACKEND_AVAILABILITY_VERSION,
      adapterId: raw.adapterId,
      adapterVersion: BACKEND_AVAILABILITY_VERSION,
      quotaIds: Object.freeze(quotaIds),
      identity: raw.identity,
      statusCheck: raw.statusCheck,
      ...(capacity !== undefined ? { capacity } : {}),
      ...(checkCostBoundMicrousd !== undefined ? { checkCostBoundMicrousd } : {})
    })
  };
}

export function validateQuotaObservation(raw: unknown): QuotaObservationValidationOutcome {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      code: 'invalid-quota-observation',
      message: 'QuotaObservation must be a plain object.'
    };
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_QUOTA_OBSERVATION_KEYS.has(key)) {
      return {
        ok: false,
        code: 'invalid-quota-observation',
        message: `Unknown field '${key}' in QuotaObservation.`
      };
    }
  }
  if (!isValidObservationId(raw.observationId) || !isValidQuotaId(raw.quotaId)) {
    return {
      ok: false,
      code: 'invalid-quota-observation',
      message: 'QuotaObservation observationId and quotaId must be valid opaque ASCII tokens.'
    };
  }
  if (raw.observationId === UNKNOWN_LOCAL_QUOTA_ID) {
    return {
      ok: false,
      code: 'invalid-quota-observation',
      message: `Shared bucket '${UNKNOWN_LOCAL_QUOTA_ID}' cannot be used directly as an observationId.`
    };
  }
  if (raw.quotaId === UNKNOWN_LOCAL_QUOTA_ID) {
    if (!raw.observationId.startsWith(UNKNOWN_OBSERVATION_PREFIX)) {
      return {
        ok: false,
        code: 'invalid-quota-observation',
        message: 'Unknown quota observations must use observationId = "unknown/" + candidateOccurrenceId.'
      };
    }
    if (raw.capacity !== 1) {
      return {
        ok: false,
        code: 'invalid-quota-capacity',
        message: 'Unknown quota observations must have capacity 1.'
      };
    }
  } else if (raw.observationId !== raw.quotaId) {
    return {
      ok: false,
      code: 'invalid-quota-observation',
      message: 'Qualified quota observations must have observationId === quotaId.'
    };
  }

  if (!isNonNegativeSafeInt(raw.generation)) {
    return {
      ok: false,
      code: 'invalid-quota-observation',
      message: 'QuotaObservation.generation must be a nonnegative safe integer.'
    };
  }
  if (
    typeof raw.status !== 'string' ||
    !(QUOTA_OBSERVATION_STATUSES as readonly string[]).includes(raw.status)
  ) {
    return {
      ok: false,
      code: 'invalid-quota-observation',
      message: `Invalid QuotaObservation.status '${String(raw.status)}'.`
    };
  }
  if (
    typeof raw.source !== 'string' ||
    !(QUOTA_OBSERVATION_SOURCES as readonly string[]).includes(raw.source)
  ) {
    return {
      ok: false,
      code: 'invalid-quota-observation',
      message: `Invalid QuotaObservation.source '${String(raw.source)}'.`
    };
  }
  if (raw.status === 'ready' && raw.source === 'canonical-diagnostic') {
    return {
      ok: false,
      code: 'invalid-quota-observation',
      message: 'Canonical failure diagnostics cannot establish ready status.'
    };
  }
  if (!isNonNegativeSafeInt(raw.observedAt)) {
    return {
      ok: false,
      code: 'invalid-quota-observation',
      message: 'QuotaObservation.observedAt must be a nonnegative safe integer.'
    };
  }
  if (
    raw.observedMonotonicAt !== undefined &&
    !isNonNegativeSafeInt(raw.observedMonotonicAt)
  ) {
    return {
      ok: false,
      code: 'invalid-quota-observation',
      message: 'QuotaObservation.observedMonotonicAt must be a nonnegative safe integer.'
    };
  }
  if (typeof raw.hostEpoch !== 'string' || raw.hostEpoch.trim().length === 0) {
    return {
      ok: false,
      code: 'invalid-quota-observation',
      message: 'QuotaObservation.hostEpoch must be a non-empty string.'
    };
  }
  if (raw.resetAt !== undefined && !isNonNegativeSafeInt(raw.resetAt)) {
    return {
      ok: false,
      code: 'invalid-quota-observation',
      message: 'QuotaObservation.resetAt must be a nonnegative safe integer.'
    };
  }
  if (raw.status === 'top-up-required' && raw.resetAt !== undefined) {
    return {
      ok: false,
      code: 'invalid-quota-observation',
      message: 'top-up-required observations cannot declare an automatic resetAt.'
    };
  }
  if (raw.notBefore !== undefined && !isNonNegativeSafeInt(raw.notBefore)) {
    return {
      ok: false,
      code: 'invalid-quota-observation',
      message: 'QuotaObservation.notBefore must be a nonnegative safe integer.'
    };
  }
  if (raw.nextCheckAt !== undefined && !isNonNegativeSafeInt(raw.nextCheckAt)) {
    return {
      ok: false,
      code: 'invalid-quota-observation',
      message: 'QuotaObservation.nextCheckAt must be a nonnegative safe integer.'
    };
  }
  if (
    typeof raw.pollIndex !== 'number' ||
    !Number.isSafeInteger(raw.pollIndex) ||
    raw.pollIndex < 0 ||
    raw.pollIndex > MAX_POLL_INDEX
  ) {
    return {
      ok: false,
      code: 'invalid-quota-observation',
      message: `QuotaObservation.pollIndex must be an integer in 0..${MAX_POLL_INDEX}.`
    };
  }
  if (
    typeof raw.capacity !== 'number' ||
    !Number.isSafeInteger(raw.capacity) ||
    raw.capacity < MIN_QUOTA_CAPACITY ||
    raw.capacity > MAX_QUOTA_CAPACITY
  ) {
    return {
      ok: false,
      code: 'invalid-quota-capacity',
      message: `QuotaObservation.capacity must be an integer in ${MIN_QUOTA_CAPACITY}..${MAX_QUOTA_CAPACITY}.`
    };
  }

  return {
    ok: true,
    value: Object.freeze({
      observationId: raw.observationId,
      quotaId: raw.quotaId,
      generation: raw.generation,
      status: raw.status as QuotaObservationStatus,
      source: raw.source as QuotaObservationSource,
      observedAt: raw.observedAt,
      ...(raw.observedMonotonicAt !== undefined
        ? { observedMonotonicAt: raw.observedMonotonicAt }
        : {}),
      hostEpoch: raw.hostEpoch,
      ...(raw.resetAt !== undefined ? { resetAt: raw.resetAt } : {}),
      ...(raw.notBefore !== undefined ? { notBefore: raw.notBefore } : {}),
      ...(raw.nextCheckAt !== undefined ? { nextCheckAt: raw.nextCheckAt } : {}),
      pollIndex: raw.pollIndex,
      capacity: raw.capacity
    })
  };
}

export function validateMonitoringWindowMs(
  durationMs: unknown
):
  | { readonly ok: true; readonly durationMs: number }
  | BackendAvailabilityValidationFailure {
  if (durationMs === undefined) {
    return { ok: true, durationMs: DEFAULT_MONITORING_WINDOW_MS };
  }
  if (
    typeof durationMs !== 'number' ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < MIN_MONITORING_WINDOW_MS ||
    durationMs > MAX_MONITORING_WINDOW_MS
  ) {
    return {
      ok: false,
      code: 'invalid-monitoring-window',
      message: `Monitoring window must be an integer between ${MIN_MONITORING_WINDOW_MS} and ${MAX_MONITORING_WINDOW_MS} ms.`
    };
  }
  return { ok: true, durationMs };
}

/**
 * Deterministic jitter per D7:
 * `jitter = uint32be(SHA256(observationId + ':' + generation)[0..3]) % 5001`
 */
export function computeDeterministicCheckJitterMs(
  observationId: string,
  generation: number
): number {
  const digest = createHash('sha256')
    .update(`${observationId}:${generation}`, 'utf8')
    .digest();
  const uint32 = digest.readUInt32BE(0);
  return uint32 % (MAX_CHECK_JITTER_MS + 1);
}

/**
 * Compute next check deadline and updated pollIndex per D7:
 * - `ready`, `top-up-required`, or `check-unsupported`: no automatic poll (`nextCheckAt: undefined`), `ready` resets `pollIndex: 0`.
 * - `cooldown-known` with future `resetAt > nowMs`: `max(nowMs + 60_000, resetAt + 60_000) + jitter`.
 * - Unknown, past (`resetAt <= nowMs`), or `unreachable`: `nowMs + UNKNOWN_RESET_POLL_INTERVALS_MS[min(pollIndex, 4)] + jitter`, advancing `pollIndex` up to 4.
 * - Enforces minimum 60,000 ms after `lastCheckStartedAt` when provided.
 */
export function computeNextQuotaCheckSchedule(params: {
  readonly nowMs: number;
  readonly observationId: string;
  readonly generation: number;
  readonly status: QuotaObservationStatus;
  readonly resetAt?: number | undefined;
  readonly pollIndex: number;
  readonly advancePollIndex?: boolean | undefined;
  readonly lastCheckStartedAt?: number | undefined;
}): {
  readonly nextCheckAt?: number | undefined;
  readonly pollIndex: number;
  readonly jitterMs: number;
} {
  const clampedPollIndex = Math.max(
    0,
    Math.min(MAX_POLL_INDEX, Math.trunc(params.pollIndex))
  );
  const jitterMs = computeDeterministicCheckJitterMs(
    params.observationId,
    params.generation
  );

  if (params.status === 'ready') {
    return {
      pollIndex: 0,
      jitterMs
    };
  }

  if (
    params.status === 'top-up-required' ||
    params.status === 'check-unsupported'
  ) {
    return {
      pollIndex: clampedPollIndex,
      jitterMs
    };
  }

  const minByRateLimit =
    params.lastCheckStartedAt !== undefined
      ? params.lastCheckStartedAt + MIN_QUOTA_CHECK_INTERVAL_MS
      : params.nowMs + MIN_QUOTA_CHECK_INTERVAL_MS;

  if (
    params.status === 'cooldown-known' &&
    params.resetAt !== undefined &&
    params.resetAt > params.nowMs
  ) {
    const base = Math.max(
      params.nowMs + KNOWN_RESET_BUFFER_MS,
      params.resetAt + KNOWN_RESET_BUFFER_MS,
      minByRateLimit
    );
    return {
      nextCheckAt: base + jitterMs,
      pollIndex: clampedPollIndex,
      jitterMs
    };
  }

  const intervalMs =
    UNKNOWN_RESET_POLL_INTERVALS_MS.at(clampedPollIndex) ??
    UNKNOWN_RESET_POLL_INTERVALS_MS[MAX_POLL_INDEX];
  const base = Math.max(params.nowMs + intervalMs, minByRateLimit);
  const nextPollIndex = params.advancePollIndex
    ? Math.min(MAX_POLL_INDEX, clampedPollIndex + 1)
    : clampedPollIndex;

  return {
    nextCheckAt: base + jitterMs,
    pollIndex: nextPollIndex,
    jitterMs
  };
}

/**
 * Checks whether a `QuotaObservation` is currently fresh and ready in the given `hostEpoch`
 * and wall time (`READY_OBSERVATION_TTL_MS = 30_000`).
 */
export function isQuotaObservationFreshReady(
  observation: QuotaObservation | undefined,
  nowWallMs: number,
  currentHostEpoch: string
): boolean {
  if (observation === undefined) return false;
  if (observation.status !== 'ready') return false;
  if (observation.hostEpoch !== currentHostEpoch) return false;
  if (observation.quotaId === UNKNOWN_LOCAL_QUOTA_ID) {
    if (observation.source === 'canonical-diagnostic') return false;
    if (!observation.observationId.startsWith(UNKNOWN_OBSERVATION_PREFIX)) return false;
  }
  const ageMs = nowWallMs - observation.observedAt;
  if (ageMs < 0 || ageMs > READY_OBSERVATION_TTL_MS) return false;
  if (observation.notBefore !== undefined && nowWallMs < observation.notBefore) {
    return false;
  }
  return true;
}
