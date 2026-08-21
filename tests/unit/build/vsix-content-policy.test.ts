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
