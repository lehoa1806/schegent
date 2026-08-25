import type { SidebarCommand } from '../sidebar-ipc';

export interface IpcValidationError {
  readonly ok: false;
  readonly reason: string;
  readonly type?: string;
  readonly correlationId?: string;
}

export type IpcValidationResult =
  | { readonly ok: true; readonly command: SidebarCommand }
  | IpcValidationError;

export const CORRELATION_ID_MAX = 64;
export const QUEUE_ID_MAX = 256;

/**
 * FR-R3-080 (T1073) — the character class an identifier must be drawn from
 * before it may become a path component.
 *
 * `M-04` / `SEC-05`. Every phase-log identifier is checked for type and length
 * and then handed to `path.join`, and a bounded ID is not a safe path segment:
 * `..` is two characters, a separator is one, and a drive prefix is two. Length
 * bounds SIZE; this bounds SHAPE, and neither substitutes for the other — the
 * length check is retained everywhere it already stood.
 *
 * Enumerated rather than subtractive. A denylist of traversal forms has to
 * anticipate every encoding an operating system might accept — `..`, `%2e%2e`,
 * `\\?\`, a trailing dot on Windows, a Unicode look-alike — and a list that has
 * to be complete to be correct is one bug away from admitting the thing it
 * excludes. This admits letters, digits, dot, dash and underscore, and refuses
 * everything else including every one of those forms, without knowing what they
 * are.
 *
 * `.` and `..` are excluded separately below: both are drawn entirely from the
 * admitted class and both mean something to the filesystem that this rule must
 * not permit.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * FR-R3-080 (T1073) — is `value` a bounded, well-shaped path segment?
 *
 * The single oracle for both sites the grammar is applied at: this validator,
 * where an identifier crosses IPC, and `services/phase-log/phase-log-path.ts`,
 * where it becomes a path component. Two checks against ONE rule is what makes
 * it a grammar rather than a filter — and one rule in two places is what stops
 * the two from drifting apart, which is the failure mode a re-implementation
 * would have.
 */
export function isSafePathSegment(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= QUEUE_ID_MAX &&
    value !== '.' &&
    value !== '..' &&
    SAFE_SEGMENT.test(value)
  );
}

export function ok(command: SidebarCommand): IpcValidationResult {
  return { ok: true, command };
}

export function fail(
  reason: string,
  extra: { type?: string; correlationId?: string } = {}
): IpcValidationError {
  return { ok: false, reason, ...extra };
}

export function hasUnexpectedKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) return true;
  }
  return false;
}
