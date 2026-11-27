// FR-R3-144 (T001) — the settings VALIDATOR, split out of `general-settings.ts`.
//
// A pure function of a `KeySpec` and a value: no host config object, no I/O, no
// knowledge of targets or rollback. That is what makes it separable, and it is the
// reason the split is here rather than at a convenient line number. See the header
// of `general-settings-keys.ts`.
//
// Nothing in this move changed.

import {
  ALLOWED_KEYS,
  type AllowedKey,
  type KeySpec,
  type RuntimeType
} from './general-settings-keys';

export type WriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * FR-R3-144 (T004) — the runtime types for which `allowClear` admits the
 * `null`/`undefined` sentinel.
 *
 * "Cleared" means *no bound*, so it is meaningful exactly where there is one.
 * The set is why the pre-check below is not simply `if (value == null &&
 * spec.allowClear)`: that form would let a `string` or `array-of-string` spec
 * accept `null` too, and nothing in `KEY_SPECS` would have failed to show it,
 * because no such spec exists. A cleared string is `''`.
 */
const CLEARABLE_TYPES: ReadonlySet<RuntimeType> = new Set<RuntimeType>([
  'number',
  'number-int-range'
]);

export function isAllowedKey(key: string): key is AllowedKey {
  return ALLOWED_KEYS.has(key);
}

export function checkType(spec: KeySpec, value: unknown): WriteResult {
  // FR-R3-144 (T004) — the clear sentinel, lifted out of `number-int-range`.
  //
  // It lived inside that one case because every `allowClear` key was an integer
  // bound. `spend.maxUsdPerRun` is nullable AND decimal, so it is a `number`
  // that must accept the sentinel; without this, `writeGeneralSettings` refuses
  // the value the manifest declares as the setting's own default.
  //
  // Hoisting is behaviour-preserving for every other type: `typeof null` is
  // never `'string'`, `'number'` or `'boolean'`, and `Array.isArray(null)` is
  // false, so each case below already answered `type-mismatch` here.
  if (value === null || value === undefined) {
    return spec.allowClear === true && CLEARABLE_TYPES.has(spec.type)
      ? { ok: true }
      : { ok: false, reason: 'type-mismatch' };
  }
  switch (spec.type) {
    case 'string':
      return typeof value === 'string'
        ? { ok: true }
        : { ok: false, reason: 'type-mismatch' };
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, reason: 'type-mismatch' };
      }
      if (spec.min !== undefined && value < spec.min) {
        return { ok: false, reason: 'out-of-range' };
      }
      if (spec.max !== undefined && value > spec.max) {
        return { ok: false, reason: 'out-of-range' };
      }
      return { ok: true };
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true }
        : { ok: false, reason: 'type-mismatch' };
    case 'array-of-string':
      return Array.isArray(value)
        ? { ok: true }
        : { ok: false, reason: 'type-mismatch' };
    case 'number-int-range': {
      // The clear sentinel is handled above, for this type and for `number`.
      if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        return { ok: false, reason: 'type-mismatch' };
      }
      if (spec.min !== undefined && value < spec.min) {
        return { ok: false, reason: 'out-of-range' };
      }
      if (spec.max !== undefined && value > spec.max) {
        return { ok: false, reason: 'out-of-range' };
      }
      return { ok: true };
    }
    case 'string-enum': {
      if (typeof value !== 'string') {
        return { ok: false, reason: 'type-mismatch' };
      }
      if (!spec.allowedValues || !spec.allowedValues.includes(value)) {
        return { ok: false, reason: 'invalid-enum' };
      }
      return { ok: true };
    }
    case 'string-no-traversal': {
      // Allow empty string (= default), any absolute path, and relative
      // paths that contain no `..` segment. Path resolution against a
      // workspace happens at read time via `resolveRuntimeLogPath`.
      if (typeof value !== 'string') {
        return { ok: false, reason: 'type-mismatch' };
      }
      const trimmed = value.trim();
      if (trimmed.length === 0) return { ok: true };
      const isAbsolute =
        trimmed.startsWith('/') ||
        trimmed.startsWith('\\\\') ||
        trimmed.startsWith('//') ||
        /^[A-Za-z]:[\\/]?/.test(trimmed);
      if (isAbsolute) return { ok: true };
      const segments = trimmed.split(/[\\/]+/);
      if (segments.some((seg) => seg === '..')) {
        return { ok: false, reason: 'relative-traversal' };
      }
      return { ok: true };
    }
  }
}

export function checkArrayElements(spec: KeySpec, value: readonly unknown[]): WriteResult {
  const itemPattern = spec.itemPattern === undefined ? null : new RegExp(spec.itemPattern);
  for (const el of value) {
    if (typeof el !== 'string') return { ok: false, reason: 'invalid-array' };
    if (el.trim().length === 0) return { ok: false, reason: 'invalid-array' };
    if (itemPattern !== null && !itemPattern.test(el)) {
      return { ok: false, reason: 'invalid-array' };
    }
  }
  return { ok: true };
}
