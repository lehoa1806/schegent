// FR-R6-F11 T027 (research R6) — CSV profile v1 writes fixed bytes for hostile cells.
import { describe, expect, it } from 'vitest';
import {
  CsvTransformationCounter,
  csvField,
  csvHeader,
  csvNumberField,
  csvRecord,
  csvTextField
} from '../../../src/services/reporting/csv-profile';

const cp = (value: number): string => String.fromCodePoint(value);

function text(value: string): string {
  return csvTextField(value, new CsvTransformationCounter());
}

function number(value: number | string): string {
  return csvNumberField(value, new CsvTransformationCounter());
}

function countOf(counter: CsvTransformationCounter, name: string): number | undefined {
  return counter.snapshot().find((entry) => entry.name === name)?.count;
}

describe('CSV profile v1 text cells', () => {
  it.each([
    ['=1+1', '"text:=1+1"'],
    ['+cmd', '"text:+cmd"'],
    ['-2', '"text:-2"'],
    ['@SUM(A1)', '"text:@SUM(A1)"'],
    [' leading space', '"text: leading space"'],
    ['a"b,c', '"text:a""b,c"'],
    ['a\\b', '"text:a\\\\b"']
  ])('writes %j as fixed bytes', (value, expected) => {
    expect(text(value)).toBe(expected);
  });

  it.each([
    [cp(0x09) + 'x', '"text:\\u{0009}x"'],
    [cp(0x0d) + 'x', '"text:\\u{000D}x"'],
    ['a' + cp(0x00) + 'b', '"text:a\\u{0000}b"'],
    ['a' + cp(0x202e) + 'b', '"text:a\\u{202E}b"'],
    ['a' + cp(0x2028) + 'b', '"text:a\\u{2028}b"'],
    [cp(0xfeff) + 'b', '"text:\\u{FEFF}b"'],
    ['a' + cp(0x7f) + cp(0x85) + cp(0xad), '"text:a\\u{007F}\\u{0085}\\u{00AD}"'],
    ['a' + cp(0x061c) + cp(0x180e) + cp(0x2066) + cp(0xfffb), '"text:a\\u{061C}\\u{180E}\\u{2066}\\u{FFFB}"'],
    ['a' + '\ud800', '"text:a\\u{D800}"']
  ])('escapes the invisible character in case %#', (value, expected) => {
    expect(text(value)).toBe(expected);
  });

  it.each([
    0x034f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180f, 0x2065, 0x206a, 0x206f, 0x3164, 0xfe00, 0xfe0f, 0xffa0, 0xfff0, 0xfff8,
    0x13430, 0x1343f, 0x1bca0, 0x1bca3, 0x1d173, 0x1d17a, 0xe0000, 0xe0080, 0xe0fff
  ])('escapes the default-ignorable or filler code point %s', (codePoint) => {
    const hex = codePoint.toString(16).toUpperCase().padStart(4, '0');
    expect(text('a' + cp(codePoint) + 'b')).toBe(`"text:a\\u{${hex}}b"`);
  });

  it.each([
    0x034e, 0x0350, 0x0600, 0x115e, 0x1161, 0x17b3, 0x17b6, 0x180a, 0x1810, 0x205f, 0x2070, 0x3163, 0x3165, 0xfdff, 0xfe10, 0xff9f,
    0xffa1, 0xffef, 0xfffc, 0x1342f, 0x13440, 0x1bc9f, 0x1bca4, 0x1d172, 0x1d17b, 0xdffff, 0xe1000
  ])(
    'keeps the neighbouring code point %s as it is',
    (codePoint) => {
      expect(text('a' + cp(codePoint) + 'b')).toBe('"text:a' + cp(codePoint) + 'b"');
    }
  );

  it('keeps an ordinary non-ASCII character as it is', () => {
    expect(text('caf' + cp(0xe9) + cp(0x10000))).toBe('"text:caf' + cp(0xe9) + cp(0x10000) + '"');
  });

  it('cuts a value longer than 4,096 code points and marks it', () => {
    const counter = new CsvTransformationCounter();
    const astral = cp(0x10000);
    const field = csvTextField(astral.repeat(4_097), counter);
    expect(field).toBe('"text:' + astral.repeat(4_096) + '\\u{2026}[truncated]"');
    expect(countOf(counter, 'truncated')).toBe(1);
  });

  it('keeps a value of exactly 4,096 code points whole', () => {
    expect(text('a'.repeat(4_096))).toBe('"text:' + 'a'.repeat(4_096) + '"');
  });
});

describe('CSV profile v1 number cells', () => {
  it.each([
    [0, '"0"'],
    [42, '"42"'],
    [-7, '"-7"'],
    [2 ** 53 - 1, '"9007199254740991"'],
    [-(2 ** 53 - 1), '"-9007199254740991"'],
    [2 ** 53, '"number:9007199254740992"'],
    [-(2 ** 53), '"number:-9007199254740992"'],
    [1.5, '"1.5"'],
    ['123456789012345678901', '"number:123456789012345678901"'],
    ['123456789.123456', '"123456789.123456"'],
    ['1234567890.123456', '"number:1234567890.123456"'],
    ['0.000123456789012345', '"0.000123456789012345"'],
    ['0.0001234567890123456', '"number:0.0001234567890123456"']
  ])('writes %j as fixed bytes', (value, expected) => {
    expect(number(value)).toBe(expected);
  });

  it('writes a value outside the decimal grammar as text', () => {
    expect(number('1e5')).toBe('"text:1e5"');
    expect(number('+1')).toBe('"text:+1"');
    expect(number(Number.NaN)).toBe('"text:NaN"');
  });
});

describe('CSV profile v1 records', () => {
  it('writes an unknown value as an empty quoted field, never zero', () => {
    expect(csvField(null, new CsvTransformationCounter())).toBe('""');
  });

  it('frames a record with commas and CRLF', () => {
    const counter = new CsvTransformationCounter();
    const record = csvRecord([{ kind: 'text', value: 'a' }, null, { kind: 'number', value: 3 }], counter);
    expect(record).toBe('"text:a","","3"\r\n');
  });

  it('writes header cells as text cells', () => {
    expect(csvHeader(['rootId', 'durationMs'], new CsvTransformationCounter())).toBe('"text:rootId","text:durationMs"\r\n');
  });

  it('counts each transformation once per cell, in profile order', () => {
    const counter = new CsvTransformationCounter();
    csvRecord(
      [
        { kind: 'text', value: cp(0) + cp(0x202e) },
        { kind: 'text', value: 'plain' },
        { kind: 'number', value: 2 ** 53 },
        { kind: 'number', value: 1 },
        null
      ],
      counter
    );
    expect(counter.snapshot()).toEqual([
      { name: 'text-prefix', count: 2 },
      { name: 'control-escaped', count: 1 },
      { name: 'truncated', count: 0 },
      { name: 'number-prefixed', count: 1 }
    ]);
  });
});
