/**
 * FR-R6-F08 (FR-019, research R11, US5 scenario 3) — mapping a record captured before the
 * cutover into a handoff preparation. Pure.
 *
 * Lineage maps one to one and keeps the record's ids. Outcome and certainty pass through
 * unchanged, and a paused record sets the paused flag. The backend and runtime attribution, and
 * any provider session id, go into `legacyProvenance` only: a provider session id is never an
 * ACP session id. A recovery envelope whose version this build does not know maps to
 * `unsupported`, keeping the record's identity and nothing else.
 *
 * Continuation goes through `planSession`: `legacyPriorSession` offers the provider id as a
 * `legacy` prior session, which always plans a fresh session, unless the caller supplies an
 * explicit ACP session mapping.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import {
  ATTEMPT_OUTCOME_REASONS,
  ATTEMPT_OUTCOME_STATUSES,
  type AttemptOutcomeReason,
  type AttemptOutcomeStatus
} from '../../contracts/decision-results';
import {
  RECOVERY_EFFECT_CERTAINTY_VALUES,
  RECOVERY_ENVELOPE_VERSION,
  validateRecoveryEnvelope,
  type RecoveryEffectCertainty,
  type RecoveryEnvelope
} from '../../contracts/recovery-envelope';
import {
  HANDOFF_MANIFEST_VERSION,
  MAX_HANDOFF_LEGACY_PROVENANCE_BYTES,
  MAX_HANDOFF_REFERENCES_PER_ROLE,
  type HandoffCutoff,
  type HandoffLineage,
  type ManifestRefusalCode
} from '../../contracts/recovery-handoff/handoff-types';
import { serializeHandoffManifest, type HandoffManifest } from '../../contracts/recovery-handoff/handoff-manifest';
import { isEphemeralBridgeSessionId } from '../acp-runtime/acp-durable-runtime-store';
import { includesValue, isNonNegativeInteger, isOpaqueId } from '../artifact-lifecycle/lifecycle-results';
import type { PriorSession, SessionParty } from './session-plan';

export const LEGACY_RECORD_STATUSES = Object.freeze(['settled', 'paused', 'uncertain'] as const);
export type LegacyRecordStatus = (typeof LEGACY_RECORD_STATUSES)[number];

/** Maximum total artifact references mapped from one legacy envelope across all roles (`16-12`). */
export const MAX_LEGACY_MAPPED_REFERENCES = MAX_HANDOFF_REFERENCES_PER_ROLE;

/** A record captured before the cutover, as F13's legacy drain reads it. */
export interface LegacyHandoffRecord {
  readonly workspaceId: string;
  /** The legacy Run id; it becomes the root execution id. */
  readonly runId: string;
  readonly invocationId: string;
  /** The legacy attempt id; it becomes the source attempt id. */
  readonly attemptId: string;
  readonly status: LegacyRecordStatus;
  readonly outcome: { readonly status: AttemptOutcomeStatus; readonly reason: AttemptOutcomeReason };
  readonly certainty: RecoveryEffectCertainty;
  readonly frozenDefinitionDigest: string;
  readonly cutoff: HandoffCutoff;
  /** The historical runtime attribution, kept as provenance. */
  readonly attribution: { readonly backendId: string; readonly runtimeId: string };
  readonly providerSessionId?: string;
  /** The parsed legacy `.recovery.json`, if the record had one. */
  readonly envelope?: unknown;
}

export type LegacyMapping =
  | {
      readonly kind: 'prepare';
      readonly lineage: HandoffLineage;
      readonly cutoff: HandoffCutoff;
      readonly manifest: HandoffManifest;
      readonly legacyProvenance: string;
      readonly paused: boolean;
    }
  | { readonly kind: 'unsupported'; readonly lineage: HandoffLineage; readonly legacyProvenance: string }
  | { readonly kind: 'invalid'; readonly field: string; readonly code?: ManifestRefusalCode };

/** The caller's explicit identity mapping from a legacy record to an owned ACP session. */
export interface AcpSessionMapping {
  readonly kind: 'acp-session';
  readonly sessionId: string;
}

/** Parsed form of `recovery_handoffs.legacy_provenance` used to enforce stored session provenance. */
export type ParsedLegacyProvenance =
  | { readonly kind: 'none' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'legacy-record'; readonly providerSessionId: string | null }
  | { readonly kind: 'unsupported-envelope'; readonly version: number | null };

