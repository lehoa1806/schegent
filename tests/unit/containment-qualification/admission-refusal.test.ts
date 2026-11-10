// FR-R6-F09 T003 -- the spawn admission refusal is a subtype of the uncontained refusal.
//
// WHY A SUBTYPE: the phase runner already marks an uncontained refusal as a pre-spawn refusal, so
// a subtype is treated the same way with no edit there. The message names the kind and the reason
// only: no path, no environment value, no seeded secret.

import { describe, expect, it } from 'vitest';
import {
  CONSENTABLE_REFUSAL_REASONS,
  CONTAINMENT_REFUSAL_REASONS
} from '../../../src/contracts/containment-qualification';
import {
  UncontainedBackendRefusedError,
  isUncontainedBackendRefusal
} from '../../../src/services/backend-containment-policy';
import {
  ContainmentAdmissionRefusedError,
  isContainmentAdmissionRefusal
} from '../../../src/services/containment-qualification/admission-refusal';

const SEEDED = 'F09-SEEDED-SECRET';

describe('FR-R6-F09 T003 -- ContainmentAdmissionRefusedError', () => {
  it.each(CONTAINMENT_REFUSAL_REASONS)('%s is an uncontained refusal subtype', (reason) => {
    const err = new ContainmentAdmissionRefusedError({ kind: 'codex', reason });
    expect(err).toBeInstanceOf(UncontainedBackendRefusedError);
    expect(err).toBeInstanceOf(Error);
    expect(isUncontainedBackendRefusal(err)).toBe(true);
    expect(isContainmentAdmissionRefusal(err)).toBe(true);
    expect(err.kind).toBe('codex');
    expect(err.reason).toBe(reason);
    expect(err.consentable).toBe(CONSENTABLE_REFUSAL_REASONS.includes(reason));
    expect(err.name).toBe('ContainmentAdmissionRefusedError');
  });

  it('names the kind and the reason, and nothing from the environment', () => {
    const err = new ContainmentAdmissionRefusedError({
      kind: 'claude',
      reason: 'backend-executable-unresolved',
      cause: 'not-found'
    });
    expect(err.message).toContain("'claude'");
    expect(err.message).toContain('backend-executable-unresolved');
    expect(err.message).toContain('not-found');
    expect(err.message).not.toContain('/');
    expect(err.message).not.toContain(SEEDED);
    expect(err.executableCause).toBe('not-found');
  });

  it('names the changed component and carries the fingerprint digest', () => {
    const digest = 'a'.repeat(64);
    const err = new ContainmentAdmissionRefusedError({
      kind: 'claude',
      reason: 'acceptance-fingerprint-changed',
      changedComponent: 'version',
      fingerprint: {
        digest,
        components: {
          backend: 'claude',
          version: '2.2',
          os: 'darwin',
          arch: 'arm64',
          mechanism: 'none',
          'environment-policy': 'b'.repeat(64),
          'flag-surface': 'c'.repeat(64)
        }
      }
    });
    expect(err.message).toContain('version');
    expect(err.fingerprintDigest).toBe(digest);
    expect(err.changedComponent).toBe('version');
    expect(err.consentable).toBe(true);
  });

  it('does not recognise a plain uncontained refusal or an arbitrary error', () => {
    expect(isContainmentAdmissionRefusal(new UncontainedBackendRefusedError('agy', 'no'))).toBe(false);
    expect(isContainmentAdmissionRefusal(new Error('x'))).toBe(false);
    expect(isContainmentAdmissionRefusal(null)).toBe(false);
  });

  it('honours an explicit consentable false on a consentable reason', () => {
    const err = new ContainmentAdmissionRefusedError({
      kind: 'agy',
      reason: 'acceptance-fingerprint-changed',
      consentable: false
    });
    expect(err.consentable).toBe(false);
  });

  it('a refusal no consent can lift never tells the operator to accept it again (review R9)', () => {
    const narrowed = new ContainmentAdmissionRefusedError({
      kind: 'claude',
      reason: 'acceptance-fingerprint-changed',
      consentable: false
    });
    const offered = new ContainmentAdmissionRefusedError({ kind: 'claude', reason: 'acceptance-fingerprint-changed' });
    expect(narrowed.message).not.toContain('accept it again');
    expect(narrowed.message).toContain('newer version');
    expect(offered.message).toContain('accept it again');
  });
});
