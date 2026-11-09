/**
 * FR-R6-F02 — Shared memory and storage contracts: Error taxonomy, identifier
 * validation, C1 field dictionary, and C2 single-authority inventory
 * (FR-001..FR-003, FR-012, FR-015, SC-001, SC-008).
 *
 * Zero `vscode` imports (SC-009, docs/hard-rules.md rule 13).
 */

import { createHash } from 'node:crypto';
import { SanitizedLogger } from '../../lib/logger';

export const SHARED_STORAGE_CONTRACT_VERSION = 1 as const;
export const MAX_SHARED_IDENTIFIER_UTF8_BYTES = 256 as const;
export const MAX_FREE_TEXT_EXPLANATION_UTF8_BYTES = 240 as const;
export const MAX_COLLECTION_ITEMS_DEFAULT = 256 as const;
export const NEW_METADATA_RETENTION_MAX_AGE_DAYS = 90 as const;
export const NEW_METADATA_RETENTION_RECLAIM_TARGET_BYTES = 268_435_456 as const; // 256 MiB

export const SHARED_CONTRACT_ERROR_CATEGORIES = [
  'identity-mismatch',
  'stale-revision',
  'invalid-observation',
  'missing-artifact',
  'expired-cursor',
  'unsupported-version',
  'capacity-refusal',
  'uncertain-persistence'
] as const;

export type SharedContractErrorCategory = (typeof SHARED_CONTRACT_ERROR_CATEGORIES)[number];

export interface SharedContractErrorDetail {
  readonly category: SharedContractErrorCategory;
  readonly reasonCode: string;
  readonly field?: string | undefined;
  readonly operatorExplanation: string;
}

export type StorageBoundaryOutcome<T> =
  | {
      readonly status: 'accepted';
      readonly value: T;
      readonly operationId?: string | undefined;
    }
  | {
      readonly status: 'refused';
      readonly error: SharedContractErrorDetail;
      readonly operationId?: string | undefined;
    }
  | {
      readonly status: 'uncertain';
      readonly error: SharedContractErrorDetail;
      readonly operationId: string;
      readonly recoveryObligation: 'reconcile-receipt-before-retry-or-effect';
    };

const SAFE_ID_PATTERN = /^[A-Za-z0-9._:@/-]+$/;
const PATH_TRAVERSAL_PATTERN = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
// Quote characters are written as \x22 / \x27 so source scanners never read them as string delimiters.
const HOST_PATH_PATTERN =
  /(?:\/Users\/[^\s\x22\x27,;]+|\/home\/[^\s\x22\x27,;]+|\/var\/folders\/[^\s\x22\x27,;]+|[A-Za-z]:\\[^\s\x22\x27,;]+)/g;

/**
 * Credential redaction is delegated to the canonical sanitizer in
 * `src/lib/logger.ts` so the secret key-name words keep one home
 * (docs/hard-rules.md rule 23). A sink-less logger writes nothing.
 */
const CREDENTIAL_SANITIZER = new SanitizedLogger();

export function sanitizeOperatorExplanation(raw: string): string {
  const redacted = CREDENTIAL_SANITIZER.sanitize(raw)
    .replace(HOST_PATH_PATTERN, '[redacted-path]')
    .trim();
  if (Buffer.byteLength(redacted, 'utf8') <= MAX_FREE_TEXT_EXPLANATION_UTF8_BYTES) {
    return redacted;
  }
  // Truncate by code point so multi-byte text never exceeds the byte ceiling.
  const suffix = '...';
  const budget = MAX_FREE_TEXT_EXPLANATION_UTF8_BYTES - Buffer.byteLength(suffix, 'utf8');
  let out = '';
  let used = 0;
  for (const ch of redacted) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > budget) break;
    out += ch;
    used += size;
  }
  return `${out}${suffix}`;
}

