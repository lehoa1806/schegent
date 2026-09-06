/**
 * The census scan: what is a comment, what is an assertion, and why the two counts differ.
 *
 * FR-R3-167 / FR-001, FR-004, FR-015. Unit tests against synthetic fixtures, so the scanner's
 * behaviour is pinned independently of whatever the real tree happens to contain today.
 *
 * Every fixture field name here is invented (`alphaField`, `betaField`, …). That is not
 * decoration: this file lives under `tests/`, so the census scans it, and a fixture naming a
 * real contract field would plant a finding in the population the gate reports.
 */

import { describe, expect, it } from 'vitest';

import { blankComments, blankCommentsBounded, findDecisionNote, scanSource } from '../../lint/absent-field-census';

/** Wall-clock for one call, in milliseconds. */
const elapsed = (fn: () => void): number => {
  const started = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
};

describe('blankComments', () => {
  it('blanks a line comment and keeps the code beside it', () => {
    const source = ["const a = 1; // not.toHaveProperty('alphaField')", 'const b = 2;'].join('\n');
    const blanked = blankComments(source);

    expect(blanked.split('\n')).toHaveLength(2);
    expect(blanked).toContain('const a = 1;');
    expect(blanked).not.toContain('toHaveProperty');
  });

  it('preserves offsets so a blanked line still reports its own line number', () => {
    const source = ["// gone\nconst a = 1;\n/* also gone */\nconst b = 2;"].join('');
    const blanked = blankComments(source);

    expect(blanked).toHaveLength(source.length);
    expect(blanked.split('\n')).toHaveLength(4);
    expect(blanked.split('\n')[1]).toBe('const a = 1;');
  });

  it('blanks a block comment across lines, including `*` continuation lines', () => {
    const source = [
      '/**',
      ' * A doc block.',
      " * Many assertions below are not.toHaveProperty('betaField'),",
      ' * which passes on undefined.',
      ' */',
      "expect(record).not.toHaveProperty('gammaField');",
    ].join('\n');

    const blanked = blankComments(source);

    expect(blanked).not.toContain('betaField');
    expect(blanked).toContain('gammaField');
  });

  it('leaves a comment marker inside a string literal alone', () => {
    const source = ["const s = 'http://example.test/x'; // real comment", 'const t = 3;'].join('\n');
    const blanked = blankComments(source);

    expect(blanked).toContain('http://example.test/x');
    expect(blanked).not.toContain('real comment');
  });

  it('leaves a block-comment opener inside a string literal alone', () => {
    const source = ["const s = '/* not a comment */'; const u = 4;"].join('\n');
    const blanked = blankComments(source);

    expect(blanked).toContain('not a comment');
    expect(blanked).toContain('const u = 4;');
  });

  it('reads a regex literal after `return`, so an apostrophe inside it opens no phantom string', () => {
    // The desynchronisation that deletes assertions instead of reporting them. Read `/` as
    // division and the apostrophe starts a string that never closes on its line; every later `//`
    // is then read inside-out, and the assertions below vanish from the population while the
    // lines-versus-assertions accounting stays balanced. Green, and wrong.
    const source = [
      "const isContraction = (s) => { return /don't/.test(s); };",
      "expect(record).not.toHaveProperty('alphaField');",
    ].join('\n');
    const blanked = blankComments(source);

    expect(blanked).toContain('alphaField');
    expect(scanSource('tests/fixture.test.ts', source).assertions).toHaveLength(1);
  });

  it('treats `.return` as a property name, not the keyword', () => {
    // `obj.return / 2` divides. Reading the `/` as a regex opener here would swallow real code.
    const source = ['const half = obj.return / 2;', "expect(record).not.toHaveProperty('alphaField');"].join('\n');
    const blanked = blankComments(source);

    expect(blanked).toContain('const half = obj.return / 2;');
    expect(scanSource('tests/fixture.test.ts', source).assertions).toHaveLength(1);
  });

  it('reads a `/` inside a character class as an ordinary character', () => {
    // Found by differential-testing this blanker against the TypeScript compiler's own comment
    // ranges over the whole corpus. A path-matching regex is the shape that breaks it: the `/` in
    // the class closes the literal three characters early, the backtick after it opens a phantom
    // template, and from there the file is read inside-out. `lint-anchor-grounding.test.ts` and
    // `release-qualification.test.ts` both carry it. Latent when found — neither desynced region
    // held an absent-field pattern — and latent is not fixed: one assertion added below either
    // line would have left the population without a word.
    const source = [
      "const paths = /['\"`]((?:src|tests)\\/[\\w.-]+)['\"`]/g;",
      '// a real comment, which must still be blanked',
      "expect(record).not.toHaveProperty('alphaField');",
    ].join('\n');
    const blanked = blankComments(source);

    expect(blanked).toContain('const paths =');
    expect(blanked).not.toContain('a real comment');
    expect(scanSource('tests/fixture.test.ts', source).assertions).toHaveLength(1);
  });

  it('reads a template nested inside an interpolation, not the outer backtick it opens with', () => {
    // The second construct the differential test disagreed on, in
    // `save-general-settings-doc-parity.test.ts`. Scanning for the next unescaped backtick stops at
    // the *inner* template's opening one, so the rest of the outer template is read as code — and a
    // `//` inside it blanks a line that is not a comment.
    const source = [
      'const rendered = `keys: ${keys.map((key) => `\\`${key}\\``).join(", ")} // not a comment`;',
      "expect(record).not.toHaveProperty('alphaField');",
    ].join('\n');
    const blanked = blankComments(source);

    expect(blanked).toContain('not a comment');
    expect(blanked).toContain('alphaField');
    expect(scanSource('tests/fixture.test.ts', source).assertions).toHaveLength(1);
  });

  it('does not let an unterminated template inside an interpolation swallow the file', () => {
    const source = ['const s = `${"unclosed}`;', "expect(record).not.toHaveProperty('alphaField');"].join('\n');
    const blanked = blankComments(source);

    expect(blanked).toContain('alphaField');
    expect(scanSource('tests/fixture.test.ts', source).assertions).toHaveLength(1);
  });

  it('survives a template nested deeper than the call stack would have allowed', () => {
    // The fix for the two constructs above put the nesting depth on the call stack, by way of a
    // `templateEnd`/`interpolationEnd` pair that called each other. A corpus file nesting templates
    // deeply enough then threw `RangeError: Maximum call stack size exceeded` — and `runCensus`
    // runs at module scope, where vitest's `testTimeout` does not reach, so the whole gate reported
    // nothing instead of reporting a finding about the file that did it. A scanner the corpus can
    // take down is not a gate.
    //
    // 50,000 is chosen against measurement, not for roundness: the recursive form crashed here and
    // survived 30,000 under this same runner, so a smaller depth would pass either way and pin
    // nothing. On the heap the ceiling is memory, and this fixture is a quarter of a megabyte.
    const depth = 50_000;
    const deep = `${'`${'.repeat(depth)}\`x\`${'}`'.repeat(depth)}`;
    const source = [`const nested = ${deep};`, "expect(record).not.toHaveProperty('alphaField');"].join('\n');

    expect(() => blankComments(source)).not.toThrow();
    expect(scanSource('tests/fixture.test.ts', source).assertions).toHaveLength(1);
  });

  it('does not let one unmatched quote swallow the rest of the file', () => {
    // A quoted string cannot span a line, so a lone apostrophe is a lone apostrophe. Treating it
    // as an opener would put everything after it "inside a string" and blank nothing again.
    const source = ["const note = 3; // it's fine", "expect(record).not.toHaveProperty('alphaField');"].join('\n');
    const blanked = blankComments(source);

    expect(blanked).not.toContain('fine');
    expect(blanked).toContain('alphaField');
    expect(scanSource('tests/fixture.test.ts', source).assertions).toHaveLength(1);
  });
});

