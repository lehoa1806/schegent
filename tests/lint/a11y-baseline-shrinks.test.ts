// FR-R3-131 — the accessibility baseline ratchets in one direction only.
//
// THE CLASS. `FR-R3-091` recorded 30 WCAG 2.1 AA color-contrast findings in
// `a11y-baseline.json` and gated on them, which stopped the debt growing. The
// audit of 2026-08-27 then read the file and made the second point: a baseline
// prevents growth, and then its stability starts reading as compliance. The gate
// was green over an unmet target for three days, and both facts were true at
// once.
//
// The 30 are gone — fixed at the colour source, three token decisions, not
// thirty CSS edits. This gate is what stops them coming back one accepted entry
// at a time.
//
// WHY A CEILING AND NOT A DIFF. `lint-gates-are-hermetic.test.ts` permits `git`,
// so a merge-base comparison would pass that rule — but its verdict would then
// depend on clone depth, on which branch CI fetched, and on whether the base ref
// exists locally at all. Every other ratchet in this tree is an asserted
// constant instead: the two compiler counts, the eslint baseline, the LoC
// budgets, and `drive-loop-loc-budget.test.ts` from this same batch. The
// accessibility baseline joins them.
//
// THERE IS NO RAISE PATH HERE. A finding that genuinely must be accepted needs a
// dated exception, reviewed like every other dated exception in this repository,
// and the failure message says so — a ratchet that only says *no* gets deleted
// by the first author who needs one.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const BASELINE_PATH = 'tests/a11y/a11y-baseline.json';
const SCAN_SPEC_PATH = 'tests/a11y/a11y-scan.spec.ts';

const read = (path: string): string => readFileSync(resolve(REPO_ROOT, path), 'utf8');

interface Baseline {
  readonly about?: readonly string[];
  readonly target: string;
  readonly accepted: ReadonlyArray<{
    readonly route: string;
    readonly theme: string;
    readonly ruleId: string;
    readonly selector: string;
  }>;
}

/**
 * Accepted findings permitted in `a11y-baseline.json`.
 *
 * SHRINK-ONLY. Lower it in the change that clears an entry; it may not be
 * raised. At zero there is nothing to break down per rule, which is the point:
 * every route and every theme in the scanned surface is clean.
 */
const MAX_ACCEPTED_ENTRIES = 0;

/** Phrases the baseline's own `about` block must still carry. */
const RULE_STATEMENTS = ['SHRINK-ONLY', 'dated exception'] as const;

describe('FR-R3-131 — the a11y baseline shrinks or stays put', () => {
  const baseline = JSON.parse(read(BASELINE_PATH)) as Baseline;

  it('holds the accepted list to its recorded ceiling', () => {
    expect(
      baseline.accepted.length,
      `tests/a11y/a11y-baseline.json accepts ${baseline.accepted.length} finding(s), over its ` +
        `recorded ceiling of ${MAX_ACCEPTED_ENTRIES}. This baseline is SHRINK-ONLY and there is ` +
        'no raise-with-a-reason path in this gate: the audit of 2026-08-27 found the previous 30 ' +
        'entries reading as compliance for as long as the gate stayed green over them. Fix the ' +
        'finding at its colour source, or — if it must genuinely be accepted — file a dated ' +
        'exception and change the ceiling there, in review, not here in passing.'
    ).toBeLessThanOrEqual(MAX_ACCEPTED_ENTRIES);
  });

  it('leaves the ceiling no slack to grow into', () => {
    // The half that makes it a ratchet rather than a cap. A ceiling above the
    // real count is room for the next entry to arrive silently; this forces the
    // constant down in the same change that clears an entry.
    expect(
      MAX_ACCEPTED_ENTRIES - baseline.accepted.length,
      `MAX_ACCEPTED_ENTRIES is ${MAX_ACCEPTED_ENTRIES} while the baseline holds ` +
        `${baseline.accepted.length}. Lower the constant to match: slack in a ratchet is where ` +
        'the next regression lands without failing anything.'
    ).toBeLessThanOrEqual(0);
  });

  it('keeps the rule written in the record the gate judges', () => {
    // The gate and the file must not disagree about what the file is for. An
    // author reaching for the baseline reads the JSON, not this test.
    const about = (baseline.about ?? []).join(' ');
    for (const statement of RULE_STATEMENTS) {
      expect(
        about,
        `tests/a11y/a11y-baseline.json's "about" block no longer states "${statement}". The gate ` +
          'is enforced here but read there; the two may not drift.'
      ).toContain(statement);
    }
  });

  it('pins the scan\'s positive control, which the empty baseline made load-bearing', () => {
    // With 30 accepted entries, a harness that rendered nothing failed on 30
    // fallen entries. At zero it reports exactly what a clean sweep reports —
    // measured: scoping axe to `document.head` produced `findings: 0` and passed
    // BOTH baseline assertions. Only the node floor caught it.
    const spec = read(SCAN_SPEC_PATH);
    expect(spec, 'the scan must still assert a floor on what axe examined').toContain(
      'MIN_NODES_EXAMINED'
    );
    expect(spec).toContain('toBeGreaterThanOrEqual(MIN_NODES_EXAMINED)');
  });
});
