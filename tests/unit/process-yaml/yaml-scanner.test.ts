// Feature 084 T003 — scanner unit tests (test-first).
//
// Covers the layout half of contracts/phase-yaml-grammar.ebnf: two-space
// indent levels, dedent, comment and blank lines, both line breaks, and the
// tab-in-indentation refusal (FR-003, QS-9).

import { describe, it, expect } from 'vitest';
import { scanDocument, type YamlEntryToken } from '../../../src/services/process-yaml/yaml-scanner';

function entries(text: string): readonly YamlEntryToken[] {
  const result = scanDocument(text);
  if (!result.ok) {
    throw new Error(`expected scan to succeed, got ${result.refusal.code}: ${result.refusal.message}`);
  }
  return result.tokens.filter((t): t is YamlEntryToken => t.kind === 'entry');
}

function refusal(text: string): { code: string; message: string } {
  const result = scanDocument(text);
  if (result.ok) {
    throw new Error('expected scan to refuse');
  }
  return result.refusal;
}

describe('yaml-scanner — layout', () => {
  it('reports one indent level per two spaces', () => {
    const tokens = entries('metadata:\n  phaseId: a\n  name: A\n');
    expect(tokens.map((t) => [t.key, t.indent])).toEqual([
      ['metadata', 0],
      ['phaseId', 1],
      ['name', 1]
    ]);
  });

  it('tracks a dedent back to an enclosing level', () => {
    const tokens = entries('metadata:\n  phaseId: a\nspec:\n  skill: s\n');
    expect(tokens.map((t) => [t.key, t.indent])).toEqual([
      ['metadata', 0],
      ['phaseId', 1],
      ['spec', 0],
      ['skill', 1]
    ]);
  });

  it('refuses an odd number of leading spaces', () => {
    expect(refusal('metadata:\n   phaseId: a\n').code).toBe('disallowed-syntax');
  });

  it('refuses an indent that jumps more than one level', () => {
    expect(refusal('metadata:\n    phaseId: a\n').code).toBe('disallowed-syntax');
  });

  it('discards comment lines and blank lines at any indent', () => {
    const tokens = entries('# leading\n\nkind: Phase\n\n  # indented comment\nspec:\n');
    expect(tokens.map((t) => t.key)).toEqual(['kind', 'spec']);
  });

  it('accepts CRLF and LF interchangeably', () => {
    const lf = entries('kind: Phase\nspec:\n  skill: s\n');
    const crlf = entries('kind: Phase\r\nspec:\r\n  skill: s\r\n');
    expect(crlf.map((t) => [t.key, t.value?.value])).toEqual(lf.map((t) => [t.key, t.value?.value]));
  });

  it('accepts a document with no trailing line break', () => {
    expect(entries('kind: Phase').map((t) => t.key)).toEqual(['kind']);
  });

  it('refuses a tab used for indentation', () => {
    const r = refusal('metadata:\n\tphaseId: a\n');
    expect(r.code).toBe('disallowed-syntax');
    expect(r.message).toMatch(/tab/i);
  });

  it('refuses a tab mixed into otherwise valid indentation', () => {
    expect(refusal('metadata:\n \tphaseId: a\n').code).toBe('disallowed-syntax');
  });

  it('reports one-based line numbers', () => {
    const tokens = entries('# comment\nkind: Phase\n');
    expect(tokens[0].line).toBe(2);
  });
});

describe('yaml-scanner — entries and scalars', () => {
  it('separates a key from a plain scalar on "key: value"', () => {
    const [token] = entries('name: My Phase\n');
    expect(token.key).toBe('name');
    expect(token.value).toEqual({ kind: 'scalar', value: 'My Phase', quoted: false, line: 1 });
  });

  it('yields a null value for a nesting key', () => {
    const [token] = entries('metadata:\n  name: A\n');
    expect(token.value).toBeNull();
  });

  it('marks a double-quoted scalar as quoted', () => {
    const [token] = entries('name: "42"\n');
    expect(token.value).toEqual({ kind: 'scalar', value: '42', quoted: true, line: 1 });
  });

  it('strips a trailing comment from a plain scalar', () => {
    const [token] = entries('name: value # trailing\n');
    expect(token.value?.value).toBe('value');
  });

  it('keeps a "#" that is not preceded by a space inside a plain scalar', () => {
    const [token] = entries('name: a#b\n');
    expect(token.value?.value).toBe('a#b');
  });

  it('refuses a key with no space after the colon', () => {
    expect(refusal('name:value\n').code).toBe('disallowed-syntax');
  });

  it('refuses a plain scalar containing ": "', () => {
    expect(refusal('name: a: b\n').code).toBe('disallowed-syntax');
  });

  it('refuses a raw tab inside a plain scalar', () => {
    expect(refusal('name: a\tb\n').code).toBe('disallowed-syntax');
  });
});

describe('yaml-scanner — block literals', () => {
  it('joins block-literal lines with a single line break and strips the indent', () => {
    const [token] = entries('instruction: |-\n  first\n  second\n');
    expect(token.value).toEqual({ kind: 'scalar', value: 'first\nsecond', quoted: true, line: 1 });
  });

  it('preserves extra indentation inside the literal body', () => {
    const [token] = entries('instruction: |-\n  a\n    b\n');
    expect(token.value?.value).toBe('a\n  b');
  });

  it('preserves an interior blank line', () => {
    const [token] = entries('instruction: |-\n  a\n\n  b\n');
    expect(token.value?.value).toBe('a\n\nb');
  });

  it('ends the literal at the first line back at the enclosing level', () => {
    const tokens = entries('instruction: |-\n  body\nmodel: m\n');
    expect(tokens.map((t) => [t.key, t.value?.value])).toEqual([
      ['instruction', 'body'],
      ['model', 'm']
    ]);
  });

  it('refuses a folded scalar', () => {
    expect(refusal('instruction: >-\n  body\n').code).toBe('disallowed-syntax');
  });

  it.each(['|', '|+', '|2'])('refuses the block form %s', (form) => {
    expect(refusal(`instruction: ${form}\n  body\n`).code).toBe('disallowed-syntax');
  });
});
