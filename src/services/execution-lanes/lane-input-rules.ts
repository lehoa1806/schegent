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
export const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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

function isValidArgument(arg: unknown): boolean {
  return typeof arg === 'string' && arg.length > 0 && arg.length <= VERIFICATION_LIMITS.maxArgChars && !arg.includes('\u0000');
}

function isValidCheck(check: unknown): check is VerificationCheck {
  if (typeof check !== 'object' || check === null || Array.isArray(check)) return false;
  const keys = Object.keys(check).sort();
  if (keys.join(',') !== 'argv,name,timeoutMs') return false;
  const { name, argv, timeoutMs } = check as Record<string, unknown>;
  if (typeof name !== 'string' || !CHECK_NAME_PATTERN.test(name)) return false;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > VERIFICATION_LIMITS.maxArgs) return false;
  if (!argv.every(isValidArgument)) return false;
  return (
    typeof timeoutMs === 'number' &&
    Number.isInteger(timeoutMs) &&
    timeoutMs >= VERIFICATION_LIMITS.minTimeoutMs &&
    timeoutMs <= VERIFICATION_LIMITS.maxTimeoutMs
  );
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

/** Research R9 and `VERIFICATION_LIMITS`, the canonical JSON size included. */
export function isValidProfile(profile: unknown): profile is VerificationProfile {
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return false;
  if (Object.keys(profile).sort().join(',') !== 'checks,profileId,revision') return false;
  const { profileId, revision, checks } = profile as Record<string, unknown>;
  if (typeof profileId !== 'string' || !PROFILE_ID_PATTERN.test(profileId)) return false;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return false;
  if (!Array.isArray(checks) || checks.length === 0 || checks.length > VERIFICATION_LIMITS.maxChecks) return false;
  if (!checks.every(isValidCheck)) return false;
  const json = canonicalProfileJson(profile as VerificationProfile);
  return Buffer.byteLength(json, 'utf8') <= VERIFICATION_LIMITS.maxProfileJsonBytes;
}

/** Reads a profile frozen on a request; `null` when the stored text no longer validates. */
export function parseFrozenProfile(json: string): VerificationProfile | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  return isValidProfile(value) ? value : null;
}
