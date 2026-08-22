// A gate that scans a tree and asserts "no offenders" must also prove it found
// something to look at.
//
// This is the defect class the 2026-08-22 remediation round kept producing and
// kept catching, in itself and in its own fixes:
//
//   * `no-vscode-import-in-telemetry.test.ts` had patterns anchored on grep's
//     OUTPUT shape (`^<path>:<lineno>:`). Migrating it to whole-file matching
//     left the anchor matching nothing, and two of its three assertions became
//     vacuous. A real `import * as vscode from 'vscode'` passed all three.
//   * A permission gate re-asserted the same predicate that had built its own
//     input list, so it could not fail by construction.
//   * A parity gate compared only overrides present in EVERY manifest, and was
//     blind to the one-sided pin that was the entire incident it guarded.
//
// None was caught by a green suite, because a green suite is what all three
// produced. The suite count was identical before and after the telemetry
// regression: 655 either way. **Pass/fail counts cannot see a test going from
// meaningful to vacuous.**
//
// So the rule: if a gate walks a tree and asserts an empty result, it must
// somewhere assert a NON-empty one — an anchor file that has to appear, a
// minimum site count, a known helper that must be found. 39 of the 63 scanning
// gates in this directory already do, and one of them names the reason better
// than this comment can: "Without them a path typo would empty the scan and pass
// every assertion below trivially — the failure mode a reachability guard can
// least afford."
//
// WHAT THIS DOES NOT DO. The detection is heuristic: it reads source text for
// scanning calls, for `toEqual([])`, and for the shapes a vacuity control takes.
// It cannot prove a gate is vacuous, and it cannot prove one is sound. A gate
// with a control that does not actually constrain anything passes here. What it
// buys is narrower and still worth having: a NEW scanning gate cannot be added
// without someone deciding how it proves it scanned.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const LINT_DIR = resolve(__dirname);
const read = (file: string): string => readFileSync(resolve(LINT_DIR, file), 'utf8');