const ID_FIELDS = ['workspaceId', 'runId', 'invocationId', 'attemptId'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses `recovery_handoffs.legacy_provenance` fail-safely (`16-12`, FR-012).
 * Malformed JSON or unexpected shapes return `{ kind: 'malformed' }`, never throwing.
 */
export function parseLegacyProvenance(raw: string | null): ParsedLegacyProvenance {
  if (raw === null) return { kind: 'none' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'malformed' };
  }
  if (!isPlainObject(parsed)) return { kind: 'malformed' };
  if (parsed['kind'] === 'unsupported-envelope') {
    const version = parsed['version'];
    return {
      kind: 'unsupported-envelope',
      version: typeof version === 'number' && Number.isSafeInteger(version) ? version : null
    };
  }
  if (parsed['kind'] !== 'legacy-record') return { kind: 'malformed' };
  const providerSession = parsed['providerSession'];
  if (providerSession === null) {
    return { kind: 'legacy-record', providerSessionId: null };
  }
  if (
    isPlainObject(providerSession) &&
    providerSession['kind'] === 'legacy-provider-session' &&
    typeof providerSession['value'] === 'string' &&
    isOpaqueId(providerSession['value'])
  ) {
    return { kind: 'legacy-record', providerSessionId: providerSession['value'] };
  }
  return { kind: 'malformed' };
}

/**
 * Validates an explicit legacy-to-ACP session mapping (`16-12`, FR-012):
 * rejects malformed mappings, ephemeral bridge session IDs, and direct reuse of a legacy provider ID.
 */
export function isValidAcpSessionMapping(
  mapping: unknown,
  legacyProviderSessionId?: string | null
): mapping is AcpSessionMapping {
  if (!isPlainObject(mapping)) return false;
  if (mapping['kind'] !== 'acp-session') return false;
  const sessionId = mapping['sessionId'];
  if (typeof sessionId !== 'string' || !isOpaqueId(sessionId)) return false;
  if (isEphemeralBridgeSessionId(sessionId)) return false;
  if (
    legacyProviderSessionId !== undefined &&
    legacyProviderSessionId !== null &&
    sessionId === legacyProviderSessionId
  ) {
    return false;
  }
  return true;
}

function invalidRecordField(record: LegacyHandoffRecord): string | null {
  for (const field of ID_FIELDS) {
    if (!isOpaqueId(record[field])) return field;
  }
  if (!includesValue(LEGACY_RECORD_STATUSES, record.status)) return 'status';
  if (!includesValue(ATTEMPT_OUTCOME_STATUSES, record.outcome.status)) return 'outcome.status';
  if (!includesValue(ATTEMPT_OUTCOME_REASONS, record.outcome.reason)) return 'outcome.reason';
  if (!includesValue(RECOVERY_EFFECT_CERTAINTY_VALUES, record.certainty)) return 'certainty';
  if (!isOpaqueId(record.cutoff.executionRevision)) return 'cutoff.executionRevision';
  if (!isNonNegativeInteger(record.cutoff.usageRevision)) return 'cutoff.usageRevision';
  if (!isNonNegativeInteger(record.cutoff.factCutoffMs)) return 'cutoff.factCutoffMs';
  if (!isOpaqueId(record.attribution.backendId)) return 'attribution.backendId';
  if (!isOpaqueId(record.attribution.runtimeId)) return 'attribution.runtimeId';
  if (record.providerSessionId !== undefined && !isOpaqueId(record.providerSessionId)) return 'providerSessionId';
  return null;
}

function lineageOf(record: LegacyHandoffRecord): HandoffLineage {
  return {
    workspaceId: record.workspaceId,
    rootExecutionId: record.runId,
    invocationId: record.invocationId,
    sourceAttemptId: record.attemptId
  };
}

/** A version number is kept only as a safe integer; anything else is recorded as `null`. */
function unknownVersionOf(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const version: unknown = (raw as { readonly version?: unknown }).version;
  return typeof version === 'number' && Number.isSafeInteger(version) ? version : null;
}

type EnvelopeReading =
  | { readonly kind: 'none' }
  | { readonly kind: 'valid'; readonly envelope: RecoveryEnvelope }
  | { readonly kind: 'unsupported'; readonly version: number | null }
  | { readonly kind: 'invalid' };

function readEnvelope(raw: unknown): EnvelopeReading {
  if (raw === undefined) return { kind: 'none' };
  const validated = validateRecoveryEnvelope(raw);
  if (validated.ok) return { kind: 'valid', envelope: validated.value };
  if (unknownVersionOf(raw) !== RECOVERY_ENVELOPE_VERSION) return { kind: 'unsupported', version: unknownVersionOf(raw) };
  return { kind: 'invalid' };
}

