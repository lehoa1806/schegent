// FR-R6-F09 T015 + T022 -- `judgeSpawnAdmission`, research R11 steps 3, 5, 6 and 7.
//
// WHAT THIS PINS:
//   - an unresolved executable refuses first, not consentable, with the cause;
//   - qualified codex is contained with no grant;
//   - unqualified codex, claude and agy without a grant refuse `containment-unqualified-for-tuple`,
//     consentable, carrying the fingerprint;
//   - a grant with no binding admits and asks for a `legacy-first-use` bind;
//   - an equal binding admits with no write; a different one refuses
//     `acceptance-fingerprint-changed`, consentable, naming the first changed component;
//   - an unverified version on a no-claim backend skips the version comparison (FR-013);
//   - a binding a newer host wrote refuses, not consentable.

import { describe, expect, it } from 'vitest';
import type { BackendRunnerKind } from '../../../src/contracts/backend-kinds';
import type {
  AcceptanceBinding,
  AdmissionVerdict,
  BackendIdentity
} from '../../../src/contracts/containment-qualification';
import { judgeSpawnAdmission } from '../../../src/services/containment-qualification/admission';
import { computeFingerprint } from '../../../src/services/containment-qualification/fingerprint';

const ENV = 'e'.repeat(64);
const NONE: ReadonlySet<BackendRunnerKind> = new Set();

function identity(over: Partial<BackendIdentity> & { kind: BackendRunnerKind }): BackendIdentity {
  return {
    executable: 'resolved',
    versionMinor: '0.163',
    os: 'darwin',
    arch: 'arm64',
    environmentPolicyDigest: ENV,
    ...over
  };
}

function bindingFor(id: BackendIdentity): AcceptanceBinding {
  return { fingerprint: computeFingerprint(id), origin: 'consent', boundAt: '2026-11-10T00:00:00.000Z' };
}

function refused(verdict: AdmissionVerdict): Extract<AdmissionVerdict, { outcome: 'refused' }> {
  if (verdict.outcome !== 'refused') throw new Error('expected a refusal');
  return verdict;
}

function admitted(verdict: AdmissionVerdict): Extract<AdmissionVerdict, { outcome: 'admitted' }> {
  if (verdict.outcome !== 'admitted') throw new Error('expected an admission');
  return verdict;
}

const CLAUDE = identity({ kind: 'claude', versionMinor: '2.1' });
const CLAUDE_GRANT: ReadonlySet<BackendRunnerKind> = new Set(['claude']);

describe('FR-R6-F09 T015 -- step 3: the executable must resolve', () => {
  it.each(['not-found', 'not-executable'] as const)('%s refuses first, not consentable', (cause) => {
    const verdict = refused(
      judgeSpawnAdmission({ identity: identity({ kind: 'codex', executable: cause }), granted: NONE, binding: null })
    );
    expect(verdict.reason).toBe('backend-executable-unresolved');
    expect(verdict.consentable).toBe(false);
    expect(verdict.cause).toBe(cause);
  });

  it('refuses an unresolved executable even with a grant and an equal binding', () => {
    const id = { ...CLAUDE, executable: 'not-found' as const };
    const verdict = refused(judgeSpawnAdmission({ identity: id, granted: CLAUDE_GRANT, binding: bindingFor(CLAUDE) }));
    expect(verdict.reason).toBe('backend-executable-unresolved');
  });
});

