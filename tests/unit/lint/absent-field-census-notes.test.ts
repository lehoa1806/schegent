/**
 * The adjacent dated decision note, rule by rule.
 *
 * FR-R3-167 / FR-012. The grammar is in the feature's `contracts/decision-note-grammar.md`; the
 * short version is a comment carrying an ISO-8601 date, either trailing the assertion's own line
 * or anywhere inside the unbroken comment block immediately above it. Every edge that contract
 * lists has a case here.
 *
 * Why adjacency rather than a registry: the census read 64 hits by hand, judged most of them
 * coincidental, wrote the judgement into a document, and the document decayed. A judgement about
 * one line of code lives on that line or it does not survive.
 *
 * Fixture field names are invented on purpose; see the note in `absent-field-census-scan.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { findDecisionNote } from '../../lint/absent-field-census';

const ASSERTION = "  expect(record).not.toHaveProperty('alphaField');";

function noteFor(...lines: readonly string[]): ReturnType<typeof findDecisionNote> {
  const at = lines.findIndex((line) => line.includes('toHaveProperty'));
  return findDecisionNote(lines, at + 1);
}

describe('date form', () => {
  it('recognises YYYY-MM-DD', () => {
    const note = noteFor(`${ASSERTION} // 2026-09-06 coincidental: a queue item`);

    expect(note?.date).toBe('2026-09-06');
  });

  it('accepts a shape-valid but impossible date, rather than becoming a calendar', () => {
    const note = noteFor(`${ASSERTION} // 2026-13-45 deliberate: fat-fingered month, still a decision`);

    expect(note?.date).toBe('2026-13-45');
  });

  it('accepts a future date — there is no expiry and no staleness check', () => {
    const note = noteFor(`${ASSERTION} // 2099-01-01 deliberate: still a recorded decision`);

    expect(note?.date).toBe('2099-01-01');
  });

  it.each(['06/09/2026', 'Sep 6 2026', '20260906', '2026-9-6'])('rejects the date form %s', (written) => {
    const note = noteFor(`${ASSERTION} // ${written} coincidental: a queue item`);

    expect(note).toBeNull();
  });

  it('reports the first of two dates; nothing turns on which', () => {
    const note = noteFor(`${ASSERTION} // 2026-09-06 superseding 2025-01-02`);

    expect(note?.date).toBe('2026-09-06');
  });
});

describe('siting — same line', () => {
  it('recognises a trailing line comment', () => {
    const note = noteFor(`${ASSERTION} // 2026-09-06 coincidental: a queue item, not an audit payload`);

    expect(note?.siting).toBe('same-line');
    expect(note?.text).toContain('coincidental');
  });

  it('recognises a trailing block comment', () => {
    const note = noteFor(`${ASSERTION} /* 2026-09-06 deliberate: the projection drops it */`);

    expect(note?.siting).toBe('same-line');
  });

  it('does not read a date inside a string literal on the assertion line', () => {
    const note = noteFor(`${ASSERTION} const stamp = '2026-09-06';`);

    expect(note).toBeNull();
  });
});

describe('siting — the unbroken comment block above', () => {
  it('recognises a single line comment directly above', () => {
    const note = noteFor('  // 2026-09-06 deliberate: the projection drops this field', ASSERTION);

    expect(note?.siting).toBe('block-above');
    expect(note?.line).toBe(1);
  });

  it('recognises a date on any line of a multi-line `//` block', () => {
    const note = noteFor(
      '  // The receiver here is the queue item, not the audit event.',
      '  // 2026-09-06 coincidental: the name collided.',
      ASSERTION
    );

    expect(note?.siting).toBe('block-above');
    expect(note?.date).toBe('2026-09-06');
  });

  it('recognises a date on a `*` continuation line inside a doc block', () => {
    const note = noteFor('  /**', '   * 2026-09-06 deliberate: contract update filed separately.', '   */', ASSERTION);

    expect(note?.siting).toBe('block-above');
    expect(note?.date).toBe('2026-09-06');
  });

  it('is detached by a blank line', () => {
    const note = noteFor('  // 2026-09-06 deliberate: this no longer applies to the line below', '', ASSERTION);

    expect(note).toBeNull();
  });

  it('is detached by an intervening statement, even a trivial one', () => {
    const note = noteFor('  // 2026-09-06 deliberate: detached', '  const record = build();', ASSERTION);

    expect(note).toBeNull();
  });

  it('reads only the block touching the assertion when two blocks are stacked', () => {
    const note = noteFor(
      '  // 2026-09-06 the date is in the further block',
      '',
      '  // no date in this one',
      ASSERTION
    );

    expect(note).toBeNull();
  });
});

