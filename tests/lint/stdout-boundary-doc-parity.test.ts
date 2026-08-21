// Feature 107 (T620, FR-025, FR-026, SC-008) — the threat model's CLI-stdout
// row and the parser that implements it must not drift apart.
//
// FR-R3-023 exists because a fix shipped and its documentation did not follow:
// `e2bf9ad` moved grace-termination onto the stream-json envelope, and the
// field, contract entry, comments, and 14 test arguments went on describing the
// retired substring scan as live for five months. Anyone reading the code to
// learn the boundary learned the wrong one. Adding a threat-model row that
// states the *current* boundary fixes that once; without a gate it decays the
// same way, and a security document that describes a mitigation the code no
// longer has is worse than no document, because it is trusted.
//
// So the row is pinned in **both directions** (SC-008):
//
//   - Doc → code: every module path and mitigation literal the row names must
//     be present in the source it points at. Deleting the region function or
//     renaming the degraded-path warning fails here.
//   - Code → doc: the row must still *state* those things. Editing the
//     mitigation out of the document, so the doc-side assertions have nothing
//     left to check, fails here too.
//
// The second direction is the one parity gates usually get wrong: a guard that
// only asserts `doc.includes(x)` for each `x` it finds in the doc is vacuous —
// it passes an empty document. `cap-authority-citation-parity.test.ts` solves
// it with a "the record still states the premises this test pins" case, and
// this file does the same, plus one thing that precedent does not: the check is
// a **pure function** of (doc text, source texts), so both failure directions
// are *demonstrated* against mutated fixtures rather than asserted in a
// comment. A matcher that silently stops matching fails here.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const THREAT_MODEL = join(REPO_ROOT, 'docs', 'security', 'threat-model.md');

/** The heading whose table holds the row, and the row's own leading cell. */
const TABLE_HEADING = '## The untrusted input classes';
const ROW_LABEL = '| **CLI stdout** |';

/**
 * What the row must claim, and where that claim has to be true.
 *
 * `inDoc` is matched against the row; `inSource` against the file at `source`.
 * Keeping them in one table is the point — a claim cannot be added to the
 * document without naming the file that backs it, and cannot be dropped from
 * the document without the `states every claim` case noticing.
 */
interface BoundClaim {
  what: string;
  inDoc: string;
  source: string;
  inSource: string;
}

const CLAIMS: ReadonlyArray<BoundClaim> = [
  {
    what: 'the region is computed by the module that owns the markers',
    inDoc: 'src/parser/audit-log-parser.ts',
    source: 'src/parser/audit-log-parser.ts',
    inSource: 'export interface TrailingRegion',
  },
  {
    what: 'the region is consumed where the outcome is decided',
    inDoc: 'src/parser/stdout-parser.ts',
    source: 'src/parser/stdout-parser.ts',
    inSource: 'function detectTermination(',
  },
  {
    what: 'a degraded read is labelled rather than silent',
    inDoc: '[constitution] token accepted without audit block',
    source: 'src/parser/stdout-parser.ts',
    inSource: "'[constitution] token accepted without audit block'",
  },
  {
    what: 'an out-of-region token is reported, not acted on',
    inDoc: 'never acted on',
    source: 'src/parser/stdout-parser.ts',
    inSource: '[constitution] termination token outside audit region',
  },
  {
    what: 'process control arms on the harness envelope, not on content',
    inDoc: '{"type":"result"}',
    source: 'src/runner/claude-cli.ts',
    inSource: "record.type === 'result'",
  },
];

/** The anchor the row hands the reader for the full argument. */
const ANCHOR_LINK = '[T25](#t25--control-sentinel-carried-in-cli-output)';
const ANCHOR_HEADING = '### T25 — Control sentinel carried in CLI output';

/**
 * The whole check, as a function of its inputs, so a fixture can drive it.
 *
 * Returns the list of drift descriptions — empty means parity holds. Both
 * directions are here: a claim missing from `docText` and a claim missing from
 * its source file produce distinct entries.
 */