export function buildSharedContractRefusal(
  category: SharedContractErrorCategory,
  reasonCode: string,
  explanation: string,
  field?: string,
  operationId?: string
): StorageBoundaryOutcome<never> {
  return {
    status: 'refused',
    error: {
      category,
      reasonCode,
      ...(field !== undefined ? { field } : {}),
      operatorExplanation: sanitizeOperatorExplanation(explanation)
    },
    ...(operationId !== undefined ? { operationId } : {})
  };
}

export interface ValidatedIdentifier {
  readonly id: string;
  readonly originalId?: string | undefined;
  readonly aliased: boolean;
  readonly utf8Bytes: number;
}

export function validateSharedIdentifier(
  value: unknown,
  fieldName: string,
  options?: { readonly allowLegacyAlias?: boolean | undefined }
): StorageBoundaryOutcome<ValidatedIdentifier> {
  if (typeof value !== 'string' || value.length === 0) {
    return buildSharedContractRefusal(
      'identity-mismatch',
      'empty-or-non-string-identifier',
      `Identifier field '${fieldName}' must be a non-empty string.`,
      fieldName
    );
  }
  if (
    value === '.' ||
    value === '..' ||
    value.startsWith('/') ||
    PATH_TRAVERSAL_PATTERN.test(value) ||
    value.includes('\u0000') ||
    !SAFE_ID_PATTERN.test(value)
  ) {
    return buildSharedContractRefusal(
      'identity-mismatch',
      'malformed-identifier-syntax',
      `Identifier field '${fieldName}' contains disallowed characters or traversal segments.`,
      fieldName
    );
  }
  const utf8Bytes = Buffer.byteLength(value, 'utf8');
  if (utf8Bytes <= MAX_SHARED_IDENTIFIER_UTF8_BYTES) {
    return {
      status: 'accepted',
      value: { id: value, aliased: false, utf8Bytes }
    };
  }
  if (options?.allowLegacyAlias === true) {
    const digest = createHash('sha256').update(value, 'utf8').digest('hex');
    const aliasId = `alias:${digest}`;
    return {
      status: 'accepted',
      value: {
        id: aliasId,
        originalId: value,
        aliased: true,
        utf8Bytes: Buffer.byteLength(aliasId, 'utf8')
      }
    };
  }
  return buildSharedContractRefusal(
    'identity-mismatch',
    'identifier-exceeds-256-utf8-bytes',
    `Identifier field '${fieldName}' exceeds the 256 UTF-8 byte limit (${utf8Bytes} bytes).`,
    fieldName
  );
}

export function rejectUnknownInputFields(
  input: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
  contextName: string
): StorageBoundaryOutcome<true> {
  for (const key of Object.keys(input)) {
    if (!allowedFields.has(key)) {
      return buildSharedContractRefusal(
        'invalid-observation',
        'unknown-input-field',
        `Unknown field '${key}' is not permitted in ${contextName} and is never executed as policy.`,
        key
      );
    }
  }
  return { status: 'accepted', value: true };
}

export const ROUND6_FEATURE_IDS = [
  'F01',
  'F02',
  'F03',
  'F04',
  'F05',
  'F06',
  'F07',
  'F08',
  'F09',
  'F10',
  'F11',
  'F12',
  'F13',
  'F14',
  'F15'
] as const;

export type Round6FeatureId = (typeof ROUND6_FEATURE_IDS)[number];

export const DATA_CLASS_IDS = [
  'current-execution-admission-permits',
  'window-queue-ownership',
  'accepted-usage-observations-adjustments',
  'historical-execution-facts',
  'audit-evidence',
  'artifact-bytes',
  'artifact-availability-references-pins',
  'accepted-phase-context-input-selection',
  'review-findings-fix-claims',
  'catalog-definitions-version-pointers',
  'acp-interaction-metadata',
  'ui-state-caches',
  'provider-conversation-history'
] as const;

export type DataClassId = (typeof DATA_CLASS_IDS)[number];

export const NON_AUTHORITATIVE_EXECUTION_SOURCES = [
  'report',
  'transcript',
  'model-summary',
  'telemetry-span',
  'ui-cache',
  'restored-backup'
] as const;

export type NonAuthoritativeExecutionSource =
  (typeof NON_AUTHORITATIVE_EXECUTION_SOURCES)[number];

