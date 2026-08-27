// FR-R3-131 — the assistive-technology matrix says what was observed, and the
// release documents may not claim more than it holds.
//
// THE CLASS. `FR-R3-091` built the AT matrix and wrote the rule inside it: *"Do
// not mark a row from an automated result. The scan is in `repo/tests/a11y/`; it
// is a different claim."* Nothing enforced it. The audit of 2026-08-27 then found
// the paired defect one level up — a WCAG 2.1 AA target stated in two product
// documents while 30 violations sat accepted in a baseline and every AT row read
// UNTESTED. The gate that would have caught the drift did not exist; this is it.
//
// TARGET vs CLAIM, which is the distinction that makes this gate writable at
// all. `PRODUCT.md` and `docs/prd-metrics-dashboard.md` state WCAG 2.1 AA as a
// TARGET, and `a11y-policy-parity.test.ts` REQUIRES those statements so the
// scan's axe tag set cannot drift from the level the product aims at. A gate that
// forbade "AA in a document" would contradict that one. What is forbidden is a
// CONFORMANCE ASSERTION: that the product conforms to, is compliant with, or
// meets the level — a statement about an evaluation, made while the evaluation's
// own record says every row is untested.
//
// WHY IT IS SCOPED TO RELEASE DOCUMENTS. A conformance claim does its damage
// where someone reads it before installing. `docs/` prose that discusses the
// distinction — this repository has a lot of it, deliberately — is not the
// hazard, and a gate that scanned it would flag the sentences explaining the
// rule.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readReviewDate, reviewIsDue } from './review-dates';

const REPO_ROOT = resolve(__dirname, '..', '..');
const MATRIX_PATH = 'docs/release/accessibility-at-matrix.md';
const RELEASE_PATH = 'RELEASE.md';

/**
 * The marker the matrix's review date is authored under. Same mechanism
 * `FR-R3-129` gave the platform decline, for the same reason: the owed VoiceOver
 * session is only honest while somebody re-reads the fact that it is owed. The
 * predicate is shared (`review-dates.ts`); the date lives in the document.
 */
const REVIEW_MARKER = 'at-matrix-review-date';

const read = (path: string): string => readFileSync(resolve(REPO_ROOT, path), 'utf8');

/**
 * Documents a prospective user or operator reads as a statement about the
 * shipped product. `PRODUCT.md` and the PRD live in the planning envelope and
 * are deliberately absent: they carry the TARGET statement that
 * `a11y-policy-parity.test.ts` requires.
 */
const RELEASE_DOCUMENTS = [RELEASE_PATH, 'README.md', 'docs/release/README.md'] as const;

/**
 * Conformance assertions, as they are actually written. Each pattern needs the
 * verb AND the level: "meets" alone catches nothing useful, and "WCAG 2.1 AA"
 * alone is the target statement that must be allowed.
 */
const CONFORMANCE_ASSERTIONS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly phrasing: string;
}> = [
  { pattern: /conforms?\s+to\s+WCAG/i, phrasing: 'conforms to WCAG' },
  { pattern: /(?:is|are|fully)\s+compliant\s+with\s+WCAG/i, phrasing: 'compliant with WCAG' },
  { pattern: /WCAG[^.\n]{0,40}complian(?:t|ce)\b/i, phrasing: 'WCAG ... compliant/compliance' },
  { pattern: /\bmeets\s+(?:the\s+)?(?:requirements\s+of\s+)?WCAG/i, phrasing: 'meets WCAG' },
  { pattern: /\bAA\s+(?:certified|conformant)\b/i, phrasing: 'AA certified/conformant' },
  { pattern: /accessibility\s+conformance\s+report/i, phrasing: 'accessibility conformance report' }
];

/**
 * A phrase is quoted-and-forbidden, not asserted, when a negation governs it —
 * meaning the negation sits in the SAME CLAUSE.
 *
 * TWO WRONG DESIGNS CAME FIRST and both are worth recording, because each was
 * plausible and each shipped a defect a review caught.
 *
 *  1. `line.includes('is not')` over the whole line. *"Feature X is not supported
 *     on Linux, but the product meets WCAG 2.1 AA"* contains the substring in an
 *     unrelated clause, so a real claim was waved through.
 *  2. "a negation within 60 characters, with no clause boundary between" — where
 *     the boundary list was `[.;:—]` plus a comma followed by one of five
 *     conjunctions. The whitelist was the hole: *"This does not change engineering
 *     practice, the product meets WCAG 2.1 AA today"* has a bare comma splice and
 *     *"…, so the product meets…"* has an unlisted conjunction. Both excused.
 *
 * So the check is CONTAINMENT, not absence: find the clause the phrase sits in —
 * everything after the last clause mark of ANY kind — and ask whether a negation
 * is inside it. A whitelist can be short; "any comma ends a clause" cannot.
 *
 * ASIDES ARE TRANSPARENT, which the containment rule needs to be usable on this
 * repository's prose. *"A release may not — under any circumstance — say the
 * product meets WCAG 2.1 AA"* is a prohibition, and em-dash asides are how these
 * documents are written. A balanced aside is removed before the clause is found,
 * so it neither ends the clause nor hides the negation.
 */
