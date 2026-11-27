// FR-R3-144 (T003/T004) — the clear sentinel belongs to `allowClear`, not to one
// runtime type.
//
// `spend.maxUsdPerRun` is the setting that exposed this. It is nullable (an
// operator clears the bound rather than setting it to zero) AND decimal (USD),
// so it is a `number` that must accept the clear sentinel. No existing spec has
// that pair: every `allowClear` in `KEY_SPECS` today is `number-int-range`, and
// the sentinel branch was written inside that one case. A `number` spec with
// `allowClear: true` therefore refused `null` with `type-mismatch` — the value
// its own manifest default is.
//
// The contract these tests pin, in the order that matters:
//
//  1. `allowClear` decides whether the sentinel is accepted; the numeric runtime
//     type decides everything else.
//  2. It is a NUMERIC clear. Lifting the branch to the top of `checkType` — one
//     `if (value == null && spec.allowClear)` before the switch — would also let
//     a string or array spec accept `null`, which is a hole no caller asked for
//     and no test would have caught, because no such spec exists to fail. The
//     shape is only safe if it is scoped to the types where "cleared" has a
//     meaning: absence of a bound. A cleared string is `''`.
//  3. Accepting the sentinel does not relax the range. `null` is in; `0` against
//     `min: 0.01` is still out of range.

import { describe, expect, it } from 'vitest';

import { checkType } from '../../../src/config/general-settings-validate';
import type { KeySpec } from '../../../src/config/general-settings-keys';

/** A decimal, nullable bound — the shape `spend.maxUsdPerRun` introduces. */
const CLEARABLE_DECIMAL: KeySpec = {
  scope: 'resource',
  type: 'number',
  typedField: 'loopMaxIterations',
  defaultValue: null,
  min: 0.01,
  allowClear: true
};

const PLAIN_DECIMAL: KeySpec = {
  scope: 'resource',
  type: 'number',
  typedField: 'loopMaxIterations',
  defaultValue: 10,
  min: 1
};

/** The pair that already worked, kept here so T004 cannot regress it silently. */
const CLEARABLE_INT: KeySpec = {
  scope: 'resource',
  type: 'number-int-range',
  typedField: 'loopMaxIterations',
  defaultValue: null,
  min: 1,
  allowClear: true
};

const PLAIN_INT: KeySpec = {
  scope: 'resource',
  type: 'number-int-range',
  typedField: 'loopMaxIterations',
  defaultValue: 10,
  min: 1
};

describe('the clear sentinel is a property of allowClear, not of number-int-range', () => {
  it('a `number` spec with allowClear accepts null', () => {
    expect(checkType(CLEARABLE_DECIMAL, null)).toEqual({ ok: true });
  });

  it('a `number` spec with allowClear accepts undefined', () => {
    expect(checkType(CLEARABLE_DECIMAL, undefined)).toEqual({ ok: true });
  });

  it('a `number` spec WITHOUT allowClear still refuses null', () => {
    expect(checkType(PLAIN_DECIMAL, null)).toEqual({ ok: false, reason: 'type-mismatch' });
    expect(checkType(PLAIN_DECIMAL, undefined)).toEqual({
      ok: false,
      reason: 'type-mismatch'
    });
  });

  it('`number-int-range` keeps the behaviour it already had, both ways', () => {
    expect(checkType(CLEARABLE_INT, null)).toEqual({ ok: true });
    expect(checkType(CLEARABLE_INT, undefined)).toEqual({ ok: true });
    expect(checkType(PLAIN_INT, null)).toEqual({ ok: false, reason: 'type-mismatch' });
    expect(checkType(PLAIN_INT, undefined)).toEqual({ ok: false, reason: 'type-mismatch' });
  });

  it('clearing is allowed; violating the range is not', () => {
    expect(checkType(CLEARABLE_DECIMAL, 0)).toEqual({ ok: false, reason: 'out-of-range' });
    expect(checkType(CLEARABLE_DECIMAL, 0.01)).toEqual({ ok: true });
    expect(checkType(CLEARABLE_DECIMAL, 12.5)).toEqual({ ok: true });
  });

  it('the two numeric types still disagree about decimals', () => {
    expect(checkType(CLEARABLE_DECIMAL, 12.5)).toEqual({ ok: true });
    expect(checkType(CLEARABLE_INT, 12.5)).toEqual({ ok: false, reason: 'type-mismatch' });
  });

  it('allowClear on a non-numeric spec does not admit null', () => {
    // No such spec exists in `KEY_SPECS`, which is exactly why this is asserted:
    // a pre-check hoisted above the switch would pass every case here and no
    // production key would fail. The sentinel means "no bound", so it is scoped
    // to the types that have one.
    const clearableString: KeySpec = {
      scope: 'application',
      type: 'string',
      typedField: 'cliPath',
      defaultValue: 'claude',
      allowClear: true
    };
    const clearableList: KeySpec = {
      scope: 'resource',
      type: 'array-of-string',
      typedField: 'fatalSignatures',
      defaultValue: [],
      allowClear: true
    };
    const clearableEnum: KeySpec = {
      scope: 'application',
      type: 'string-enum',
      typedField: 'cliPath',
      defaultValue: 'claude',
      allowedValues: ['claude'],
      allowClear: true
    };

    expect(checkType(clearableString, null)).toEqual({ ok: false, reason: 'type-mismatch' });
    expect(checkType(clearableList, null)).toEqual({ ok: false, reason: 'type-mismatch' });
    expect(checkType(clearableEnum, null)).toEqual({ ok: false, reason: 'type-mismatch' });
  });
});
