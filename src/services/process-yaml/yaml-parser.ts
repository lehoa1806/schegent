// Feature 084 T007/T008 — recursive-descent parser for the closed exchange
// subset, plus the pre-parse guards.
//
// The parser consumes the scanner's token stream and builds a mapping tree.
// It never coerces a scalar: every value stays text, carrying only the flag
// that says whether its source form fixed it as text. Type interpretation is
// the validator's job, where the field's declared type is known.
//
// Feature 085 T007/T008 — a key whose value is a block opens EITHER a mapping
// or a sequence, decided by the first token beneath it and by nothing else. A
// level is one or the other, never both: `buildMapping` refuses an item at its
// own level and `buildSequence` refuses an entry at its own, so a document that
// mixes them is refused at the point the second kind appears rather than being
// silently reinterpreted.
//
// Guard order in parseDocumentBytes is load-bearing (FR-011, QS-8):
//
//   size bound  ->  byte-order mark  ->  strict UTF-8 decode  ->  scanner
//
// The bound is checked on the raw bytes so an over-sized document never
// reaches the decoder, let alone the scanner. A bound enforced after
// tokenizing does not do what the bound is for.
//
// Errors are values. Nothing in this file throws (research R1).

import { scanDocument, type YamlToken } from './yaml-scanner';
import {
  PHASE_YAML_MAX_BYTES,
  type DocumentRefusal,
  type DocumentRefusalCode,
  type ParseDocumentResult,
  type YamlMappingEntry,
  type YamlMappingNode,
  type YamlNode,
  type YamlSequenceNode
} from './types';

const BYTE_ORDER_MARK = '\uFEFF';

function refuse(code: DocumentRefusalCode, message: string): ParseDocumentResult {
  return { ok: false, refusal: { code, message } };
}

/**
 * Parse a document from its raw bytes. This is the entry point every host
 * caller uses; `parseDocumentText` exists for the pure round-trip path where
 * the text was produced by this module's own serializer.
 */
export function parseDocumentBytes(bytes: Uint8Array): ParseDocumentResult {
  if (bytes.byteLength > PHASE_YAML_MAX_BYTES) {
    return refuse(
      'too-large',
      `Document is larger than the ${PHASE_YAML_MAX_BYTES}-byte limit and was not parsed`
    );
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return refuse('unreadable', 'Document begins with a byte-order mark');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return refuse('unreadable', 'Document is not valid UTF-8');
  }
  return parseDocumentText(text);
}

/** Parse a document from already-decoded text. */
export function parseDocumentText(text: string): ParseDocumentResult {
  if (text.startsWith(BYTE_ORDER_MARK)) {
    return refuse('unreadable', 'Document begins with a byte-order mark');
  }
  if (new TextEncoder().encode(text).byteLength > PHASE_YAML_MAX_BYTES) {
    return refuse(
      'too-large',
      `Document is larger than the ${PHASE_YAML_MAX_BYTES}-byte limit and was not parsed`
    );
  }
  const scanned = scanDocument(text);
  if (!scanned.ok) {
    return { ok: false, refusal: scanned.refusal };
  }
  return buildDocument(scanned.tokens);
}

function buildDocument(tokens: readonly YamlToken[]): ParseDocumentResult {
  let cursor = tokens.length > 0 && tokens[0].kind === 'document-start' ? 1 : 0;
  if (cursor >= tokens.length) {
    return refuse('empty', 'Document declares no resource');
  }
  const mapping = buildMapping(tokens, cursor, 0);
  if (!mapping.ok) {
    return { ok: false, refusal: mapping.refusal };
  }
  cursor = mapping.cursor;
  if (cursor !== tokens.length) {
    return refuse('disallowed-syntax', 'unexpected trailing content after the resource');
  }
  if (mapping.node.entries.length === 0) {
    return refuse('empty', 'Document declares no resource');
  }
  return { ok: true, node: mapping.node };
}

type MappingResult =
  | { readonly ok: true; readonly node: YamlMappingNode; readonly cursor: number }
  | { readonly ok: false; readonly refusal: DocumentRefusal };

