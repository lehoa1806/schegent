// FR-R6-F09 T009 -- `BackendIdentityCache`: the last identity the gate observed, per backend.
//
// WHAT THIS PINS: one entry per kind, a write replaces it, a read returns a frozen copy the
// caller cannot use to change the cache, and an unobserved kind reads null.

import { describe, expect, it } from 'vitest';
import type { BackendIdentity } from '../../../src/contracts/containment-qualification';
import { BackendIdentityCache } from '../../../src/services/containment-qualification/identity-cache';

const CLAUDE: BackendIdentity = {
  kind: 'claude',
  executable: 'resolved',
  versionMinor: '2.1',
  os: 'darwin',
  arch: 'arm64',
  environmentPolicyDigest: 'e'.repeat(64)
};

describe('FR-R6-F09 T009 -- BackendIdentityCache', () => {
  it('reads null for a kind it never observed', () => {
    expect(new BackendIdentityCache().read('codex')).toBeNull();
  });

  it('keeps one entry per kind, and a write replaces it', () => {
    const cache = new BackendIdentityCache();
    cache.record(CLAUDE);
    cache.record({ ...CLAUDE, versionMinor: '2.2' });
    cache.record({ ...CLAUDE, kind: 'agy', versionMinor: '1.5' });
    expect(cache.read('claude')?.versionMinor).toBe('2.2');
    expect(cache.read('agy')?.versionMinor).toBe('1.5');
    expect(cache.read('codex')).toBeNull();
  });

  it('returns a frozen copy, not the caller object', () => {
    const cache = new BackendIdentityCache();
    const written = { ...CLAUDE };
    cache.record(written);
    written.versionMinor = '9.9';
    const read = cache.read('claude');
    expect(read?.versionMinor).toBe('2.1');
    expect(Object.isFrozen(read)).toBe(true);
  });
});
