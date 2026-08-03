// Feature 084 T013 — the deterministic emitter.
//
// Property order is declared here as a constant and iterated, so byte-identical
// output (FR-017) is a property of this module rather than of the order in
// which some caller happened to build the object. Nothing reads
// `Object.keys(...)`.
//
// The emitter writes block style only: no flow collections, no document start
// marker, `|-` for a multi-line value, and double quotes for anything the
// shared predicate says cannot be written plain (research R5). Every style
// decision goes through `scalar-style.ts`, which the scanner also uses, so the
// writer and the reader cannot disagree about what is safe.
//
// Numbers and booleans are emitted bare. They are typed fields of the format,
// and the validator is what turns a scalar's text back into them on the way in.

import { chooseScalarStyle, quoteDouble } from './scalar-style';
import { PHASE_YAML_INDENT, type PhaseYamlDocument } from './types';

export const DOCUMENT_KEY_ORDER = Object.freeze([
  'apiVersion',
  'kind',
  'metadata',
  'spec'
] as const);

export const METADATA_KEY_ORDER = Object.freeze([
  'phaseId',
  'name',
  'version',
  'description'
] as const);

export const SPEC_KEY_ORDER = Object.freeze([
  'instruction',
  'skill',
  'runner',
  'model',
  'effort',
  'timeoutSeconds',
  'loopable',
  'isRequired',
  'retryCondition'
] as const);

type ScalarValue = string | number | boolean;

function emitEntry(indent: string, key: string, value: ScalarValue): string {
  if (typeof value !== 'string') {
    return `${indent}${key}: ${String(value)}\n`;
  }
  const style = chooseScalarStyle(value);
  if (style === 'block') {
    const contentIndent = `${indent}${PHASE_YAML_INDENT}`;
    const body = value
      .split('\n')
      .map((line) => (line.length === 0 ? '' : `${contentIndent}${line}`))
      .join('\n');
    return `${indent}${key}: |-\n${body}\n`;
  }
  const scalar = style === 'double' ? quoteDouble(value) : value;
  return `${indent}${key}: ${scalar}\n`;
}

/**
 * Emit one nested mapping in the declared key order. The section is read by key
 * because the order constant, not the object's own shape, decides what is
 * written; every value the format admits is a scalar.
 */
function emitMapping(order: readonly string[], section: object): string {
  const source = section as Readonly<Record<string, ScalarValue | undefined>>;
  let out = '';
  for (const key of order) {
    const value = source[key];
    if (value === undefined) continue;
    out += emitEntry(PHASE_YAML_INDENT, key, value);
  }
  return out;
}

/**
 * Render a document. The same document always renders to the same bytes, and
 * the result parses back to the same document (SC-003).
 */
export function serializePhaseDocument(document: PhaseYamlDocument): string {
  let out = '';
  for (const key of DOCUMENT_KEY_ORDER) {
    switch (key) {
      case 'apiVersion':
      case 'kind':
        out += emitEntry('', key, document[key]);
        break;
      case 'metadata':
        out += 'metadata:\n';
        out += emitMapping(METADATA_KEY_ORDER, document.metadata);
        break;
      case 'spec':
        out += 'spec:\n';
        out += emitMapping(SPEC_KEY_ORDER, document.spec);
        break;
    }
  }
  return out;
}