describe('blankComments — a comment inside a `${...}` interpolation', () => {
  // `${...}` holds expression text and expression text may be commented; a template body may not.
  // Reading the two the same way desynchronises in the quietest possible direction: the brace inside
  // the comment closes the interpolation, the backtick after it closes the template, and live code
  // beyond is blanked away. The reconciliation gate in the census cannot see it happen — the erased
  // line still counts once against `linesByFamily` and once against `commentLines`, so
  // `lines === code + comment` still holds while the population is one assertion short.

  it('does not let a brace and a backtick inside a block comment close the template', () => {
    const source = ['const s = `${/* } ` */ 0}`;', "expect(record).not.toHaveProperty('alphaField');"].join('\n');
    const blanked = blankComments(source);

    // The assertion is live code and must survive intact.
    expect(blanked).toContain("expect(record).not.toHaveProperty('alphaField');");
    expect(scanSource('tests/fixture.test.ts', source).assertions).toHaveLength(1);
    // And the comment is a comment: blanked, like every other one.
    expect(blanked).toContain('const s = `${');
    expect(blanked).not.toContain('/*');
  });

  it('does the same for a line comment, which ends at the newline and not before', () => {
    const source = ['const s = `${// } `', '0}`;', "expect(record).not.toHaveProperty('alphaField');"].join('\n');
    const blanked = blankComments(source);

    expect(blanked.split('\n')).toHaveLength(3);
    expect(blanked).not.toContain('//');
    expect(scanSource('tests/fixture.test.ts', source).assertions).toHaveLength(1);
  });

  it('leaves a `//` in the template body alone, because there it is two characters', () => {
    // The other direction, and the one a careless fix breaks: comment skipping belongs to the
    // interpolation frames only. Applied to the body it would eat the rest of every URL.
    const source = ['const s = `http://example.test/x`;', "expect(record).not.toHaveProperty('alphaField');"].join(
      '\n'
    );
    const blanked = blankComments(source);

    expect(blanked).toContain('`http://example.test/x`');
    expect(scanSource('tests/fixture.test.ts', source).assertions).toHaveLength(1);
  });

  it('keeps a commented-out assertion inside an interpolation out of the population', () => {
    // The reason the spans are blanked rather than merely stepped over. TypeScript calls this a
    // comment; a census that counted it would be reporting an assertion nobody wrote.
    const source = ["const s = `${/* expect(r).not.toHaveProperty('alphaField') */ 0}`;"].join('\n');

    expect(scanSource('tests/fixture.test.ts', source).assertions).toEqual([]);
  });

  it('leaves no blank behind when the template it was found in turns out not to be one', () => {
    // A scan that fails is discarded and the caller re-reads the same text from the backtick onward
    // as ordinary code. A blank written during the abandoned scan would erase what is live under the
    // reading actually kept — so the spans are collected and applied only if the scan closes.
    //
    // Telling the two readings apart takes a construct the template scanner does not know and the
    // blanking loop does: a regex literal. Inside `/[ … ]/` the characters below are a character
    // class, and the template scan — which has no notion of a regex — reads them as a comment. If it
    // could blank on the way out, it would gut a live regex.
    const source = [
      'const pattern = `${x = /[/* keep */]/ };',
      "expect(record).not.toHaveProperty('alphaField');",
    ].join('\n');
    const blanked = blankComments(source);

    expect(blanked).toContain('/[/* keep */]/');
    expect(scanSource('tests/fixture.test.ts', source).assertions).toHaveLength(1);
  });
});

