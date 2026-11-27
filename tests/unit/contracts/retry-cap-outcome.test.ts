import { describe, it, expect } from 'vitest';
import {
  resolveRetryCapOutcome,
  statesRetryCapOutcome,
  type RetryCapDefLike
} from '../../../src/contracts/retry-cap-outcome';
import { RETRY_CAP_OUTCOMES, type RetryCapOutcome } from '../../../src/contracts/process-definitions';

/**
 * FR-R3-157 — contract C1. The resolution table is TOTAL: every combination of the
 * three inputs returns one of exactly three outcomes, and no input throws.
 *
 * The rows below are contract C1.2 transcribed, in its order. Where the contract
 * says "any / absent" the row is expanded over every value that phrase covers, so
 * a change that made the ignored input matter would fail here rather than pass by
 * happening not to be exercised.
 */
describe('resolveRetryCapOutcome — contract C1', () => {
  const ANY_BOOL: ReadonlyArray<boolean | undefined> = [true, false, undefined];

  describe('C1.2 rows 1-3: a stated outcome wins over everything (FR-006, spec A4)', () => {
    for (const stated of RETRY_CAP_OUTCOMES) {
      for (const deprecated of ANY_BOOL) {
        for (const workspaceDefault of ANY_BOOL) {
          const label =
            `onRetryCap=${stated}, forceContinueOnRetryCap=${String(deprecated)}, ` +
            `workspaceDefault=${String(workspaceDefault)}`;
          it(`returns '${stated}' for ${label}`, () => {
            const phaseDef: RetryCapDefLike = {
              onRetryCap: stated,
              ...(deprecated === undefined ? {} : { forceContinueOnRetryCap: deprecated })
            };
            expect(resolveRetryCapOutcome(phaseDef, workspaceDefault)).toBe(stated);
          });
        }
      }
    }
  });

  describe('C1.2 rows 4-5: the deprecated switch maps onto the new vocabulary (FR-006)', () => {
    for (const workspaceDefault of ANY_BOOL) {
      it(`true maps to 'continue' regardless of the workspace default (${String(workspaceDefault)})`, () => {
        expect(resolveRetryCapOutcome({ forceContinueOnRetryCap: true }, workspaceDefault)).toBe(
          'continue'
        );
      });

      it(`false maps to 'fail' regardless of the workspace default (${String(workspaceDefault)})`, () => {
        expect(resolveRetryCapOutcome({ forceContinueOnRetryCap: false }, workspaceDefault)).toBe(
          'fail'
        );
      });
    }
  });

  describe('C1.2 rows 6-8: the workspace default applies only when the phase states nothing (FR-005)', () => {
    it("returns 'continue' when the workspace default is true", () => {
      expect(resolveRetryCapOutcome({}, true)).toBe('continue');
    });

    it("returns 'fail' when the workspace default is false", () => {
      expect(resolveRetryCapOutcome({}, false)).toBe('fail');
    });

    it("returns 'fail' when absent everywhere (FR-005)", () => {
      expect(resolveRetryCapOutcome({}, undefined)).toBe('fail');
    });
  });

  describe('C1.2 rows 9-10: no phase definition at all', () => {
    it("returns 'continue' when the workspace default is true", () => {
      expect(resolveRetryCapOutcome(undefined, true)).toBe('continue');
    });

    it("returns 'fail' when the workspace default is false", () => {
      expect(resolveRetryCapOutcome(undefined, false)).toBe('fail');
    });

    it("returns 'fail' when the workspace default is absent", () => {
      expect(resolveRetryCapOutcome(undefined, undefined)).toBe('fail');
    });
  });

  /**
   * C1.1 — totality, asserted as a property rather than a row. Every combination of
   * the three inputs, including the ones the rows above cover, returns a member of
   * the frozen vocabulary and does not throw. A future fourth outcome that forgot a
   * branch would fall out here as `undefined`.
   */
  it('C1.1: is total over every input combination, with no throw path', () => {
    const statedValues: ReadonlyArray<RetryCapOutcome | undefined> = [
      ...RETRY_CAP_OUTCOMES,
      undefined
    ];
    const outcomes = new Set<string>();

    for (const stated of statedValues) {
      for (const deprecated of ANY_BOOL) {
        for (const workspaceDefault of ANY_BOOL) {
          const phaseDef: RetryCapDefLike = {
            ...(stated === undefined ? {} : { onRetryCap: stated }),
            ...(deprecated === undefined ? {} : { forceContinueOnRetryCap: deprecated })
          };
          const result = resolveRetryCapOutcome(phaseDef, workspaceDefault);
          expect(RETRY_CAP_OUTCOMES).toContain(result);
          outcomes.add(result);
        }
      }
    }

    for (const workspaceDefault of ANY_BOOL) {
      const result = resolveRetryCapOutcome(undefined, workspaceDefault);
      expect(RETRY_CAP_OUTCOMES).toContain(result);
      outcomes.add(result);
    }

    // All three are reachable. A resolver that collapsed to one value would satisfy
    // every assertion above this line except this one.
    expect([...outcomes].sort()).toEqual([...RETRY_CAP_OUTCOMES].sort());
  });

  it('C1.3: the stated outcome wins over the deprecated switch that contradicts it', () => {
    expect(
      resolveRetryCapOutcome({ onRetryCap: 'fail', forceContinueOnRetryCap: true }, true)
    ).toBe('fail');
    expect(
      resolveRetryCapOutcome({ onRetryCap: 'continue', forceContinueOnRetryCap: false }, false)
    ).toBe('continue');
    expect(
      resolveRetryCapOutcome(
        { onRetryCap: 'continue-degraded', forceContinueOnRetryCap: false },
        false
      )
    ).toBe('continue-degraded');
  });

  it('C1.3: the phase wins over the workspace default that contradicts it', () => {
    expect(resolveRetryCapOutcome({ forceContinueOnRetryCap: false }, true)).toBe('fail');
    expect(resolveRetryCapOutcome({ forceContinueOnRetryCap: true }, false)).toBe('continue');
  });
});

