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
    // FR-R4-F12 (FR-002, TG L1): a token with no complete block before it is reported, never read.
    what: 'a token with no complete audit block is reported and not accepted',
    inDoc: '[constitution] termination token without audit block',
    source: 'src/parser/stdout-parser.ts',
    inSource: "'[constitution] termination token without audit block, not accepted'",
  },
  {
    // FR-R4-F12 (FR-006, TG L1): tool-output text is never read for a token.
    what: 'a token in tool output is reported and not accepted',
    inDoc: '[constitution] termination token in tool output',
    source: 'src/parser/stdout-parser.ts',
    inSource: "'[constitution] termination token in tool output, not accepted'",
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

/**
 * FR-R4-F12 (FR-013, TG L1, spelling half) -- the accepted set is stated once in the contract module
 * and again in T25, and the two must not drift.
 *
 * The alternatives are DERIVED from the pattern's source text, never retyped here, so adding a
 * fourth spelling to `TERMINATION_PATTERN` fails this case until T25 names it.
 */
const CONTRACT_SOURCE = 'src/contracts/phase-output-contract.ts';
const T25_TOLERANCE_PHRASES: ReadonlyArray<string> = ['any letter case', 'whitespace after the colon'];

/** The alternatives inside the `(…)` group of `TERMINATION_PATTERN`, or null when they cannot be read. */
function acceptedAlternatives(contractSource: string): string[] | null {
  const line = contractSource.split('\n').find((candidate) => candidate.startsWith('const TERMINATION_PATTERN'));
  if (line === undefined) return null;
  const open = line.indexOf('(');
  const close = line.indexOf(')', open);
  if (open < 0 || close < 0) return null;
  const alternatives = line.slice(open + 1, close).split('|');
  return alternatives.every((alternative) => /^[A-Z]+$/.test(alternative)) ? alternatives : null;
}

/** The T25 section: its heading to the next `###` heading, or to the end of the file. */
function t25Section(docText: string): string | null {
  const start = docText.indexOf(ANCHOR_HEADING);
  if (start < 0) return null;
  const next = docText.indexOf('\n### ', start + ANCHOR_HEADING.length);
  return docText.slice(start, next < 0 ? undefined : next);
}

function findSpellingDrift(docText: string, contractSource: string): string[] {
  const alternatives = acceptedAlternatives(contractSource);
  if (alternatives === null) {
    return [`code: ${CONTRACT_SOURCE} no longer has a TERMINATION_PATTERN whose alternatives can be read`];
  }
  const section = t25Section(docText);
  if (section === null) return [`doc: the threat anchor heading is gone (expected "${ANCHOR_HEADING}")`];
  const drift: string[] = [];
  for (const alternative of alternatives) {
    if (!section.includes(`\`${alternative}\``)) {
      drift.push(`doc: T25 no longer names the accepted spelling \`${alternative}\``);
    }
  }
  for (const phrase of T25_TOLERANCE_PHRASES) {
    if (!section.includes(phrase)) drift.push(`doc: T25 no longer states the tolerance "${phrase}"`);
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

describe('the accepted spellings are stated in T25 as the contract module accepts them (FR-R4-F12, FR-013)', () => {
  it('derives CLEAR, DONE and RESOLVED from the pattern, and T25 names each with the tolerance', () => {
    expect(acceptedAlternatives(realSource(CONTRACT_SOURCE))).toEqual(['CLEAR', 'DONE', 'RESOLVED']);
    expect(findSpellingDrift(realDoc(), realSource(CONTRACT_SOURCE))).toEqual([]);
  });

  it('T25 states that the prompt asks for the canonical token only', () => {
    const section = t25Section(realDoc()) ?? '';
    expect(section).toContain('the prompt asks for `[SCHEGENT_STATUS: CLEAR]` only');
  });
});

describe('the fence handling is stated in T25 as the parser has it (FR-R4-F12)', () => {
  const FENCE_WARNING = '[constitution] termination token inside a code fence';

  it('T25 names the warning a fenced token draws and the one fence the count leaves out', () => {
    const section = t25Section(realDoc()) ?? '';
    expect(section).toContain(FENCE_WARNING);
    expect(section).toContain('is not counted as opening one around the token');
  });

  it('the parser still raises that warning, and still records whether the block was fenced', () => {
    expect(realSource('src/parser/stdout-parser.ts')).toContain(FENCE_WARNING);
    expect(realSource('src/parser/audit-log-parser.ts')).toContain('blockFenced?: true');
  });
});

describe('the spelling check fails in both directions (FR-R4-F12)', () => {
  const contract = (): string => realSource(CONTRACT_SOURCE);

  it('reports drift when T25 drops one accepted spelling', () => {
    const section = t25Section(realDoc()) as string;
    const gutted = realDoc().replace(section, section.replace('`RESOLVED`', '`REVIEWED`'));
    const drift = findSpellingDrift(gutted, contract());
    expect(drift).toEqual(['doc: T25 no longer names the accepted spelling `RESOLVED`']);
  });

  it('reports drift when T25 drops the case tolerance, and the whitespace tolerance', () => {
    const section = t25Section(realDoc()) as string;
    const gutted = realDoc().replace(
      section,
      section.replace('any letter case', 'one letter case').replace('whitespace after the colon', 'no whitespace')
    );
    expect(findSpellingDrift(gutted, contract())).toEqual([
      'doc: T25 no longer states the tolerance "any letter case"',
      'doc: T25 no longer states the tolerance "whitespace after the colon"'
    ]);
  });

  it('reports drift when the pattern gains a spelling that T25 does not name', () => {
    const widened = contract().replace('(CLEAR|DONE|RESOLVED)', '(CLEAR|DONE|RESOLVED|FINISHED)');
    expect(widened).not.toBe(contract());
    expect(findSpellingDrift(realDoc(), widened)).toEqual(['doc: T25 no longer names the accepted spelling `FINISHED`']);
  });

  it('reports drift when the pattern can no longer be read', () => {
    const unreadable = contract().replace('const TERMINATION_PATTERN', 'const SOMETHING_ELSE');
    expect(findSpellingDrift(realDoc(), unreadable)).toEqual([
      `code: ${CONTRACT_SOURCE} no longer has a TERMINATION_PATTERN whose alternatives can be read`
    ]);
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

  it('reports drift when the document drops the no-block report (FR-R4-F12)', () => {
    const gutted = realDoc().replace(
      '[constitution] termination token without audit block',
      'handled appropriately'
    );
    const drift = findDrift(gutted, realSource);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain('doc: the CLI stdout row no longer states');
    expect(drift[0]).toContain('a token with no complete audit block is reported and not accepted');
  });

  it('reports drift when the document drops the tool-output report (FR-R4-F12)', () => {
    const gutted = realDoc().replace(
      '[constitution] termination token in tool output',
      'handled appropriately'
    );
    const drift = findDrift(gutted, realSource);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain('doc: the CLI stdout row no longer states');
    expect(drift[0]).toContain('a token in tool output is reported and not accepted');
  });

  it('reports drift when the source drops either new literal (FR-R4-F12)', () => {
    const stubbed = (path: string): string =>
      path === 'src/parser/stdout-parser.ts'
        ? realSource(path)
            .replace(
              "'[constitution] termination token without audit block, not accepted'",
              "'[constitution] renamed'"
            )
            .replace(
              "'[constitution] termination token in tool output, not accepted'",
              "'[constitution] renamed again'"
            )
        : realSource(path);
    const drift = findDrift(realDoc(), stubbed);
    expect(drift).toHaveLength(2);
    expect(drift.every((entry) => entry.startsWith('code: src/parser/stdout-parser.ts no longer provides'))).toBe(true);
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
