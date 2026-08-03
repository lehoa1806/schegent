// Feature 084 T004 — line/indent/token scanner for the closed exchange
// subset. Normative grammar: specs/084-phase-yaml-exchange/contracts/
// phase-yaml-grammar.ebnf.
//
// This is NOT a YAML scanner. It admits exactly the constructs the grammar
// names and refuses everything else AT THE TOKEN, before any value the
// document declares has been constructed (FR-003a). An anchor, alias, merge
// key, tag, directive, flow collection or block sequence is rejected the
// moment its indicator is read — never expanded, resolved, or constructed and
// then discarded.
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

export interface YamlDocumentStartToken {
  readonly kind: 'document-start';
  readonly line: number;
}

export type YamlToken = YamlEntryToken | YamlDocumentStartToken;

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
    if (rest === '-' || rest.startsWith('- ')) {
      return refuse('disallowed-syntax', 'block sequences are not part of this format', lineNo);
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

    const keyMatch = KEY_PATTERN.exec(rest);
    if (!keyMatch) {
      const reason = PLAIN_FIRST_EXCLUDED.get(rest[0]) ?? 'unrecognized construct';
      return refuse('disallowed-syntax', reason, lineNo);
    }
    const key = keyMatch[0];
    const afterKey = rest.slice(key.length);
    if (!afterKey.startsWith(':')) {
      return refuse('disallowed-syntax', "expected ':' after a mapping key", lineNo);
    }
    const afterColon = afterKey.slice(1);
    if (afterColon.length > 0 && !afterColon.startsWith(' ')) {
      return refuse('disallowed-syntax', "a mapping key must be followed by ': '", lineNo);
    }
    const valueText = afterColon.replace(/^ +/, '');

    sawContent = true;
    previousLevel = level;

    if (valueText.length === 0 || valueText.startsWith('#')) {
      previousOpensMapping = true;
      tokens.push({ kind: 'entry', indent: level, key, value: null, line: lineNo });
      continue;
    }

    if (valueText.startsWith('|')) {
      const literal = readBlockLiteral(lines, index, leading.length, valueText, lineNo);
      if (!literal.ok) return literal.result;
      index = literal.lastLineIndex;
      previousOpensMapping = false;
      tokens.push({ kind: 'entry', indent: level, key, value: literal.node, line: lineNo });
      continue;
    }

    const parsed = valueText.startsWith('"')
      ? readDoubleQuoted(valueText, lineNo)
      : readPlain(valueText, lineNo);
    if (!parsed.ok) return parsed.result;
    previousOpensMapping = false;
    tokens.push({ kind: 'entry', indent: level, key, value: parsed.node, line: lineNo });
  }

  return { ok: true, tokens };
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
