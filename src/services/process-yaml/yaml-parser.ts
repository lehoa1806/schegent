// Feature 084 T007/T008 — recursive-descent parser for the closed exchange
// subset, plus the pre-parse guards.
//
// The parser consumes the scanner's token stream and builds a mapping tree.
// It never coerces a scalar: every value stays text, carrying only the flag
// that says whether its source form fixed it as text. Type interpretation is
// the validator's job, where the field's declared type is known.
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
  type YamlMappingNode
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

function buildMapping(tokens: readonly YamlToken[], start: number, level: number): MappingResult {
  const entries: YamlMappingEntry[] = [];
  const seen = new Set<string>();
  const line = start < tokens.length ? tokens[start].line : 0;
  let cursor = start;

  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (token.kind === 'document-start') {
      return {
        ok: false,
        refusal: {
          code: 'multi-document',
          message: `a second document start is not part of this format (line ${token.line})`
        }
      };
    }
    if (token.indent < level) break;
    if (token.indent > level) {
      return {
        ok: false,
        refusal: {
          code: 'disallowed-syntax',
          message: `unexpected indentation (line ${token.line})`
        }
      };
    }
    if (seen.has(token.key)) {
      return {
        ok: false,
        refusal: {
          code: 'disallowed-syntax',
          message: `duplicate key '${token.key}' in one mapping (line ${token.line})`
        }
      };
    }
    seen.add(token.key);

    if (token.value === null) {
      const nested = buildMapping(tokens, cursor + 1, level + 1);
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
