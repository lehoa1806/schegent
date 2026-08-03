// Feature 084 T010 — the shared scalar-style predicate (test-first).
//
// One module decides how a string may be written. The serializer asks it what
// style to emit; the scanner asks it whether a plain scalar it just read is
// legal. Two copies of this rule would eventually disagree, and a disagreement
// here is a silent round-trip corruption rather than a visible error
// (research R5).
//
// The last describe is the one that matters: for every value the predicate
// calls plain-safe, the parser must read back exactly that value, and for every
// value it does not, writing it plain must NOT quietly succeed with different
// text.

import { describe, it, expect } from 'vitest';
import {
  chooseScalarStyle,
  looksTyped,
  plainScalarDefect,
  quoteDouble,
  requiresQuoting
} from '../../../src/services/process-yaml/scalar-style';
import { parseDocumentText } from '../../../src/services/process-yaml/yaml-parser';

const TYPE_CONFUSABLE = [
  'true',
  'True',
  'FALSE',
  'yes',
  'no',
  'on',
  'Off',
  'null',
  'Null',
  '~',
  '0',
  '12',
  '-3',
  '+4',
  '1.5',
  '.5',
  '1e10',
  '1_000',
  '0x1f',
  '0o17',
  '.inf',
  '-.INF',
  '.nan',
  // YAML 1.1 sexagesimals and timestamps: still re-typed by widely used readers.
  '1:30',
  '2026-08-03'
];

const PLAIN_SAFE = [
  'My Phase',
  'schegent/v1',
  'Phase',
  'my-phase_1',
  'a#b',
  'attempts < 3',
  'Summarize the input and stop',
  'café \u{1F600}',
  '12 apples',
  // `?` and `:` lead an indicator only when a space follows; alone they are
  // ordinary text, and so is a negative number's leading `-` (see `-3` above).
  '?key',
  ':leading'
];

const SYNTACTICALLY_UNSAFE = [
  '',
  ' leading',
  'trailing ',
  'has: colon',
  'has #hash',
  'ends:',
  '#comment',
  '- item',
  '-',
  '? key',
  ': value',
  '*alias',
  '&anchor',
  '!tag',
  '{a}',
  '[a]',
  "'quoted'",
  '>folded',
  '%directive',
  ',comma',
  '`backtick',
  '@reserved',
  'tab\there',
  'ctrl\u0001here'
];

describe('scalar-style — type confusability (research R5)', () => {
  it.each(TYPE_CONFUSABLE)('quotes %j so it cannot be re-typed', (value) => {
    expect(looksTyped(value)).toBe(true);
    expect(requiresQuoting(value)).toBe(true);
    expect(chooseScalarStyle(value)).toBe('double');
  });

  it.each(PLAIN_SAFE)('leaves %j plain', (value) => {
    expect(looksTyped(value)).toBe(false);
    expect(plainScalarDefect(value)).toBeNull();
    expect(chooseScalarStyle(value)).toBe('plain');
  });
});

describe('scalar-style — syntactic plain-safety', () => {
  it.each(SYNTACTICALLY_UNSAFE)('refuses %j as a plain scalar', (value) => {
    expect(plainScalarDefect(value)).not.toBeNull();
    expect(requiresQuoting(value)).toBe(true);
  });

  it('gives a reason naming the construct, not a generic message', () => {
    expect(plainScalarDefect('*alias')).toMatch(/alias/i);
    expect(plainScalarDefect('has: colon')).toMatch(/colon|': '/);
    expect(plainScalarDefect('tab\there')).toMatch(/tab/i);
  });
});

describe('scalar-style — multi-line values', () => {
  it('uses a block literal for a multi-line value', () => {
    expect(chooseScalarStyle('one\ntwo')).toBe('block');
  });

  it('falls back to quoting when a trailing newline would be clipped', () => {
    // `|-` strips the final line break, so a value ending in one cannot survive.
    expect(chooseScalarStyle('one\ntwo\n')).toBe('double');
  });

  it('falls back to quoting when a carriage return is present', () => {
    expect(chooseScalarStyle('one\r\ntwo')).toBe('double');
  });

  it('falls back to quoting when the first line is indented', () => {
    expect(chooseScalarStyle('  one\ntwo')).toBe('double');
  });

  it('falls back to quoting when a line is whitespace only', () => {
    expect(chooseScalarStyle('one\n   \ntwo')).toBe('double');
  });

  it('falls back to quoting when a control character is present', () => {
    expect(chooseScalarStyle('one\n\u0007two')).toBe('double');
  });

  it('keeps an interior blank line in block style', () => {
    expect(chooseScalarStyle('one\n\ntwo')).toBe('block');
  });
});

describe('scalar-style — double-quoted emission', () => {
  it('escapes the characters the grammar admits', () => {
    expect(quoteDouble('a"b\\c\nd\te\rf')).toBe('"a\\"b\\\\c\\nd\\te\\rf"');
  });

  it('escapes other control characters numerically', () => {
    expect(quoteDouble('\u0001')).toBe('"\\u0001"');
  });

  it('leaves printable non-ASCII alone', () => {
    expect(quoteDouble('café')).toBe('"café"');
  });

  it('round-trips through the parser', () => {
    for (const value of [...TYPE_CONFUSABLE, ...SYNTACTICALLY_UNSAFE, ...PLAIN_SAFE]) {
      if (value.includes('\r')) continue;
      const result = parseDocumentText(`a: ${quoteDouble(value)}\n`);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const entry = result.node.entries[0];
        expect(entry.value).toMatchObject({ kind: 'scalar', value, quoted: true });
      }
    }
  });
});

describe('scalar-style — the predicate and the parser agree', () => {
  const CORPUS = [...TYPE_CONFUSABLE, ...PLAIN_SAFE, ...SYNTACTICALLY_UNSAFE];

  it('reads back every plain-safe value unchanged', () => {
    for (const value of CORPUS) {
      if (plainScalarDefect(value) !== null) continue;
      const result = parseDocumentText(`a: ${value}\n`);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.node.entries[0].value).toMatchObject({ value, quoted: false });
      }
    }
  });

  it('never lets an unsafe value pass as plain text unchanged', () => {
    for (const value of SYNTACTICALLY_UNSAFE) {
      const result = parseDocumentText(`a: ${value}\n`);
      if (!result.ok) continue;
      const entry = result.node.entries[0];
      expect(entry.value?.kind === 'scalar' ? entry.value.value : null).not.toBe(value);
    }
  });
});
