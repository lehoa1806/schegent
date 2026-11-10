// FR-R6-F09 T033 -- `qualifyTeardown` (FR-009, FR-010; research R12).
//
// WHAT THIS PINS: each ladder result maps to its qualification outcome and residuals, a confirmed
// group exit always carries the standing residual, and no ladder result maps to anything that
// reads as a release: the vocabulary has no such word, so uncertainty cannot become permission.

import { describe, expect, it } from 'vitest';
import type { TreeTeardownResult } from '../../../src/contracts/backend-runner';
import { TEARDOWN_OUTCOMES, TEARDOWN_RESIDUALS } from '../../../src/contracts/containment-qualification';
import { qualifyTeardown } from '../../../src/services/containment-qualification/teardown-qualification';

const LADDER_RESULTS: readonly TreeTeardownResult[] = [
  'group-gone',
  'tree-unconfirmed',
  'bound-elapsed',
  'platform-unanswerable'
];

describe('FR-R6-F09 T033 -- qualifyTeardown (research R12)', () => {
  it.each([
    ['group-gone', 'group-exit-confirmed', ['descendants-outside-group-undetectable']],
    ['tree-unconfirmed', 'residual', ['group-survived']],
    ['bound-elapsed', 'residual', ['bound-elapsed']],
    ['platform-unanswerable', 'unanswerable', []]
  ] as const)('%s -> %s %j', (result, outcome, residuals) => {
    expect(qualifyTeardown(result)).toEqual({ outcome, residuals });
  });

  it('a confirmed group exit never claims every descendant is gone (FR-009)', () => {
    const confirmed = LADDER_RESULTS.map(qualifyTeardown).filter((q) => q.outcome === 'group-exit-confirmed');
    expect(confirmed).toHaveLength(1);
    expect(confirmed.at(0)?.residuals).toContain('descendants-outside-group-undetectable');
  });

  it('no ladder result maps to a release -- every outcome is in the closed vocabulary (FR-010)', () => {
    for (const result of LADDER_RESULTS) {
      const qualification = qualifyTeardown(result);
      expect(TEARDOWN_OUTCOMES).toContain(qualification.outcome);
      for (const residual of qualification.residuals) expect(TEARDOWN_RESIDUALS).toContain(residual);
    }
    expect([...TEARDOWN_OUTCOMES].some((word) => /releas|redispatch|clear/i.test(word))).toBe(false);
  });

  it('an elapsed bound stays a residual, not a confirmation (FR-010)', () => {
    expect(qualifyTeardown('bound-elapsed').outcome).not.toBe('group-exit-confirmed');
  });

  it('the answer is frozen, so a caller cannot edit a shared residual list', () => {
    const qualification = qualifyTeardown('group-gone');
    expect(Object.isFrozen(qualification)).toBe(true);
    expect(Object.isFrozen(qualification.residuals)).toBe(true);
  });
});
