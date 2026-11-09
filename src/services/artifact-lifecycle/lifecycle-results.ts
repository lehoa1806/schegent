/**
 * FR-R6-F05 — small helpers shared by the lifecycle modules: result
 * construction, opaque-id validation, the single-transaction wrapper and the
 * display-name sanitizer.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import type {
  LifecycleRefusalCode,
  LifecycleResult
} from '../../contracts/artifact-lifecycle/lifecycle-types';
import {
  ARTIFACT_DISPLAY_NAME_MAX_BYTES,
  LIFECYCLE_OPAQUE_ID_PATTERN
} from '../../contracts/artifact-lifecycle/lifecycle-types';
import { sanitizeOperatorExplanation } from '../../contracts/shared-memory-storage/inventories';
import type { NodeSqliteConnection } from '../sqlite-store';

export function ok<T>(value: T): LifecycleResult<T> {
  return { ok: true, value };
}

export function refuse<T>(code: LifecycleRefusalCode, message: string, artifactId?: string): LifecycleResult<T> {
  const refusal = artifactId === undefined ? { code, message } : { code, message, artifactId };
  return { ok: false, refusal };
}

export function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && LIFECYCLE_OPAQUE_ID_PATTERN.test(value);
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function includesValue<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/** Sanitized (credentials and host paths redacted) and bounded to 256 UTF-8 bytes. */
export function sanitizeDisplayName(raw: string): string {
  const sanitized = sanitizeOperatorExplanation(raw);
  if (Buffer.byteLength(sanitized, 'utf8') <= ARTIFACT_DISPLAY_NAME_MAX_BYTES) return sanitized;
  let out = '';
  let used = 0;
  for (const ch of sanitized) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > ARTIFACT_DISPLAY_NAME_MAX_BYTES) break;
    out += ch;
    used += size;
  }
  return out;
}

/** Runs `body` inside one `BEGIN IMMEDIATE`; rolls back and rethrows on any error. */
export function inImmediateTransaction<T>(conn: NodeSqliteConnection, body: () => T): T {
  conn.exec('BEGIN IMMEDIATE');
  try {
    const result = body();
    conn.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      conn.exec('ROLLBACK');
    } catch {
      // The original error is the one worth surfacing.
    }
    throw error;
  }
}
