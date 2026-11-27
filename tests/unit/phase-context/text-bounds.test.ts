// FR-R6-F15 T006 — the text rules every contribution passes: UTF-8 size, well-formedness and
// the control characters that would let a line leave its quote (research R3).
import { describe, expect, it } from 'vitest';

import { textFault, utf8Bytes } from '../../../src/services/phase-context/text-bounds';
import { textOfBytes, wideTextOfBytes } from '../../fixtures/phase-context/builders';

const HIGH_SURROGATE = String.fromCharCode(0xd83d);
const LOW_SURROGATE = String.fromCharCode(0xde00);

function forbiddenControls(): number[] {
  const units: number[] = [0x7f, 0x2028, 0x2029];
  for (let unit = 0; unit < 0x20; unit += 1) {
    if (unit !== 0x09 && unit !== 0x0a) units.push(unit);
  }
  for (let unit = 0x80; unit <= 0x9f; unit += 1) units.push(unit);
  // The bidirectional embeddings and overrides, then the isolates.
  for (let unit = 0x202a; unit <= 0x202e; unit += 1) units.push(unit);
  for (let unit = 0x2066; unit <= 0x2069; unit += 1) units.push(unit);
  return units;
}

describe('utf8Bytes', () => {
  it.each([
    ['one-byte', 'a', 1],
    ['two-byte', String.fromCodePoint(0xe9), 2],
    ['three-byte', String.fromCodePoint(0x20ac), 3],
    ['four-byte', String.fromCodePoint(0x1f600), 4]
  ])('counts a %s character as its bytes', (_label, text, bytes) => {
    expect(utf8Bytes(text)).toBe(bytes);
  });

  it('counts the bytes of mixed text', () => {
    expect(utf8Bytes(`a${String.fromCodePoint(0xe9)}${String.fromCodePoint(0x1f600)}`)).toBe(7);
  });
});

describe('textFault', () => {
  it('reports empty text', () => {
    expect(textFault('', 8)).toBe('empty');
  });

  it('accepts text of exactly the limit and refuses one byte more', () => {
    expect(textFault(textOfBytes(2048), 2048)).toBeNull();
    expect(textFault(textOfBytes(2049), 2048)).toBe('too-long');
  });

  it('measures the limit in bytes, not characters', () => {
    const wide = wideTextOfBytes(8);
    expect(wide).toHaveLength(4);
    expect(textFault(wide, 8)).toBeNull();
    expect(textFault(wide, 7)).toBe('too-long');
  });

  it.each([
    ['a lone high surrogate', `a${HIGH_SURROGATE}b`],
    ['a high surrogate at the end', `a${HIGH_SURROGATE}`],
    ['a lone low surrogate', `a${LOW_SURROGATE}b`],
    ['a reversed pair', `${LOW_SURROGATE}${HIGH_SURROGATE}`],
    ['two high surrogates', `${HIGH_SURROGATE}${HIGH_SURROGATE}${LOW_SURROGATE}`]
  ])('reports %s as ill-formed', (_label, text) => {
    expect(textFault(text, 64)).toBe('ill-formed');
  });

  it('accepts a surrogate pair', () => {
    expect(textFault(`${HIGH_SURROGATE}${LOW_SURROGATE}`, 4)).toBeNull();
  });

  it('refuses every forbidden control character, wherever it stands', () => {
    const units = forbiddenControls();
    expect(units).toHaveLength(30 + 1 + 32 + 2 + 5 + 4);
    for (const unit of units) {
      const control = String.fromCharCode(unit);
      expect(textFault(control, 64), `0x${unit.toString(16)} alone`).toBe('control-character');
      expect(textFault(`before${control}after`, 64), `0x${unit.toString(16)} inside`).toBe('control-character');
    }
  });

  it.each([
    ['a tab', 0x09],
    ['a line feed', 0x0a],
    ['a space', 0x20],
    ['a tilde', 0x7e],
    ['a no-break space', 0xa0],
    ['the character before the line separator', 0x2027],
    ['the character after the bidirectional overrides', 0x202f],
    ['the character before the bidirectional isolates', 0x2065],
    ['the character after the bidirectional isolates', 0x206a],
    ['a left-to-right mark', 0x200e],
    ['a right-to-left mark', 0x200f],
    ['an Arabic letter mark', 0x061c],
    ['a zero-width joiner', 0x200d]
  ])('accepts %s', (_label, unit) => {
    expect(textFault(`a${String.fromCharCode(unit)}b`, 64)).toBeNull();
  });
});
