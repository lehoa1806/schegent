// FR-R6-F12 T007 (FR-007; research R3) — the comparison revision.
//
// WHAT THIS PINS: the revision is deterministic, has the versioned grammar, and changes when any
// one of the five bound values changes alone.

import { describe, expect, it } from 'vitest';
import { comparisonRevision, type BoundValues } from '../../../src/services/change-review/comparison-revision';

const BASE: BoundValues = {
  candidateCommit: 'a'.repeat(40),
  targetRef: 'refs/heads/main',
  targetCommit: 'b'.repeat(40),
  profileRevision: 3,
  profileDigest: 'digest-1'
};

describe('comparisonRevision', () => {
  it('is deterministic and versioned', () => {
    expect(comparisonRevision(BASE)).toBe(comparisonRevision({ ...BASE }));
    expect(comparisonRevision(BASE)).toMatch(/^cr1-[0-9a-f]{64}$/);
  });

  it.each([
    ['candidateCommit', { candidateCommit: 'c'.repeat(40) }],
    ['targetRef', { targetRef: 'refs/heads/other' }],
    ['targetCommit', { targetCommit: 'd'.repeat(40) }],
    ['profileRevision', { profileRevision: 4 }],
    ['profileDigest', { profileDigest: 'digest-2' }]
  ])('changes when %s changes alone', (_name, change) => {
    expect(comparisonRevision({ ...BASE, ...change })).not.toBe(comparisonRevision(BASE));
  });

  it('cannot be forged by moving text between fields', () => {
    const shifted: BoundValues = { ...BASE, targetRef: 'refs/heads/mai', profileDigest: `n${BASE.profileDigest}` };
    expect(comparisonRevision(shifted)).not.toBe(comparisonRevision(BASE));
  });
});
