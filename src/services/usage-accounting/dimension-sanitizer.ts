/**
 * FR-R6-F06 (FR-016, research R11) — grouping dimensions as bounded, closed-pattern values.
 *
 * A dimension that fails its pattern, exceeds 256 UTF-8 bytes or looks like a credential is
 * excluded. The caller counts a `dimension-excluded` gap and stores NULL; the raw value is
 * never stored or logged. A provider session id is stored only as a truncated SHA-256.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { createHash } from 'node:crypto';
import { isBackendRunnerKind } from '../../contracts/backend-kinds';
import { DIMENSION_VALUE_PATTERNS } from '../../contracts/usage-accounting/query-contract';
import { SanitizedLogger } from '../../lib/logger';

export const DIMENSION_MAX_BYTES = 256;
export const PROVIDER_SESSION_REF_HEX_LENGTH = 32;

export type DimensionName = 'backend' | 'model' | 'phaseId' | 'workflowRevision' | 'providerSession';

export type SanitizedDimension = { readonly value: string | null } | { readonly excluded: true };

const { backend: OTHER_BACKEND, model: MODEL, identifier: IDENTIFIER } = DIMENSION_VALUE_PATTERNS;

const EXCLUDED: SanitizedDimension = Object.freeze({ excluded: true });
const ABSENT: SanitizedDimension = Object.freeze({ value: null });

// Sinkless: only `sanitize()` is used, as a credential detector.
const secretDetector = new SanitizedLogger();

/** The stored reference for a provider session id: SHA-256 hex, first 32 characters. */
export function providerSessionRef(sessionId: string): string {
  return createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, PROVIDER_SESSION_REF_HEX_LENGTH);
}

function matchesPattern(name: DimensionName, value: string): boolean {
  switch (name) {
    case 'backend':
      return isBackendRunnerKind(value) || OTHER_BACKEND.test(value);
    case 'model':
      return MODEL.test(value);
    case 'phaseId':
    case 'workflowRevision':
      return IDENTIFIER.test(value);
    case 'providerSession':
      return value.length > 0;
  }
}

function looksLikeSecret(value: string): boolean {
  try {
    return secretDetector.sanitize(value) !== value;
  } catch {
    return true;
  }
}

/**
 * The stored form of one dimension. Absent (`undefined`/`null`) is `{ value: null }`; anything
 * else that is not an acceptable string is `{ excluded: true }`. Never throws.
 */
export function sanitizeDimension(name: DimensionName, raw: unknown): SanitizedDimension {
  if (raw === undefined || raw === null) return ABSENT;
  if (typeof raw !== 'string') return EXCLUDED;
  if (Buffer.byteLength(raw, 'utf8') > DIMENSION_MAX_BYTES) return EXCLUDED;
  if (!matchesPattern(name, raw)) return EXCLUDED;
  if (name === 'providerSession') return { value: providerSessionRef(raw) };
  if (looksLikeSecret(raw)) return EXCLUDED;
  return { value: raw };
}
