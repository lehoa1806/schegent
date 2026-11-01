import { describe, expect, it } from 'vitest';
import { UNKNOWN_BUILD_IDENTITY, readBuildIdentity } from '../../../src/lib/build-identity';

/**
 * FR-R4-F09 (FR-032, US7-4; contract BI3, test T2) -- the runtime read of the build identity.
 *
 * The host reads the identity esbuild stamped into the bundle. Under this test runner, and under
 * the tsc-compiled integration suite, nothing was stamped, so the constant does not exist and the
 * honest answer is "unknown". The value is validated by pattern before it is believed, because the
 * identity is shown in a diagnostics bundle a person attaches to a report: a malformed value is
 * never repaired, truncated or passed through, it becomes the unknown identity.
 *
 * `readBuildIdentity` takes the raw value as an argument, with the stamped constant as its default,
 * so every case below supplies one and no case needs a bundler.
 */
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

describe('a valid stamped value', () => {
  it.each([
    [{ commit: COMMIT, dirty: false, mode: 'production' }],
    [{ commit: COMMIT, dirty: true, mode: 'development' }],
    [{ commit: 'unknown', dirty: 'unknown', mode: 'development' }],
    [{ commit: 'unknown', dirty: 'unknown', mode: 'production' }]
  ])('is read verbatim: %j', (raw) => {
    expect(readBuildIdentity(raw)).toEqual(raw);
  });

  it('keeps only the three fields, whatever else the object carries', () => {
    const identity = readBuildIdentity({ commit: COMMIT, dirty: false, mode: 'production', extra: 'x' });
    expect(Object.keys(identity)).toEqual(['commit', 'dirty', 'mode']);
  });
});

describe('a malformed value becomes the unknown identity', () => {
  const valid = { commit: COMMIT, dirty: false, mode: 'production' };

  it.each([
    ['a 7-character commit', { ...valid, commit: COMMIT.slice(0, 7) }],
    ['an uppercase commit', { ...valid, commit: COMMIT.toUpperCase() }],
    ['a 41-character commit', { ...valid, commit: `${COMMIT}0` }],
    ['an empty commit', { ...valid, commit: '' }],
    ['a commit that is not a string', { ...valid, commit: 123 }],
    ['a missing commit', { dirty: false, mode: 'production' }],
    ['a dirty flag that is a string other than unknown', { ...valid, dirty: 'yes' }],
    ['a dirty flag that is a number', { ...valid, dirty: 0 }],
    ['a dirty flag that is null', { ...valid, dirty: null }],
    ['a missing dirty flag', { commit: COMMIT, mode: 'production' }],
    ['a mode outside the closed set', { ...valid, mode: 'staging' }],
    ['a mode of unknown, which only the unknown identity carries', { ...valid, mode: 'unknown' }],
    ['a missing mode', { commit: COMMIT, dirty: false }]
  ])('%s', (_label, raw) => {
    expect(readBuildIdentity(raw)).toEqual(UNKNOWN_BUILD_IDENTITY);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', '{"commit":"x"}'],
    ['a number', 7],
    ['an array', [COMMIT, false, 'production']],
    ['a function', () => valid]
  ])('and so does a value that is %s', (_label, raw) => {
    expect(readBuildIdentity(raw)).toEqual(UNKNOWN_BUILD_IDENTITY);
  });
});

describe('the unknown identity', () => {
  it('says unknown for all three fields', () => {
    expect(UNKNOWN_BUILD_IDENTITY).toEqual({ commit: 'unknown', dirty: 'unknown', mode: 'unknown' });
  });

  it('cannot be changed by a caller', () => {
    expect(Object.isFrozen(UNKNOWN_BUILD_IDENTITY)).toBe(true);
  });
});

describe('under this runner, where nothing was stamped', () => {
  it('reads the unknown identity when called with no argument', () => {
    // The constant `__SCHEGENT_BUILD_IDENTITY__` is absent under vitest. A read that threw a
    // ReferenceError here would break every test that builds a diagnostics bundle.
    expect(readBuildIdentity()).toEqual(UNKNOWN_BUILD_IDENTITY);
  });

  it('returns a value a caller may hold without it being the shared constant mutated later', () => {
    expect(readBuildIdentity()).toEqual(UNKNOWN_BUILD_IDENTITY);
    expect(readBuildIdentity({ commit: COMMIT, dirty: false, mode: 'production' })).not.toBe(UNKNOWN_BUILD_IDENTITY);
  });
});
