import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  censusProseOf,
  gateFiles,
  readCensusRows,
  reconcile,
  render
  // @ts-expect-error -- .mjs generator, typed by use rather than by declaration
} from '../../scripts/census-lint-gates.mjs';

/**
 * FR-R3-121 (FR-020) — the census covers every gate, and names no gate that is gone.
 *
 * WHY A GATE AND NOT JUST A DOCUMENT. An un-gated census is stale the moment the next
 * gate is added, which is the decay this round keeps finding: a record that was true
 * when written, describing a tree that moved. `FR-R3-121` itself measured 141 where
 * the tree now holds 150 — four of those are this round's own additions.
 *
 * WHAT IT CHECKS: bijection. Every `tests/lint/**\/*.test.ts` has exactly one census
 * row; every census row names a file that exists.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK: the `Also held by`, `Verdict` and `Evidence`
 * columns. Whether a redundancy argument is sound is a judgement about the whole
 * tree, and a gate that appeared to validate one would be claiming a capability it
 * does not have — which is precisely the overclaim `FR-R3-116` was filed about.
 * Reproducing it inside this feature's own census would be a poor result.
 *
 * RECURSIVE. A flat glob misses `gate-integrity/`'s five gates and yields a census
 * that looks complete and is not.
 */
const CENSUS_REL = 'docs/development/lint-gate-census.md';

