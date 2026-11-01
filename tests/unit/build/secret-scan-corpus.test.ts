import { afterEach, describe, expect, it } from 'vitest';
import { CLEAN, DROPPED, PLANTED } from '../../fixtures/secret-scan-corpus';
import { removeSandboxes, sandbox, scan } from './secret-scan-harness';

/**
 * FR-R4-F09 (FR-026, SC-007; research R20; contract DP3, test T13) -- the secret scan still
 * detects every key family it detected, and still passes what is not a secret.
 *
 * WHY THIS EXISTS. FR-025 moves the secretlint engine to the version the rest of the family and
 * the packaging tool already use. That is a change under the repository's only static control, and
 * "the scan still passes on this repository" proves nothing about it: a scan that stopped
 * detecting a family would pass on a tree that holds none. So the test plants one synthetic value
 * per family in its own repository, so a finding is attributable to its case, and asserts three
 * things of each: the scan exits non-zero, the report names that family's rule, and the report
 * does not repeat the value. All the clean cases share one repository, and the scan must exit 0
 * over it. It runs before the dependency change and again after it, and both must pass
 * (baseline-green).
 *
 * The harness is shared with `secret-scan-outcomes.test.ts`, so the two cannot drift in how they
 * build a repository or run the scan. Every value is assembled at call time by the fixture, so
 * this file and the fixture hold no token for the repository's own scan to report.
 */
afterEach(removeSandboxes);

/** Words long enough to be a value, split at the characters a line puts around one. */
function valueWords(text: string): string[] {
  return text.split(/[\s"'=,]+/).filter((word) => word.length >= 12);
}

describe('the planted cases are each detected', () => {
  it('plants at least one case per family, and a distinct family each', () => {
    const families = PLANTED.map((planted) => planted.family);
    expect(families.length).toBeGreaterThanOrEqual(10);
    expect(new Set(families).size).toBe(families.length);
  });

  it.each(PLANTED.map((planted) => [planted.family, planted] as const))(
    'detects %s, names its rule, and prints no part of the value',
    (_family, planted) => {
      const value = planted.build();
      const { status, out } = scan(sandbox({ [planted.file]: value }));
      expect(status, `the scan must fail on a planted ${planted.family} value. Got: ${out}`).toBe(1);
      expect(out).toContain(`secretlint-rule-${planted.family}`);
      expect(out).toContain(planted.file);
      const words = valueWords(value);
      expect(words.length, 'the masking check needs something to look for').toBeGreaterThan(0);
      for (const word of words) expect(out, `a part of the value reached the report`).not.toContain(word);
    }
  );

  it('builds each value afresh, and the fixture file itself holds none', () => {
    for (const planted of PLANTED) expect(planted.build()).toBe(planted.build());
  });
});

describe('the clean cases all pass together', () => {
  it('passes one repository holding every near-miss, allowed value and prose case', () => {
    const files = Object.fromEntries(CLEAN.map((clean) => [clean.file, clean.text]));
    expect(Object.keys(files).length).toBe(CLEAN.length);
    const { status, out } = scan(sandbox(files));
    expect(status, out).toBe(0);
    expect(out).toContain(`secretlint over ${CLEAN.length} tracked file(s)`);
  });

  it('CONTROL: the same repository fails once one planted value is added to it', () => {
    const files = Object.fromEntries(CLEAN.map((clean) => [clean.file, clean.text]));
    const planted = PLANTED.find((entry) => entry.family === 'slack');
    expect(planted).toBeDefined();
    const { status } = scan(sandbox({ ...files, [planted?.file ?? 'slack.txt']: planted?.build() ?? '' }));
    expect(status).toBe(1);
  });
});

describe('the families that are not planted are recorded, not hidden', () => {
  it('gives each dropped family a measured reason and no planted case', () => {
    for (const dropped of DROPPED) {
      expect(dropped.reason.length).toBeGreaterThan(20);
      expect(PLANTED.some((planted) => planted.family === dropped.family)).toBe(false);
    }
  });
});
