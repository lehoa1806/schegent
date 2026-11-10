// FR-R6-F09 (FR-004, FR-013; research R6, R7) -- the enforcement fingerprint.
//
// WHAT IT IS. SHA-256 over seven components in a fixed order: the backend, its `major.minor`
// version, the host platform and architecture, the containment mechanism, a digest of the
// environment policy, and a digest of the confirmed flag surface. The components are kept beside
// the digest, so a mismatch names the first changed one.
//
// WHAT IT IS NOT. No path is a component: the executable location is identity, not configuration.
// No environment value is one either: the policy digest covers the mode, the inheritance switch
// and the sorted allowlist NAMES. A patch upgrade cannot change the digest, because only
// `major.minor` is a component.

import { createHash } from 'node:crypto';
import type { BackendRunnerKind } from '../../contracts/backend-kinds';
import {
  FINGERPRINT_COMPONENTS,
  VERSION_MINOR_PATTERN,
  type BackendIdentity,
  type FingerprintComponent,
  type FingerprintRecord
} from '../../contracts/containment-qualification';
import type { ProcessEnvironmentPolicy } from '../../contracts/process-environment-policy';
import { mechanismOf } from '../backend-containment-policy';
import { CONFIRMED_FLAGS } from '../capability-confirmed-flags';

/** The version component of an identity whose version could not be read. */
export const UNVERIFIED_VERSION = 'unverified';

const MAJOR_MINOR = /(\d+)\.(\d+)/;

function sha256(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}

/**
 * `major.minor` from a CLI's normalised `--version` line: the first `(\d+)\.(\d+)` match, or
 * `null` (unverified) when there is none or it exceeds six digits a side.
 */
export function versionMinorOf(line: string | null): string | null {
  if (line === null) return null;
  const minor = MAJOR_MINOR.exec(line)?.at(0);
  if (minor === undefined || !VERSION_MINOR_PATTERN.test(minor)) return null;
  return minor;
}

/** The policy's mode, inheritance switch and sorted allowlist names. Never a value. */
export function environmentPolicyDigestOf(policy: ProcessEnvironmentPolicy): string {
  const names = policy.processEnvAllowlist === undefined ? null : [...policy.processEnvAllowlist].sort();
  return sha256(['env1', policy.mode, policy.inheritProcessEnv, names]);
}

function flagSurfaceDigestOf(kind: BackendRunnerKind): string {
  return sha256(['flags1', kind, [...CONFIRMED_FLAGS[kind]].sort()]);
}

export function computeFingerprint(identity: BackendIdentity): FingerprintRecord {
  const components: Readonly<Record<FingerprintComponent, string>> = Object.freeze({
    backend: identity.kind,
    version: identity.versionMinor ?? UNVERIFIED_VERSION,
    os: identity.os,
    arch: identity.arch,
    mechanism: mechanismOf(identity.kind),
    'environment-policy': identity.environmentPolicyDigest,
    'flag-surface': flagSurfaceDigestOf(identity.kind)
  });
  const digest = sha256(['fp1', ...FINGERPRINT_COMPONENTS.map((name) => components[name])]);
  return Object.freeze({ digest, components });
}

/**
 * The first component, in `FINGERPRINT_COMPONENTS` order, whose value differs; `null` when none
 * does. `ignoreVersion` skips the version (FR-013: an unverified version on a backend that claims
 * no containment neither blocks it nor asks for a rebind).
 */
export function diffFingerprint(
  a: FingerprintRecord,
  b: FingerprintRecord,
  opts: { readonly ignoreVersion: boolean }
): FingerprintComponent | null {
  for (const name of FINGERPRINT_COMPONENTS) {
    if (opts.ignoreVersion && name === 'version') continue;
    if (a.components[name] !== b.components[name]) return name;
  }
  return null;
}