describe('FR-R6-F09 T015 -- steps 5 and 6: qualification and grant', () => {
  it('admits qualified codex as contained with no grant and no binding write', () => {
    const verdict = admitted(judgeSpawnAdmission({ identity: identity({ kind: 'codex' }), granted: NONE, binding: null }));
    expect(verdict.containment).toBe('contained');
    expect(verdict.bindingWrite).toBeUndefined();
    expect(verdict.fingerprint.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    identity({ kind: 'codex', os: 'linux', arch: 'x64' }),
    identity({ kind: 'codex', versionMinor: '0.164' }),
    identity({ kind: 'codex', versionMinor: null }),
    CLAUDE,
    identity({ kind: 'agy', versionMinor: '1.5' })
  ])('refuses $kind $os/$arch $versionMinor without a grant, consentable, with the fingerprint', (id) => {
    const verdict = refused(judgeSpawnAdmission({ identity: id, granted: NONE, binding: null }));
    expect(verdict.reason).toBe('containment-unqualified-for-tuple');
    expect(verdict.consentable).toBe(true);
    expect(verdict.fingerprint).toEqual(computeFingerprint(id));
  });

  it('with a grant and no binding, admits and asks for a legacy-first-use bind', () => {
    const verdict = admitted(judgeSpawnAdmission({ identity: CLAUDE, granted: CLAUDE_GRANT, binding: null }));
    expect(verdict.containment).toBe('accepted-uncontained');
    expect(verdict.bindingWrite).toBe('legacy-first-use');
    expect(verdict.fingerprint).toEqual(computeFingerprint(CLAUDE));
  });

  it('a granted unqualified codex is accepted-unqualified, not uncontained', () => {
    const id = identity({ kind: 'codex', os: 'linux', arch: 'x64' });
    const verdict = admitted(judgeSpawnAdmission({ identity: id, granted: new Set(['codex']), binding: null }));
    expect(verdict.containment).toBe('accepted-unqualified');
  });

  it('a grant for another backend does not count', () => {
    const verdict = refused(judgeSpawnAdmission({ identity: CLAUDE, granted: new Set(['agy']), binding: null }));
    expect(verdict.reason).toBe('containment-unqualified-for-tuple');
  });
});

describe('FR-R6-F09 T022 -- step 7: the acceptance binding', () => {
  it('an equal binding admits with no write', () => {
    const verdict = admitted(
      judgeSpawnAdmission({ identity: CLAUDE, granted: CLAUDE_GRANT, binding: bindingFor(CLAUDE) })
    );
    expect(verdict.containment).toBe('accepted-uncontained');
    expect(verdict.bindingWrite).toBeUndefined();
  });

  it.each([
    ['version', { versionMinor: '2.2' }],
    ['os', { os: 'linux' }],
    ['environment-policy', { environmentPolicyDigest: 'f'.repeat(64) }]
  ] as const)('a changed %s refuses acceptance-fingerprint-changed, consentable, naming it', (component, change) => {
    const verdict = refused(
      judgeSpawnAdmission({ identity: { ...CLAUDE, ...change }, granted: CLAUDE_GRANT, binding: bindingFor(CLAUDE) })
    );
    expect(verdict.reason).toBe('acceptance-fingerprint-changed');
    expect(verdict.consentable).toBe(true);
    expect(verdict.changedComponent).toBe(component);
    expect(verdict.fingerprint).toEqual(computeFingerprint({ ...CLAUDE, ...change }));
  });

  it('a patch upgrade, the same major.minor, is admitted without asking again', () => {
    const verdict = admitted(
      judgeSpawnAdmission({ identity: { ...CLAUDE }, granted: CLAUDE_GRANT, binding: bindingFor(CLAUDE) })
    );
    expect(verdict.outcome).toBe('admitted');
  });

  it('an unverified version on a no-claim backend skips the version and asks for no rebind (FR-013)', () => {
    const unverified = { ...CLAUDE, versionMinor: null };
    const verdict = admitted(
      judgeSpawnAdmission({ identity: unverified, granted: CLAUDE_GRANT, binding: bindingFor(CLAUDE) })
    );
    expect(verdict.bindingWrite).toBeUndefined();
  });

  it('an unverified codex version still compares the version', () => {
    const codex = identity({ kind: 'codex', versionMinor: '0.164' });
    const verdict = refused(
      judgeSpawnAdmission({
        identity: { ...codex, versionMinor: null },
        granted: new Set(['codex']),
        binding: bindingFor(codex)
      })
    );
    expect(verdict.changedComponent).toBe('version');
  });

  it('a binding made while the version was unverified is completed, not refused, once it reads (review R1, FR-013)', () => {
    const verdict = admitted(
      judgeSpawnAdmission({
        identity: CLAUDE,
        granted: CLAUDE_GRANT,
        binding: bindingFor({ ...CLAUDE, versionMinor: null })
      })
    );
    expect(verdict.bindingWrite).toBe('consent');
    expect(verdict.fingerprint).toEqual(computeFingerprint(CLAUDE));
  });

  it('completing an unverified binding still refuses any other changed component', () => {
    const verdict = refused(
      judgeSpawnAdmission({
        identity: { ...CLAUDE, os: 'linux' },
        granted: CLAUDE_GRANT,
        binding: bindingFor({ ...CLAUDE, versionMinor: null })
      })
    );
    expect(verdict.changedComponent).toBe('os');
  });

  it('an unverified codex binding still compares the version once it reads', () => {
    const codex = identity({ kind: 'codex', versionMinor: '0.164' });
    const verdict = refused(
      judgeSpawnAdmission({
        identity: codex,
        granted: new Set(['codex']),
        binding: bindingFor({ ...codex, versionMinor: null })
      })
    );
    expect(verdict.changedComponent).toBe('version');
  });

  it('a binding a newer host wrote refuses, not consentable', () => {
    const verdict = refused(judgeSpawnAdmission({ identity: CLAUDE, granted: CLAUDE_GRANT, binding: 'future-schema' }));
    expect(verdict.reason).toBe('acceptance-fingerprint-changed');
    expect(verdict.consentable).toBe(false);
  });

  it('qualified codex ignores a stale binding', () => {
    const verdict = admitted(
      judgeSpawnAdmission({
        identity: identity({ kind: 'codex' }),
        granted: NONE,
        binding: bindingFor(identity({ kind: 'codex', versionMinor: '0.150' }))
      })
    );
    expect(verdict.containment).toBe('contained');
  });
});
