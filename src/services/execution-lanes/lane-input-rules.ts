/**
 * FR-R6-F10 (contract §7, research R9): the shape rules for a target branch and a verification
 * profile, shared by the service and the headless port. Pure; no Git call.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { createHash } from 'node:crypto';
import { VERIFICATION_LIMITS, type VerificationCheck, type VerificationProfile } from '../../contracts/execution-lanes';

/** In UTF-8 bytes: the store bounds `refs/heads/<branch>` at 255 bytes, so characters are not enough. */
export const TARGET_BRANCH_MAX_BYTES = 200;
export const CHECK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Caller identifier grammar (1–128 chars), aligned with `contracts/execution-lanes.ts` and `lane-schema.ts`. */
export const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** `git check-ref-format --branch`: none of these anywhere in the name. */
const BRANCH_FORBIDDEN = /[ ~^:?*[\\]|\.\.|@\{|\/\/|\/\.|\.lock\//;
/** Code points below this, and DEL, are control characters. */
const FIRST_PRINTABLE_CODE_POINT = 0x20;
const DEL_CODE_POINT = 0x7f;
const BRANCH_FORBIDDEN_ENDS = Object.freeze(['.', '/', '.lock']);
const BRANCH_FORBIDDEN_STARTS = Object.freeze(['-', '/', '.']);
/** The single character `@` names HEAD to Git. */
const BRANCH_RESERVED = '@';

function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < FIRST_PRINTABLE_CODE_POINT || code === DEL_CODE_POINT) return true;
  }
  return false;
}

/** The `git check-ref-format --branch` rules, applied without calling Git (contract §7). */
export function isValidTargetBranch(name: string): boolean {
  if (name.length === 0 || Buffer.byteLength(name, 'utf8') > TARGET_BRANCH_MAX_BYTES) return false;
  if (name === BRANCH_RESERVED || BRANCH_FORBIDDEN.test(name) || hasControlCharacter(name)) return false;
  if (BRANCH_FORBIDDEN_STARTS.some((prefix) => name.startsWith(prefix))) return false;
  return !BRANCH_FORBIDDEN_ENDS.some((suffix) => name.endsWith(suffix));
}

/** Plain object check (`Object.prototype` or `null` prototype, never arrays or class instances). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isValidArgument(arg: unknown): arg is string {
  return typeof arg === 'string' && arg.length > 0 && arg.length <= VERIFICATION_LIMITS.maxArgChars && !arg.includes('\u0000');
}

function snapshotCheck(check: unknown): VerificationCheck | null {
  if (!isPlainObject(check)) return null;
  const keys = Object.keys(check).sort();
  if (keys.join(',') !== 'argv,name,timeoutMs') return null;
  let name: unknown;
  let rawArgv: unknown;
  let timeoutMs: unknown;
  try {
    name = check['name'];
    rawArgv = check['argv'];
    timeoutMs = check['timeoutMs'];
  } catch {
    return null;
  }
  if (typeof name !== 'string' || !CHECK_NAME_PATTERN.test(name)) return null;
  if (!Array.isArray(rawArgv)) return null;
  const argvLen = rawArgv.length;
  if (argvLen === 0 || argvLen > VERIFICATION_LIMITS.maxArgs) return null;
  const argv: string[] = [];
  for (let i = 0; i < argvLen; i += 1) {
    if (!Object.hasOwn(rawArgv, i)) return null;
    let item: unknown;
    try {
      item = rawArgv[i];
    } catch {
      return null;
    }
    if (!isValidArgument(item)) return null;
    argv.push(item);
  }
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < VERIFICATION_LIMITS.minTimeoutMs ||
    timeoutMs > VERIFICATION_LIMITS.maxTimeoutMs
  ) {
    return null;
  }
  return Object.freeze({ name, argv: Object.freeze(argv), timeoutMs });
}

/**
 * The profile as stored and digested: fixed key order, checks in their given order. Throws on a
 * value no `isValidProfile` accepts.
 */
export function canonicalProfileJson(profile: VerificationProfile): string {
  return JSON.stringify({
    profileId: profile.profileId,
    revision: profile.revision,
    checks: profile.checks.map((check) => ({ name: check.name, argv: [...check.argv], timeoutMs: check.timeoutMs }))
  });
}

export function profileDigest(canonicalJson: string): string {
  return createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

/**
 * Validates and deep-snapshots a `VerificationProfile` in a single pass (reading every property
 * and array element at most once) so accessor getters or post-call mutations cannot diverge across
 * validation and async use. Returns `null` when invalid.
 */
export function snapshotVerificationProfile(profile: unknown): VerificationProfile | null {
  if (!isPlainObject(profile)) return null;
  if (Object.keys(profile).sort().join(',') !== 'checks,profileId,revision') return null;
  let profileId: unknown;
  let revision: unknown;
  let rawChecks: unknown;
  try {
    profileId = profile['profileId'];
    revision = profile['revision'];
    rawChecks = profile['checks'];
  } catch {
    return null;
  }
  if (typeof profileId !== 'string' || !PROFILE_ID_PATTERN.test(profileId)) return null;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return null;
  if (!Array.isArray(rawChecks)) return null;
  const checkLen = rawChecks.length;
  if (checkLen === 0 || checkLen > VERIFICATION_LIMITS.maxChecks) return null;
  const checks: VerificationCheck[] = [];
  for (let i = 0; i < checkLen; i += 1) {
    if (!Object.hasOwn(rawChecks, i)) return null;
    let rawCheck: unknown;
    try {
      rawCheck = rawChecks[i];
    } catch {
      return null;
    }
    const snapped = snapshotCheck(rawCheck);
    if (snapped === null) return null;
    checks.push(snapped);
  }
  const snapshot: VerificationProfile = Object.freeze({
    profileId,
    revision,
    checks: Object.freeze(checks)
  });
  const json = canonicalProfileJson(snapshot);
  if (Buffer.byteLength(json, 'utf8') > VERIFICATION_LIMITS.maxProfileJsonBytes) return null;
  return snapshot;
}

/** Research R9 and `VERIFICATION_LIMITS`, the canonical JSON size included. */
export function isValidProfile(profile: unknown): profile is VerificationProfile {
  return snapshotVerificationProfile(profile) !== null;
}

/** Reads a profile frozen on a request; `null` when the stored text no longer validates. */
export function parseFrozenProfile(json: string): VerificationProfile | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  return snapshotVerificationProfile(value);
}