export type ProtectedExecutionEffect =
  | 'dispatch'
  | 'completion'
  | 'permit-release'
  | 'git-integration';

export interface DataClassAuthorityEntry {
  readonly dataClass: DataClassId;
  readonly authorityDescription: string;
  readonly singleAuthorityOwner: Round6FeatureId;
  readonly derivedConsumers: readonly Round6FeatureId[];
  readonly canAuthorizeExecutionEffects: boolean;
}

export const DATA_CLASS_AUTHORITY_INVENTORY: readonly DataClassAuthorityEntry[] = Object.freeze([
  {
    dataClass: 'current-execution-admission-permits',
    authorityDescription: 'Host state machine and its fenced SQLite domain records',
    singleAuthorityOwner: 'F01',
    derivedConsumers: ['F03', 'F04', 'F08', 'F09', 'F10', 'F12'],
    canAuthorizeExecutionEffects: true
  },
  {
    dataClass: 'window-queue-ownership',
    authorityDescription:
      'Existing authoritative ownership records; database records are projections where required',
    singleAuthorityOwner: 'F01',
    derivedConsumers: ['F04', 'F08', 'F10'],
    canAuthorizeExecutionEffects: true
  },
  {
    dataClass: 'accepted-usage-observations-adjustments',
    authorityDescription: 'Normalized, versioned usage records attributed to an attempt',
    singleAuthorityOwner: 'F06',
    derivedConsumers: ['F03', 'F11', 'F14'],
    canAuthorizeExecutionEffects: false
  },
  {
    dataClass: 'historical-execution-facts',
    authorityDescription: 'Durable accepted transitions with their source and coverage',
    singleAuthorityOwner: 'F04',
    derivedConsumers: ['F08', 'F11', 'F12', 'F14', 'F15'],
    canAuthorizeExecutionEffects: false
  },
  {
    dataClass: 'audit-evidence',
    authorityDescription: 'Existing append-only audit writer and independent integrity checks',
    singleAuthorityOwner: 'F02',
    derivedConsumers: ['F05', 'F08', 'F11', 'F12'],
    canAuthorizeExecutionEffects: false
  },
  {
    dataClass: 'artifact-bytes',
    authorityDescription: 'Immutable artifact version in its governed file store',
    singleAuthorityOwner: 'F05',
    derivedConsumers: ['F07', 'F08', 'F11', 'F12', 'F15'],
    canAuthorizeExecutionEffects: false
  },
  {
    dataClass: 'artifact-availability-references-pins',
    authorityDescription: 'Host artifact index reconciled with the actual file',
    singleAuthorityOwner: 'F05',
    derivedConsumers: ['F03', 'F07', 'F08', 'F11', 'F15'],
    canAuthorizeExecutionEffects: false
  },
  {
    dataClass: 'accepted-phase-context-input-selection',
    authorityDescription:
      'F15 versioned manifest and immutable target input envelope in SQLite; validated by the host',
    singleAuthorityOwner: 'F15',
    derivedConsumers: ['F08', 'F13'],
    canAuthorizeExecutionEffects: false
  },
  {
    dataClass: 'review-findings-fix-claims',
    authorityDescription:
      'F15 versioned accepted observations in SQLite, linked to protected report artifacts',
    singleAuthorityOwner: 'F15',
    derivedConsumers: ['F01', 'F10', 'F12'],
    canAuthorizeExecutionEffects: false
  },
  {
    dataClass: 'catalog-definitions-version-pointers',
    authorityDescription:
      'Immutable SQLite version records and transactional pointer acceptance after mandatory F04 catalog cutover',
    singleAuthorityOwner: 'F04',
    derivedConsumers: ['F01', 'F08', 'F11', 'F15'],
    canAuthorizeExecutionEffects: false
  },
  {
    dataClass: 'acp-interaction-metadata',
    authorityDescription:
      'Validated profile/connection/session/turn correlation and accepted observation receipts in SQLite',
    singleAuthorityOwner: 'F13',
    derivedConsumers: ['F01', 'F06', 'F07', 'F08', 'F14', 'F15'],
    canAuthorizeExecutionEffects: false
  },
  {
    dataClass: 'ui-state-caches',
    authorityDescription: 'Disposable projections with a revision/cursor',
    singleAuthorityOwner: 'F02',
    derivedConsumers: ['F06', 'F07', 'F11', 'F12'],
    canAuthorizeExecutionEffects: false
  },
  {
    dataClass: 'provider-conversation-history',
    authorityDescription: 'Provider-owned backend store',
    singleAuthorityOwner: 'F13',
    derivedConsumers: ['F08'],
    canAuthorizeExecutionEffects: false
  }
]);

