import {
  ATTEMPT_OUTCOME_REASONS,
  ATTEMPT_OUTCOME_STATUSES,
  type AttemptOutcomeReason,
  type AttemptOutcomeStatus
} from './decision-results';

export const RECOVERY_ENVELOPE_VERSION = 1 as const;
export const MAX_RECOVERY_ENVELOPE_BYTES = 16_384 as const;
export const MAX_RECOVERY_WORKSPACE_ENTRIES = 100 as const;
export const MAX_RECOVERY_REF_BYTES = 128 as const;
export const MAX_RECOVERY_REFS_PER_ARRAY = 32 as const;
export const MAX_RECOVERY_PATH_BYTES = 512 as const;
export const MAX_CAPTURE_CANDIDATE_PATHS = 1_000 as const;
export const MAX_CAPTURE_FILE_BYTES = 1_048_576 as const;
export const MAX_CAPTURE_TOTAL_BYTES = 8_388_608 as const;
export const MAX_CAPTURE_DURATION_MS = 2_000 as const;

export const RECOVERY_WORKSPACE_COVERAGE_VALUES = [
  'complete',
  'partial',
  'unavailable'
] as const;

export type RecoveryWorkspaceCoverage = (typeof RECOVERY_WORKSPACE_COVERAGE_VALUES)[number];

export const RECOVERY_WORKSPACE_ATTRIBUTION_VALUES = [
  'attempt',
  'preexisting',
  'concurrent',
  'unknown'
] as const;

export type RecoveryWorkspaceAttribution = (typeof RECOVERY_WORKSPACE_ATTRIBUTION_VALUES)[number];

export const RECOVERY_EFFECT_CERTAINTY_VALUES = [
  'safe',
  'uncertain',
  'unknown'
] as const;

export type RecoveryEffectCertainty = (typeof RECOVERY_EFFECT_CERTAINTY_VALUES)[number];

export interface RecoveryPreviousOutcome {
  readonly status: AttemptOutcomeStatus;
  readonly reason: AttemptOutcomeReason;
}

export interface RecoveryWorkspaceEntry {
  readonly path: string;
  readonly existedBefore: boolean;
  readonly dirtyBefore: boolean;
  readonly beforeSha256?: string | undefined;
  readonly afterSha256?: string | undefined;
  readonly attribution: RecoveryWorkspaceAttribution;
}

export interface RecoveryWorkspaceSnapshot {
  readonly repositoryId?: string | undefined;
  readonly head?: string | undefined;
  readonly coverage: RecoveryWorkspaceCoverage;
  readonly omittedCount: number;
  readonly entries: readonly RecoveryWorkspaceEntry[];
}

export interface RecoveryEffectsSnapshot {
  readonly certainty: RecoveryEffectCertainty;
  readonly evidenceRefs: readonly string[];
}

export interface RecoveryEnvelope {
  readonly version: typeof RECOVERY_ENVELOPE_VERSION;
  readonly invocationId: string;
  readonly previousAttemptId?: string | undefined;
  readonly previousOutcome?: RecoveryPreviousOutcome | undefined;
  readonly upstreamArtifactRefs: readonly string[];
  readonly partialArtifactRefs: readonly string[];
  readonly workspace: RecoveryWorkspaceSnapshot;
  readonly effects: RecoveryEffectsSnapshot;
  readonly truncated: boolean;
}

export type RecoveryEnvelopeValidationCode =
  | 'unsupported-recovery-envelope-version'
  | 'unknown-recovery-envelope-field'
  | 'invalid-recovery-envelope-field'
  | 'invalid-recovery-path'
  | 'invalid-recovery-ref'
  | 'recovery-context-too-large';

export interface RecoveryEnvelopeValidationDiagnostic {
  readonly code: RecoveryEnvelopeValidationCode;
  readonly field: string;
  readonly message: string;
}

export type RecoveryEnvelopeValidationResult =
  | {
      readonly ok: true;
      readonly value: RecoveryEnvelope;
      readonly diagnostics: readonly [];
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly RecoveryEnvelopeValidationDiagnostic[];
    };