function manifestOf(record: LegacyHandoffRecord, envelope: RecoveryEnvelope | null): HandoffManifest {
  const workspace = envelope?.workspace;
  return {
    version: HANDOFF_MANIFEST_VERSION,
    sourceOutcome: { status: record.outcome.status, reason: record.outcome.reason },
    frozenDefinitionDigest: record.frozenDefinitionDigest,
    certainty: record.certainty,
    coverage: workspace?.coverage ?? 'unavailable',
    workspace: {
      entries: (workspace?.entries ?? []).map((entry) => ({ path: entry.path, attribution: entry.attribution })),
      omittedCount: workspace?.omittedCount ?? 0
    },
    references: [
      ...(envelope?.upstreamArtifactRefs ?? []).map((artifactId) => ({
        artifactId,
        role: 'validated' as const,
        required: false
      })),
      ...(envelope?.partialArtifactRefs ?? []).map((artifactId) => ({ artifactId, role: 'partial' as const, required: false })),
      ...(envelope?.effects.evidenceRefs ?? []).map((artifactId) => ({
        artifactId,
        role: 'evidence' as const,
        required: false
      }))
    ],
    excluded: [],
    contextId: null,
    envelope: null
  };
}

function provenanceOf(record: LegacyHandoffRecord): string {
  return JSON.stringify({
    kind: 'legacy-record',
    status: record.status,
    attribution: { backendId: record.attribution.backendId, runtimeId: record.attribution.runtimeId },
    providerSession:
      record.providerSessionId === undefined ? null : { kind: 'legacy-provider-session', value: record.providerSessionId }
  });
}

/** Maps a pre-cutover record into a validated handoff preparation (R11, `16-12`). */
export function mapLegacyRecord(record: LegacyHandoffRecord): LegacyMapping {
  const field = invalidRecordField(record);
  if (field !== null) return { kind: 'invalid', field };
  const lineage = lineageOf(record);
  const reading = readEnvelope(record.envelope);
  if (reading.kind === 'invalid') return { kind: 'invalid', field: 'envelope' };
  if (reading.kind === 'unsupported') {
    return {
      kind: 'unsupported',
      lineage,
      legacyProvenance: JSON.stringify({ kind: 'unsupported-envelope', version: reading.version })
    };
  }
  const legacyProvenance = provenanceOf(record);
  if (Buffer.byteLength(legacyProvenance, 'utf8') > MAX_HANDOFF_LEGACY_PROVENANCE_BYTES) {
    return { kind: 'invalid', code: 'over-limit', field: 'legacyProvenance' };
  }
  const candidateManifest = manifestOf(record, reading.kind === 'valid' ? reading.envelope : null);
  if (candidateManifest.references.length > MAX_LEGACY_MAPPED_REFERENCES) {
    return { kind: 'invalid', code: 'over-limit', field: 'references' };
  }
  const serialized = serializeHandoffManifest(candidateManifest);
  if (!serialized.ok) {
    return { kind: 'invalid', code: serialized.code, field: serialized.field };
  }
  return {
    kind: 'prepare',
    lineage,
    cutoff: record.cutoff,
    manifest: serialized.manifest,
    legacyProvenance,
    paused: record.status === 'paused'
  };
}

/**
 * The prior session `planSession` compares for a legacy record. A provider session id is offered
 * only as a `legacy` prior session, which never loads; a validated non-ephemeral explicit ACP
 * mapping distinct from the provider session id is offered as an `acp` prior session owned by
 * `party`. With neither there is no prior session.
 */
export function legacyPriorSession(
  record: LegacyHandoffRecord,
  party: SessionParty,
  mapping?: AcpSessionMapping
): PriorSession | null {
  if (mapping !== undefined) {
    const mappedSessionId = mapping.sessionId;
    if (isValidAcpSessionMapping(mapping, record.providerSessionId)) {
      return { ...party, sessionId: mappedSessionId, source: 'acp' };
    }
    if (record.providerSessionId !== undefined) {
      return { ...party, sessionId: record.providerSessionId, source: 'legacy' };
    }
    return isOpaqueId(mappedSessionId) ? { ...party, sessionId: mappedSessionId, source: 'legacy' } : null;
  }
  if (record.providerSessionId === undefined) return null;
  return { ...party, sessionId: record.providerSessionId, source: 'legacy' };
}
