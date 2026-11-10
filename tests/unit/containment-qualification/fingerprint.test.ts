// FR-R6-F09 T020 -- the enforcement fingerprint (research R6).
//
// WHAT THIS PINS: a 64-hex deterministic digest; each of the seven components changes it; a patch
// upgrade cannot, because only `major.minor` is a component; `diffFingerprint` names the first
// changed component in the fixed order and can skip the version; no component holds a path or an
// environment value.

import { describe, expect, it } from 'vitest';
import {
  FINGERPRINT_COMPONENTS,
  type BackendIdentity
} from '../../../src/contracts/containment-qualification';
import {
  computeFingerprint,
  diffFingerprint,
  environmentPolicyDigestOf,
  versionMinorOf
} from '../../../src/services/containment-qualification/fingerprint';

const HEX_64 = /^[0-9a-f]{64}$/;
const SEEDED = 'F09-SEEDED-SECRET';

const ENV_DIGEST = environmentPolicyDigestOf({
  mode: 'allowlist',
  inheritProcessEnv: false,
  processEnvAllowlist: ['PATH', 'HOME']
});

const CLAUDE: BackendIdentity = Object.freeze({
  kind: 'claude',
  executable: 'resolved',
  versionMinor: '2.1',
  os: 'darwin',
  arch: 'arm64',
  environmentPolicyDigest: ENV_DIGEST
});

describe('FR-R6-F09 T020 -- versionMinorOf', () => {
  it.each([
    ['codex-cli 0.163.0', '0.163'],
    ['2.1.321 (Claude Code)', '2.1'],
    ['1.5.2', '1.5'],
    ['v10.0', '10.0']
  ])('%s gives %s', (line, minor) => {
    expect(versionMinorOf(line)).toBe(minor);
  });

  it.each([null, '', 'unknown', 'build 7', '1234567.1'])('%s is unverified', (line) => {
    expect(versionMinorOf(line)).toBeNull();
  });
});

describe('FR-R6-F09 T020 -- environmentPolicyDigestOf', () => {
  it('is 64 hex, ignores allowlist order, and never holds a name or value', () => {
    const reordered = environmentPolicyDigestOf({
      mode: 'allowlist',
      inheritProcessEnv: false,
      processEnvAllowlist: ['HOME', 'PATH']
    });
    expect(ENV_DIGEST).toMatch(HEX_64);
    expect(reordered).toBe(ENV_DIGEST);
    expect(ENV_DIGEST).not.toContain('PATH');
  });

  it('changes with the mode, the inheritance and the allowlist names', () => {
    const others = [
      environmentPolicyDigestOf({ mode: 'minimal', inheritProcessEnv: false }),
      environmentPolicyDigestOf({ mode: 'allowlist', inheritProcessEnv: true, processEnvAllowlist: ['PATH', 'HOME'] }),
      environmentPolicyDigestOf({ mode: 'allowlist', inheritProcessEnv: false, processEnvAllowlist: ['PATH'] })
    ];
    for (const other of others) {
      expect(other).not.toBe(ENV_DIGEST);
    }
  });
});

describe('FR-R6-F09 T020 -- computeFingerprint', () => {
  it('is a deterministic 64-hex digest over the seven components', () => {
    const a = computeFingerprint(CLAUDE);
    const b = computeFingerprint({ ...CLAUDE });
    expect(a.digest).toMatch(HEX_64);
    expect(b.digest).toBe(a.digest);
    expect(Object.keys(a.components)).toEqual([...FINGERPRINT_COMPONENTS]);
    expect(a.components.backend).toBe('claude');
    expect(a.components.version).toBe('2.1');
    expect(a.components.mechanism).toBe('none');
    expect(a.components['environment-policy']).toBe(ENV_DIGEST);
    expect(a.components['flag-surface']).toMatch(HEX_64);
  });

  it('records an unverified version as the word unverified', () => {
    expect(computeFingerprint({ ...CLAUDE, versionMinor: null }).components.version).toBe('unverified');
  });

  it.each([
    ['backend', { kind: 'agy' }],
    ['version', { versionMinor: '2.2' }],
    ['os', { os: 'linux' }],
    ['arch', { arch: 'x64' }],
    ['environment-policy', { environmentPolicyDigest: 'f'.repeat(64) }]
  ] as const)('a changed %s changes the digest and is named by the diff', (component, change) => {
    const base = computeFingerprint(CLAUDE);
    const next = computeFingerprint({ ...CLAUDE, ...change });
    expect(next.digest).not.toBe(base.digest);
    expect(diffFingerprint(base, next, { ignoreVersion: false })).toBe(component);
  });

  it('a different kind also changes the mechanism and the flag surface', () => {
    const codex = computeFingerprint({ ...CLAUDE, kind: 'codex' });
    const claude = computeFingerprint(CLAUDE);
    expect(codex.components.mechanism).toBe('codex-sandbox-workspace-write');
    expect(codex.components['flag-surface']).not.toBe(claude.components['flag-surface']);
  });

  it('names the FIRST changed component in the fixed order', () => {
    const base = computeFingerprint(CLAUDE);
    const next = computeFingerprint({ ...CLAUDE, arch: 'x64', versionMinor: '3.0' });
    expect(diffFingerprint(base, next, { ignoreVersion: false })).toBe('version');
    expect(diffFingerprint(base, next, { ignoreVersion: true })).toBe('arch');
  });

  it('gives no difference for equal records and when only an ignored version differs', () => {
    const base = computeFingerprint(CLAUDE);
    expect(diffFingerprint(base, computeFingerprint(CLAUDE), { ignoreVersion: false })).toBeNull();
    const unverified = computeFingerprint({ ...CLAUDE, versionMinor: null });
    expect(diffFingerprint(base, unverified, { ignoreVersion: true })).toBeNull();
  });

  it('a patch upgrade cannot change it, because only major.minor is a component', () => {
    const before = computeFingerprint({ ...CLAUDE, versionMinor: versionMinorOf('2.1.316 (Claude Code)') });
    const after = computeFingerprint({ ...CLAUDE, versionMinor: versionMinorOf('2.1.321 (Claude Code)') });
    expect(after.digest).toBe(before.digest);
  });

  it('holds no path, separator or seeded secret in any component', () => {
    const fp = computeFingerprint(CLAUDE);
    for (const value of Object.values(fp.components)) {
      expect(value.length).toBeLessThanOrEqual(80);
      expect(value).not.toContain('/');
      expect(value).not.toContain('\\');
      expect(value).not.toContain(SEEDED);
    }
  });
});
