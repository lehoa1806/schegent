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
      'toContain\\(\\s*(HELPER|ANCHOR)',
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
 * Scanning gates that assert emptiness and prove nothing about their own scan,
 * as of 2026-08-23.
 *
 * This started at 24 entries. Eight came straight back off: they carry a real
 * control spelled `toContain('src/lib/runtime-log/runtime-log-sink.ts')` rather
 * than `toContain(HELPER)`, and the first version of the detector above matched
 * only the second spelling. The staleness check below is what caught that — on
 * its first run, against its own list.
 *
 * This is a paydown list, not an exemption list, and it follows the same pattern
 * as `eslint-baseline.json`: record what exists, forbid growth, pay it down
 * deliberately. Several of these were probed by hand and do bite today — they
 * work because their scan roots happen to exist and their patterns happen to
 * match. That is a property of the current tree rather than of the gate, which
 * is exactly what a control would fix.
 *
 * Removing an entry is the goal. Adding one requires explaining, in review, why
 * a new gate should be unable to tell a clean tree from a broken scan.
 */
const WITHOUT_A_CONTROL: ReadonlySet<string> = new Set([
  'catalog-lifecycle-dispatch.test.ts',
  'message-router-trust-wiring.test.ts',
  'no-as-queue-projection-cast.test.ts',
  'no-direct-first-workspace-folder.test.ts',
  'no-direct-queue-setter.test.ts',
  'no-direct-vscode-webview-api.test.ts',
  'no-html-interpolation-in-activity-feed.test.ts',
  'no-identity-less-cancel.test.ts',
  'no-inline-phase-breakpoint-ipc.test.ts',
  'no-inline-phase-control.test.ts',
  'no-inline-phase-log-ipc.test.ts',
  'no-legacy-setpaused.test.ts',
  'no-running-state-literal.test.ts',
  'no-tryAutoDrain-doc-references.test.ts',
  'no-unconditional-describe-skip.test.ts',
  'spec-traceability-governance.test.ts'
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