export type RecoveryEnvelopeSerializeResult =
  | {
      readonly ok: true;
      readonly handover: RecoveryEnvelope;
      readonly serialized: string;
      readonly byteLength: number;
    }
  | {
      readonly ok: false;
      readonly code: 'recovery-context-too-large' | 'invalid-recovery-envelope';
      readonly message: string;
      readonly diagnostics: readonly RecoveryEnvelopeValidationDiagnostic[];
    };

const TOP_LEVEL_KEYS = new Set([
  'version',
  'invocationId',
  'previousAttemptId',
  'previousOutcome',
  'upstreamArtifactRefs',
  'partialArtifactRefs',
  'workspace',
  'effects',
  'truncated'
]);

const PREVIOUS_OUTCOME_KEYS = new Set(['status', 'reason']);
const WORKSPACE_KEYS = new Set(['repositoryId', 'head', 'coverage', 'omittedCount', 'entries']);
const WORKSPACE_ENTRY_KEYS = new Set([
  'path',
  'existedBefore',
  'dirtyBefore',
  'beforeSha256',
  'afterSha256',
  'attribution'
]);
const EFFECTS_KEYS = new Set(['certainty', 'evidenceRefs']);

const COVERAGE_SET = new Set<string>(RECOVERY_WORKSPACE_COVERAGE_VALUES);
const ATTRIBUTION_SET = new Set<string>(RECOVERY_WORKSPACE_ATTRIBUTION_VALUES);
const CERTAINTY_SET = new Set<string>(RECOVERY_EFFECT_CERTAINTY_VALUES);
const OUTCOME_STATUS_SET = new Set<string>(ATTEMPT_OUTCOME_STATUSES);
const OUTCOME_REASON_SET = new Set<string>(ATTEMPT_OUTCOME_REASONS);

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const GIT_HEAD_PATTERN = /^[0-9a-f]{7,64}$/i;
const WINDOWS_DRIVE_PREFIX = /^[a-zA-Z]:[\\/]/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function isValidContainedWorkspacePath(candidatePath: string): boolean {
  if (candidatePath.length === 0) {
    return false;
  }
  if (utf8ByteLength(candidatePath) > MAX_RECOVERY_PATH_BYTES) {
    return false;
  }
  if (candidatePath.includes('\0') || candidatePath.includes('\\')) {
    return false;
  }
  if (candidatePath.startsWith('/') || WINDOWS_DRIVE_PREFIX.test(candidatePath)) {
    return false;
  }
  const segments = candidatePath.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      return false;
    }
  }
  return true;
}

export function isValidOpaqueRef(ref: string): boolean {
  if (ref.trim().length === 0 || ref !== ref.trim()) {
    return false;
  }
  if (utf8ByteLength(ref) > MAX_RECOVERY_REF_BYTES) {
    return false;
  }
  if (ref.includes('\0') || ref.includes('\n') || ref.includes('\r')) {
    return false;
  }
  return true;
}

export function isValidRepositoryId(repositoryId: string): boolean {
  if (!isValidOpaqueRef(repositoryId)) {
    return false;
  }
  // Never allow absolute root paths as repositoryId
  if (repositoryId.startsWith('/') || repositoryId.includes('\\') || WINDOWS_DRIVE_PREFIX.test(repositoryId)) {
    return false;
  }
  return true;
}

function validateRefArray(
  raw: unknown,
  field: string,
  diagnostics: RecoveryEnvelopeValidationDiagnostic[]
): string[] {
  if (!Array.isArray(raw)) {
    diagnostics.push({
      code: 'invalid-recovery-envelope-field',
      field,
      message: `${field} must be an array of opaque references.`
    });
    return [];
  }
  if (raw.length > MAX_RECOVERY_REFS_PER_ARRAY) {
    diagnostics.push({
      code: 'invalid-recovery-ref',
      field,
      message: `${field} exceeds maximum length of ${MAX_RECOVERY_REFS_PER_ARRAY}.`
    });
  }
  const valid: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item: unknown = raw.at(index);
    if (typeof item !== 'string' || !isValidOpaqueRef(item)) {
      diagnostics.push({
        code: 'invalid-recovery-ref',
        field: `${field}[${index}]`,
        message: `${field}[${index}] must be a non-empty opaque string <= ${MAX_RECOVERY_REF_BYTES} UTF-8 bytes.`
      });
      continue;
    }
    valid.push(item);
  }
  return valid;
}

