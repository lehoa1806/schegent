// Feature 084 T004 — line/indent/token scanner for the closed exchange
// subset. Normative grammar: specs/084-phase-yaml-exchange/contracts/
// phase-yaml-grammar.ebnf.
//
// This is NOT a YAML scanner. It admits exactly the constructs the grammar
// names and refuses everything else AT THE TOKEN, before any value the
// document declares has been constructed (FR-003a). An anchor, alias, merge
// key, tag, directive or flow collection is rejected the moment its indicator
// is read — never expanded, resolved, or constructed and then discarded.
//
// Feature 085 widened the subset by exactly one production: a block sequence
// whose entry is a scalar or a mapping. The widening is additive — every
// document the feature-084 reader accepted parses to the same tree, and every
// refusal it produced is produced here with the same code. The new refusals
// (specs/085-pipeline-package-exchange/contracts/yaml-grammar.md) are all
// narrowings on the new production. `- ` is exactly two characters, so THE DASH
// OCCUPIES EXACTLY ONE INDENT LEVEL: an item whose dash sits at level L has its
// body at level L + 1, and the body's continuation keys are ordinary lines at
// that same column. That is arithmetic, not a special case.
//
// Errors are values. Nothing in this file throws, mirroring the shipped
// hand-rolled-parser precedent in src/lib/retry-condition.ts (research R1).

import { PLAIN_FIRST_EXCLUDED, plainScalarDefect } from './scalar-style';
import type { DocumentRefusal, DocumentRefusalCode, YamlScalarNode } from './types';

export interface YamlEntryToken {
  readonly kind: 'entry';
  /** Indent level, not column count. One level is two spaces. */
  readonly indent: number;
  readonly key: string;
  /** `null` when the entry opens a nested mapping. */
  readonly value: YamlScalarNode | null;
  readonly line: number;
}

/**
 * Feature 085 T004 — one sequence entry. Kept beside `YamlEntryToken` rather
 * than in `types.ts` so the token family has one home; `types.ts` owns the node
 * family, which is what callers outside this module consume.
 */
export interface YamlSequenceItemToken {
  readonly kind: 'item';
  /** Level of the DASH. The entry's body sits at `indent + 1`. */
  readonly indent: number;
  /** The scalar entry, or `null` when the entry opens a mapping. */
  readonly value: YamlScalarNode | null;
  readonly line: number;
}

export interface YamlDocumentStartToken {
  readonly kind: 'document-start';
  readonly line: number;
}

export type YamlToken = YamlEntryToken | YamlSequenceItemToken | YamlDocumentStartToken;

export type ScanResult =
  | { readonly ok: true; readonly tokens: readonly YamlToken[] }
  | { readonly ok: false; readonly refusal: DocumentRefusal };

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*/;
const INDENT_WIDTH = 2;

function refuse(code: DocumentRefusalCode, message: string, line: number): ScanResult {
  return { ok: false, refusal: { code, message: `${message} (line ${line})` } };
}

function scalar(value: string, quoted: boolean, line: number): YamlScalarNode {
  return { kind: 'scalar', value, quoted, line };
}

interface ScalarParse {
  readonly ok: true;
  readonly node: YamlScalarNode;
}

type ScalarResult = ScalarParse | { readonly ok: false; readonly result: ScanResult };

/**
 * Tokenize a decoded document. The caller is responsible for the pre-parse
 * guards (strict UTF-8, byte-order mark, size bound); see yaml-parser.ts.
 */
