// Feature 084 T003 — scanner unit tests (test-first).
//
// Covers the layout half of contracts/phase-yaml-grammar.ebnf: two-space
// indent levels, dedent, comment and blank lines, both line breaks, and the
// tab-in-indentation refusal (FR-003, QS-9).

import { describe, it, expect } from 'vitest';
import {
  scanDocument,
  type YamlEntryToken,
  type YamlToken
} from '../../../src/services/process-yaml/yaml-scanner';

function tokens(text: string): readonly YamlToken[] {
  const result = scanDocument(text);
  if (!result.ok) {
    throw new Error(`expected scan to succeed, got ${result.refusal.code}: ${result.refusal.message}`);
  }
  return result.tokens;
}

function entries(text: string): readonly YamlEntryToken[] {
  return tokens(text).filter((t): t is YamlEntryToken => t.kind === 'entry');
}

/** `kind:indent` per token, the compact shape the layout assertions read best. */
function shape(text: string): readonly string[] {
  return tokens(text).map((t) =>
    t.kind === 'document-start' ? 'document-start' : `${t.kind}:${t.indent}`
  );
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

// ---------------------------------------------------------------------------
// Feature 085 T005 — the one production the closed subset gained.
// specs/085-pipeline-package-exchange/contracts/yaml-grammar.md
// ---------------------------------------------------------------------------

describe('yaml-scanner — sequence entries', () => {
  it('emits one item token per "- scalar"', () => {
    const scanned = tokens('phaseIds:\n  - specify\n  - plan\n');
    expect(scanned).toEqual([
      { kind: 'entry', indent: 0, key: 'phaseIds', value: null, line: 1 },
      { kind: 'item', indent: 1, value: { kind: 'scalar', value: 'specify', quoted: false, line: 2 }, line: 2 },
      { kind: 'item', indent: 1, value: { kind: 'scalar', value: 'plan', quoted: false, line: 3 }, line: 3 }
    ]);
  });

  it.each([1, 2, 3])('accepts a scalar entry at level %i', (level) => {
    // One key per level down to the sequence, so the indent gates are exercised
    // at each depth rather than only at the first.
    const keys = Array.from({ length: level }, (_, i) => '  '.repeat(i) + `k${i}:\n`).join('');
    const item = `${'  '.repeat(level)}- value\n`;
    const scanned = tokens(keys + item);
    expect(scanned[scanned.length - 1]).toEqual({
      kind: 'item',
      indent: level,
      value: { kind: 'scalar', value: 'value', quoted: false, line: level + 1 },
      line: level + 1
    });
  });

  it('emits an item plus its first key for "- key: value"', () => {
    expect(shape('bindings:\n  - kind: input\n')).toEqual(['entry:0', 'item:1', 'entry:2']);
  });

  it('puts the dash at exactly one level below its body', () => {
    // `- ` is two characters, so the body column is the dash column + 2. A
    // continuation key is an ordinary line at that same column.
    const scanned = tokens('bindings:\n  - kind: input\n    phaseIndex: 0\n');
    const labelled = scanned.map((t) => {
      if (t.kind === 'document-start') return ['---', -1];
      return t.kind === 'entry' ? [t.key, t.indent] : ['-', t.indent];
    });
    expect(labelled).toEqual([
      ['bindings', 0],
      ['-', 1],
      ['kind', 2],
      ['phaseIndex', 2]
    ]);
  });

  it('reads a second item after a mapping entry with continuation keys', () => {
    expect(shape('bindings:\n  - kind: input\n    phaseIndex: 0\n  - kind: output\n')).toEqual([
      'entry:0',
      'item:1',
      'entry:2',
      'entry:2',
      'item:1',
      'entry:2'
    ]);
  });

  it('accepts a nested mapping inside an item body', () => {
    expect(shape('bindings:\n  - kind: input\n    source:\n      from: pipeline-input\n')).toEqual([
      'entry:0',
      'item:1',
      'entry:2',
      'entry:2',
      'entry:3'
    ]);
  });

  it('accepts a sequence nested under an item body key', () => {
    expect(shape('a:\n  - b:\n      - c\n')).toEqual(['entry:0', 'item:1', 'entry:2', 'item:3']);
  });

  it('accepts a block literal as an item body value', () => {
    // Dash at column 2 -> body at column 4 -> literal content at column 6.
    const scanned = tokens('phases:\n  - instruction: |-\n      first\n      second\n');
    const entry = scanned[2];
    expect(entry.kind).toBe('entry');
    expect(entry.kind === 'entry' ? entry.value : null).toEqual({
      kind: 'scalar',
      value: 'first\nsecond',
      quoted: true,
      line: 2
    });
  });

  it('keeps "-1" a plain scalar rather than reading the dash as an indicator', () => {
    const [token] = entries('timeoutSeconds: -1\n');
    expect(token.value?.value).toBe('-1');
  });

  it('refuses a bare dash', () => {
    const r = refusal('a:\n  -\n');
    expect(r.code).toBe('disallowed-syntax');
    expect(r.message).toMatch(/'- '/);
  });

  it('refuses a dash followed by two or more spaces', () => {
    const r = refusal('a:\n  -  value\n');
    expect(r.code).toBe('disallowed-syntax');
    expect(r.message).toMatch(/exactly one space/);
  });

  it.each(['-x', '--', '-# comment'])('refuses "%s" as a malformed entry opener', (body) => {
    expect(refusal(`a:\n  ${body}\n`).code).toBe('disallowed-syntax');
  });

  it('refuses a comment-only entry body', () => {
    expect(refusal('a:\n  - # nothing\n').code).toBe('disallowed-syntax');
  });

  it('refuses a nested sequence via the shared plain-scalar oracle', () => {
    const r = refusal('a:\n  - - b\n');
    expect(r.code).toBe('disallowed-syntax');
    expect(r.message).toMatch(/may not begin with '- '/);
  });

  it('refuses an item indented under an entry that already took an inline value', () => {
    const r = refusal('a: value\n  - b\n');
    expect(r.code).toBe('disallowed-syntax');
    expect(r.message).toMatch(/does not belong to a mapping/);
  });

  it('refuses an item indented under a scalar item', () => {
    expect(refusal('a:\n  - b\n      c: 1\n').code).toBe('disallowed-syntax');
  });
});
