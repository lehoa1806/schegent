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
//
// Feature 085 T011 — the emitters became composable and the key-order constants
// grew to cover the package document's mappings. Every order this format writes
// lives in this file (contracts/yaml-grammar.md "Determinism"), so determinism
// is one file's property rather than a convention several modules follow.

import { chooseScalarStyle, quoteDouble } from './scalar-style';
import {
  PHASE_YAML_INDENT,
  type PhaseYamlDocument,
  type PhaseYamlDocumentBody
} from './types';

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

// --- package document orders (data-model.md §2) -----------------------------

export const PACKAGE_DOCUMENT_KEY_ORDER = Object.freeze([
  'apiVersion',
  'kind',
  'metadata',
  'spec',
  'included'
] as const);

export const PIPELINE_METADATA_KEY_ORDER = Object.freeze([
  'id',
  'name',
  'version',
  'description'
] as const);

export const PIPELINE_SPEC_KEY_ORDER = Object.freeze([
  'phaseIds',
  'inputs',
  'outputs',
  'bindings',
  'executionDefaults',
  'recommendedNext'
] as const);

export const INPUT_PORT_KEY_ORDER = Object.freeze([
  'portId',
  'label',
  'type',
  'required',
  'description'
] as const);

export const OUTPUT_PORT_KEY_ORDER = Object.freeze([
  'portId',
  'label',
  'type',
  'description'
] as const);

export const INPUT_BINDING_KEY_ORDER = Object.freeze([
  'kind',
  'phaseIndex',
  'inputKey',
  'source'
] as const);

export const OUTPUT_BINDING_KEY_ORDER = Object.freeze([
  'kind',
  'phaseIndex',
  'portId',
  'outputKey'
] as const);

export const BINDING_SOURCE_KEY_ORDER = Object.freeze([
  'from',
  'phaseIndex',
  'portId'
] as const);

export const EXECUTION_DEFAULTS_KEY_ORDER = Object.freeze([
  'runner',
  'model',
  'effort',
  'timeoutSeconds'
] as const);

// --- Workflow package document orders (contracts/workflow-yaml-grammar.md §2) -
//
// Feature 086 adds orders, not productions. A Workflow document is written with
// the same emitters as a Pipeline one — the grammar does not move — so what is
// new here is nine declarations and nothing else.
//
// Each of these is also the unknown-key oracle on read, as `PACKAGE_TOP_LEVEL_KEYS`
// already is: a key absent from the order is a key this format does not have.
// That is why the document order below duplicates `PACKAGE_DOCUMENT_KEY_ORDER`
// key for key rather than aliasing it — the two documents are free to diverge,
// and an alias would silently accept the other's shape if either ever did.

export const WORKFLOW_PACKAGE_DOCUMENT_KEY_ORDER = Object.freeze([
  'apiVersion',
  'kind',
  'metadata',
  'spec',
  'included'
] as const);

export const WORKFLOW_METADATA_KEY_ORDER = Object.freeze([
  'id',
  'name',
  'description',
  'version'
] as const);

export const WORKFLOW_SPEC_KEY_ORDER = Object.freeze([
  'nodes',
  'connections',
  'startNodeIds'
] as const);

export const WORKFLOW_NODE_KEY_ORDER = Object.freeze([
  'nodeId',
  'pipelineId',
  'label'
] as const);

export const WORKFLOW_CONNECTION_KEY_ORDER = Object.freeze([
  'from',
  'to',
  'condition',
  'priority',
  'isDefault',
  'selection'
] as const);

export const WORKFLOW_ENDPOINT_KEY_ORDER = Object.freeze([
  'nodeId',
  'portId'
] as const);

/**
 * A condition is structured data, never an expression string, so its shape is a
 * declared key order like any other mapping's. There is nothing here to parse
 * and therefore nothing to sandbox.
 */
export const WORKFLOW_CONDITION_KEY_ORDER = Object.freeze([
  'left',
  'operator',
  'right'
] as const);

export const WORKFLOW_OPERAND_KEY_ORDER = Object.freeze([
  'source',
  'nodeId',
  'field'
] as const);

export const WORKFLOW_INCLUDED_KEY_ORDER = Object.freeze([
  'pipelines',
  'phases'
] as const);

export type ScalarValue = string | number | boolean;

/**
 * The text that follows `key: ` or `- `. `ownerIndent` is the column the
 * construct that owns this scalar starts at, which is what a block literal
 * measures its body from — for an entry that is the key's indent, for a
 * sequence entry it is the dash's indent plus one level, because the dash
 * occupies exactly one level.
 */