function validateWorkspaceEntries(
  raw: unknown,
  diagnostics: RecoveryEnvelopeValidationDiagnostic[]
): RecoveryWorkspaceEntry[] {
  if (!Array.isArray(raw)) {
    diagnostics.push({
      code: 'invalid-recovery-envelope-field',
      field: 'workspace.entries',
      message: 'workspace.entries must be an array.'
    });
    return [];
  }
  if (raw.length > MAX_RECOVERY_WORKSPACE_ENTRIES) {
    diagnostics.push({
      code: 'invalid-recovery-envelope-field',
      field: 'workspace.entries',
      message: `workspace.entries exceeds maximum of ${MAX_RECOVERY_WORKSPACE_ENTRIES} entries.`
    });
  }
  const entries: RecoveryWorkspaceEntry[] = [];
  let previousPath: string | undefined;
  for (let index = 0; index < raw.length; index += 1) {
    const item: unknown = raw.at(index);
    const entryField = `workspace.entries[${index}]`;
    if (!isPlainRecord(item)) {
      diagnostics.push({
        code: 'invalid-recovery-envelope-field',
        field: entryField,
        message: `${entryField} must be a plain object.`
      });
      continue;
    }
    for (const key of Object.keys(item)) {
      if (!WORKSPACE_ENTRY_KEYS.has(key)) {
        diagnostics.push({
          code: 'unknown-recovery-envelope-field',
          field: `${entryField}.${key}`,
          message: `Unknown field "${key}" in ${entryField}.`
        });
      }
    }
    const rawPath = item.path;
    if (typeof rawPath !== 'string' || !isValidContainedWorkspacePath(rawPath)) {
      diagnostics.push({
        code: 'invalid-recovery-path',
        field: `${entryField}.path`,
        message: `${entryField}.path must be a contained workspace-relative path <= ${MAX_RECOVERY_PATH_BYTES} UTF-8 bytes.`
      });
    } else if (previousPath !== undefined && Buffer.compare(Buffer.from(previousPath, 'utf8'), Buffer.from(rawPath, 'utf8')) >= 0) {
      diagnostics.push({
        code: 'invalid-recovery-path',
        field: `${entryField}.path`,
        message: `${entryField}.path must be strictly sorted in ascending UTF-8 byte order.`
      });
    } else if (typeof rawPath === 'string') {
      previousPath = rawPath;
    }

    const existedBefore = item.existedBefore;
    if (typeof existedBefore !== 'boolean') {
      diagnostics.push({
        code: 'invalid-recovery-envelope-field',
        field: `${entryField}.existedBefore`,
        message: `${entryField}.existedBefore must be a boolean.`
      });
    }
    const dirtyBefore = item.dirtyBefore;
    if (typeof dirtyBefore !== 'boolean') {
      diagnostics.push({
        code: 'invalid-recovery-envelope-field',
        field: `${entryField}.dirtyBefore`,
        message: `${entryField}.dirtyBefore must be a boolean.`
      });
    }
    const beforeSha256 = item.beforeSha256;
    if (beforeSha256 !== undefined && (typeof beforeSha256 !== 'string' || !SHA256_HEX_PATTERN.test(beforeSha256))) {
      diagnostics.push({
        code: 'invalid-recovery-envelope-field',
        field: `${entryField}.beforeSha256`,
        message: `${entryField}.beforeSha256 must be a 64-character lowercase hex SHA-256 string when present.`
      });
    }
    const afterSha256 = item.afterSha256;
    if (afterSha256 !== undefined && (typeof afterSha256 !== 'string' || !SHA256_HEX_PATTERN.test(afterSha256))) {
      diagnostics.push({
        code: 'invalid-recovery-envelope-field',
        field: `${entryField}.afterSha256`,
        message: `${entryField}.afterSha256 must be a 64-character lowercase hex SHA-256 string when present.`
      });
    }
    const attribution = item.attribution;
    if (typeof attribution !== 'string' || !ATTRIBUTION_SET.has(attribution)) {
      diagnostics.push({
        code: 'invalid-recovery-envelope-field',
        field: `${entryField}.attribution`,
        message: `${entryField}.attribution must be one of ${RECOVERY_WORKSPACE_ATTRIBUTION_VALUES.join(', ')}.`
      });
    }

    if (
      typeof rawPath === 'string' &&
      typeof existedBefore === 'boolean' &&
      typeof dirtyBefore === 'boolean' &&
      typeof attribution === 'string' &&
      ATTRIBUTION_SET.has(attribution)
    ) {
      entries.push({
        path: rawPath,
        existedBefore,
        dirtyBefore,
        ...(typeof beforeSha256 === 'string' ? { beforeSha256 } : {}),
        ...(typeof afterSha256 === 'string' ? { afterSha256 } : {}),
        attribution: attribution as RecoveryWorkspaceAttribution
      });
    }
  }
  return entries;
}

