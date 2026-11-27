import {
  ARTIFACT_ACCESS_MODES,
  QUALIFY_ACCESS_REQUEST_KEYS,
  type ArtifactAccessHandle,
  type ArtifactAccessMode,
  type QualifyAccessRequest
} from '../artifact-lifecycle/access-types';
import {
  LIFECYCLE_OPAQUE_ID_PATTERN,
  type ArtifactDigest,
  type LifecycleResult
} from '../artifact-lifecycle/lifecycle-types';
import { hasUnexpectedKeys } from './shared';

// FR-R6-F05 (FR-023, SC-008) — the validators for qualified artifact access. A request that
// carries a path, a URI or any key outside the contract is refused `invalid-input` here, before
// the service consults the policy or the store, so an agent-supplied location never reaches
// resolution. A refusal names the field that was wrong, never the value it held.

type Plain = Record<string, unknown>;

const DIGEST_KEYS = ['algorithm', 'value'] as const;
const HANDLE_KEYS = ['handleId', 'artifactId', 'digest', 'sessionScope', 'mode', 'pinReferenceId'] as const;
const SCOPE_KEYS = ['attemptId', 'sessionId'] as const;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const REFERENCE_ID = /^[0-9a-f]{64}$/;

function invalid<T>(field: string): LifecycleResult<T> {
  return { ok: false, refusal: { code: 'invalid-input', message: `${field} is malformed` } };
}

function isPlain(value: unknown): value is Plain {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && LIFECYCLE_OPAQUE_ID_PATTERN.test(value);
}

function isMode(value: unknown): value is ArtifactAccessMode {
  return typeof value === 'string' && (ARTIFACT_ACCESS_MODES as readonly string[]).includes(value);
}

/** A sha256 digest in the lifecycle's shape; `null` when it is anything else. */
export function readArtifactDigest(value: unknown): ArtifactDigest | null {
  if (!isPlain(value) || hasUnexpectedKeys(value, DIGEST_KEYS)) return null;
  const { algorithm, value: hex } = value;
  if (algorithm !== 'sha256' || typeof hex !== 'string' || !SHA256_HEX.test(hex)) return null;
  return { algorithm, value: hex };
}

/** One `qualifyAccess` request: opaque ids, an expected digest and a mode, nothing else. */
export function validateQualifyAccessRequest(input: unknown): LifecycleResult<QualifyAccessRequest> {
  if (!isPlain(input) || hasUnexpectedKeys(input, QUALIFY_ACCESS_REQUEST_KEYS)) return invalid('request');
  const { artifactId, attemptId, sessionId, mode } = input;
  if (!isOpaqueId(artifactId)) return invalid('artifactId');
  if (!isOpaqueId(attemptId)) return invalid('attemptId');
  if (!isOpaqueId(sessionId)) return invalid('sessionId');
  if (!isMode(mode)) return invalid('mode');
  const expectedDigest = readArtifactDigest(input['expectedDigest']);
  if (expectedDigest === null) return invalid('expectedDigest');
  return { ok: true, value: { artifactId, expectedDigest, attemptId, sessionId, mode } };
}

/** A handle presented back to the service; only the shape is checked, never its standing. */
export function validateAccessHandle(input: unknown): LifecycleResult<ArtifactAccessHandle> {
  if (!isPlain(input) || hasUnexpectedKeys(input, HANDLE_KEYS)) return invalid('handle');
  const { handleId, artifactId, mode, pinReferenceId, sessionScope } = input;
  if (!isOpaqueId(handleId) || !isOpaqueId(artifactId)) return invalid('handle');
  if (!isMode(mode) || typeof pinReferenceId !== 'string' || !REFERENCE_ID.test(pinReferenceId)) return invalid('handle');
  if (!isPlain(sessionScope) || hasUnexpectedKeys(sessionScope, SCOPE_KEYS)) return invalid('handle');
  const { attemptId, sessionId } = sessionScope;
  if (!isOpaqueId(attemptId) || !isOpaqueId(sessionId)) return invalid('handle');
  const digest = readArtifactDigest(input['digest']);
  if (digest === null) return invalid('handle');
  return {
    ok: true,
    value: { handleId, artifactId, digest, sessionScope: { attemptId, sessionId }, mode, pinReferenceId }
  };
}
