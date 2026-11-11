// FR-R6-F15 T028 — the strict parser of review artifacts: what `JSON.parse` accepts parses to
// the same value, and each bound and each rule it adds refuses the whole text with one reason.
import { describe, expect, it } from 'vitest';

import { parseStrictJson, type StrictJsonLimits } from '../../../src/services/phase-context/strict-json';

const LIMITS: StrictJsonLimits = { maxBytes: 262_144, maxDepth: 16, maxValues: 8_192 };
const BACKSLASH = String.fromCharCode(92);

function parsed(text: string, limits: StrictJsonLimits = LIMITS): unknown {
  const result = parseStrictJson(text, limits);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.value;
}

function reasonOf(text: string, limits: StrictJsonLimits = LIMITS): string {
  const result = parseStrictJson(text, limits);
  return result.ok ? 'accepted' : result.reason;
}

/** `count` arrays, one inside the other; the innermost is empty. */
function nestedArrays(count: number): string {
  return '['.repeat(count) + ']'.repeat(count);
}

/** `count` objects, one inside the other; the innermost is empty. */
function nestedObjects(count: number): string {
  return '{"a":'.repeat(count - 1) + '{}' + '}'.repeat(count - 1);
}

function escapedKey(key: string): string {
  return `${BACKSLASH}u${key.charCodeAt(0).toString(16).padStart(4, '0')}${key.slice(1)}`;
}