export function validateRecoveryEnvelope(raw: unknown): RecoveryEnvelopeValidationResult {
  const diagnostics: RecoveryEnvelopeValidationDiagnostic[] = [];
  if (!isPlainRecord(raw)) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'invalid-recovery-envelope-field',
          field: 'recoveryEnvelope',
          message: 'RecoveryEnvelope must be a plain object.'
        }
      ]
    };
  }

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      diagnostics.push({
        code: 'unknown-recovery-envelope-field',
        field: key,
        message: `Unknown top-level field "${key}" in RecoveryEnvelope.`
      });
    }
  }

  if (raw.version !== RECOVERY_ENVELOPE_VERSION) {
    diagnostics.push({
      code: 'unsupported-recovery-envelope-version',
      field: 'version',
      message: `Unsupported RecoveryEnvelope version "${String(raw.version)}"; expected ${RECOVERY_ENVELOPE_VERSION}.`
    });
  }

  const invocationId = raw.invocationId;
  if (typeof invocationId !== 'string' || !isValidOpaqueRef(invocationId)) {
    diagnostics.push({
      code: 'invalid-recovery-envelope-field',
      field: 'invocationId',
      message: `invocationId must be a non-empty string <= ${MAX_RECOVERY_REF_BYTES} UTF-8 bytes.`
    });
  }

  const previousAttemptId = raw.previousAttemptId;
  if (previousAttemptId !== undefined && (typeof previousAttemptId !== 'string' || !isValidOpaqueRef(previousAttemptId))) {
    diagnostics.push({
      code: 'invalid-recovery-envelope-field',
      field: 'previousAttemptId',
      message: `previousAttemptId must be a non-empty string <= ${MAX_RECOVERY_REF_BYTES} UTF-8 bytes when present.`
    });
  }

  let validatedPreviousOutcome: RecoveryPreviousOutcome | undefined;
  if (raw.previousOutcome !== undefined) {
    if (!isPlainRecord(raw.previousOutcome)) {
      diagnostics.push({
        code: 'invalid-recovery-envelope-field',
        field: 'previousOutcome',
        message: 'previousOutcome must be a plain object when present.'
      });
    } else {
      for (const key of Object.keys(raw.previousOutcome)) {
        if (!PREVIOUS_OUTCOME_KEYS.has(key)) {
          diagnostics.push({
            code: 'unknown-recovery-envelope-field',
            field: `previousOutcome.${key}`,
            message: `Unknown field "${key}" in previousOutcome.`
          });
        }
      }
      const status = raw.previousOutcome.status;
      const reason = raw.previousOutcome.reason;
      if (typeof status !== 'string' || !OUTCOME_STATUS_SET.has(status)) {
        diagnostics.push({
          code: 'invalid-recovery-envelope-field',
          field: 'previousOutcome.status',
          message: 'previousOutcome.status must be a valid AttemptOutcome status.'
        });
      }
      if (typeof reason !== 'string' || !OUTCOME_REASON_SET.has(reason)) {
        diagnostics.push({
          code: 'invalid-recovery-envelope-field',
          field: 'previousOutcome.reason',
          message: 'previousOutcome.reason must be a valid AttemptOutcome reason.'
        });
      }
      if (
        typeof status === 'string' &&
        OUTCOME_STATUS_SET.has(status) &&
        typeof reason === 'string' &&
        OUTCOME_REASON_SET.has(reason)
      ) {
        validatedPreviousOutcome = {
          status: status as AttemptOutcomeStatus,
          reason: reason as AttemptOutcomeReason
        };
      }
    }
  }

  const upstreamArtifactRefs = validateRefArray(raw.upstreamArtifactRefs, 'upstreamArtifactRefs', diagnostics);
  const partialArtifactRefs = validateRefArray(raw.partialArtifactRefs, 'partialArtifactRefs', diagnostics);

  let validatedWorkspace: RecoveryWorkspaceSnapshot | undefined;
  if (!isPlainRecord(raw.workspace)) {
    diagnostics.push({
      code: 'invalid-recovery-envelope-field',
      field: 'workspace',
      message: 'workspace must be a plain object.'
    });
  } else {
    for (const key of Object.keys(raw.workspace)) {
      if (!WORKSPACE_KEYS.has(key)) {
        diagnostics.push({
          code: 'unknown-recovery-envelope-field',
          field: `workspace.${key}`,
          message: `Unknown field "${key}" in workspace.`
        });
      }
    }
    const repositoryId = raw.workspace.repositoryId;
    if (repositoryId !== undefined && (typeof repositoryId !== 'string' || !isValidRepositoryId(repositoryId))) {
      diagnostics.push({
        code: 'invalid-recovery-envelope-field',
        field: 'workspace.repositoryId',
        message: 'workspace.repositoryId must be an opaque host identifier (not an absolute path).'
      });
    }
    const head = raw.workspace.head;
    if (head !== undefined && (typeof head !== 'string' || !GIT_HEAD_PATTERN.test(head))) {
      diagnostics.push({
        code: 'invalid-recovery-envelope-field',
        field: 'workspace.head',
        message: 'workspace.head must be a valid hex commit hash when present.'
      });
    }
    const coverage = raw.workspace.coverage;
    if (typeof coverage !== 'string' || !COVERAGE_SET.has(coverage)) {
      diagnostics.push({
        code: 'invalid-recovery-envelope-field',
        field: 'workspace.coverage',
        message: `workspace.coverage must be one of ${RECOVERY_WORKSPACE_COVERAGE_VALUES.join(', ')}.`
      });
    }
    const omittedCount = raw.workspace.omittedCount;
    if (typeof omittedCount !== 'number' || !Number.isSafeInteger(omittedCount) || omittedCount < 0) {
      diagnostics.push({
        code: 'invalid-recovery-envelope-field',
        field: 'workspace.omittedCount',
        message: 'workspace.omittedCount must be a non-negative safe integer.'
      });
    }
    const entries = validateWorkspaceEntries(raw.workspace.entries, diagnostics);
    if (
      typeof coverage === 'string' &&
      COVERAGE_SET.has(coverage) &&
      typeof omittedCount === 'number' &&
      Number.isSafeInteger(omittedCount) &&
      omittedCount >= 0
    ) {
      validatedWorkspace = {
        ...(typeof repositoryId === 'string' ? { repositoryId } : {}),
        ...(typeof head === 'string' ? { head } : {}),
        coverage: coverage as RecoveryWorkspaceCoverage,
        omittedCount,
        entries
      };
    }
  }

  let validatedEffects: RecoveryEffectsSnapshot | undefined;
  if (!isPlainRecord(raw.effects)) {
    diagnostics.push({
      code: 'invalid-recovery-envelope-field',
      field: 'effects',
      message: 'effects must be a plain object.'
    });
  } else {
    for (const key of Object.keys(raw.effects)) {
      if (!EFFECTS_KEYS.has(key)) {
        diagnostics.push({
          code: 'unknown-recovery-envelope-field',
          field: `effects.${key}`,
          message: `Unknown field "${key}" in effects.`
        });
      }
    }
    const certainty = raw.effects.certainty;
    if (typeof certainty !== 'string' || !CERTAINTY_SET.has(certainty)) {
      diagnostics.push({
        code: 'invalid-recovery-envelope-field',
        field: 'effects.certainty',
        message: `effects.certainty must be one of ${RECOVERY_EFFECT_CERTAINTY_VALUES.join(', ')}.`
      });
    }
    const evidenceRefs = validateRefArray(raw.effects.evidenceRefs, 'effects.evidenceRefs', diagnostics);
    if (typeof certainty === 'string' && CERTAINTY_SET.has(certainty)) {
      validatedEffects = {
        certainty: certainty as RecoveryEffectCertainty,
        evidenceRefs
      };
    }
  }

  const truncated = raw.truncated;
  if (typeof truncated !== 'boolean') {
    diagnostics.push({
      code: 'invalid-recovery-envelope-field',
      field: 'truncated',
      message: 'truncated must be a boolean.'
    });
  }

  if (
    typeof invocationId === 'string' &&
    validatedWorkspace !== undefined &&
    validatedEffects !== undefined &&
    typeof truncated === 'boolean'
  ) {
    const validHandover: RecoveryEnvelope = {
      version: RECOVERY_ENVELOPE_VERSION,
      invocationId,
      ...(typeof previousAttemptId === 'string' ? { previousAttemptId } : {}),
      ...(validatedPreviousOutcome !== undefined ? { previousOutcome: validatedPreviousOutcome } : {}),
      upstreamArtifactRefs,
      partialArtifactRefs,
      workspace: validatedWorkspace,
      effects: validatedEffects,
      truncated
    };
    const serialized = canonicalStringifyRecoveryEnvelope(validHandover);
    if (utf8ByteLength(serialized) > MAX_RECOVERY_ENVELOPE_BYTES) {
      diagnostics.push({
        code: 'recovery-context-too-large',
        field: 'recoveryEnvelope',
        message: `Serialized RecoveryEnvelope (${utf8ByteLength(serialized)} bytes) exceeds ${MAX_RECOVERY_ENVELOPE_BYTES} UTF-8 bytes.`
      });
    }
    if (diagnostics.length === 0) {
      return {
        ok: true,
        value: validHandover,
        diagnostics: []
      };
    }
  }

  return {
    ok: false,
    diagnostics
  };
}

