/**
 * FR-R6-F15 (F15-A; FR-017, FR-020, FR-021) — the shape checks every untrusted value of a
 * handoff passes, and the tagged SHA-256 its digests share.
 *
 * A value is read as plain data only: an object whose prototype is the plain one, with no
 * accessor, and exactly the keys its contract names. Anything else refuses the value, so
 * nothing a contract does not name reaches a manifest.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { createHash } from 'node:crypto';

import type { PhaseContextFailure, Refusal } from '../../contracts/phase-context/context-policy';

export type PlainRecord = Readonly<Record<string, unknown>>;

/** The value as a record, or `null` when it is not a plain object of data properties. */
export function plainRecord(value: unknown): PlainRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return null;
  }
  return value as PlainRecord;
}

/** True when the record holds exactly these keys: none missing and none besides. */
export function hasExactKeys(record: PlainRecord, keys: readonly string[]): boolean {
  if (Reflect.ownKeys(record).length !== keys.length) return false;
  return keys.every((key) => Object.hasOwn(record, key));
}

export function isWholeNumber(value: unknown, min: number, max: number = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function matchesPattern(pattern: RegExp, value: unknown): value is string {
  return typeof value === 'string' && pattern.test(value);
}

export function isOneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/** The value as a list of at most `max` items, or `null`. */
export function listOf(value: unknown, max: number): readonly unknown[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  return value as readonly unknown[];
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The digest of a tagged array. The array is written as JSON, so no two different lists of
 * parts give the same text: a separator inside one part cannot stand for a boundary.
 */
export function taggedDigest(parts: readonly unknown[]): string {
  return sha256Hex(JSON.stringify(parts));
}

export function refuse(failure: PhaseContextFailure, detail: string): Refusal {
  return { ok: false, failure, detail };
}

/** Code-unit order, the same on every machine and in every locale. */
export function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