function renderScalar(ownerIndent: string, value: ScalarValue): string {
  if (typeof value !== 'string') {
    return String(value);
  }
  const style = chooseScalarStyle(value);
  if (style === 'block') {
    const contentIndent = `${ownerIndent}${PHASE_YAML_INDENT}`;
    const body = value
      .split('\n')
      .map((line) => (line.length === 0 ? '' : `${contentIndent}${line}`))
      .join('\n');
    return `|-\n${body}`;
  }
  return style === 'double' ? quoteDouble(value) : value;
}

export function emitEntry(indent: string, key: string, value: ScalarValue): string {
  return `${indent}${key}: ${renderScalar(indent, value)}\n`;
}

/** A key whose value is a block — a mapping or a sequence at `indent + 1`. */
export function emitKey(indent: string, key: string): string {
  return `${indent}${key}:\n`;
}

/**
 * Emit one mapping in the declared key order. The section is read by key
 * because the order constant, not the object's own shape, decides what is
 * written; every value handled here is a scalar. A key whose value is itself a
 * block is composed by the caller from `emitKey` plus the block's own emitter.
 */
export function emitMapping(indent: string, order: readonly string[], section: object): string {
  const source = section as Readonly<Record<string, ScalarValue | undefined>>;
  let out = '';
  for (const key of order) {
    const value = source[key];
    if (value === undefined) continue;
    out += emitEntry(indent, key, value);
  }
  return out;
}

/** One `- scalar` entry. `indent` is the dash's own indent. */
export function emitScalarItem(indent: string, value: ScalarValue): string {
  return `${indent}- ${renderScalar(`${indent}${PHASE_YAML_INDENT}`, value)}\n`;
}

/**
 * Turn a mapping already rendered at `indent + 1` into a sequence entry by
 * rewriting the FIRST line's leading whitespace to `- `. `"  "` and `"- "` are
 * both two characters, so only that one prefix moves; every later line already
 * sits at the body column and is untouched.
 */
export function openWithDash(indent: string, body: string): string {
  const bodyIndent = `${indent}${PHASE_YAML_INDENT}`;
  return `${indent}- ${body.slice(bodyIndent.length)}`;
}

/**
 * A key whose value is a list of scalars. An empty list emits NOTHING — the key
 * is omitted, because `key:` with no children reads back as an empty mapping and
 * would make the round trip lossy (research R3).
 */
export function emitSequence(
  indent: string,
  key: string,
  values: readonly ScalarValue[]
): string {
  if (values.length === 0) return '';
  const itemIndent = `${indent}${PHASE_YAML_INDENT}`;
  let out = emitKey(indent, key);
  for (const value of values) {
    out += emitScalarItem(itemIndent, value);
  }
  return out;
}

/**
 * A key whose value is a list of mappings — the format's only other sequence
 * shape. `render` receives the body indent and returns that entry's mapping
 * lines; this function is what puts the dash on the first of them. Same
 * empty-list rule as `emitSequence`.
 */
export function emitMappingSequence<T>(
  indent: string,
  key: string,
  items: readonly T[],
  render: (bodyIndent: string, item: T) => string
): string {
  if (items.length === 0) return '';
  const itemIndent = `${indent}${PHASE_YAML_INDENT}`;
  const bodyIndent = `${itemIndent}${PHASE_YAML_INDENT}`;
  let out = emitKey(indent, key);
  for (const item of items) {
    out += openWithDash(itemIndent, render(bodyIndent, item));
  }
  return out;
}

/**
 * A Phase's two body mappings, at any indent.
 *
 * Feature 085 T025 — exported because the package document's `included.phases`
 * writes exactly this (FR-008), and a second walk of `METADATA_KEY_ORDER` and
 * `SPEC_KEY_ORDER` is a second thing to keep in step. The only difference
 * between a root Phase document and an included one is the indent and the two
 * declaration keys the root carries, so that is the only difference in the code.
 */
export function emitPhaseDocumentBody(indent: string, body: PhaseYamlDocumentBody): string {
  const fieldIndent = `${indent}${PHASE_YAML_INDENT}`;
  return (
    emitKey(indent, 'metadata') +
    emitMapping(fieldIndent, METADATA_KEY_ORDER, body.metadata) +
    emitKey(indent, 'spec') +
    emitMapping(fieldIndent, SPEC_KEY_ORDER, body.spec)
  );
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
        // Both body mappings are written here, by the shared emitter, in the
        // order `DOCUMENT_KEY_ORDER` declares. The `spec` arm below is
        // deliberately empty rather than absent, so a key added to that
        // constant still has to be answered here.
        out += emitPhaseDocumentBody('', document);
        break;
      case 'spec':
        break;
    }
  }
  return out;
}