export function scanDocument(text: string): ScanResult {
  const lines = text.split(/\r?\n/);
  const tokens: YamlToken[] = [];
  // The level of the last construct's OWN content, and whether that construct
  // left a block open beneath it. For an entry the content level is the key's
  // level; for a sequence entry it is the body's, one level past the dash.
  let previousLevel = -1;
  // The document itself is the enclosing mapping, so level 0 is always open.
  let previousOpensMapping = true;
  let sawDocumentStart = false;
  let sawContent = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineNo = index + 1;

    if (line.includes('\r')) {
      return refuse('disallowed-syntax', 'carriage return inside a line', lineNo);
    }

    const leading = /^[ \t]*/.exec(line)?.[0] ?? '';
    if (leading.includes('\t')) {
      return refuse('disallowed-syntax', 'a tab may not be used for indentation', lineNo);
    }
    const rest = line.slice(leading.length);
    if (rest.length === 0 || rest.startsWith('#')) {
      continue;
    }

    if (rest === '---' || rest.startsWith('--- ')) {
      if (leading.length !== 0) {
        return refuse('disallowed-syntax', 'a document start must be unindented', lineNo);
      }
      if (sawDocumentStart || sawContent) {
        return refuse('multi-document', 'a second document start is not part of this format', lineNo);
      }
      sawDocumentStart = true;
      tokens.push({ kind: 'document-start', line: lineNo });
      continue;
    }
    if (rest === '...' || rest.startsWith('... ')) {
      return refuse('multi-document', 'a document end marker is not part of this format', lineNo);
    }
    if (rest.startsWith('%')) {
      return refuse('disallowed-syntax', 'directives are not part of this format', lineNo);
    }
    if (rest === '?' || rest.startsWith('? ')) {
      return refuse('disallowed-syntax', 'complex keys are not part of this format', lineNo);
    }
    if (rest.startsWith('<<')) {
      return refuse('disallowed-syntax', 'merge keys are not part of this format', lineNo);
    }

    if (leading.length % INDENT_WIDTH !== 0) {
      return refuse('disallowed-syntax', 'indentation must be a multiple of two spaces', lineNo);
    }
    const level = leading.length / INDENT_WIDTH;
    if (level > previousLevel + 1) {
      return refuse('disallowed-syntax', 'indentation increases by more than one level', lineNo);
    }
    if (level === previousLevel + 1 && !previousOpensMapping) {
      return refuse('disallowed-syntax', 'indented entry does not belong to a mapping', lineNo);
    }

    // ----- sequence entry -------------------------------------------------
    if (rest[0] === '-') {
      const item = readSequenceItem(lines, index, leading.length, rest, lineNo);
      if (!item.ok) return item.result;
      index = item.lastLineIndex;
      sawContent = true;
      // The dash occupies one level, so the body — and anything the body opens
      // — is measured from `level + 1`.
      previousLevel = level + 1;
      previousOpensMapping = item.opensMapping;
      for (const token of item.tokens) tokens.push(token);
      continue;
    }

    // ----- mapping entry --------------------------------------------------
    const keyed = readKeyedLine(lines, index, leading.length, rest, lineNo, level);
    if (!keyed.ok) return keyed.result;
    index = keyed.lastLineIndex;
    sawContent = true;
    previousLevel = level;
    previousOpensMapping = keyed.token.value === null;
    tokens.push(keyed.token);
  }

  return { ok: true, tokens };
}

type KeyedLineResult =
  | { readonly ok: true; readonly token: YamlEntryToken; readonly lastLineIndex: number }
  | { readonly ok: false; readonly result: ScanResult };

/** Whether `text` opens `key:` — the discriminator between an entry and a scalar. */
function looksKeyed(text: string): boolean {
  const keyMatch = KEY_PATTERN.exec(text);
  return keyMatch !== null && text.slice(keyMatch[0].length).startsWith(':');
}

/**
 * Read `key: value` starting at `column`. Shared by the mapping-entry path and
 * the sequence entry whose body opens a mapping, so the two cannot disagree
 * about what a key is or how a value is read.
 */
function readKeyedLine(
  lines: readonly string[],
  index: number,
  column: number,
  text: string,
  lineNo: number,
  level: number
): KeyedLineResult {
  const keyMatch = KEY_PATTERN.exec(text);
  if (!keyMatch) {
    const reason = PLAIN_FIRST_EXCLUDED.get(text[0]) ?? 'unrecognized construct';
    return { ok: false, result: refuse('disallowed-syntax', reason, lineNo) };
  }
  const key = keyMatch[0];
  const afterKey = text.slice(key.length);
  if (!afterKey.startsWith(':')) {
    return { ok: false, result: refuse('disallowed-syntax', "expected ':' after a mapping key", lineNo) };
  }
  const afterColon = afterKey.slice(1);
  if (afterColon.length > 0 && !afterColon.startsWith(' ')) {
    return {
      ok: false,
      result: refuse('disallowed-syntax', "a mapping key must be followed by ': '", lineNo)
    };
  }
  const valueText = afterColon.replace(/^ +/, '');

  if (valueText.length === 0 || valueText.startsWith('#')) {
    return {
      ok: true,
      token: { kind: 'entry', indent: level, key, value: null, line: lineNo },
      lastLineIndex: index
    };
  }

  const scalarResult = readScalarValue(lines, index, column, valueText, lineNo);
  if (!scalarResult.ok) return { ok: false, result: scalarResult.result };
  return {
    ok: true,
    token: { kind: 'entry', indent: level, key, value: scalarResult.node, line: lineNo },
    lastLineIndex: scalarResult.lastLineIndex
  };
}