const PROHIBITION_MARKERS = [
  'may NOT',
  'may not',
  'must not',
  'does not',
  'do not',
  'cannot',
  'no longer',
  'not claim',
  'is not',
  'are not',
  'never'
] as const;

/** Marks that end a clause. ANY comma counts — see design 2 above. */
const CLAUSE_MARKS = /[.;:,—]/g;

/**
 * Markdown emphasis, stripped before matching.
 *
 * WITHOUT THIS THE GATE WAS ACCIDENTALLY SILENT. `RELEASE.md`'s own prohibition
 * used `*meets*` and `*conforms to*`, which no pattern here matched — so the
 * negation path was exercised only by fixtures, and a real claim written as *the
 * product **meets** WCAG 2.1 AA* would have escaped for the same reason.
 */
const EMPHASIS = /[*_`]/g;

/** Balanced asides, which a clause reads through rather than ending at. */
const ASIDES: readonly RegExp[] = [/—[^—]*—/g, /\([^)]*\)/g, /\[[^\]]*\]/g];

/**
 * The document as STATEMENTS — wrapped prose rejoined, then split into sentences.
 *
 * Scanning by line was the third wrong design, and the live document caught it
 * immediately: `RELEASE.md` wraps at 100 columns, so *"It may not say the product
 * meets WCAG 2.1 Level AA."* arrives as two lines and the negation sits on the
 * one the phrase does not. A line is a typographic unit; a clause is not.
 *
 * Block markers — table rows, list items, headings, fences — end a statement, so
 * a table row is never glued to the prose above it.
 */
const BLOCK_START = /^\s*(?:[|>#-]|\d+\.|```)/;

