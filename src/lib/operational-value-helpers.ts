/**
 * FR-R7-07 — Pure JSON/value helpers relocated from
 * `src/services/sqlite-store/operational-entity-schema.ts` into `src/lib/` so
 * both `src/state/` and `src/services/sqlite-store/` share one domain-free
 * implementation without `state/` value-importing `services/`.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 * Zero raw `node:fs` write primitives (docs/hard-rules.md rule 69).
 */

import { createHash } from 'node:crypto';

export const MAX_OPERATIONAL_JSON_DEPTH = 128;

const DANGEROUS_ENTITY_KEYS = new Set<string>(['__proto__', 'constructor', 'prototype']);
const STRICT_POSITIVE_INT_PATTERN = /^[1-9]\d*$/;

export function parseStrictSchemaMetaVersion(raw: string): number | null {
  if (!STRICT_POSITIVE_INT_PATTERN.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

export function isSafeEntityKey(key: string): boolean {
  return key.length > 0 && !DANGEROUS_ENTITY_KEYS.has(key);
}

/**
 * Safely defines an own enumerable data property on `target`, avoiding `Object.prototype.__proto__`
 * setter invocation when `key === '__proto__'`.
 */
export function setOwnProp(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true
    });
  } else {
    target[key] = value;
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

export function hasOwnDefinedEntries(record: Readonly<Record<string, unknown>>): boolean {
  for (const key of Object.keys(record)) {
    if (record[key] !== undefined) return true;
  }
  return false;
}

const DEEP_FROZEN_SNAPSHOTS = new WeakSet<object>();

/**
 * Returns `true` only for objects deeply frozen by `deepFreezeValue` or
 * `freezeSnapshotWithStructuralSharing` (never raw shallow `Object.freeze` wrappers).
 */
export function isDeepFrozenSnapshot(value: unknown): boolean {
  return value !== null && typeof value === 'object' && DEEP_FROZEN_SNAPSHOTS.has(value);
}

/**
 * Deterministic canonical JSON stringification with sorted object keys (omitting `undefined`
 * object properties to match `JSON.stringify` round-trip semantics), bounded by
 * `MAX_OPERATIONAL_JSON_DEPTH` and guarded against cyclic references.
 */
export function canonicalJsonStringify(
  value: unknown,
  depth = 0,
  seen?: WeakSet<object>
): string {
  if (value === null || typeof value !== 'object') {
    const encoded: unknown = JSON.stringify(value);
    return typeof encoded === 'string' ? encoded : 'null';
  }
  if (depth > MAX_OPERATIONAL_JSON_DEPTH) {
    throw new RangeError('OPERATIONAL_JSON_MAX_DEPTH_EXCEEDED');
  }
  const active = seen ?? new WeakSet<object>();
  if (active.has(value)) {
    throw new TypeError('OPERATIONAL_JSON_CYCLE_DETECTED');
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let i = 0; i < value.length; i += 1) {
        const elem = value[i];
        items.push(elem === undefined ? 'null' : canonicalJsonStringify(elem, depth + 1, active));
      }
      return `[${items.join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const pairs: string[] = [];
    for (const key of keys) {
      const prop = record[key];
      if (prop === undefined) continue;
      pairs.push(`${JSON.stringify(key)}:${canonicalJsonStringify(prop, depth + 1, active)}`);
    }
    return `{${pairs.join(',')}}`;
  } finally {
    active.delete(value);
  }
}

export function computeCanonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJsonStringify(value)).digest('hex');
}

/**
 * Fast recursive value equality for JSON-compatible operational state objects, using reference
 * identity (`Object.is(a, b)`) as an O(1) short-circuit, own-property lookup (`Object.hasOwn`),
 * and depth bounding (`MAX_OPERATIONAL_JSON_DEPTH`).
 */
export function isDeepEqualJsonValue(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (depth > MAX_OPERATIONAL_JSON_DEPTH) {
    throw new RangeError('OPERATIONAL_JSON_MAX_DEPTH_EXCEEDED');
  }
  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray || bIsArray) {
    if (!aIsArray || !bIsArray) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!isDeepEqualJsonValue(a[i], b[i], depth + 1)) return false;
    }
    return true;
  }
  if (!isPlainRecord(a) || !isPlainRecord(b)) return false;
  const recA = a;
  const recB = b;
  const keysA = Object.keys(recA);
  const keysB = Object.keys(recB);

  let definedA = 0;
  for (const key of keysA) {
    const valA = recA[key];
    if (valA === undefined) continue;
    definedA += 1;
    if (!Object.hasOwn(recB, key)) return false;
    if (!isDeepEqualJsonValue(valA, recB[key], depth + 1)) return false;
  }

  let definedB = 0;
  for (const key of keysB) {
    if (recB[key] !== undefined) definedB += 1;
  }
  return definedA === definedB;
}

/**
 * In-place deep freeze for freshly parsed SQLite objects. Subtrees already marked in
 * `DEEP_FROZEN_SNAPSHOTS` short-circuit in O(1); externally shallow-frozen objects still have
 * their descendants frozen before being added to `DEEP_FROZEN_SNAPSHOTS`.
 */
export function deepFreezeValue<T>(value: T, depth = 0, seen?: WeakSet<object>): T {
  if (value === null || typeof value !== 'object') return value;
  if (DEEP_FROZEN_SNAPSHOTS.has(value)) return value;
  if (depth > MAX_OPERATIONAL_JSON_DEPTH) {
    throw new RangeError('OPERATIONAL_JSON_MAX_DEPTH_EXCEEDED');
  }
  const active = seen ?? new WeakSet<object>();
  if (active.has(value)) {
    throw new TypeError('OPERATIONAL_JSON_CYCLE_DETECTED');
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        deepFreezeValue(value[i], depth + 1, active);
      }
    } else {
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        deepFreezeValue(record[key], depth + 1, active);
      }
    }
  } finally {
    active.delete(value);
  }
  Object.freeze(value);
  DEEP_FROZEN_SNAPSHOTS.add(value);
  return value;
}

/**
 * Produces a deeply frozen cache snapshot with structural sharing:
 * - Subtrees verified deeply frozen by this module (`DEEP_FROZEN_SNAPSHOTS`) are reused in O(1).
 * - Unfrozen or externally shallow-frozen caller objects/arrays are copied before freezing so
 *   callers remain isolated from store cache internals and mutable descendants cannot leak in.
 */
export function freezeSnapshotWithStructuralSharing<T>(
  value: T,
  depth = 0,
  seen?: WeakSet<object>
): T {
  if (value === null || typeof value !== 'object') return value;
  if (DEEP_FROZEN_SNAPSHOTS.has(value)) return value;
  if (depth > MAX_OPERATIONAL_JSON_DEPTH) {
    throw new RangeError('OPERATIONAL_JSON_MAX_DEPTH_EXCEEDED');
  }
  const active = seen ?? new WeakSet<object>();
  if (active.has(value)) {
    throw new TypeError('OPERATIONAL_JSON_CYCLE_DETECTED');
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const clone = new Array<unknown>(value.length);
      for (let i = 0; i < value.length; i += 1) {
        clone[i] = freezeSnapshotWithStructuralSharing(value[i], depth + 1, active);
      }
      Object.freeze(clone);
      DEEP_FROZEN_SNAPSHOTS.add(clone);
      return clone as unknown as T;
    }
    if (isPlainRecord(value)) {
      const clone: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        setOwnProp(clone, key, freezeSnapshotWithStructuralSharing(value[key], depth + 1, active));
      }
      Object.freeze(clone);
      DEEP_FROZEN_SNAPSHOTS.add(clone);
      return clone as unknown as T;
    }
    return deepFreezeValue(structuredClone(value), depth, active);
  } finally {
    active.delete(value);
  }
}

export function toSafeIntOrDefault(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const truncated = Math.trunc(value);
  return Number.isSafeInteger(truncated) ? truncated : fallback;
}

export function toSafeIntOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const truncated = Math.trunc(value);
  return Number.isSafeInteger(truncated) ? truncated : null;
}

export function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
