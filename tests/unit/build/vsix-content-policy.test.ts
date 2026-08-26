/**
 * Feature 106 (T592b, FR-036) — the acceptance case no longer feeds the module's
 * own list back to the module's own validator.
 *
 * The first case here used to be `assertAllowedEntryNames(ALLOWED_VSIX_ENTRIES)`
 * not.toThrow, which the grounding test described accurately as passing "by
 * construction however stale the pin becomes". It could not fail: the argument was
 * the expectation. After the derivation it would not even have been circular, it
 * would have been wrong — the pinned list holds no chunks, so the correspondence
 * has nothing to match and the call throws.
 *
 * What replaces it is a listing assembled here: the hand-maintained entries, plus
 * one `chunks/<name>.js` for every boundary an independent scan of
 * `webview-ui/src` finds, plus a contiguous stylesheet run. The chunk and
 * stylesheet halves are entries the module does not list, so accepting them is an
 * observation about the two shape predicates and the correspondence rather than a
 * restatement of the pin.
 *
 * The hand-maintained half still comes from the module, and that is by design
 * (FR-010): a reviewed list has nothing to be derived from. Only `package:smoke`
 * compares it to an actual archive — except for `examples/`, which
 * `vsix-allowlist-grounding.test.ts` checks against the directory without a build.
 */

import { describe, expect, it } from 'vitest';

import { plausiblePackagedNames } from './authored-boundaries';

describe('exact VSIX content policy', () => {
  it('accepts a package holding the audited files, a chunk per boundary, and a contiguous stylesheet run', async () => {
    const { assertAllowedEntryNames } = await import('../../../scripts/check-vsix-smoke.mjs');
    const names = await plausiblePackagedNames();
    expect(() => assertAllowedEntryNames(names)).not.toThrow();
  });

  it('rejects a deliberate development-only junk file', async () => {
    const { assertAllowedEntryNames } = await import('../../../scripts/check-vsix-smoke.mjs');
    const names = await plausiblePackagedNames();
    expect(() =>
      assertAllowedEntryNames([...names, 'extension/test_output.txt'])
    ).toThrow(/unexpected packaged file extension\/test_output\.txt/);
  });

  it('rejects a missing runtime file and unsafe archive paths', async () => {
    const { assertAllowedEntryNames } = await import('../../../scripts/check-vsix-smoke.mjs');
    const names = await plausiblePackagedNames();
    expect(() =>
      assertAllowedEntryNames(names.filter((name) => name !== 'extension/dist/extension.js'))
    ).toThrow(/missing required packaged file extension\/dist\/extension\.js/);
    expect(() => assertAllowedEntryNames([...names, '../outside'])).toThrow(
      /unsafe ZIP entry path/
    );
  });
});

/**
 * FR-R3-112 — repository tooling configuration stays out of the package.
 *
 * FOUND BY THE PACKAGING GATE, which is the part worth recording. `vsce package` refused the
 * build with *"found GitHub Token"* pointing at `.secretlintrc.json` line 15 — the allowlist entry
 * holding a **synthetic** token (`ghp_0123456789…`, sequential filler) so the redaction fixture in
 * `workflow-catalog-projector.test.ts` does not trip the scanner. The scanner's verdict about the
 * string was wrong; its verdict about the FILE was right, and that is the defect: a repository lint
 * configuration was being shipped to every operator who installs the extension.
 *
 * The two untracked records are here for the same reason one step further on: `.gate-attestation.json`
 * and `.backend-qualification.json` describe one machine's observation of one tree at one moment.
 * Neither is committed, so neither is usually present — which is exactly why an ignore rule is the
 * right place for them rather than a hope that they never are.
 */
describe('the package carries no repository tooling configuration', () => {
  const MUST_NOT_SHIP = [
    '.secretlintrc.json',
    '.secretlintignore',
    '.gate-attestation.json',
    '.backend-qualification.json'
  ] as const;

  it('ignores each by name in .vscodeignore', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const ignore = readFileSync(
      resolve(__dirname, '..', '..', '..', '.vscodeignore'),
      'utf8'
    );
    for (const name of MUST_NOT_SHIP) {
      expect(
        ignore.split('\n').some((line) => line.trim() === name),
        `${name} must be ignored by name; a published extension has no use for it`
      ).toBe(true);
    }
  });

  it('would reject each if it reached the archive anyway', async () => {
    // The ignore rule is a claim about what vsce does; this is the independent check that the
    // content policy would catch the file if the rule were ever removed or misspelled.
    const { assertAllowedEntryNames } = await import('../../../scripts/check-vsix-smoke.mjs');
    const names = await plausiblePackagedNames();
    for (const name of MUST_NOT_SHIP) {
      expect(
        () => assertAllowedEntryNames([...names, `extension/${name}`]),
        `${name} must not be an allowed entry`
      ).toThrow();
    }
  });
});