export function statements(source: string): readonly string[] {
  // `previous` is carried rather than read back out of the array: an indexed read
  // needs an `undefined` guard that `no-unnecessary-condition` calls dead and
  // `noUncheckedIndexedAccess` requires. Carrying it makes the type honest.
  const joined: string[] = [];
  let previous = '';
  for (const line of source.split('\n')) {
    const continues =
      previous.trim().length > 0 &&
      line.trim().length > 0 &&
      !BLOCK_START.test(line) &&
      !BLOCK_START.test(previous);
    previous = continues ? `${previous.trimEnd()} ${line.trim()}` : line;
    if (continues) {
      joined[joined.length - 1] = previous;
      continue;
    }
    joined.push(line);
  }
  // A sentence boundary is a clause mark too, so splitting here only improves the
  // failure message; `governingClause` would reach the same verdict either way.
  return joined.flatMap((block) => block.split(/(?<=\.)\s+(?=[A-Z(])/));
}

/** The clause the phrase at `matchIndex` sits in. */
export function governingClause(line: string, matchIndex: number): string {
  let before = line.slice(0, matchIndex);
  for (const aside of ASIDES) before = before.replace(aside, ' ');
  let last = -1;
  CLAUSE_MARKS.lastIndex = 0;
  for (let mark = CLAUSE_MARKS.exec(before); mark !== null; mark = CLAUSE_MARKS.exec(before)) {
    last = mark.index;
  }
  return before.slice(last + 1);
}

/** Is the matched phrase governed by a negation, rather than merely near one? */
export function isNegated(line: string, matchIndex: number): boolean {
  const clause = governingClause(line, matchIndex);
  return PROHIBITION_MARKERS.some((marker) => clause.includes(marker));
}

interface MatrixRow {
  readonly os: string;
  readonly reader: string;
  readonly result: string;
  readonly trigger: string;
  readonly line: string;
}

/** The rows of the matrix table, which is the first table in the document. */
function matrixRows(source: string): readonly MatrixRow[] {
  const rows: MatrixRow[] = [];
  for (const line of source.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    // `| OS | reader | version | exercised | result | trigger |` — 6 cells plus
    // the empty edges the split produces.
    if (cells.length !== 8) continue;
    // Defaults rather than four `undefined` guards: the length check above does
    // not narrow the elements for `noUncheckedIndexedAccess`, and the guards it
    // would need are what `no-unnecessary-condition` calls dead. A default is
    // true under both readings.
    const [, os = '', reader = '', , , result = '', trigger = ''] = cells;
    if (os === 'OS' || os.startsWith('---')) continue;
    if (!/^(macOS|Windows|Linux)$/.test(os)) continue;
    rows.push({ os, reader, result, trigger, line });
  }
  return rows;
}

describe('FR-R3-131 — the AT matrix records observation, not inference', () => {
  const matrix = read(MATRIX_PATH);
  const rows = matrixRows(matrix);

  it('finds the matrix rows at all', () => {
    // The control. Every assertion below is a per-row loop, and this file's whole
    // subject is a table whose format could change: a parser that silently
    // matched nothing would turn this gate into four vacuous loops reporting
    // green. The four platforms are named in FR-R3-091's own matrix.
    expect(rows.length, `no platform rows parsed from ${MATRIX_PATH}`).toBeGreaterThanOrEqual(4);
    expect(rows.map((row) => row.reader).sort()).toEqual(
      ['NVDA', 'Narrator', 'Orca', 'VoiceOver'].sort()
    );
  });

  it('carries no result without a date', () => {
    for (const row of rows) {
      if (/UNTESTED/i.test(row.result)) continue;
      expect(
        row.result,
        `${row.os}/${row.reader} records a result — "${row.result}" — with no date. A row that ` +
          'says pass without saying when says nothing: the product it was measured against has ' +
          'moved. Name the AT version, the OS version and the date.'
      ).toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });

  it('gives every untested row a trigger', () => {
    for (const row of rows) {
      if (!/UNTESTED/i.test(row.result)) continue;
      expect(
        row.trigger.length,
        `${row.os}/${row.reader} is UNTESTED with no trigger. An untested row with no trigger is ` +
          'a deferral with no owner, which is how a gap outlives the person who accepted it. Name ' +
          'a date or the verification it waits on.'
      ).toBeGreaterThan(0);
      expect(row.trigger).not.toBe('—');
    }
  });

  it('carries a review date that has not passed', () => {
    const reviewDate = readReviewDate(matrix, REVIEW_MARKER);
    // Vacuity control first: a removed marker makes the date null, and a gate
    // comparing null to today would pass — the owed row silently losing the only
    // thing that makes it temporary.
    expect(
      reviewDate,
      `${MATRIX_PATH} carries no '<!-- ${REVIEW_MARKER}: YYYY-MM-DD -->' marker. An owed ` +
        'assistive-technology session with no review date is a deferral that expires quietly.'
    ).not.toBeNull();
    expect(
      reviewIsDue(reviewDate!, new Date()),
      `The AT matrix's review date (${reviewDate!}) has passed. This failure IS the reminder: ` +
        'either the VoiceOver session was run and the rows carry dated results, or it was not and ' +
        'the date moves with a sentence saying what was re-read. Do not delete the marker.'
    ).toBe(false);
  });

  it('keeps the runnable procedure beside the row that owes it', () => {
    // A row recorded as owed is only honest if executing it is a session's work
    // rather than a design exercise — the standard FR-R3-129 set for the live
    // canary declination.
    expect(matrix).toContain('The VoiceOver procedure');
    expect(matrix).toContain('user-quickstart.md');
    expect(matrix, 'the procedure must forbid marking a row from the automated scan').toContain(
      'Do not mark a row from an automated result'
    );
  });
});

describe('FR-R3-131 — release documents claim no more than the matrix holds', () => {
  const matrix = read(MATRIX_PATH);
  const anyUntested = matrixRows(matrix).some((row) => /UNTESTED/i.test(row.result));

  it('has something to judge', () => {
    // Control: if no release document existed, every loop below would pass.
    const present = RELEASE_DOCUMENTS.filter((path) => existsSync(resolve(REPO_ROOT, path)));
    expect(present).toContain(RELEASE_PATH);
    expect(present.length).toBeGreaterThanOrEqual(1);
  });

  it('asserts no conformance while any AT row is untested', () => {
    expect(
      anyUntested,
      'every AT row now carries a result — update this gate: the prohibition it enforces was ' +
        'written for the state where none did'
    ).toBe(true);

    for (const path of RELEASE_DOCUMENTS) {
      if (!existsSync(resolve(REPO_ROOT, path))) continue;
      for (const raw of statements(read(path))) {
        const line = raw.replace(EMPHASIS, '');
        const forbidden = CONFORMANCE_ASSERTIONS.map((entry) => ({
          entry,
          at: entry.pattern.exec(line)?.index ?? -1
        })).find((candidate) => candidate.at >= 0);
        if (forbidden === undefined) continue;
        // The sentences that FORBID the claim necessarily contain it. A gate that
        // could not tell those apart would fail on the prohibition it enforces.
        if (isNegated(line, forbidden.at)) continue;
        expect.fail(
          `${path} asserts conformance ("${forbidden.entry.phrasing}") while the ` +
            'assistive-technology ' +
            `matrix records every row UNTESTED:\n    ${line.trim()}\n  A clean automated scan is ` +
            'not conformance — AA is not a contrast ratio. Say the product is BUILT AGAINST the ' +
            'level, or execute the matrix.'
        );
      }
    }
  });

  it('tells a governing negation from an unrelated one — every review case', () => {
    // Each row below was a bypass or a false positive in a real draft of this
    // gate, found by review before it landed. They are fixtures because a false
    // negative here ships an overclaim and a false positive fails the gate on
    // honest prose — and the two pull in opposite directions, so a regression in
    // either would otherwise look like a fix.
    const MEETS = /\bmeets\s+(?:the\s+)?(?:requirements\s+of\s+)?WCAG/i;
    const cases: ReadonlyArray<{ line: string; negated: boolean; why: string }> = [
      {
        line: 'A release may not say the product meets WCAG 2.1 Level AA.',
        negated: true,
        why: 'a plain governing prohibition'
      },
      {
        line: 'A release may not — under any circumstance — say the product meets WCAG 2.1 AA.',
        negated: true,
        why: 'an em-dash aside between negation and phrase does not end the clause'
      },
      {
        line: 'A release may not (see the matrix) say the product meets WCAG 2.1 AA.',
        negated: true,
        why: 'a parenthetical aside is transparent too'
      },
      {
        line: 'Feature X is not supported on Linux, but the product meets WCAG 2.1 AA.',
        negated: false,
        why: 'the whole-line substring bypass: an unrelated clause held "is not"'
      },
      {
        line: 'This does not change engineering practice, the product meets WCAG 2.1 AA today.',
        negated: false,
        why: 'a bare comma splice, which a conjunction whitelist missed'
      },
      {
        line: 'The audit does not cover every route, so the product meets WCAG 2.1 AA.',
        negated: false,
        why: 'an unlisted conjunction, which the same whitelist missed'
      },
      {
        line: 'A release may not overstate anything. The product meets WCAG 2.1 AA.',
        negated: false,
        why: 'a full stop ends the clause; the next sentence is its own claim'
      }
    ];

    for (const { line, negated, why } of cases) {
      const at = MEETS.exec(line)?.index ?? -1;
      expect(at, `fixture must match a conformance pattern: ${line}`).toBeGreaterThan(0);
      expect(isNegated(line, at), `${why} — ${line}`).toBe(negated);
    }
  });

  it('exercises the negation path on the live prohibition, not only on fixtures', () => {
    // The control for `isNegated`. Every assertion in the test above this one is
    // a fixture, and a gate whose discriminating logic is only ever run against
    // fixtures is a gate that could be deleted without any real document
    // noticing. RELEASE.md's prohibition MUST match a forbidden pattern and MUST
    // be excused — if it stops matching, the patterns have drifted from the prose
    // they are supposed to police.
    let excused = 0;
    for (const raw of statements(read(RELEASE_PATH))) {
      const line = raw.replace(EMPHASIS, '');
      const at = CONFORMANCE_ASSERTIONS.map((entry) => entry.pattern.exec(line)?.index ?? -1).find(
        (index) => index >= 0
      );
      if (at === undefined) continue;
      expect(isNegated(line, at), `unexcused in the live document: ${line.trim()}`).toBe(true);
      excused += 1;
    }
    expect(
      excused,
      'RELEASE.md no longer contains a single sentence matching a conformance pattern. Either the ' +
        'prohibition was rewritten past the patterns, or the patterns drifted: both mean this ' +
        'gate is now judging prose that does not exist.'
    ).toBeGreaterThanOrEqual(4);
  });

  it('states the boundary and what would lift it', () => {
    const release = read(RELEASE_PATH);
    expect(release, 'the boundary must be written where claims are made').toContain(
      'The accessibility claims a release may NOT make'
    );
    expect(release, 'and it must name the manual pass no snapshot expresses').toContain(
      'The manual accessibility pass a release must run'
    );
    // Naming only the prohibition leaves an author with no path forward, which is
    // how a boundary gets deleted instead of satisfied.
    expect(release).toContain('What lifts the prohibition');
    expect(release).toContain('accessibility-at-matrix.md');
  });
});