function findDrift(docText: string, sourceText: (path: string) => string): string[] {
  const drift: string[] = [];

  const tableIdx = docText.indexOf(TABLE_HEADING);
  if (tableIdx < 0) {
    return [`the "${TABLE_HEADING}" section is gone`];
  }
  const rowIdx = docText.indexOf(ROW_LABEL, tableIdx);
  if (rowIdx < 0) {
    return [`the untrusted-input table has no ${ROW_LABEL} row`];
  }
  // A markdown table row is one line.
  const rowEnd = docText.indexOf('\n', rowIdx);
  const row = docText.slice(rowIdx, rowEnd < 0 ? undefined : rowEnd);

  for (const claim of CLAIMS) {
    if (!row.includes(claim.inDoc)) {
      drift.push(`doc: the CLI stdout row no longer states ${claim.what} (expected "${claim.inDoc}")`);
    }
    if (!sourceText(claim.source).includes(claim.inSource)) {
      drift.push(`code: ${claim.source} no longer provides ${claim.what} (expected "${claim.inSource}")`);
    }
  }

  if (!row.includes(ANCHOR_LINK)) {
    drift.push(`doc: the row no longer links the threat anchor (expected "${ANCHOR_LINK}")`);
  }
  if (!docText.includes(ANCHOR_HEADING)) {
    drift.push(`doc: the threat anchor heading is gone (expected "${ANCHOR_HEADING}")`);
  }

  return drift;
}

const realDoc = (): string => readFileSync(THREAT_MODEL, 'utf8');
const realSource = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8');

describe('CLI stdout boundary: threat model and parser agree (FR-025)', () => {
  it('every claim the row makes is backed by the source it names', () => {
    expect(
      findDrift(realDoc(), realSource),
      'The threat model and the parser disagree about the stdout boundary. ' +
        'Fix whichever one is wrong — do not relax this gate. A security document ' +
        'describing a mitigation the code does not have is trusted and false.'
    ).toEqual([]);
  });

  it('the row is inside the untrusted-input table, not merely somewhere in the file', () => {
    // Position matters for the same reason it matters to the mitigation itself:
    // a paragraph elsewhere that happens to mention CLI stdout is not the
    // enumeration an operator reads to learn which inputs are untrusted.
    const doc = realDoc();
    const tableIdx = doc.indexOf(TABLE_HEADING);
    const rowIdx = doc.indexOf(ROW_LABEL);
    const nextHeadingIdx = doc.indexOf('\n## ', tableIdx + TABLE_HEADING.length);
    expect(rowIdx).toBeGreaterThan(tableIdx);
    expect(rowIdx).toBeLessThan(nextHeadingIdx);
  });

  it('the class count in the section prose matches the number of rows', () => {
    // The prose states a count twice, and a seventh class added without
    // updating it leaves the document quietly wrong about its own scope.
    const doc = realDoc();
    const tableIdx = doc.indexOf(TABLE_HEADING);
    const nextHeadingIdx = doc.indexOf('\n## ', tableIdx + TABLE_HEADING.length);
    const section = doc.slice(tableIdx, nextHeadingIdx);
    const rowCount = section
      .split('\n')
      .filter((line) => /^\|\s*\*\*/.test(line)).length;
    expect(rowCount).toBe(6);
    expect(section).toContain('Six classes qualify');
    expect(section).toContain('common to all six');
  });
});

describe('the parity check fails in both directions (SC-008)', () => {
  // Demonstrated, not asserted. Each fixture removes exactly one thing and the
  // check must name it — so a `findDrift` that stopped looking would fail here
  // rather than pass the suite while checking nothing.

  it('reports drift when the document drops the mitigation', () => {
    const gutted = realDoc().replace(
      '[constitution] token accepted without audit block',
      'handled appropriately'
    );
    const drift = findDrift(gutted, realSource);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain('doc: the CLI stdout row no longer states');
    expect(drift[0]).toContain('a degraded read is labelled rather than silent');
  });

  it('reports drift when the document loses the whole row', () => {
    const rowIdx = realDoc().indexOf(ROW_LABEL);
    const doc = realDoc();
    const gutted = doc.slice(0, rowIdx) + doc.slice(doc.indexOf('\n', rowIdx) + 1);
    expect(findDrift(gutted, realSource)).toEqual([
      `the untrusted-input table has no ${ROW_LABEL} row`,
    ]);
  });

  it('reports drift when the source drops the boundary the row names', () => {
    // The regression that actually happened in `e2bf9ad`, inverted: the code
    // moves and the document keeps describing the old world.
    const stubbed = (path: string): string => {
      const text = realSource(path);
      return path === 'src/parser/stdout-parser.ts'
        ? text.replace('function detectTermination(', 'function detectSomethingElse(')
        : text;
    };
    const drift = findDrift(realDoc(), stubbed);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain('code: src/parser/stdout-parser.ts no longer provides');
  });

  it('reports drift when the threat anchor is removed', () => {
    const gutted = realDoc().replace(ANCHOR_HEADING, '### T25 — Renamed without updating the row');
    const drift = findDrift(gutted, realSource);
    expect(drift).toEqual([`doc: the threat anchor heading is gone (expected "${ANCHOR_HEADING}")`]);
  });
});