describe('what is not a site', () => {
  it('does not read a comment below the assertion', () => {
    const note = noteFor(ASSERTION, '  // 2026-09-06 this reads as a note about the next statement');

    expect(note).toBeNull();
  });

  it('does not read the enclosing `it(...)` title', () => {
    const note = noteFor("  it('omits alphaField — 2026-09-06 deliberate', () => {", ASSERTION);

    expect(note).toBeNull();
  });

  it('does not read the file header', () => {
    const note = noteFor(
      '/** 2026-09-06 every absence in this file is deliberate */',
      '',
      "describe('x', () => {",
      ASSERTION
    );

    expect(note).toBeNull();
  });
});

describe('the note must be dated', () => {
  it('an undated trailing comment is not a note', () => {
    const note = noteFor(`${ASSERTION} // coincidental: this is a queue item`);

    expect(note).toBeNull();
  });

  it('an undated block above is not a note', () => {
    const note = noteFor('  // coincidental: this is a queue item', ASSERTION);

    expect(note).toBeNull();
  });

  it('carries the comment body as text, for the report to quote back', () => {
    const note = noteFor(`${ASSERTION} // 2026-09-06 coincidental: this is a queue item`);

    expect(note?.text).toBe('2026-09-06 coincidental: this is a queue item');
  });

  it('a dated filename cited in a comment is not a date', () => {
    // `docs/audits/2026-05-19-speckit-checklists.md` is a path, and a comment that merely cites one
    // has decided nothing. Accepting it would let a reference satisfy the rule that exists to make
    // someone state a judgement.
    const note = noteFor(`${ASSERTION} // see docs/audits/2026-05-19-speckit-checklists.md`);

    expect(note).toBeNull();
  });

  it('a longer hyphenated token that opens with a date shape is not a date', () => {
    const note = noteFor(`${ASSERTION} // ticket 2026-05-19-1477 is open`);

    expect(note).toBeNull();
  });

  it('still reads a real date next to punctuation, and a timestamp', () => {
    expect(noteFor(`${ASSERTION} // (2026-09-06) coincidental: a queue item`)?.date).toBe('2026-09-06');
    expect(noteFor(`${ASSERTION} // 2026-09-06: coincidental: a queue item`)?.date).toBe('2026-09-06');
    expect(noteFor(`${ASSERTION} // decided 2026-09-06T14:00Z: deliberate`)?.date).toBe('2026-09-06');
  });
});

describe('multi-line assertions', () => {
  it('reads the block above from the assertion match line', () => {
    const note = noteFor(
      '  // 2026-09-06 deliberate: the projection drops it',
      '  expect(record).not.toHaveProperty(',
      "    'alphaField'",
      '  );'
    );

    expect(note?.siting).toBe('block-above');
  });

  it('reads the block above a wrapped B-family assertion, matched at the property not at `expect(`', () => {
    // The A case above passes for a reason that does not generalise: family A's pattern begins at
    // `not.toHaveProperty(`, so the match line is the statement's first line and the comment is
    // directly above it. A B-family pattern begins at the property access, which a wrap puts on a
    // line of its own — and the line above *that* is `expect(`, a statement, which detaches the
    // block. The author would have seen the finding stay red with the note plainly sitting above it.
    const note = findDecisionNote(
      [
        '  // 2026-09-06 coincidental: this is a queue item, not an audit payload',
        '  expect(',
        '    record.wrappedField',
        '  ).toBeNull();',
      ],
      3
    );

    expect(note?.siting).toBe('block-above');
    expect(note?.date).toBe('2026-09-06');
  });

  it('reads a note trailing the `expect(` line of a wrapped assertion', () => {
    const note = findDecisionNote(
      ['  expect( // 2026-09-06 deliberate: the projection drops it', '    record.wrappedField', '  ).toBeNull();'],
      2
    );

    expect(note?.siting).toBe('same-line');
    expect(note?.line).toBe(1);
  });

  it('does not walk back past a line that is not a continuation', () => {
    // The walk-back is bounded by the open paren. A preceding statement still detaches the block,
    // exactly as it does for an unwrapped assertion.
    const note = findDecisionNote(
      [
        '  // 2026-09-06 deliberate: detached by the statement below it',
        '  const record = build();',
        '  expect(',
        '    record.wrappedField',
        '  ).toBeNull();',
      ],
      4
    );

    expect(note).toBeNull();
  });
});
