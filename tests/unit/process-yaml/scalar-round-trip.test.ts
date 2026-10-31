// Feature 254 (FR-R4-F07, Q-T1, N2; contract Q1 to Q4; data-model §4; FR-009, FR-010) — every scalar
// the serializer writes, in either position, is read back as the same string.
//
// The scanner reads a plain sequence item that opens `key:` as the start of a mapping, so an item such
// as `ollama:llama3` was exported plain and then refused on import (`disallowed-syntax`): the product's
// own export could not be imported. Mapping VALUES have no such ambiguity (`model: ollama:llama3` reads
// back as the string), so the fix is confined to item position: `chooseScalarStyle(value, 'item')`
// double-quotes an item that `looksKeyed`, and nothing else moves (FR-009, FR-011).
//
// Three things are pinned here:
//
//   * The round trip (Q4). A seeded corpus plus a fixed list, serialized in item position and in value
//     position, parses back to the original string.
//   * Value position is untouched (Q3), with one exception found at implement. `chooseScalarStyle(v,
//     'value')` and the one-argument call give what the function gave before this feature, which is kept
//     below as an oracle, EXCEPT for a value whose first character is `"`. The baseline wrote that plain,
//     and the scanner opens a quoted scalar at a leading quote: `"q"` read back as `q` and `"Ak` was
//     refused, in both positions. FR-009 ("otherwise refuse") and FR-010 ("quotes") cover it, so it is
//     written quoted. It is the only value-position change, and it moves only exports that did not
//     import.
//   * One rule (Q1, N2). The scanner declares no key pattern of its own and imports it from
//     `scalar-style.ts` (hard rule 46: that module is the single scalar rule).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  PLAIN_FIRST_EXCLUDED,
  chooseScalarStyle,
  looksTyped,
  type ScalarStyle
} from '../../../src/services/process-yaml/scalar-style';
import { parseDocumentText } from '../../../src/services/process-yaml/yaml-parser';
import { emitEntry, emitSequence } from '../../../src/services/process-yaml/yaml-serializer';

const SCANNER_PATH = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'services',
  'process-yaml',
  'yaml-scanner.ts'
);

// ---------------------------------------------------------------------------
// The oracle: `chooseScalarStyle` as it was at c744874f, verbatim
// ---------------------------------------------------------------------------

const DELETE_CODE = 0x7f;

/** `-`, `?` and `:` indicate only at the end of the value or before a space (as at baseline). */
const CONDITIONAL_FIRST: ReadonlySet<string> = new Set(['-', '?', ':']);

/**
 * `plainScalarDefect` as it was at c744874f, verbatim. The module's own copy now also names a value
 * that opens with a double quote (feature 254), so an oracle built on it would move with the code it
 * is meant to check.
 */
function baselinePlainScalarDefect(value: string): string | null {
  if (value.length === 0) {
    return 'an empty value must be quoted';
  }
  if (value.includes('\n') || value.includes('\r')) {
    return 'a plain scalar is a single line';
  }
  if (value.startsWith(' ')) {
    return 'a leading space would be lost';
  }
  if (value.endsWith(' ')) {
    return 'a trailing space would be lost';
  }
  const first = value.charAt(0);
  const excluded = PLAIN_FIRST_EXCLUDED.get(first);
  const indicates = !CONDITIONAL_FIRST.has(first) || value.length === 1 || value.charAt(1) === ' ';
  if (excluded !== undefined && indicates) {
    return excluded;
  }
  if (value.includes('\t')) {
    return 'a tab may not appear in a plain scalar';
  }
  if (controlCharacterAt(value) !== -1) {
    return 'a control character may not appear in a plain scalar';
  }
  if (value.includes(': ')) {
    return "a plain scalar may not contain ': '";
  }
  if (value.endsWith(':')) {
    return 'a plain scalar may not end with a colon';
  }
  if (value.includes(' #')) {
    return 'a plain scalar may not contain a comment marker';
  }
  return null;
}

function controlCharacterAt(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === DELETE_CODE) return i;
  }
  return -1;
}

function blockLiteralIsLossless(value: string): boolean {
  if (!value.includes('\n')) return false;
  if (value.includes('\r')) return false;
  if (value.endsWith('\n')) return false;

  const lines = value.split('\n');
  const firstLine = lines.at(0) ?? '';
  if (firstLine.startsWith(' ') || firstLine.startsWith('\t')) return false;
  for (const line of lines) {
    if (line.length > 0 && line.trim().length === 0) return false;
    const control = controlCharacterAt(line);
    if (control !== -1 && line[control] !== '\t') return false;
  }
  return true;
}