/**
 * FR-R3-157 (T048, FR-016, SC-011) — the other half of what the editor must say.
 *
 * `resolveRetryCapOutcome` answers "which outcome", and on its own that is not
 * enough for the control: `'fail'` is both the commonest stated outcome and the
 * value a workspace that has configured nothing falls back to, so the answer alone
 * cannot tell an operator whether editing the workspace setting would move this
 * phase. This predicate answers "whose outcome is it", and it lives beside the
 * resolver for the reason the resolver is here at all — the two answers are read
 * together at every call site, and a surface that derived this one locally would be
 * the second reader in everything but name.
 */
describe('statesRetryCapOutcome — stated or inherited (C4.5)', () => {
  it('is true for a phase that states the new form', () => {
    for (const outcome of RETRY_CAP_OUTCOMES) {
      expect(statesRetryCapOutcome({ onRetryCap: outcome })).toBe(true);
    }
  });

  it('is true for a phase that states only the deprecated switch, in EITHER position', () => {
    // The row this exists for. `false` is the trap: it is the same outcome the
    // unconfigured default produces, so a predicate written as a truthiness check
    // would call this phase "inherited" and be wrong in the one direction that
    // matters — an author who wrote `false` deliberately, to hold this phase to
    // `'fail'` in a workspace whose default is `'continue'`, would be shown a
    // reading that says the workspace decides.
    expect(statesRetryCapOutcome({ forceContinueOnRetryCap: true })).toBe(true);
    expect(statesRetryCapOutcome({ forceContinueOnRetryCap: false })).toBe(true);
  });

  it('is false for a phase that states neither form, and for no definition at all', () => {
    expect(statesRetryCapOutcome({})).toBe(false);
    expect(statesRetryCapOutcome(undefined)).toBe(false);
  });

  it('agrees with the resolver: a phase that states nothing is the only one the default moves', () => {
    // The two functions are one answer read in two halves, so the property that
    // binds them is asserted rather than left to the reader: flipping the workspace
    // default changes the resolved outcome for exactly the definitions this
    // predicate calls inherited.
    const definitions: readonly (RetryCapDefLike | undefined)[] = [
      undefined,
      {},
      { onRetryCap: 'fail' },
      { onRetryCap: 'continue' },
      { onRetryCap: 'continue-degraded' },
      { forceContinueOnRetryCap: true },
      { forceContinueOnRetryCap: false },
      { onRetryCap: 'fail', forceContinueOnRetryCap: true }
    ];

    for (const definition of definitions) {
      const movedByDefault =
        resolveRetryCapOutcome(definition, true) !== resolveRetryCapOutcome(definition, false);
      expect(
        movedByDefault,
        `${JSON.stringify(definition)} is ${statesRetryCapOutcome(definition) ? 'stated' : 'inherited'}, ` +
          'so the workspace default must ' +
          (statesRetryCapOutcome(definition) ? 'not ' : '') +
          'move its resolved outcome'
      ).toBe(!statesRetryCapOutcome(definition));
    }
  });
});