export interface SharedFieldDictionaryEntry {
  readonly fieldName: string;
  readonly category:
    | 'identity'
    | 'schema-version'
    | 'timing'
    | 'quality'
    | 'artifact'
    | 'stream-report'
    | 'acp';
  readonly maxUtf8Bytes?: number | undefined;
  readonly maxItems?: number | undefined;
  readonly ownerFeature: Round6FeatureId;
  readonly namedConsumers: readonly Round6FeatureId[];
  readonly description: string;
}

export const SHARED_FIELD_DICTIONARY: readonly SharedFieldDictionaryEntry[] = Object.freeze([
  {
    fieldName: 'schemaVersion',
    category: 'schema-version',
    ownerFeature: 'F02',
    namedConsumers: ['F01', 'F03', 'F04', 'F05', 'F06', 'F07', 'F08', 'F09', 'F10', 'F11', 'F12', 'F13', 'F14', 'F15'],
    description:
      'Explicit positive integer schema/version discriminator carried on every logical record crossing persistence or IPC.'
  },
  {
    fieldName: 'workspaceId',
    category: 'identity',
    maxUtf8Bytes: MAX_SHARED_IDENTIFIER_UTF8_BYTES,
    ownerFeature: 'F02',
    namedConsumers: ['F01', 'F04', 'F05', 'F08', 'F10', 'F11'],
    description: 'Host-resolved canonical workspace identity; never an untrusted UI-supplied path.'
  },
  {
    fieldName: 'rootExecutionId',
    category: 'identity',
    maxUtf8Bytes: MAX_SHARED_IDENTIFIER_UTF8_BYTES,
    ownerFeature: 'F01',
    namedConsumers: ['F02', 'F03', 'F04', 'F05', 'F06', 'F07', 'F08', 'F10', 'F11', 'F12', 'F13', 'F14', 'F15'],
    description:
      'Admitted root Workflow execution identity mapped to existing connected-run or leaf run identity.'
  },
  {
    fieldName: 'queueId',
    category: 'identity',
    maxUtf8Bytes: MAX_SHARED_IDENTIFIER_UTF8_BYTES,
    ownerFeature: 'F01',
    namedConsumers: ['F02', 'F03', 'F04', 'F06', 'F08', 'F10', 'F11', 'F12'],
    description: 'Owning queue identifier required on all queue-qualified mutations and projections.'
  },
  {
    fieldName: 'invocationId',
    category: 'identity',
    maxUtf8Bytes: MAX_SHARED_IDENTIFIER_UTF8_BYTES,
    ownerFeature: 'F01',
    namedConsumers: ['F02', 'F04', 'F06', 'F07', 'F08', 'F11', 'F12', 'F15'],
    description:
      'Workflow invocation/frame identity in the frozen root, paired with occurrence nodePath and index.'
  },
  {
    fieldName: 'attemptId',
    category: 'identity',
    maxUtf8Bytes: MAX_SHARED_IDENTIFIER_UTF8_BYTES,
    ownerFeature: 'F01',
    namedConsumers: ['F02', 'F03', 'F04', 'F05', 'F06', 'F07', 'F08', 'F09', 'F10', 'F11', 'F12', 'F13', 'F14', 'F15'],
    description:
      'Admitted backend execution attempt identity; retries allocate new attemptIds while redeliveries reuse it.'
  },
  {
    fieldName: 'providerSessionId',
    category: 'identity',
    maxUtf8Bytes: MAX_SHARED_IDENTIFIER_UTF8_BYTES,
    ownerFeature: 'F13',
    namedConsumers: ['F02', 'F06', 'F08', 'F11'],
    description:
      'Optional backend-owned conversation identity scoped by backend and opaque provider account alias.'
  },
  {
    fieldName: 'acpSessionId',
    category: 'acp',
    maxUtf8Bytes: MAX_SHARED_IDENTIFIER_UTF8_BYTES,
    ownerFeature: 'F13',
    namedConsumers: ['F02', 'F04', 'F06', 'F07', 'F08', 'F14', 'F15'],
    description: 'ACP runtime session identity; distinct from underlying providerSessionId.'
  },
  {
    fieldName: 'observationId',
    category: 'identity',
    maxUtf8Bytes: MAX_SHARED_IDENTIFIER_UTF8_BYTES,
    ownerFeature: 'F06',
    namedConsumers: ['F02', 'F04', 'F06', 'F11', 'F13', 'F14', 'F15'],
    description:
      'Idempotency identity of an accepted input fact combining producerNamespace and producer identifier.'
  },
  {
    fieldName: 'artifactId',
    category: 'artifact',
    maxUtf8Bytes: MAX_SHARED_IDENTIFIER_UTF8_BYTES,
    ownerFeature: 'F05',
    namedConsumers: ['F02', 'F04', 'F07', 'F08', 'F11', 'F12', 'F15'],
    description: 'Opaque host-resolved identity for an immutable artifact version.'
  },
  {
    fieldName: 'handoffId',
    category: 'identity',
    maxUtf8Bytes: MAX_SHARED_IDENTIFIER_UTF8_BYTES,
    ownerFeature: 'F15',
    namedConsumers: ['F02', 'F04', 'F08', 'F12', 'F13', 'F15'],
    description: 'Stable identity of one accepted source-to-target context transfer.'
  },
  {
    fieldName: 'acceptedSeq',
    category: 'timing',
    ownerFeature: 'F04',
    namedConsumers: ['F02', 'F05', 'F06', 'F07', 'F08', 'F11', 'F12', 'F14', 'F15'],
    description:
      'Monotonic host-allocated commit sequence ordering accepted facts independently of wall-clock skew.'
  },
  {
    fieldName: 'quality.provenance',
    category: 'quality',
    ownerFeature: 'F02',
    namedConsumers: ['F06', 'F07', 'F08', 'F11', 'F12', 'F14'],
    description: 'Orthogonal provenance axis: observed, derived, or estimated.'
  },
  {
    fieldName: 'quality.completeness',
    category: 'quality',
    ownerFeature: 'F02',
    namedConsumers: ['F06', 'F07', 'F08', 'F11', 'F12', 'F14', 'F15'],
    description: 'Orthogonal completeness axis: known, partial, unknown, or conflicting.'
  },
  {
    fieldName: 'streamCursor',
    category: 'stream-report',
    maxUtf8Bytes: MAX_SHARED_IDENTIFIER_UTF8_BYTES,
    ownerFeature: 'F07',
    namedConsumers: ['F02', 'F03', 'F07', 'F11', 'F12'],
    description: 'Bounded stream identity, generation, and sequence cursor.'
  },
  {
    fieldName: 'sourceCutoff',
    category: 'stream-report',
    ownerFeature: 'F11',
    namedConsumers: ['F02', 'F04', 'F08', 'F11', 'F12', 'F15'],
    description: 'Immutable committed sequence cutoff governing stable report paging and handoff manifests.'
  },
  {
    fieldName: 'omissions',
    category: 'stream-report',
    maxItems: MAX_COLLECTION_ITEMS_DEFAULT,
    maxUtf8Bytes: MAX_FREE_TEXT_EXPLANATION_UTF8_BYTES,
    ownerFeature: 'F02',
    namedConsumers: ['F05', 'F06', 'F08', 'F11', 'F12', 'F15'],
    description: 'Bounded collection of omission entries with safe operator explanations.'
  }
]);