function baselineChooseScalarStyle(value: string): ScalarStyle {
  if (blockLiteralIsLossless(value)) return 'block';
  return baselinePlainScalarDefect(value) !== null || looksTyped(value) ? 'double' : 'plain';
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

/** Values the filing and the contract name, plus the shapes that sit on each side of the rule. */
const FIXED: readonly string[] = [
  'ollama:llama3',
  'http://x/y',
  'a:b:c',
  'llama3',
  ':a',
  'a:',
  'has: colon',
  'say "hi"',
  'a "quoted" word',
  '"q"',
  '"',
  '"unterminated',
  'ends with a quote"',
  'key:',
  '#x',
  'true',
  '42',
  'null',
  '~',
  '#',
  '# comment',
  'a #b',
  'a#b',
  'tag:with-dash',
  'claude-sonnet-5-5',
  'gpt-6.1-sol',
  'key:value:more',
  '_under:score',
  'Mixed1:Case',
  '9digit:first',
  'a b:c',
  'a:b c',
  "it's",
  'back\\slash',
  '- dash first',
  '-1',
  'one\ntwo',
  '  padded  ',
  'tab\there'
];

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Printable ASCII weighted towards the characters the key rule and the quoting rule care about. */
const ALPHABET = [
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789',
  ':',
  ':',
  ':',
  ' ',
  '#',
  '"',
  '\\',
  '-',
  '_',
  '.',
  '/',
  "'",
  ',',
  '?',
  '!',
  '&',
  '*',
  '%',
  '@',
  'é'
] as const;

function seeded(count: number): string[] {
  const next = mulberry32(0x254a01);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const length = 1 + Math.floor(next() * 12);
    let value = '';
    for (let c = 0; c < length; c++) {
      value += ALPHABET[Math.floor(next() * ALPHABET.length)] as string;
    }
    out.push(value);
  }
  return out;
}

const CORPUS: readonly string[] = [...FIXED, ...seeded(3000)];

// ---------------------------------------------------------------------------
// Serialize, then parse
// ---------------------------------------------------------------------------

/** The string a one-item sequence reads back as, or the refusal's code. */
function roundTripInItemPosition(value: string): string {
  const parsed = parseDocumentText(emitSequence('', 'items', [value]));
  if (!parsed.ok) return `REFUSED:${parsed.refusal.code}`;
  const sequence = parsed.node.entries.at(0)?.value;
  if (sequence?.kind !== 'sequence') return 'NOT-A-SEQUENCE';
  const item = sequence.items.at(0);
  return item?.kind === 'scalar' ? item.value : 'NOT-A-SCALAR';
}

/** The string a mapping value reads back as, or the refusal's code. */
function roundTripInValuePosition(value: string): string {
  const parsed = parseDocumentText(emitEntry('', 'key', value));
  if (!parsed.ok) return `REFUSED:${parsed.refusal.code}`;
  const entry = parsed.node.entries.at(0)?.value;
  return entry?.kind === 'scalar' ? entry.value : 'NOT-A-SCALAR';
}

function failuresOf(read: (value: string) => string): string[] {
  return CORPUS.filter((value) => read(value) !== value).map(
    (value) => `${JSON.stringify(value)} -> ${JSON.stringify(read(value))}`
  );
}

describe('FR-R4-F07 Q-T1 — what is written is read back, in both positions', () => {
  it('has a corpus that holds the keyed-looking shapes it exists for', () => {
    expect(CORPUS.length).toBeGreaterThan(3000);
    expect(CORPUS).toContain('ollama:llama3');
    // The control that the corpus reaches the rule: some corpus members are keyed-looking.
    const keyed = CORPUS.filter((value) => /^[A-Za-z_][A-Za-z0-9_]*:/.test(value));
    expect(keyed.length).toBeGreaterThan(100);
  });

  it('round-trips every value in item position', () => {
    expect(failuresOf(roundTripInItemPosition).slice(0, 10)).toEqual([]);
  });

  it('round-trips every value in value position', () => {
    expect(failuresOf(roundTripInValuePosition).slice(0, 10)).toEqual([]);
  });
});

/**
 * What value position gives after this feature: the baseline's answer, except that a single-line value
 * opening with a double quote is written quoted. A block literal opens with `|-` and is unaffected.
 */
function expectedValueStyle(value: string): ScalarStyle {
  const baseline = baselineChooseScalarStyle(value);
  if (baseline === 'block') return baseline;
  return value.startsWith('"') ? 'double' : baseline;
}

