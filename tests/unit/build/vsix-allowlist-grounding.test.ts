/**
 * Grounds the webview half of the VSIX policy in the source tree, without a build.
 *
 * Feature 106 (T592a, FR-013a) rewrote what there is to ground here, because the
 * derivation removed this file's own subject.
 *
 * Two of the three original chunk directions are gone:
 *
 *   1. "every pinned chunk names a module that exists under `webview-ui/src/`" is
 *      **removed**, not moved. After the derivation nothing under `chunks/` is
 *      pinned, so its subject is an empty list and it passed over nothing — the
 *      exact vacuity this file was written to close, one level up. It was also
 *      the rule that made the pin unrepairable: `chunks/empty-catalog-guidance.js`
 *      is emitted, is required by the archive check, and matches no source module,
 *      so the two gates could not both be green. It must not come back;
 *      `docs/operations/vsix-allowlist-derivation.md` records why.
 *   2. "every dynamically imported surface has a pinned chunk" moved into
 *      `check-vsix-smoke.mjs`, where it is asserted against the *emitted* set
 *      rather than the pinned one, so `package:smoke` is the thing that fails.
 *
 * What is left here is the part that still needs no build, and the part a second
 * implementation is the only way to check:
 *
 *   1. the script's scan for authored boundaries agrees with this file's;
 *   2. the route map parse resolves to boundaries the scan also found — the
 *      correspondence names routes from it, and a regex that stopped matching
 *      would silently downgrade every route failure to an anonymous one;
 *   3. the pinned `examples/` entries and the `examples/` directory agree, both
 *      ways — unchanged, and still exact rather than front-loading, because
 *      `.vscodeignore` excludes no part of `examples/` so what vsce takes from it
 *      is exactly what is on disk.
 *
 * This does not replace `package:smoke`. Vite emits shared chunks it extracts on
 * its own — `format.js`, `WorkflowRun.js`, `empty-catalog-guidance.js`, the
 * `indexN.css` stylesheets — and those are not derivable from source without
 * building, so only the archive check sees them. The point is to front-load the
 * directions that drift in practice, not to claim the policy is fully verified
 * here.
 */

import { describe, expect, it } from 'vitest';
import * as path from 'path';

import { REPO_ROOT, dynamicallyImportedComponents, walk } from './authored-boundaries';

const EXAMPLES_PREFIX = 'extension/examples/';
const EXAMPLES_DIR = path.join(REPO_ROOT, 'examples');

/**
 * Every file the packager would take from `examples/`, named as the entry it
 * would carry in the archive.
 *
 * `.DS_Store` is dropped because `.vscodeignore` drops it (`**\/.DS_Store`) —
 * this function has to model what vsce packages, not what the directory holds,
 * or a stray Finder artifact reads as an unpinned payload. Nothing else in
 * `.vscodeignore` touches `examples/`, so that one line is the whole
 * difference.
 */
function packagedExampleEntries(): readonly string[] {
  return walk(EXAMPLES_DIR)
    .filter((file) => path.basename(file) !== '.DS_Store')
    .map((file) => EXAMPLES_PREFIX + path.relative(EXAMPLES_DIR, file).split(path.sep).join('/'))
    .sort();
}

async function pinnedExampleEntries(): Promise<readonly string[]> {
  const { ALLOWED_VSIX_ENTRIES } = await import('../../../scripts/check-vsix-smoke.mjs');
  return ALLOWED_VSIX_ENTRIES.filter((name) => name.startsWith(EXAMPLES_PREFIX)).sort();
}

describe('the authored code-split boundaries are grounded in the webview source tree', () => {
  it('the script finds the same boundaries this file does', async () => {
    const { readAuthoredBoundaries } = await import('../../../scripts/check-vsix-smoke.mjs');
    const scanned = readAuthoredBoundaries()
      .boundaries.map((boundary) => boundary.component)
      .sort();
    expect(
      scanned,
      'check-vsix-smoke.mjs disagrees with this file about which components are ' +
        'code-split boundaries; the correspondence it asserts is only as good as ' +
        'this scan, and a scan that quietly stops matching passes over nothing'
    ).toEqual([...dynamicallyImportedComponents()]);
  });

  it('every route in the map resolves to a boundary the scan found', async () => {
    const { readAuthoredBoundaries } = await import('../../../scripts/check-vsix-smoke.mjs');
    const { boundaries, routes } = readAuthoredBoundaries();
    const named = boundaries
      .filter((boundary) => boundary.route !== null)
      .map((boundary) => boundary.route);
    expect(
      [...named].sort(),
      'the route map parse and the boundary scan disagree; every route loader is a ' +
        'dynamic import, so a route that resolves to nothing means one of the two ' +
        'regexes drifted and route failures would be reported anonymously'
    ).toEqual(routes.map((entry) => entry.route).sort());
  });

  it('finds the dynamic imports and the routes it claims to check', async () => {
    // Both regexes could stop matching and leave every check above vacuously
    // green — an empty scan agrees with an empty scan. This is the same failure
    // mode the file exists to close, so it is asserted rather than assumed.
    const { readAuthoredBoundaries } = await import('../../../scripts/check-vsix-smoke.mjs');
    expect(dynamicallyImportedComponents().length).toBeGreaterThan(0);
    expect(readAuthoredBoundaries().routes.length).toBeGreaterThan(0);
  });
});

/**
 * Feature 098 (T063) changed what there is to check here.
 *
 * The pin used to be three literal entries and these cases compared them to the
 * directory in both directions. `check-vsix-smoke.mjs` now enumerates
 * `examples/` itself, so "is every file pinned" answers itself and both
 * directions collapse into one claim: the script's model of what vsce takes from
 * `examples/` matches this file's. They stay two independent implementations —
 * the `.DS_Store` exclusion is spelled out in each — so the comparison still has
 * something to catch, and it catches the regression that matters most: a return
 * to a hand-maintained list, which is what went stale twice.
 */
describe('the pinned VSIX examples agree with the examples directory', () => {
  it('pins exactly what ships from examples/, derived rather than listed', async () => {
    expect(
      await pinnedExampleEntries(),
      'ALLOWED_VSIX_ENTRIES disagrees with examples/; the pin is derived from that ' +
        'directory, so a difference means the two models of .vscodeignore have drifted ' +
        'or the entries were hand-listed again'
    ).toEqual(packagedExampleEntries());
  });

  it('finds the example files it claims to check', () => {
    // Same reason as the dynamic-import control above: a walk that silently
    // returned nothing would make the comparison vacuously green — and now more
    // easily so, since an enumeration that returns nothing agrees with a walk
    // that returns nothing.
    expect(packagedExampleEntries().length).toBeGreaterThan(0);
  });
});