function canonicalStringifyRecoveryEnvelope(handover: RecoveryEnvelope): string {
  const ordered: Record<string, unknown> = {
    version: handover.version,
    invocationId: handover.invocationId,
    ...(handover.previousAttemptId !== undefined ? { previousAttemptId: handover.previousAttemptId } : {}),
    ...(handover.previousOutcome !== undefined
      ? {
          previousOutcome: {
            status: handover.previousOutcome.status,
            reason: handover.previousOutcome.reason
          }
        }
      : {}),
    upstreamArtifactRefs: [...handover.upstreamArtifactRefs],
    partialArtifactRefs: [...handover.partialArtifactRefs],
    workspace: {
      ...(handover.workspace.repositoryId !== undefined ? { repositoryId: handover.workspace.repositoryId } : {}),
      ...(handover.workspace.head !== undefined ? { head: handover.workspace.head } : {}),
      coverage: handover.workspace.coverage,
      omittedCount: handover.workspace.omittedCount,
      entries: handover.workspace.entries.map((entry) => ({
        path: entry.path,
        existedBefore: entry.existedBefore,
        dirtyBefore: entry.dirtyBefore,
        ...(entry.beforeSha256 !== undefined ? { beforeSha256: entry.beforeSha256 } : {}),
        ...(entry.afterSha256 !== undefined ? { afterSha256: entry.afterSha256 } : {}),
        attribution: entry.attribution
      }))
    },
    effects: {
      certainty: handover.effects.certainty,
      evidenceRefs: [...handover.effects.evidenceRefs]
    },
    truncated: handover.truncated
  };
  return JSON.stringify(ordered);
}