type ScalarValueResult =
  | { readonly ok: true; readonly node: YamlScalarNode; readonly lastLineIndex: number }
  | { readonly ok: false; readonly result: ScanResult };

/**
 * Read one scalar in value position. `column` is the column the construct that
 * owns the scalar starts at, which is what a block literal measures its body
 * from.
 */
function readScalarValue(
  lines: readonly string[],
  index: number,
  column: number,
  valueText: string,
  lineNo: number
): ScalarValueResult {
  if (valueText.startsWith('|')) {
    const literal = readBlockLiteral(lines, index, column, valueText, lineNo);
    if (!literal.ok) return { ok: false, result: literal.result };
    return { ok: true, node: literal.node, lastLineIndex: literal.lastLineIndex };
  }
  const parsed = valueText.startsWith('"')
    ? readDoubleQuoted(valueText, lineNo)
    : readPlain(valueText, lineNo);
  if (!parsed.ok) return { ok: false, result: parsed.result };
  return { ok: true, node: parsed.node, lastLineIndex: index };
}

type SequenceItemResult =
  | {
      readonly ok: true;
      readonly tokens: readonly YamlToken[];
      readonly lastLineIndex: number;
      readonly opensMapping: boolean;
    }
  | { readonly ok: false; readonly result: ScanResult };

/**
 * Read one `- …` line. Exactly one space follows the dash, and the entry is a
 * scalar or a mapping — the three narrowings below are what keep the widening
 * bounded (grammar "New, all of them narrowings").
 *
 * A mapping entry emits TWO tokens: the item itself at the dash's level, and
 * the first key at the body's level. The body's remaining keys are ordinary
 * lines the main loop reads at that same level, so a continuation key needs no
 * special case.
 */
function readSequenceItem(
  lines: readonly string[],
  index: number,
  column: number,
  rest: string,
  lineNo: number
): SequenceItemResult {
  if (!rest.startsWith('- ')) {
    // `-`, `-x`, `--`. One canonical spelling only (FR-004b).
    return {
      ok: false,
      result: refuse('disallowed-syntax', "a sequence entry is written '- ' followed by a value", lineNo)
    };
  }
  if (rest.startsWith('-  ')) {
    return {
      ok: false,
      result: refuse('disallowed-syntax', "a sequence entry uses exactly one space after '-'", lineNo)
    };
  }
  const body = rest.slice(2);
  if (body.length === 0 || body.startsWith('#')) {
    return {
      ok: false,
      result: refuse('disallowed-syntax', "a sequence entry is written '- ' followed by a value", lineNo)
    };
  }

  const level = column / INDENT_WIDTH;
  const bodyColumn = column + INDENT_WIDTH;

  if (looksKeyed(body)) {
    const keyed = readKeyedLine(lines, index, bodyColumn, body, lineNo, level + 1);
    if (!keyed.ok) return { ok: false, result: keyed.result };
    return {
      ok: true,
      tokens: [{ kind: 'item', indent: level, value: null, line: lineNo }, keyed.token],
      lastLineIndex: keyed.lastLineIndex,
      opensMapping: keyed.token.value === null
    };
  }

  // A scalar entry. `- - a` lands here and is refused by the shared plain-scalar
  // oracle, which excludes a leading `- ` — the same rule that keeps `-1` legal.
  const scalarResult = readScalarValue(lines, index, bodyColumn, body, lineNo);
  if (!scalarResult.ok) return { ok: false, result: scalarResult.result };
  return {
    ok: true,
    tokens: [{ kind: 'item', indent: level, value: scalarResult.node, line: lineNo }],
    lastLineIndex: scalarResult.lastLineIndex,
    opensMapping: false
  };
}