/** Walks a tree, or resolves a file set from one. */
const SCANS = /filesMatching|filesUnder|linesMatching|readdirSync|collect\w*Files|walk\(/;

/** Asserts that a collected set of offenders is empty. */
const ASSERTS_EMPTY = /\.toEqual\(\s*\[\s*\]\s*\)/;

/**
 * Shapes a vacuity control takes here. Deliberately broad — the question is
 * whether the author thought about it, not whether they picked a house form.
 */
const PROVES_NON_EMPTY =
  new RegExp(
    [
      'toBeGreaterThan',
      'toBeGreaterThanOrEqual',
      // `toContain(HELPER)` and `toContain('webview-ui/src/lib/reorder-task.ts')`
      // are the same control spelled two ways. An earlier version of this
      // detector recognised only the first and reported four gates as
      // uncontrolled that were not — a detector with a false negative is the
      // same defect it exists to find, one level up.
      // An ALL_CAPS module constant passed to toContain is this suite's idiom for
      // "the scan must find this anchor": HELPER, ANCHOR, DISPATCH_MODULE. The
      // detector has now missed this spelling twice — first the path literal,
      // then the named constant — which is worth stating plainly: each miss
      // reported a controlled gate as uncontrolled, and each was caught by the
      // staleness check below rather than by reading the files.
      'toContain\\(\\s*[A-Z][A-Z0-9_]{2,}',
      "toContain\\(\\s*['\"`][\\w./-]+\\.(ts|svelte|md|json)",
      'ANCHORS',
      'MIN_SITES',
      'MIN_\\w+',
      'vacuous',
      'toHaveLength\\(\\s*[1-9]',
      'expect\\.fail'
    ].join('|')
  );

/**
 * Scanning gates that assert emptiness and prove nothing about their own scan.
 *
 * **This list is empty, and that is the point.** It began at 24 entries on
 * 2026-08-23 and was paid down to zero the same day. It stays here because the
 * mechanism is the deliverable, not the list: a new scanning gate added without
 * a control fails the assertion below, and the only way to land it is to add an
 * entry here — in a diff a reviewer reads, with a reason.
 *
 * How the 24 cleared, because the proportions are the useful part:
 *
 *   - **9 were never uncontrolled.** The detector above had blind spots. It
 *     matched `toContain(HELPER)` but not `toContain('path/to/file.ts')`, and
 *     not `toContain(DISPATCH_MODULE)` — the same control, spelled three ways.
 *     Both misses were caught by the staleness check below rather than by
 *     reading the files, which is the argument for asserting a list in both
 *     directions.
 *   - **15 genuinely had none** and were given one: an anchor file the scan must
 *     contain, an allowlist entry that must still match, a floor on the file
 *     count, or a planted offender proving the pattern still recognises what it
 *     forbids. Each was verified by mutation — break the scan root, rename the
 *     constant, break the pattern — not by the suite staying green.
 *
 * Four stale exemptions fell out of that work: `no-running-state-literal`
 * allowlisted four files that no longer contained the literal they were excused
 * for. An allowlist used as an anchor becomes a staleness check for free, which
 * is the strongest argument for that shape over a bare file count.
 *
 * Adding an entry here is not forbidden — a gate may legitimately have nothing
 * to anchor on. It requires saying so.
 */
const WITHOUT_A_CONTROL: ReadonlySet<string> = new Set<string>([
  // Empty by design. See above before adding to it.
]);

const SELF = 'scanning-gates-prove-they-scanned.test.ts';

function scanningGates(): string[] {
  return readdirSync(LINT_DIR)
    .filter((file) => file.endsWith('.test.ts') && file !== SELF)
    .filter((file) => {
      const source = read(file);
      return SCANS.test(source) && ASSERTS_EMPTY.test(source);
    })
    .sort();
}

describe('a scanning gate proves it scanned something', () => {
  it('finds scanning gates to check, so this gate is not itself vacuous', () => {
    // The rule applied to the rule. A detector that matched nothing would report
    // perfect compliance over an empty set, which is the failure it exists to
    // forbid.
    expect(
      scanningGates().length,
      'no gate in tests/lint/ was detected as scanning a tree and asserting emptiness. ' +
        'Either the detection heuristic has stopped matching this directory\'s idioms, or the ' +
        'directory changed shape. Both mean this gate is reporting compliance it did not measure.'
    ).toBeGreaterThan(30);
  });

  it('every new scanning gate proves its scan was non-empty', () => {
    const offenders = scanningGates().filter(
      (file) => !PROVES_NON_EMPTY.test(read(file)) && !WITHOUT_A_CONTROL.has(file)
    );
    expect(
      offenders,
      `These gates walk a tree and assert "no offenders" without asserting they found anything ` +
        `to look at:\n  ${offenders.join('\n  ')}\n\n` +
        `A path typo, a moved scan root, or a pattern that stops matching turns such a gate into ` +
        `one that passes on every tree — and a suite count cannot tell that apart from a clean ` +
        `tree, because both are green. Add a control: an anchor file the scan must contain, a ` +
        `minimum number of sites, or a known helper it must find. 39 gates here already do.`
    ).toEqual([]);
  });

  it('the paydown list does not grow, and shrinks when a gate is fixed', () => {
    // Both directions. An entry that no longer applies must be removed, or the
    // list stops describing the tree and starts excusing it.
    const stale = [...WITHOUT_A_CONTROL].filter((file) => {
      const gates = scanningGates();
      return !gates.includes(file) || PROVES_NON_EMPTY.test(read(file));
    });
    expect(
      stale,
      `These are on the paydown list but no longer need to be: ${stale.join(', ')}. ` +
        `Remove them — a list that keeps entries it has outgrown is how an allowlist becomes ` +
        `permanent.`
    ).toEqual([]);
  });
});
