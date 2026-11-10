// FR-R6-F09 (FR-014, SC-005; contract section 6, research R13) -- the headless qualification
// inspection: what each backend's bound is qualified to do on a given identity, and what the
// spawn gate would decide for it.
//
// Pure and read-only. It starts no probe, reads no store and retains nothing: the caller supplies
// the identities, grants and bindings. It calls the same `qualifyBackend` and `judgeSpawnAdmission`
// the gate and the sidebar projection call, so the three cannot disagree.
//
// Input is validated first. A malformed request throws `InvalidInspectionInputError` naming the
// field -- never the value, so nothing a caller passes reaches a message (NFR-005).
//
// This module imports no editor host API (rule 13).

import { isBackendRunnerKind, type BackendRunnerKind } from '../contracts/backend-kinds';
import {
  DIGEST_PATTERN,
  EXECUTABLE_UNRESOLVED_CAUSES,
  PLATFORM_FIELD_MAX,
  VERSION_MINOR_PATTERN,
  type AcceptanceBinding,
  type AdmissionVerdict,
  type BackendIdentity,
  type QualificationRecord
} from '../contracts/containment-qualification';
import { parseAcceptanceBinding } from '../services/containment-qualification/acceptance-bindings';
import { judgeSpawnAdmission } from '../services/containment-qualification/admission';
import { qualifyBackend } from '../services/containment-qualification/qualify';

export interface BackendQualificationInspectionInput {
  readonly identities: readonly BackendIdentity[];
  readonly granted: readonly BackendRunnerKind[];
  readonly bindings: Readonly<Partial<Record<BackendRunnerKind, AcceptanceBinding>>>;
}

export interface BackendQualificationInspection {
  readonly record: QualificationRecord;
  readonly admission: AdmissionVerdict;
}

/** A malformed inspection request. `field` names where; no input value is carried. */
export class InvalidInspectionInputError extends Error {
  constructor(readonly field: string) {
    super(`invalid backend qualification inspection input: ${field}`);
    this.name = 'InvalidInspectionInputError';
  }
}

const INPUT_KEYS = Object.freeze(['bindings', 'granted', 'identities']);
/** Bound on `identities` and on `granted` (review S6). */
const INSPECTION_LIST_MAX = 64;
/** `os` and `arch` are `process.platform` / `process.arch` values: lower-case, no space or control. */
const PLATFORM_FIELD_PATTERN = /^[a-z0-9_-]+$/;
const IDENTITY_KEYS = Object.freeze(['arch', 'environmentPolicyDigest', 'executable', 'kind', 'os', 'versionMinor']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, index) => key === keys.at(index));
}

function isPlatformField(value: unknown): boolean {
  return typeof value === 'string' && value.length <= PLATFORM_FIELD_MAX && PLATFORM_FIELD_PATTERN.test(value);
}

function isExecutable(value: unknown): boolean {
  return value === 'resolved' || (EXECUTABLE_UNRESOLVED_CAUSES as readonly unknown[]).includes(value);
}

function isVersionMinor(value: unknown): boolean {
  return value === null || (typeof value === 'string' && VERSION_MINOR_PATTERN.test(value));
}

function isDigest(value: unknown): boolean {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

/** Reads each field once and returns a fresh frozen copy, so a getter cannot change what was judged. */
function validateIdentity(value: unknown, field: string): BackendIdentity {
  if (!isPlainObject(value) || !hasExactKeys(value, IDENTITY_KEYS)) throw new InvalidInspectionInputError(field);
  const { kind, executable, versionMinor, os, arch, environmentPolicyDigest } = value;
  if (!isBackendRunnerKind(kind)) throw new InvalidInspectionInputError(`${field}.kind`);
  if (!isExecutable(executable)) throw new InvalidInspectionInputError(`${field}.executable`);
  if (!isVersionMinor(versionMinor)) throw new InvalidInspectionInputError(`${field}.versionMinor`);
  if (!isPlatformField(os)) throw new InvalidInspectionInputError(`${field}.os`);
  if (!isPlatformField(arch)) throw new InvalidInspectionInputError(`${field}.arch`);
  if (!isDigest(environmentPolicyDigest)) throw new InvalidInspectionInputError(`${field}.environmentPolicyDigest`);
  return Object.freeze({
    kind,
    executable: executable as BackendIdentity['executable'],
    versionMinor: versionMinor as string | null,
    os: os as string,
    arch: arch as string,
    environmentPolicyDigest: environmentPolicyDigest as string
  });
}

function validateGranted(value: unknown): ReadonlySet<BackendRunnerKind> {
  if (!Array.isArray(value) || value.length > INSPECTION_LIST_MAX) throw new InvalidInspectionInputError('granted');
  value.forEach((kind: unknown, index) => {
    if (!isBackendRunnerKind(kind)) throw new InvalidInspectionInputError(`granted[${index}]`);
  });
  return new Set(value as BackendRunnerKind[]);
}

function validateBindings(value: unknown): ReadonlyMap<BackendRunnerKind, AcceptanceBinding> {
  if (!isPlainObject(value)) throw new InvalidInspectionInputError('bindings');
  const bindings = new Map<BackendRunnerKind, AcceptanceBinding>();
  for (const [kind, entry] of Object.entries(value)) {
    if (!isBackendRunnerKind(kind)) throw new InvalidInspectionInputError('bindings');
    const binding = parseAcceptanceBinding(entry, kind);
    if (binding === null) throw new InvalidInspectionInputError(`bindings.${kind}`);
    bindings.set(kind, binding);
  }
  return bindings;
}

/**
 * One `{ record, admission }` per identity, in input order. Throws
 * {@link InvalidInspectionInputError} on malformed input, before any judgement.
 */
export function inspectBackendQualification(
  input: BackendQualificationInspectionInput
): readonly BackendQualificationInspection[] {
  const raw: unknown = input;
  if (!isPlainObject(raw) || !hasExactKeys(raw, INPUT_KEYS)) throw new InvalidInspectionInputError('input');
  const identities = raw['identities'];
  if (!Array.isArray(identities) || identities.length > INSPECTION_LIST_MAX) {
    throw new InvalidInspectionInputError('identities');
  }
  const valid = identities.map((identity: unknown, index) => validateIdentity(identity, `identities[${index}]`));
  const granted = validateGranted(raw['granted']);
  const bindings = validateBindings(raw['bindings']);
  return Object.freeze(
    valid.map((identity) =>
      Object.freeze({
        record: qualifyBackend(identity),
        admission: judgeSpawnAdmission({ identity, granted, binding: bindings.get(identity.kind) ?? null })
      })
    )
  );
}