/**
 * Read a plain scalar, strip any trailing comment, then hand the result to the
 * shared predicate. The scanner does not carry its own copy of the plain-safety
 * rules: whatever the serializer refuses to write plain, the scanner refuses to
 * read plain, by construction (research R5).
 */
function readPlain(valueText: string, lineNo: number): ScalarResult {
  const commentAt = valueText.indexOf(' #');
  const value = (commentAt === -1 ? valueText : valueText.slice(0, commentAt)).replace(/ +$/, '');
  const defect = plainScalarDefect(value);
  if (defect !== null) {
    return { ok: false, result: refuse('disallowed-syntax', defect, lineNo) };
  }
  return { ok: true, node: scalar(value, false, lineNo) };
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  n: '\n',
  t: '\t',
  r: '\r',
  '0': '\0'
};

function readDoubleQuoted(valueText: string, lineNo: number): ScalarResult {
  let out = '';
  let i = 1;
  while (i < valueText.length) {
    const char = valueText[i];
    if (char === '"') {
      const trailing = valueText.slice(i + 1).replace(/^ +/, '');
      if (trailing.length > 0 && !trailing.startsWith('#')) {
        return {
          ok: false,
          result: refuse('disallowed-syntax', 'unexpected content after a quoted scalar', lineNo)
        };
      }
      return { ok: true, node: scalar(out, true, lineNo) };
    }
    if (char === '\\') {
      const next = valueText[i + 1];
      if (next === 'u') {
        const hex = valueText.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          return { ok: false, result: refuse('disallowed-syntax', 'malformed unicode escape', lineNo) };
        }
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        continue;
      }
      const simple = next === undefined ? undefined : SIMPLE_ESCAPES[next];
      if (simple === undefined) {
        return { ok: false, result: refuse('disallowed-syntax', 'unsupported escape sequence', lineNo) };
      }
      out += simple;
      i += 2;
      continue;
    }
    if (char.charCodeAt(0) < 0x20) {
      return {
        ok: false,
        result: refuse('disallowed-syntax', 'a raw control character may not appear in a quoted scalar', lineNo)
      };
    }
    out += char;
    i += 1;
  }
  return { ok: false, result: refuse('disallowed-syntax', 'unterminated quoted scalar', lineNo) };
}

type BlockLiteralResult =
  | { readonly ok: true; readonly node: YamlScalarNode; readonly lastLineIndex: number }
  | { readonly ok: false; readonly result: ScanResult };

function readBlockLiteral(
  lines: readonly string[],
  headerIndex: number,
  headerColumn: number,
  valueText: string,
  lineNo: number
): BlockLiteralResult {
  const header = valueText.replace(/ +#.*$/, '').replace(/ +$/, '');
  if (header !== '|-') {
    return {
      ok: false,
      result: refuse(
        'disallowed-syntax',
        "'|-' is the only block scalar form this format admits",
        lineNo
      )
    };
  }

  const contentColumn = headerColumn + INDENT_WIDTH;
  const body: string[] = [];
  let cursor = headerIndex;

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('\r')) {
      return { ok: false, result: refuse('disallowed-syntax', 'carriage return inside a line', i + 1) };
    }
    const prefix = line.slice(0, contentColumn);
    if (prefix.includes('\t')) {
      return {
        ok: false,
        result: refuse('disallowed-syntax', 'a tab may not be used for indentation', i + 1)
      };
    }
    if (line.trim().length === 0) {
      // A blank line belongs to the literal only if the literal continues.
      body.push('');
      cursor = i;
      continue;
    }
    if (prefix.length < contentColumn || prefix.trim().length !== 0) {
      break;
    }
    body.push(line.slice(contentColumn));
    cursor = i;
  }

  while (body.length > 0 && body[body.length - 1] === '') {
    body.pop();
  }
  return { ok: true, node: scalar(body.join('\n'), true, lineNo), lastLineIndex: cursor };
}
