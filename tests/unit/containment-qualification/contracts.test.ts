// FR-R6-F09 T002 -- the closed vocabulary of containment qualification.
//
// WHAT THIS PINS: every list is frozen and duplicate-free; the consentable reasons are a subset of
// the refusal reasons; the fingerprint comparison order and the effect order are fixed.

import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_BINDINGS_KEY,
  ACCEPTANCE_BINDINGS_MAX_BYTES,
  ACCEPTANCE_ORIGINS,
  CONSENTABLE_REFUSAL_REASONS,
  CONTAINMENT_EFFECTS,
  CONTAINMENT_REFUSAL_REASONS,
  EFFECT_OUTCOMES,
  EFFECT_RESIDUALS,
  EVIDENCE_BASES,
  EXECUTABLE_UNRESOLVED_CAUSES,
  FINGERPRINT_COMPONENTS,
  IDENTITY_STATES,
  OBSERVED_COMPONENTS,
  TEARDOWN_OUTCOMES,
  TEARDOWN_RESIDUALS
} from '../../../src/contracts/containment-qualification';

const LISTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['CONTAINMENT_EFFECTS', CONTAINMENT_EFFECTS],
  ['EFFECT_OUTCOMES', EFFECT_OUTCOMES],
  ['EVIDENCE_BASES', EVIDENCE_BASES],
  ['OBSERVED_COMPONENTS', OBSERVED_COMPONENTS],
  ['EFFECT_RESIDUALS', EFFECT_RESIDUALS],
  ['CONTAINMENT_REFUSAL_REASONS', CONTAINMENT_REFUSAL_REASONS],
  ['CONSENTABLE_REFUSAL_REASONS', CONSENTABLE_REFUSAL_REASONS],
  ['EXECUTABLE_UNRESOLVED_CAUSES', EXECUTABLE_UNRESOLVED_CAUSES],
  ['FINGERPRINT_COMPONENTS', FINGERPRINT_COMPONENTS],
  ['ACCEPTANCE_ORIGINS', ACCEPTANCE_ORIGINS],
  ['IDENTITY_STATES', IDENTITY_STATES],
  ['TEARDOWN_OUTCOMES', TEARDOWN_OUTCOMES],
  ['TEARDOWN_RESIDUALS', TEARDOWN_RESIDUALS]
];

describe('FR-R6-F09 T002 -- containment qualification contracts', () => {
  it.each(LISTS)('%s is frozen, non-empty and duplicate-free', (_name, list) => {
    expect(Object.isFrozen(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
    expect(new Set(list).size).toBe(list.length);
  });

  it('lists the six effects in record order', () => {
    expect([...CONTAINMENT_EFFECTS]).toEqual([
      'fs-read',
      'fs-write',
      'process-creation',
      'network',
      'credential-exposure',
      'descendant-lifetime'
    ]);
  });

  it('offers consent for exactly the two consentable reasons, both refusal reasons', () => {
    expect([...CONSENTABLE_REFUSAL_REASONS]).toEqual([
      'containment-unqualified-for-tuple',
      'acceptance-fingerprint-changed'
    ]);
    for (const reason of CONSENTABLE_REFUSAL_REASONS) {
      expect(CONTAINMENT_REFUSAL_REASONS).toContain(reason);
    }
    expect(CONTAINMENT_REFUSAL_REASONS).toHaveLength(6);
  });

  it('pins the fingerprint comparison order', () => {
    expect([...FINGERPRINT_COMPONENTS]).toEqual([
      'backend',
      'version',
      'os',
      'arch',
      'mechanism',
      'environment-policy',
      'flag-surface'
    ]);
  });

  it('names the binding key and the 8 KiB bound', () => {
    expect(ACCEPTANCE_BINDINGS_KEY).toBe('schegent.backend.acceptanceBindings.v1');
    expect(ACCEPTANCE_BINDINGS_MAX_BYTES).toBe(8192);
  });
});