describe('blankComments — the scan budget', () => {
  // Each sub-scanner discards its work when it fails to find a close, and the caller steps over one
  // character and tries again. That recovery is right and it is quadratic: Θ(n) failing openers, each
  // costing a Θ(n) scan. Before the budget, 375 KiB of `` `${ `` took 136 seconds — and `runCensus()`
  // runs at module scope, where vitest's `testTimeout` cannot reach it, so the gate would report
  // nothing at all rather than report the file that did it.
  //
  // 375 KiB is three times the largest file already in the corpus. The bound below is two orders of
  // magnitude above what the fixed scanner takes and three below what the broken one took, so it
  // fails on a regression and does not flake on a slow machine.
  const PATHOLOGICAL_MS = 5_000;

  const payloads: readonly { readonly name: string; readonly unit: string }[] = [
    // Two frames pushed per unit and never closed. The self-balancing `` `${` `` does not reproduce
    // it: its second backtick pops the frame the first pushed, so re-entry returns immediately.
    { name: 'templates', unit: '`${' },
    { name: 'quoted strings', unit: "=\\'" },
    { name: 'regex literals', unit: '=[/' },
  ];

  for (const { name, unit } of payloads) {
    it(`reports a file built from unterminated ${name} instead of grinding on it`, () => {
      // Every unit is three characters, so the repeat count is chosen to land on 375 KiB exactly.
      const source = unit.repeat(128_000);
      expect(source.length).toBe(375 * 1024);

      let result = { text: '', unscannable: null as string | null };
      const ms = elapsed(() => {
        result = blankCommentsBounded(source);
      });

      expect(result.unscannable).toMatch(/scan budget exhausted/);
      expect(ms).toBeLessThan(PATHOLOGICAL_MS);
    });
  }

  it('carries counts and no corpus text in the reason it reports', () => {
    // The reason reaches a failure message and a failure message reaches CI logs.
    const secret = "'tok_live_00000000000000000000";
    const { unscannable } = blankCommentsBounded(`${secret}${'`${'.repeat(2000)}`);

    expect(unscannable).not.toBeNull();
    expect(unscannable).not.toContain('tok_live');
    expect(unscannable).toMatch(/^scan budget exhausted: \d+ sub-scan character examinations over \d+ characters/);
  });

  it('throws from the unbounded convenience rather than returning a half-scanned string', () => {
    // `blankComments` is for fixtures of known size. There is nothing correct to do with a partial
    // blank, and handing one back silently is the failure this whole module is written against.
    expect(() => blankComments('`${'.repeat(2000))).toThrow(/scan budget exhausted/);
  });

  it('drops an unscannable file out of the population with its reason, not its numbers', () => {
    const scan = scanSource('tests/hostile.test.ts', `${"expect(r).not.toHaveProperty('alphaField');\n"}${'`${'.repeat(2000)}`);

    expect(scan.unscannable).toMatch(/scan budget exhausted/);
    expect(scan.assertions).toEqual([]);
    // Every counter zeroed. A blank the scanner knows it did not finish must not produce a count
    // that reads as a measurement of the file.
    expect(scan.linesByFamily).toEqual({ A: 0, B1: 0, B2: 0, B3: 0, B4: 0 });
    expect(scan.codeLinesByFamily).toEqual({ A: 0, B1: 0, B2: 0, B3: 0, B4: 0 });
  });

  it('leaves an ordinary file scannable, and the depth fixture with it', () => {
    // The budget must not be so tight that legitimate source trips it. The whole 1134-file corpus
    // scans at one character of allowance per character of source; this holds the two extremes that
    // are checkable without the tree — a plain file, and the deepest nesting the suite constructs.
    const plain = ["// a note\nconst a = `x${1}y`;", "expect(record).not.toHaveProperty('alphaField');"].join('\n');
    expect(blankCommentsBounded(plain).unscannable).toBeNull();

    const depth = 50_000;
    const deep = `${'`${'.repeat(depth)}\`x\`${'}`'.repeat(depth)}`;
    expect(blankCommentsBounded(`const nested = ${deep};`).unscannable).toBeNull();
  });
});

describe('findDecisionNote — one blanking pass per file, not one per finding', () => {
  it('answers repeatedly about one file without re-blanking it each time', () => {
    // `classify` calls this once per finding, and it blanked the whole file every time. On a 52 KiB
    // file with a hundred findings that turned a bounded cost into three minutes. The blanked split
    // is memoised on the line array `runCensus` already caches per file, so the pass happens once.
    //
    // Measured rather than asserted structurally, because the memo is an internal. 190 KiB costs
    // about 12 ms to blank; a thousand answers without the memo is twelve seconds, with it under a
    // millisecond. Two seconds sits far below the one and far above the other.
    const REPEATS = 1_000;
    const BUDGET_MS = 2_000;

    const bulk = Array.from({ length: 6_000 }, (_, k) => `const value${k} = ${k}; // filler ${k}`);
    const lines = [...bulk, '// 2026-09-06 deliberate: fixture note', "expect(r).not.toHaveProperty('alphaField');"];
    expect(lines.join('\n').length).toBeGreaterThan(150 * 1024);

    const ms = elapsed(() => {
      for (let k = 0; k < REPEATS; k += 1) findDecisionNote(lines, lines.length);
    });

    // The answer is still the answer — a memo that returned the wrong split would be worse than slow.
    expect(findDecisionNote(lines, lines.length)?.date).toBe('2026-09-06');
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});

describe('scanSource — the five pattern families', () => {
  const cases: readonly { readonly family: string; readonly line: string; readonly field: string }[] = [
    { family: 'A', line: "expect(record).not.toHaveProperty('alphaField');", field: 'alphaField' },
    { family: 'B1', line: 'expect(record.betaField).toBeUndefined();', field: 'betaField' },
    { family: 'B2', line: 'expect(record.gammaField).toBe(undefined);', field: 'gammaField' },
    { family: 'B3', line: 'expect(record.deltaField).toBeNull();', field: 'deltaField' },
    { family: 'B4', line: 'expect(record.epsilonField).toBe(null);', field: 'epsilonField' },
  ];

  for (const { family, line, field } of cases) {
    it(`matches family ${family} and reads its literal field name`, () => {
      const scan = scanSource('tests/fixture.test.ts', line);

      expect(scan.assertions).toHaveLength(1);
      const found = scan.assertions.at(0);
      expect(found?.family).toBe(family);
      expect(found?.fieldName).toBe(field);
      expect(found?.line).toBe(1);
      expect(found?.file).toBe('tests/fixture.test.ts');
    });
  }

  it('reports a 1-indexed line number, matching grep -n', () => {
    const source = ['const a = 1;', 'const b = 2;', "expect(r).not.toHaveProperty('alphaField');"].join('\n');
    const scan = scanSource('tests/fixture.test.ts', source);

    expect(scan.assertions[0]?.line).toBe(3);
  });

  it('carries the assertion source text for the failure message', () => {
    const scan = scanSource('tests/fixture.test.ts', "  expect(r).not.toHaveProperty('alphaField');");

    expect(scan.assertions[0]?.text).toBe("expect(r).not.toHaveProperty('alphaField');");
  });

  it('accepts double quotes and backticks as well as single quotes', () => {
    const source = [
      'expect(r).not.toHaveProperty("alphaField");',
      'expect(r).not.toHaveProperty(`betaField`);',
    ].join('\n');
    const scan = scanSource('tests/fixture.test.ts', source);

    expect(scan.assertions.map((a) => a.fieldName)).toEqual(['alphaField', 'betaField']);
  });
});

describe('scanSource — an assertion wrapped across lines', () => {
  /**
   * Prettier wraps an assertion the moment it crosses the print width, and every one of the five
   * published `grep` commands then stops seeing it. A census whose answer changes when a file is
   * reformatted is the decay this feature exists to end, so the scan reads the whole source and
   * reports separately how much of what it found a line-oriented search could not have.
   */
  const wrapped = [
    'expect(',
    '  (result.command as { payload: { selection: { alphaField: number | null } } }).payload',
    '    .selection.alphaField',
    ').toBeNull();',
  ].join('\n');

  it('finds the assertion and names its field', () => {
    const scan = scanSource('tests/fixture.test.ts', wrapped);

    expect(scan.assertions).toHaveLength(1);
    expect(scan.assertions[0]?.fieldName).toBe('alphaField');
    expect(scan.assertions[0]?.family).toBe('B3');
  });

  it('anchors it to the line the match starts on', () => {
    expect(scanSource('tests/fixture.test.ts', wrapped).assertions[0]?.line).toBe(3);
  });

  it('marks it as spanning, and counts it where no grep line count can reach', () => {
    const scan = scanSource('tests/fixture.test.ts', wrapped);

    expect(scan.assertions[0]?.spansLines).toBe(true);
    expect(scan.spanningByFamily.B3).toBe(1);
    expect(scan.linesByFamily.B3).toBe(0);
    expect(scan.codeLinesByFamily.B3).toBe(0);
  });

  it('collapses its text onto one line for the report', () => {
    const text = scanSource('tests/fixture.test.ts', wrapped).assertions[0]?.text ?? '';

    expect(text).not.toContain('\n');
    expect(text).toContain('.alphaField ).toBeNull()');
  });

  it('does not mark an ordinary single-line assertion as spanning', () => {
    const scan = scanSource('tests/fixture.test.ts', 'expect(record.alphaField).toBeNull();');

    expect(scan.assertions[0]?.spansLines).toBe(false);
    expect(scan.spanningByFamily.B3).toBe(0);
    expect(scan.linesByFamily.B3).toBe(1);
  });
});

describe('scanSource — the two-argument expect', () => {
  it('reads `expect(value, message)` rather than missing it entirely', () => {
    // Not an unclassifiable row: without the message group this assertion matched nothing at all
    // and left the population with no trace of itself.
    const scan = scanSource('tests/fixture.test.ts', "expect(row.alphaField, 'row 3').toBeNull();");

    expect(scan.assertions).toHaveLength(1);
    expect(scan.assertions[0]?.fieldName).toBe('alphaField');
  });

  it('cannot reach across a call boundary to pair a property with a distant matcher', () => {
    // The message class excludes both parens, so the `)` closing `expect(` is always the fence.
    const source = ['const x = wrap(record.alphaField);', 'expect(other).toBeNull();'].join('\n');
    const scan = scanSource('tests/fixture.test.ts', source);

    expect(scan.assertions.map((a) => a.fieldName)).toEqual([]);
  });

  it('leaves an assertion whose message contains a paren invisible, as the limitation states', () => {
    const scan = scanSource('tests/fixture.test.ts', "expect(row.alphaField, 'row (3)').toBeNull();");

    expect(scan.assertions).toEqual([]);
  });
});

describe('scanSource — the dynamic case', () => {
  it('yields fieldName null for a computed property name, and keeps the row', () => {
    const scan = scanSource('tests/fixture.test.ts', 'expect(record).not.toHaveProperty(key);');

    expect(scan.assertions).toHaveLength(1);
    const found = scan.assertions.at(0);
    expect(found?.fieldName).toBeNull();
    expect(found?.nameShape).toBe('dynamic-key');
    expect(found?.family).toBe('A');
  });

  it('yields fieldName null for a template-interpolated name', () => {
    const scan = scanSource('tests/fixture.test.ts', 'expect(record).not.toHaveProperty(`prefix${suffix}`);');

    expect(scan.assertions[0]?.fieldName).toBeNull();
    expect(scan.assertions[0]?.nameShape).toBe('dynamic-key');
  });

  it('separates a written-out name that is not an identifier from a computed one', () => {
    // `'9bad'` and `'has-dash'` are literals: nothing about them is dynamic. No contract declares a
    // field under a name that is not a JavaScript identifier, so they are still unresolvable — but
    // calling them dynamic misdescribes what a reader following the row would find.
    const source = [
      "expect(record).not.toHaveProperty('9bad');",
      "expect(record).not.toHaveProperty('has-dash');",
    ].join('\n');
    const scan = scanSource('tests/fixture.test.ts', source);

    expect(scan.assertions.map((a) => a.nameShape)).toEqual(['non-identifier-literal', 'non-identifier-literal']);
    expect(scan.assertions.map((a) => a.fieldName)).toEqual([null, null]);
  });

  it('calls an ordinary literal name a literal', () => {
    const scan = scanSource('tests/fixture.test.ts', "expect(record).not.toHaveProperty('alphaField');");

    expect(scan.assertions[0]?.nameShape).toBe('literal');
  });

  it('does not drop the dynamic row from the population', () => {
    const source = [
      "expect(record).not.toHaveProperty('alphaField');",
      'expect(record).not.toHaveProperty(key);',
    ].join('\n');
    const scan = scanSource('tests/fixture.test.ts', source);

    expect(scan.assertions).toHaveLength(2);
    expect(scan.linesByFamily.A).toBe(2);
  });
});

describe('scanSource — lines versus assertions', () => {
  /**
   * The exact shape that made the source filing's own count wrong by one: a `not.toHaveProperty(`
   * occurrence on a `*` continuation line inside a doc block. The filing reported 152 for family A
   * where the code population is 151, having counted the comment. The live instance is in
   * `phase-retry-evaluator.test.ts`; it is reproduced here as a fixture rather than cited by line,
   * so this test pins the shape and not that file's current numbering.
   */
  const withCommentedOccurrence = [
    '/**',
    ' * The nth appended payload, and a thrown failure if there is no nth event.',
    ' *',
    " * Not `appends[n].payload`. Many assertions below are not.toHaveProperty('stalledFixture'),",
    ' * which PASSES on `undefined`.',
    ' */',
    "expect(payload).not.toHaveProperty('alphaField');",
  ].join('\n');

  it('counts the commented occurrence as a line and not as an assertion', () => {
    const scan = scanSource('tests/fixture.test.ts', withCommentedOccurrence);

    expect(scan.linesByFamily.A).toBe(2);
    expect(scan.assertions).toHaveLength(1);
    expect(scan.assertions[0]?.line).toBe(7);
  });

  it('accounts for the whole difference by the stripped occurrences', () => {
    const scan = scanSource('tests/fixture.test.ts', withCommentedOccurrence);
    const assertionsInFamilyA = scan.assertions.filter((a) => a.family === 'A').length;

    expect(scan.linesByFamily.A - assertionsInFamilyA).toBe(1);
  });

  it('reports zero for a family with no occurrence at all, rather than omitting it', () => {
    const scan = scanSource('tests/fixture.test.ts', "expect(r).not.toHaveProperty('alphaField');");

    expect(scan.linesByFamily.B1).toBe(0);
    expect(scan.linesByFamily.B4).toBe(0);
  });

  it('finds nothing in a file that is entirely comment', () => {
    const scan = scanSource('tests/fixture.test.ts', "// expect(r).not.toHaveProperty('alphaField');");

    expect(scan.assertions).toEqual([]);
    expect(scan.linesByFamily.A).toBe(1);
  });
});