/**
 * Deterministically bounds and serializes a `RecoveryEnvelope` within `16,384` UTF-8 bytes (`D5`).
 *
 * Preserves required identity, outcome, effect certainty, and coverage metadata first, then
 * sorted workspace manifest entries and opaque references while the serialized UTF-8 byte
 * length fits within `16,384` bytes. Drops trailing entries/references deterministically,
 * updating `omittedCount`, `truncated: true`, and `workspace.coverage: 'partial'`.
 * If fixed metadata alone cannot fit within `16,384` bytes, fails closed with
 * `recovery-context-too-large`.
 */
export function serializeRecoveryEnvelope(candidateInput: RecoveryEnvelope): RecoveryEnvelopeSerializeResult {
  const sortedEntries = [...candidateInput.workspace.entries].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8'))
  );

  let droppedEntries = 0;
  let boundedEntries = sortedEntries;
  if (boundedEntries.length > MAX_RECOVERY_WORKSPACE_ENTRIES) {
    droppedEntries += boundedEntries.length - MAX_RECOVERY_WORKSPACE_ENTRIES;
    boundedEntries = boundedEntries.slice(0, MAX_RECOVERY_WORKSPACE_ENTRIES);
  }

  let truncated = candidateInput.truncated || droppedEntries > 0;
  let upstreamRefs = candidateInput.upstreamArtifactRefs.slice(0, MAX_RECOVERY_REFS_PER_ARRAY);
  let partialRefs = candidateInput.partialArtifactRefs.slice(0, MAX_RECOVERY_REFS_PER_ARRAY);
  let evidenceRefs = candidateInput.effects.evidenceRefs.slice(0, MAX_RECOVERY_REFS_PER_ARRAY);

  if (
    upstreamRefs.length < candidateInput.upstreamArtifactRefs.length ||
    partialRefs.length < candidateInput.partialArtifactRefs.length ||
    evidenceRefs.length < candidateInput.effects.evidenceRefs.length
  ) {
    truncated = true;
  }

  const buildCandidate = (
    entriesSlice: readonly RecoveryWorkspaceEntry[],
    extraDroppedEntries: number,
    upstreamSlice: readonly string[],
    partialSlice: readonly string[],
    evidenceSlice: readonly string[],
    isTruncated: boolean
  ): RecoveryEnvelope => {
    const totalOmitted = candidateInput.workspace.omittedCount + droppedEntries + extraDroppedEntries;
    const coverage: RecoveryWorkspaceCoverage =
      candidateInput.workspace.coverage === 'unavailable'
        ? 'unavailable'
        : isTruncated || totalOmitted > 0 || candidateInput.workspace.coverage === 'partial'
          ? 'partial'
          : 'complete';

    return {
      version: RECOVERY_ENVELOPE_VERSION,
      invocationId: candidateInput.invocationId,
      ...(candidateInput.previousAttemptId !== undefined
        ? { previousAttemptId: candidateInput.previousAttemptId }
        : {}),
      ...(candidateInput.previousOutcome !== undefined
        ? { previousOutcome: candidateInput.previousOutcome }
        : {}),
      upstreamArtifactRefs: upstreamSlice,
      partialArtifactRefs: partialSlice,
      workspace: {
        ...(candidateInput.workspace.repositoryId !== undefined
          ? { repositoryId: candidateInput.workspace.repositoryId }
          : {}),
        ...(candidateInput.workspace.head !== undefined
          ? { head: candidateInput.workspace.head }
          : {}),
        coverage,
        omittedCount: totalOmitted,
        entries: entriesSlice
      },
      effects: {
        certainty: candidateInput.effects.certainty,
        evidenceRefs: evidenceSlice
      },
      truncated: isTruncated
    };
  };

  let currentHandover = buildCandidate(
    boundedEntries,
    0,
    upstreamRefs,
    partialRefs,
    evidenceRefs,
    truncated
  );
  let serialized = canonicalStringifyRecoveryEnvelope(currentHandover);
  let byteLength = utf8ByteLength(serialized);

  // Drop trailing workspace entries first until <= 16 KiB
  let extraDropped = 0;
  while (byteLength > MAX_RECOVERY_ENVELOPE_BYTES && boundedEntries.length > 0) {
    boundedEntries = boundedEntries.slice(0, boundedEntries.length - 1);
    extraDropped += 1;
    truncated = true;
    currentHandover = buildCandidate(
      boundedEntries,
      extraDropped,
      upstreamRefs,
      partialRefs,
      evidenceRefs,
      truncated
    );
    serialized = canonicalStringifyRecoveryEnvelope(currentHandover);
    byteLength = utf8ByteLength(serialized);
  }

  // Drop trailing partialArtifactRefs, then upstreamArtifactRefs, then evidenceRefs if still > 16 KiB
  while (byteLength > MAX_RECOVERY_ENVELOPE_BYTES && partialRefs.length > 0) {
    partialRefs = partialRefs.slice(0, partialRefs.length - 1);
    truncated = true;
    currentHandover = buildCandidate(
      boundedEntries,
      extraDropped,
      upstreamRefs,
      partialRefs,
      evidenceRefs,
      truncated
    );
    serialized = canonicalStringifyRecoveryEnvelope(currentHandover);
    byteLength = utf8ByteLength(serialized);
  }

  while (byteLength > MAX_RECOVERY_ENVELOPE_BYTES && upstreamRefs.length > 0) {
    upstreamRefs = upstreamRefs.slice(0, upstreamRefs.length - 1);
    truncated = true;
    currentHandover = buildCandidate(
      boundedEntries,
      extraDropped,
      upstreamRefs,
      partialRefs,
      evidenceRefs,
      truncated
    );
    serialized = canonicalStringifyRecoveryEnvelope(currentHandover);
    byteLength = utf8ByteLength(serialized);
  }

  while (byteLength > MAX_RECOVERY_ENVELOPE_BYTES && evidenceRefs.length > 0) {
    evidenceRefs = evidenceRefs.slice(0, evidenceRefs.length - 1);
    truncated = true;
    currentHandover = buildCandidate(
      boundedEntries,
      extraDropped,
      upstreamRefs,
      partialRefs,
      evidenceRefs,
      truncated
    );
    serialized = canonicalStringifyRecoveryEnvelope(currentHandover);
    byteLength = utf8ByteLength(serialized);
  }

  if (byteLength > MAX_RECOVERY_ENVELOPE_BYTES) {
    return {
      ok: false,
      code: 'recovery-context-too-large',
      message: `Fixed RecoveryEnvelope metadata (${byteLength} bytes) exceeds ${MAX_RECOVERY_ENVELOPE_BYTES} UTF-8 bytes.`,
      diagnostics: [
        {
          code: 'recovery-context-too-large',
          field: 'recoveryEnvelope',
          message: `Fixed RecoveryEnvelope metadata (${byteLength} bytes) exceeds ${MAX_RECOVERY_ENVELOPE_BYTES} UTF-8 bytes.`
        }
      ]
    };
  }

  const validation = validateRecoveryEnvelope(currentHandover);
  if (!validation.ok) {
    const tooLarge = validation.diagnostics.some((diag) => diag.code === 'recovery-context-too-large');
    return {
      ok: false,
      code: tooLarge ? 'recovery-context-too-large' : 'invalid-recovery-envelope',
      message: validation.diagnostics.map((diag) => diag.message).join('; '),
      diagnostics: validation.diagnostics
    };
  }

  return {
    ok: true,
    handover: validation.value,
    serialized,
    byteLength
  };
}
