import { describe, expect, it } from 'vitest';
// @ts-expect-error -- .mjs generator, typed by use rather than by declaration
import { gateFiles, readCensusRows, reconcile } from '../../scripts/census-lint-gates.mjs';

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
