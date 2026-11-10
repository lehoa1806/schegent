/**
 * FR-R6-F08 — the bounded metadata manifest a handoff revision freezes (data-model.md).
 *
 * PROMISES
 * - `validateHandoffManifest` either returns a frozen manifest or a typed refusal; a refusal
 *   means the caller writes nothing (FR-015).
 * - A future `version` is refused as `unsupported-version` before any other field is read, so
 *   a newer build's fields are never judged by this build's rules.
 * - One artifact appears under at most one role, so a partial artifact is never also listed
 *   as validated (FR-004).
 * - `serializeHandoffManifest` emits canonical key order, so equal manifests give equal bytes
 *   and an equal digest.
 * - No field holds content: paths are contained and relative, identifiers are opaque.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { createHash } from 'node:crypto';
import { LIFECYCLE_OPAQUE_ID_PATTERN } from '../artifact-lifecycle/lifecycle-types';
import { ATTEMPT_OUTCOME_REASONS, ATTEMPT_OUTCOME_STATUSES } from '../decision-results';
import type { AttemptOutcomeReason, AttemptOutcomeStatus } from '../decision-results';
import {
  RECOVERY_EFFECT_CERTAINTY_VALUES,
  RECOVERY_WORKSPACE_ATTRIBUTION_VALUES,
  RECOVERY_WORKSPACE_COVERAGE_VALUES,
  isValidContainedWorkspacePath
} from '../recovery-envelope';
import type {
  RecoveryEffectCertainty,
  RecoveryWorkspaceAttribution,
  RecoveryWorkspaceCoverage
} from '../recovery-envelope';
import {
  HANDOFF_EXCLUDED_REASONS,
  HANDOFF_MANIFEST_VERSION,
  HANDOFF_REFERENCE_ROLES,
  MAX_HANDOFF_EXCLUDED_ITEMS,
  MAX_HANDOFF_MANIFEST_BYTES,
  MAX_HANDOFF_REFERENCES_PER_ROLE,
  MAX_HANDOFF_WORKSPACE_ENTRIES
} from './handoff-types';
import type {
  HandoffExcludedReason,
  HandoffReferenceRole,
  HandoffRefusal,
  ManifestRefusalCode
} from './handoff-types';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface HandoffManifestReference {
  readonly artifactId: string;
  readonly role: HandoffReferenceRole;
  readonly required: boolean;
  readonly digest?: string;
}

export interface HandoffManifestWorkspaceEntry {
  readonly path: string;
  readonly attribution: RecoveryWorkspaceAttribution;
}

export interface HandoffManifestExcludedItem {
  readonly itemId: string;
  readonly reason: HandoffExcludedReason;
}

export interface HandoffManifest {
  readonly version: typeof HANDOFF_MANIFEST_VERSION;
  readonly sourceOutcome: { readonly status: AttemptOutcomeStatus; readonly reason: AttemptOutcomeReason };
  readonly frozenDefinitionDigest: string;
  readonly certainty: RecoveryEffectCertainty;
  readonly coverage: RecoveryWorkspaceCoverage;
  readonly workspace: {
    readonly entries: readonly HandoffManifestWorkspaceEntry[];
    readonly omittedCount: number;
  };
  readonly references: readonly HandoffManifestReference[];
  readonly excluded: readonly HandoffManifestExcludedItem[];
  readonly contextId: string | null;
  readonly envelope: { readonly artifactId: string; readonly digest: string } | null;
}

export type HandoffManifestValidation =
  | { readonly ok: true; readonly manifest: HandoffManifest }
  | (HandoffRefusal<ManifestRefusalCode> & { readonly field: string });

export type HandoffManifestSerialization =
  | {
      readonly ok: true;
      readonly manifest: HandoffManifest;
      readonly json: string;
      readonly bytes: number;
      readonly digest: string;
    }
  | (HandoffRefusal<ManifestRefusalCode> & { readonly field: string });

/** Thrown inside the validator only; never escapes it. */
class ManifestRefused extends Error {
  constructor(
    readonly code: ManifestRefusalCode,
    readonly field: string
  ) {
    super(code);
  }
}