describe('FR-R4-F07 Q3 — value position keeps the style it always had', () => {
  it('chooseScalarStyle(v, "value") and chooseScalarStyle(v) equal the baseline over the corpus, bar a leading quote', () => {
    const different = CORPUS.filter(
      (value) =>
        chooseScalarStyle(value, 'value') !== expectedValueStyle(value) ||
        chooseScalarStyle(value) !== expectedValueStyle(value)
    );
    expect(different).toEqual([]);
  });

  it('moves exactly the values that open with a double quote and were written plain', () => {
    const moved = CORPUS.filter(
      (value) => chooseScalarStyle(value, 'value') !== baselineChooseScalarStyle(value)
    );
    expect(moved.length).toBeGreaterThan(20);
    for (const value of moved) {
      expect(value[0], JSON.stringify(value)).toBe('"');
      expect(baselineChooseScalarStyle(value), JSON.stringify(value)).toBe('plain');
      expect(chooseScalarStyle(value, 'value'), JSON.stringify(value)).toBe('double');
    }
  });

  it('item position differs from the baseline only where the plain form would read as a key or opens a quote', () => {
    const moved = CORPUS.filter(
      (value) => chooseScalarStyle(value, 'item') !== baselineChooseScalarStyle(value)
    );
    for (const value of moved) {
      expect(baselineChooseScalarStyle(value), JSON.stringify(value)).toBe('plain');
      expect(chooseScalarStyle(value, 'item'), JSON.stringify(value)).toBe('double');
      expect(
        /^[A-Za-z_][A-Za-z0-9_]*:/.test(value) || value.startsWith('"'),
        JSON.stringify(value)
      ).toBe(true);
    }
    // The control that something moved: the rule is not vacuous over this corpus.
    expect(moved).toContain('ollama:llama3');
  });
});

describe('FR-R4-F07 Q2 — what an exported sequence item looks like', () => {
  it('writes ollama:llama3 as a quoted item and llama3 as a plain one', () => {
    expect(emitSequence('', 'models', ['ollama:llama3'])).toBe('models:\n  - "ollama:llama3"\n');
    expect(emitSequence('', 'models', ['llama3'])).toBe('models:\n  - llama3\n');
  });

  it('writes the same text as a mapping value plain', () => {
    expect(emitEntry('  ', 'model', 'ollama:llama3')).toBe('  model: ollama:llama3\n');
  });

  it('quotes the other keyed-looking items: a URL, a double colon and a leading underscore', () => {
    expect(emitSequence('', 'items', ['http://x/y'])).toBe('items:\n  - "http://x/y"\n');
    expect(emitSequence('', 'items', ['a:b:c'])).toBe('items:\n  - "a:b:c"\n');
    expect(emitSequence('', 'items', ['_under:score'])).toBe('items:\n  - "_under:score"\n');
  });

  it('writes a value that opens with a double quote quoted, in both positions', () => {
    expect(emitSequence('', 'items', ['"q"'])).toBe('items:\n  - "\\"q\\""\n');
    expect(emitEntry('', 'key', '"q"')).toBe('key: "\\"q\\""\n');
    expect(emitEntry('', 'key', 'say "hi"')).toBe('key: say "hi"\n');
  });

  it('leaves the items that were already quoted, or are not keyed, as they were', () => {
    for (const value of [':a', 'a:', 'has: colon', '9digit:first', 'a b:c']) {
      expect(chooseScalarStyle(value, 'item'), JSON.stringify(value)).toBe(
        baselineChooseScalarStyle(value)
      );
    }
  });
});

// ---------------------------------------------------------------------------
// N2: one key rule
// ---------------------------------------------------------------------------

describe('FR-R4-F07 N2 — the key rule has one home', () => {
  function sourceFile(): ts.SourceFile {
    return ts.createSourceFile(
      SCANNER_PATH,
      readFileSync(SCANNER_PATH, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
  }

  /** Names of top-level variable and function declarations in a source file. */
  function declaredNames(file: ts.SourceFile): string[] {
    const names: string[] = [];
    for (const statement of file.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
        }
      }
      if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
        names.push(statement.name.text);
      }
    }
    return names;
  }

  /** Names imported from a module specifier. */
  function importedFrom(file: ts.SourceFile, specifier: string): string[] {
    const names: string[] = [];
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      if (statement.moduleSpecifier.text !== specifier) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) names.push(element.name.text);
      }
    }
    return names;
  }

  it('sees a declaration when one exists (control)', () => {
    const probe = ts.createSourceFile(
      'probe.ts',
      "const KEY_PATTERN = /^a/;\nfunction looksKeyed(t: string) { return true; }\nimport { x } from './scalar-style';\n",
      ts.ScriptTarget.Latest,
      true
    );
    expect(declaredNames(probe)).toEqual(['KEY_PATTERN', 'looksKeyed']);
    expect(importedFrom(probe, './scalar-style')).toEqual(['x']);
  });

  it('declares no KEY_PATTERN or looksKeyed in the scanner', () => {
    const declared = declaredNames(sourceFile());
    expect(declared).not.toContain('KEY_PATTERN');
    expect(declared).not.toContain('looksKeyed');
  });

  it('imports KEY_PATTERN and looksKeyed from ./scalar-style', () => {
    const imported = importedFrom(sourceFile(), './scalar-style');
    expect(imported).toContain('KEY_PATTERN');
    expect(imported).toContain('looksKeyed');
  });
});