type SequenceResult =
  | { readonly ok: true; readonly node: YamlSequenceNode; readonly cursor: number }
  | { readonly ok: false; readonly refusal: DocumentRefusal };

function syntaxRefusal(message: string, line: number): DocumentRefusal {
  return { code: 'disallowed-syntax', message: `${message} (line ${line})` };
}

function multiDocumentRefusal(line: number): DocumentRefusal {
  return {
    code: 'multi-document',
    message: `a second document start is not part of this format (line ${line})`
  };
}

type BlockResult =
  | { readonly ok: true; readonly node: YamlNode; readonly cursor: number }
  | { readonly ok: false; readonly refusal: DocumentRefusal };

/**
 * Build whatever block sits beneath a key that took no inline value. The first
 * token at the child level decides: an item opens a sequence, an entry opens a
 * mapping. There is no third possibility, because the scanner emits no third
 * token kind at a content level.
 */
function buildBlock(tokens: readonly YamlToken[], start: number, level: number): BlockResult {
  const first = start < tokens.length ? tokens[start] : undefined;
  if (first !== undefined && first.kind === 'item' && first.indent === level) {
    return buildSequence(tokens, start, level);
  }
  return buildMapping(tokens, start, level);
}

function buildMapping(tokens: readonly YamlToken[], start: number, level: number): MappingResult {
  const entries: YamlMappingEntry[] = [];
  const seen = new Set<string>();
  const line = start < tokens.length ? tokens[start].line : 0;
  let cursor = start;

  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (token.kind === 'document-start') {
      return { ok: false, refusal: multiDocumentRefusal(token.line) };
    }
    if (token.indent < level) break;
    if (token.indent > level) {
      return { ok: false, refusal: syntaxRefusal('unexpected indentation', token.line) };
    }
    if (token.kind === 'item') {
      // A sequence where a mapping key was expected. At the root this is the
      // whole document's shape; anywhere else it is a level that started as a
      // mapping and changed its mind.
      const message =
        entries.length === 0 && level === 0
          ? 'a document must begin with a mapping, not a sequence'
          : 'a sequence entry and a mapping key may not share one level';
      return { ok: false, refusal: syntaxRefusal(message, token.line) };
    }
    if (seen.has(token.key)) {
      return {
        ok: false,
        refusal: syntaxRefusal(`duplicate key '${token.key}' in one mapping`, token.line)
      };
    }
    seen.add(token.key);

    if (token.value === null) {
      const nested = buildBlock(tokens, cursor + 1, level + 1);
      if (!nested.ok) return nested;
      entries.push({ key: token.key, value: nested.node, line: token.line });
      cursor = nested.cursor;
      continue;
    }
    entries.push({ key: token.key, value: token.value, line: token.line });
    cursor += 1;
  }

  return { ok: true, node: { kind: 'mapping', entries, line }, cursor };
}

/**
 * Assemble the items at `level`. An item carrying a scalar is that scalar; an
 * item carrying none opens a mapping at `level + 1`, whose first key the
 * scanner already emitted as an ordinary entry token.
 */
function buildSequence(tokens: readonly YamlToken[], start: number, level: number): SequenceResult {
  const items: YamlNode[] = [];
  const line = start < tokens.length ? tokens[start].line : 0;
  let cursor = start;

  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (token.kind === 'document-start') {
      return { ok: false, refusal: multiDocumentRefusal(token.line) };
    }
    if (token.indent < level) break;
    if (token.indent > level) {
      return { ok: false, refusal: syntaxRefusal('unexpected indentation', token.line) };
    }
    if (token.kind === 'entry') {
      return {
        ok: false,
        refusal: syntaxRefusal('a sequence entry and a mapping key may not share one level', token.line)
      };
    }

    if (token.value === null) {
      const body = buildMapping(tokens, cursor + 1, level + 1);
      if (!body.ok) return body;
      items.push(body.node);
      cursor = body.cursor;
      continue;
    }
    items.push(token.value);
    cursor += 1;
  }

  return { ok: true, node: { kind: 'sequence', items, line }, cursor };
}