function refuse(code: ManifestRefusalCode, field: string): never {
  throw new ManifestRefused(code, field);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectWithKeys(
  value: unknown,
  field: string,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  if (!isPlainObject(value)) refuse('invalid', field);
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) refuse('invalid', `${field}.${key}`);
  }
  for (const key of required) {
    if (!(key in value)) refuse('invalid', `${field}.${key}`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) refuse('invalid', field);
  return value as T;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) refuse('invalid', field);
  return value;
}

function opaqueId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !LIFECYCLE_OPAQUE_ID_PATTERN.test(value)) refuse('invalid-ref', field);
  return value;
}

function boundedArray(value: unknown, field: string, max: number): readonly unknown[] {
  if (!Array.isArray(value)) refuse('invalid', field);
  if (value.length > max) refuse('over-limit', field);
  return value;
}

function readVersion(raw: Record<string, unknown>): typeof HANDOFF_MANIFEST_VERSION {
  const version = raw['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) refuse('invalid', 'version');
  if (version > HANDOFF_MANIFEST_VERSION) refuse('unsupported-version', 'version');
  return HANDOFF_MANIFEST_VERSION;
}

function readWorkspace(value: unknown): HandoffManifest['workspace'] {
  const workspace = objectWithKeys(value, 'workspace', ['entries', 'omittedCount']);
  const rawEntries = boundedArray(workspace['entries'], 'workspace.entries', MAX_HANDOFF_WORKSPACE_ENTRIES);
  const entries = rawEntries.map((rawEntry, index) => {
    const field = `workspace.entries.${index}`;
    const entry = objectWithKeys(rawEntry, field, ['path', 'attribution']);
    const path = entry['path'];
    if (typeof path !== 'string' || !isValidContainedWorkspacePath(path)) refuse('invalid-path', `${field}.path`);
    const attribution = oneOf(entry['attribution'], RECOVERY_WORKSPACE_ATTRIBUTION_VALUES, `${field}.attribution`);
    return Object.freeze({ path, attribution });
  });
  const omittedCount = workspace['omittedCount'];
  if (typeof omittedCount !== 'number' || !Number.isSafeInteger(omittedCount) || omittedCount < 0) {
    refuse('invalid', 'workspace.omittedCount');
  }
  return Object.freeze({ entries: Object.freeze(entries), omittedCount });
}

function readReference(rawReference: unknown, field: string): HandoffManifestReference {
  const reference = objectWithKeys(rawReference, field, ['artifactId', 'role', 'required'], ['digest']);
  const artifactId = opaqueId(reference['artifactId'], `${field}.artifactId`);
  const role = oneOf(reference['role'], HANDOFF_REFERENCE_ROLES, `${field}.role`);
  const required = reference['required'];
  if (typeof required !== 'boolean') refuse('invalid', `${field}.required`);
  if (reference['digest'] === undefined) return Object.freeze({ artifactId, role, required });
  return Object.freeze({ artifactId, role, required, digest: digest(reference['digest'], `${field}.digest`) });
}

function readReferences(value: unknown): readonly HandoffManifestReference[] {
  if (!Array.isArray(value)) refuse('invalid', 'references');
  const perRole = new Map<HandoffReferenceRole, number>();
  const seen = new Set<string>();
  const references = value.map((rawReference, index) => {
    const reference = readReference(rawReference, `references.${index}`);
    const count = (perRole.get(reference.role) ?? 0) + 1;
    if (count > MAX_HANDOFF_REFERENCES_PER_ROLE) refuse('over-limit', `references.${reference.role}`);
    perRole.set(reference.role, count);
    if (seen.has(reference.artifactId)) refuse('invalid', `references.${index}.artifactId`);
    seen.add(reference.artifactId);
    return reference;
  });
  return Object.freeze(references);
}

function readExcluded(value: unknown): readonly HandoffManifestExcludedItem[] {
  const rawItems = boundedArray(value, 'excluded', MAX_HANDOFF_EXCLUDED_ITEMS);
  return Object.freeze(
    rawItems.map((rawItem, index) => {
      const field = `excluded.${index}`;
      const item = objectWithKeys(rawItem, field, ['itemId', 'reason']);
      return Object.freeze({
        itemId: opaqueId(item['itemId'], `${field}.itemId`),
        reason: oneOf(item['reason'], HANDOFF_EXCLUDED_REASONS, `${field}.reason`)
      });
    })
  );
}

function readEnvelope(value: unknown): HandoffManifest['envelope'] {
  if (value === null) return null;
  const envelope = objectWithKeys(value, 'envelope', ['artifactId', 'digest']);
  return Object.freeze({
    artifactId: opaqueId(envelope['artifactId'], 'envelope.artifactId'),
    digest: digest(envelope['digest'], 'envelope.digest')
  });
}

const MANIFEST_KEYS = [
  'version',
  'sourceOutcome',
  'frozenDefinitionDigest',
  'certainty',
  'coverage',
  'workspace',
  'references',
  'excluded',
  'contextId',
  'envelope'
] as const;

function readManifest(raw: unknown): HandoffManifest {
  if (!isPlainObject(raw)) refuse('invalid', 'manifest');
  const version = readVersion(raw);
  const manifest = objectWithKeys(raw, 'manifest', MANIFEST_KEYS);
  const outcome = objectWithKeys(manifest['sourceOutcome'], 'sourceOutcome', ['status', 'reason']);
  const coverage = oneOf(manifest['coverage'], RECOVERY_WORKSPACE_COVERAGE_VALUES, 'coverage');
  const workspace = readWorkspace(manifest['workspace']);
  if (coverage === 'complete' && workspace.omittedCount > 0) refuse('invalid', 'coverage');
  const contextId = manifest['contextId'] === null ? null : opaqueId(manifest['contextId'], 'contextId');
  return Object.freeze({
    version,
    sourceOutcome: Object.freeze({
      status: oneOf(outcome['status'], ATTEMPT_OUTCOME_STATUSES, 'sourceOutcome.status'),
      reason: oneOf(outcome['reason'], ATTEMPT_OUTCOME_REASONS, 'sourceOutcome.reason')
    }),
    frozenDefinitionDigest: digest(manifest['frozenDefinitionDigest'], 'frozenDefinitionDigest'),
    certainty: oneOf(manifest['certainty'], RECOVERY_EFFECT_CERTAINTY_VALUES, 'certainty'),
    coverage,
    workspace,
    references: readReferences(manifest['references']),
    excluded: readExcluded(manifest['excluded']),
    contextId,
    envelope: readEnvelope(manifest['envelope'])
  });
}

/** The manifest's canonical JSON: the validated object is built in a fixed key order. */
function canonicalJson(manifest: HandoffManifest): string {
  return JSON.stringify(manifest);
}

/** Validates an untrusted manifest. Refusals carry the field path, never the value. */
export function validateHandoffManifest(raw: unknown): HandoffManifestValidation {
  const serialized = serializeHandoffManifest(raw);
  return serialized.ok ? { ok: true, manifest: serialized.manifest } : serialized;
}

/** Validates, then emits canonical JSON with its UTF-8 byte count and SHA-256 digest. */
export function serializeHandoffManifest(raw: unknown): HandoffManifestSerialization {
  let manifest: HandoffManifest;
  try {
    manifest = readManifest(raw);
  } catch (error) {
    if (error instanceof ManifestRefused) return { ok: false, code: error.code, field: error.field };
    throw error;
  }
  const json = canonicalJson(manifest);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > MAX_HANDOFF_MANIFEST_BYTES) return { ok: false, code: 'over-limit', field: 'manifest' };
  const sha = createHash('sha256').update(json, 'utf8').digest('hex');
  return { ok: true, manifest, json, bytes, digest: sha };
}