describe('parseStrictJson', () => {
  it.each([
    ['null', 'null'],
    ['true', 'true'],
    ['false', 'false'],
    ['zero', '0'],
    ['a negative zero', '-0'],
    ['a negative whole number', '-17'],
    ['a fraction with an exponent', '12.5e-3'],
    ['an upper-case exponent with a sign', '1E+2'],
    ['an empty text value', '""'],
    ['every short escape', `"a${BACKSLASH}"b${BACKSLASH}${BACKSLASH}c${BACKSLASH}/d${BACKSLASH}b${BACKSLASH}f${BACKSLASH}n${BACKSLASH}r${BACKSLASH}t"`],
    ['escaped code units', `"${BACKSLASH}u00e9${BACKSLASH}ud83d${BACKSLASH}ude00"`],
    ['an escaped lone surrogate', `"${BACKSLASH}ud800"`],
    ['text outside the basic plane, written raw', `"${String.fromCodePoint(0x1f600)} ok"`],
    ['an empty list', '[]'],
    ['an empty record', '{}'],
    ['white space around every token', ' \t\n\r [ 1 , 2 , { "a" : null } ] \n'],
    ['nested records and lists', '{"a":{"b":[1,{"c":null}]},"d":"e","f":[[],{}]}'],
    ['an empty key', '{"":1}'],
    ['a key that only looks forbidden', '{"__proto":1,"Constructor":2,"prototypes":3}'],
    ['a forbidden name as a value', '["__proto__","constructor","prototype"]']
  ])('parses %s to the value JSON.parse gives', (_label, text) => {
    expect(parsed(text)).toEqual(JSON.parse(text));
  });

  it('gives plain records that keep the order of their keys', () => {
    const value = parsed('{"b":1,"a":{"d":2,"c":3}}');

    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(JSON.stringify(value)).toBe('{"b":1,"a":{"d":2,"c":3}}');
  });

  it('gives equal results for equal input', () => {
    const text = '{"a":[1,2,{"b":"c"}]}';

    expect(parseStrictJson(text, LIMITS)).toEqual(parseStrictJson(text, LIMITS));
    expect(parseStrictJson('{"a":1,"a":2}', LIMITS)).toEqual(parseStrictJson('{"a":1,"a":2}', LIMITS));
  });

  it.each([
    ['an empty text', ''],
    ['white space only', ' \n '],
    ['an open record', '{'],
    ['an open list', '[1'],
    ['a trailing comma in a list', '[1,]'],
    ['a trailing comma in a record', '{"a":1,}'],
    ['a key without quotes', '{a:1}'],
    ['single quotes', "{'a':1}"],
    ['a missing comma', '[1 2]'],
    ['a missing colon', '{"a" 1}'],
    ['a member with no value', '{"a":}'],
    ['a leading zero', '01'],
    ['a fraction with no digit', '1.'],
    ['a fraction with no whole part', '.5'],
    ['a plus sign', '+1'],
    ['an exponent with no digit', '1e'],
    ['a sign alone', '-'],
    ['a cut literal', 'tru'],
    ['a literal in another case', 'Null'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['undefined', 'undefined'],
    ['a number that is not finite', '1e999'],
    ['a text value with no end', '"abc'],
    ['an unknown escape', `"a${BACKSLASH}x"`],
    ['an escape with a bad digit', `"${BACKSLASH}u12g4"`],
    ['an escape cut by the end', `"abc${BACKSLASH}`],
    ['a raw tab inside a text value', `"a${String.fromCharCode(9)}b"`],
    ['a raw line feed inside a text value', `"a${String.fromCharCode(10)}b"`],
    ['a comment', '/* note */ 1'],
    ['a byte order mark', `${String.fromCharCode(0xfeff)}{}`],
    ['a no-break space between tokens', `[1,${String.fromCharCode(0xa0)}2]`],
    ['trailing text after a record', '{} x'],
    ['a second value', '1 2'],
    ['a second record', '{}{}'],
    ['a closing bracket too many', '[]]']
  ])('refuses %s as malformed', (_label, text) => {
    expect(parseStrictJson(text, LIMITS)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a value that is not text as malformed', () => {
    expect(parseStrictJson(7 as unknown as string, LIMITS)).toEqual({ ok: false, reason: 'malformed' });
    expect(parseStrictJson(null as unknown as string, LIMITS)).toEqual({ ok: false, reason: 'malformed' });
  });

  describe('size', () => {
    it('accepts a text of exactly the limit and refuses one byte more', () => {
      const atLimit = `"${'a'.repeat(LIMITS.maxBytes - 2)}"`;

      expect(reasonOf(atLimit)).toBe('accepted');
      expect(reasonOf(`${atLimit} `)).toBe('oversized');
    });

    it('measures bytes, not characters', () => {
      const limits = { ...LIMITS, maxBytes: 10 };
      const wide = String.fromCharCode(0xe9);

      expect(reasonOf(`"${wide.repeat(4)}"`, limits)).toBe('accepted');
      expect(reasonOf(`"${wide.repeat(5)}"`, limits)).toBe('oversized');
    });

    it('reports the size before anything else', () => {
      expect(reasonOf(`{"a":1,"a":2${' '.repeat(LIMITS.maxBytes)}`)).toBe('oversized');
    });
  });

  describe('depth', () => {
    it('accepts 16 levels and refuses a value at level 17', () => {
      expect(reasonOf(nestedArrays(16))).toBe('accepted');
      expect(reasonOf(nestedArrays(17))).toBe('too-deep');
      expect(reasonOf(nestedObjects(16))).toBe('accepted');
      expect(reasonOf(nestedObjects(17))).toBe('too-deep');
    });

    it('counts a plain value inside the last level', () => {
      const inner = '['.repeat(16) + '1' + ']'.repeat(16);

      expect(reasonOf(inner)).toBe('too-deep');
      expect(reasonOf('['.repeat(15) + '1' + ']'.repeat(15))).toBe('accepted');
    });

    it('follows the limit it is given', () => {
      const limits = { ...LIMITS, maxDepth: 1 };

      expect(reasonOf('1', limits)).toBe('accepted');
      expect(reasonOf('[]', limits)).toBe('accepted');
      expect(reasonOf('[1]', limits)).toBe('too-deep');
    });
  });

  describe('value count', () => {
    it('accepts 8,192 values and refuses 8,193', () => {
      const zeros = (count: number): string => `[${Array.from({ length: count }, () => '0').join(',')}]`;

      expect(reasonOf(zeros(8_191))).toBe('accepted');
      expect(reasonOf(zeros(8_192))).toBe('too-many-values');
    });

    it('counts a record and each of its values once, and no key', () => {
      const members = (count: number): string => `{${Array.from({ length: count }, (_unused, index) => `"k${String(index)}":0`).join(',')}}`;

      expect(reasonOf(members(8_191))).toBe('accepted');
      expect(reasonOf(members(8_192))).toBe('too-many-values');
    });

    it('follows the limit it is given', () => {
      const limits = { ...LIMITS, maxValues: 3 };

      expect(reasonOf('[1,2]', limits)).toBe('accepted');
      expect(reasonOf('[1,2,3]', limits)).toBe('too-many-values');
    });
  });

  describe('duplicate keys', () => {
    it.each([
      ['in the outer record', '{"a":1,"a":2}'],
      ['with equal values', '{"a":1,"a":1}'],
      ['in a nested record', '{"a":{"b":1,"c":2,"b":3}}'],
      ['in a record inside a list', '[{"a":1},{"b":1,"b":2}]'],
      ['written with an escape', `{"a":1,"${escapedKey('a')}":2}`],
      ['both written with an escape', `{"${escapedKey('a')}":1,"${escapedKey('a')}":2}`],
      ['an empty key twice', '{"":1,"":2}']
    ])('refuses a duplicate key %s', (_label, text) => {
      expect(parseStrictJson(text, LIMITS)).toEqual({ ok: false, reason: 'duplicate-key' });
    });

    it('accepts one key in two records', () => {
      expect(parsed('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
      expect(parsed('{"a":{"a":1}}')).toEqual({ a: { a: 1 } });
    });
  });

  describe('forbidden keys', () => {
    it.each([
      ['__proto__', '{"__proto__":{"polluted":true}}'],
      ['prototype', '{"prototype":1}'],
      ['constructor', '{"constructor":{"prototype":{"polluted":true}}}'],
      ['a nested __proto__', '{"a":[{"__proto__":1}]}'],
      ['a nested constructor', '{"a":{"b":{"constructor":1}}}'],
      ['__proto__ written with an escape', `{"${escapedKey('__proto__')}":1}`],
      ['constructor written with an escape', `{"${escapedKey('constructor')}":1}`]
    ])('refuses the key %s', (_label, text) => {
      expect(parseStrictJson(text, LIMITS)).toEqual({ ok: false, reason: 'forbidden-key' });
    });

    it('changes no prototype when it refuses', () => {
      parseStrictJson('{"__proto__":{"polluted":true}}', LIMITS);
      const fresh: Record<string, unknown> = {};

      expect(fresh.polluted).toBeUndefined();
      expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
    });
  });

  it('reports the first fault it meets', () => {
    expect(reasonOf('{"a":1,"a":2')).toBe('duplicate-key');
    expect(reasonOf('{"a":1,"__proto__":2,"a":3}')).toBe('forbidden-key');
    expect(reasonOf('[1,}')).toBe('malformed');
  });
});