describe('the lint-gate census is complete (FR-R3-121)', () => {
  const files: readonly string[] = gateFiles();
  const rows: Map<string, unknown> = readCensusRows();

  it('finds the gates it governs', () => {
    // Vacuity control. Every assertion below compares two sets and expects the
    // difference to be empty, so two empty sets pass them all — and an empty scan is
    // exactly how the five `gate-integrity/` gates would go unnoticed.
    expect(
      files.length,
      'no gate file was found under tests/lint/ — the enumerator no longer matches how ' +
        'this tree names its gates, so this check is comparing nothing to nothing'
    ).toBeGreaterThan(100);
  });

  it('includes the gate-integrity subdirectory, not only the top level', () => {
    // Named explicitly because the flat glob is the mistake that is easy to make and
    // impossible to see: it produces a census that looks complete.
    expect(files.some((f) => f.startsWith('gate-integrity/'))).toBe(true);
  });

  it('has a census row for every gate file', () => {
    const { missingRows } = reconcile({ files, rows });
    expect(
      missingRows,
      'these gates have no row in docs/development/lint-gate-census.md. Run ' +
        '`node scripts/census-lint-gates.mjs` to add them, then write their ' +
        '`Also held by` / `Verdict` / `Evidence` columns by hand — the generator ' +
        'will not, because that judgement is not machine-checkable.'
    ).toEqual([]);
  });

  it('names no gate that no longer exists', () => {
    const { orphanRows } = reconcile({ files, rows });
    expect(
      orphanRows,
      'these census rows name files that are gone. A census that keeps describing a ' +
        'deleted gate is the stale-record shape this round has been closing; ' +
        'regenerate to drop them.'
    ).toEqual([]);
  });

  // Lifecycle round-check of 2026-08-30 (T1616). Regenerating the census twice
  // used to produce two different files: `censusProseOf` captured the newline the
  // template writes after `<!-- census:prose -->`, and `render` emitted its own
  // newline before the captured text, so every run added one blank line. Found by
  // regenerating twice while adding a gate, and normalised by hand at the time —
  // which is the shape worth refusing, because a generator whose output drifts on
  // re-run makes every regeneration diff carry noise a reviewer learns to skip.
  //
  // Asserted as a fixed point rather than by counting blank lines: `render` after
  // a read of `render` must be the same text. Nothing is written to disk; both
  // calls are pure over a synthetic row set, so this cannot disturb the real
  // census.
  describe('regeneration is idempotent (T1616)', () => {
    const files = ['a.test.ts', 'gate-integrity/b.test.ts'];
    const rows = new Map([
      ['a.test.ts', { invariant: 'refuses a thing', alsoHeldBy: '—', verdict: 'unique', evidence: '—' }],
      [
        'gate-integrity/b.test.ts',
        { invariant: 'refuses another', alsoHeldBy: '—', verdict: 'unique', evidence: '—' }
      ]
    ]);

    it('re-rendering hand-written prose reproduces it byte for byte', () => {
      const prose = '\nA hand-written section.\n\nWith a blank line inside it.\n\n';
      const once: string = render(files, rows, prose);
      expect(censusProseOf(once)).toBe(prose);
    });

    it('rendering the census a second time changes nothing', () => {
      const once: string = render(files, rows, '\nMethod: something a human wrote.\n\n');
      const twice: string = render(files, rows, censusProseOf(once));
      expect(twice).toBe(once);
    });

    it('holds for empty prose, the case that first shipped the extra line', () => {
      const once: string = render(files, rows, '');
      expect(render(files, rows, censusProseOf(once))).toBe(once);
    });
  });

  /**
   * FR-R3-145 (2026-08-31) — the summary block counts the rows beneath it.
   *
   * FOUND, NOT PREDICTED. Adding a gate regenerated this file and moved
   * `partially redundant` from 13 to 14. Nothing in that change touched a verdict,
   * so the 13 had been wrong at rest: the committed summary claimed 162 unique and
   * 13 partially redundant while its own rows tallied 161 and 14. Some earlier edit
   * changed one row's verdict and left the totals above it alone.
   *
   * WHY THE IDEMPOTENCE TESTS ABOVE DID NOT CATCH IT. They are pure over a
   * synthetic two-row set, by design and correctly — they prove `render` is a fixed
   * point, which is a property of the generator. Being a fixed point says nothing
   * about whether the file ON DISK is what the generator would produce from the
   * rows it contains. That is the gap: a stale summary is exactly a file that
   * disagrees with its own content, and no test read the real one.
   *
   * This is the same defect as the item it was found under — a document asserting
   * something about itself that stopped being true, where the assertion is the
   * thing that stops anyone checking. A reader auditing coverage reads these four
   * numbers, not 176 rows.
   */
  it('the summary block agrees with the rows it summarises (FR-R3-145)', () => {
    const census = readFileSync(resolve(__dirname, '..', '..', CENSUS_REL), 'utf8');
    const tally = new Map<string, number>([
      ['unique', 0],
      ['partially redundant', 0],
      ['redundant', 0]
    ]);
    for (const row of rows.values()) {
      const { verdict } = row as { verdict: string };
      tally.set(verdict, (tally.get(verdict) ?? 0) + 1);
    }

    const stated = (label: string): number | null => {
      const line = new RegExp(`^\\| ${label} \\| \\*{0,2}(\\d+)\\*{0,2} \\|`, 'm').exec(census);
      return line === null ? null : Number(line[1]);
    };

    const drifted: string[] = [];
    const claims: ReadonlyArray<readonly [string, number]> = [
      ['Gate files', files.length],
      ['Marked `unique`', tally.get('unique') ?? 0],
      ['Marked `partially redundant`', tally.get('partially redundant') ?? 0],
      ['Marked `redundant`', tally.get('redundant') ?? 0]
    ];
    for (const [label, actual] of claims) {
      const claimed = stated(label);
      if (claimed === null) {
        drifted.push(`"${label}" has no row in the summary block for this gate to check`);
        continue;
      }
      if (claimed !== actual) drifted.push(`${label}: summary says ${claimed}, rows hold ${actual}`);
    }

    expect(
      drifted,
      'The census summary no longer counts its own rows. Run ' +
        '`node scripts/census-lint-gates.mjs`, which recomputes these totals; do not ' +
        'hand-edit them back into agreement, because the number being wrong is never ' +
        'the defect — the verdict that changed underneath it is.'
    ).toEqual([]);
  });

  it('every row carries a verdict from the closed vocabulary', () => {
    // Not a judgement about whether the verdict is RIGHT — only that one was made.
    // A blank verdict is a row nobody looked at, which is the census not existing.
    const allowed = new Set(['unique', 'partially redundant', 'redundant']);
    const bad = [...rows.entries()]
      .filter(([, row]) => !allowed.has((row as { verdict: string }).verdict))
      .map(([gate, row]) => `${gate}: "${(row as { verdict: string }).verdict}"`);
    expect(bad).toEqual([]);
  });
});
