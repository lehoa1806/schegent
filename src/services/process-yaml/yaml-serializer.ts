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

import { chooseScalarStyle, quoteDouble, type ScalarPosition } from './scalar-style';
import {
  PHASE_YAML_INDENT,
  type PhaseYamlDocument,
  type PhaseYamlDocumentBody,
  type PhaseYamlSpec
} from './types';
import {
  isTypedLeafTest,
  type DecisionField,
  type ResultContract,
  type TypedCondition,
  type TypedLeaf
} from '../../contracts/decision-results';
import type {
  CandidateBlockControl,
  CandidateSpec,
  DecisionResultBinding,
  RepeatCarryMapping,
  WorkflowDecisionResultField,
  WorkflowDecisionResults,
  WorkflowNodeControl
} from '../../contracts/workflow-controls';

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

// Feature 098 T012 — `sideEffects` and `evidencePolicy` are admitted HERE and
// only here. `phase-yaml-validator.ts` derives its admitted-key set from this
// constant and `phase-yaml-mapper.ts` derives its portable-field set from it, so
// one edit opens the reader, the writer, and the portability check together and
// there is no way to admit a field in one of the three and forget the others.
//
// Placement after `runner` is deliberate: `sideEffects` is the field the
// Git-runner rule reads alongside `runner`, and adjacency keeps an exported
// document legible (data-model.md §1.2). Order here is emission order only — the
// reader admits these keys in any order.
export const SPEC_KEY_ORDER = Object.freeze([
  'instruction',
  'skill',
  'runner',
  'sideEffects',
  'evidencePolicy',
  // FR-R3-058 — beside `evidencePolicy` because they are the two evidence axes:
  // whether a record is required, and who is believed when the host and the model
  // disagree. Without this key the field would be unauthorable in the shipped
  // format, which would make the whole marking unreachable.
  'hostVerification',
  // FR-R3-086 — a SET of enum members, which this format has no other example of
  // and cannot carry as a list. Its one list convention is that an absent key
  // reads back as `[]` (types.ts `YamlSequenceNode`), and for this field that
  // convention is exactly inverted: absent must mean the UNBOUNDED default, and
  // the empty set must mean nothing granted. A block sequence cannot write the
  // empty set at all, so a list-shaped key would turn the most restrictive
  // declaration into the least — a silent widening, in the one field where
  // widening is the whole risk.
  //
  // So it is written as a scalar holding the members joined by `,`: absent is
  // the default, `""` is the empty set, `"a,b"` is that set. The members are a
  // closed union and the reader checks each against it, so this is a typed field
  // whose text the validator turns back into values -- the same thing this
  // format already does for integers and booleans, not free-form text.
  //
  // Member order is the document's own, not canonicalized, so the round trip is
  // byte-exact (FR-017). Order carries no meaning: `declaredCapabilitySet`
  // filters to a canonical order at the point of use.
  'capabilities',
  'model',
  'effort',
  'timeoutSeconds',
  // FR-R3-112 — the per-phase spend bound, beside the other authored bound. Both denominations,
  // because a document that carried only one would come back with the other silently cleared —
  // and a bound that vanishes through a round trip is the widening this format's key order
  // exists to prevent.
  'spendBoundUsd',
  'spendBoundTokens',
  'loopable',
  'isRequired',
  'forceContinueOnRetryCap',
  // FR-R3-157 — the three-valued cap outcome, immediately after the boolean it
  // supersedes. A document may carry both (contract V2) and this order is what
  // makes that legible: consecutive lines, deprecated first, so an author
  // reading their own file sees the pair as one decision rather than two
  // unrelated settings pages apart. Neither is dropped on save — dropping the
  // boolean breaks a reader that predates this key, dropping `onRetryCap`
  // silently reverts the author's decision to the boolean's two-valued answer.
  'onRetryCap',
  'retryCondition',
  'resultContract'
] as const);

export const RESULT_CONTRACT_KEY_ORDER = Object.freeze([
  'version',
  'operator',
  'operatorVersion',
  'fields',
  'source',
  'completion'
] as const);

export const RESULT_CONTRACT_SOURCE_KEY_ORDER = Object.freeze([
  'kind',
  'outputKey',
  'recordType'
] as const);

export const DECISION_FIELD_KEY_ORDER = Object.freeze([
  'fieldId',
  'type',
  'required',
  'selector'
] as const);

export const TYPED_OPERAND_KEY_ORDER = Object.freeze([
  'source',
  'nodeId',
  'fieldId'
] as const);

export const TYPED_LEAF_KEY_ORDER = Object.freeze([
  'left',
  'operator',
  'right'
] as const);

// --- Workflow package document orders (contracts/workflow-yaml-grammar.md §2) -
//
// Feature 086 / Feature 263 (FR-R5-F04) — every mapping key order in a
// composable Workflow package is declared here and serves as both the
// deterministic emission order and the unknown-key oracle on read.

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
  'inputs',
  'outputs',
  'nodes',
  'connections',
  'bindings',
  'startNodeIds',
  'executionDefaults',
  'recommendedNext',
  'control',
  'decisionResults'
] as const);

export const WORKFLOW_PORT_KEY_ORDER = Object.freeze([
  'portId',
  'label',
  'type',
  'required',
  'description'
] as const);

export const WORKFLOW_NODE_KEY_ORDER = Object.freeze([
  'nodeId',
  'kind',
  'phaseId',
  'workflowId',
  'label',
  'control'
] as const);

export const CANDIDATE_BLOCK_CONTROL_KEY_ORDER = Object.freeze([
  'version',
  'kind',
  'candidates',
  'availabilityPolicy',
  'maxDispatches',
  'monitoringWindowMs',
  'budget'
] as const);

export const CANDIDATE_SPEC_KEY_ORDER = Object.freeze([
  'candidateId',
  'nodeId',
  'priority',
  'maxAttempts',
  'retry',
  'allowUnverifiedTrial'
] as const);

export const CANDIDATE_RETRY_KEY_ORDER = Object.freeze([
  'initialDelayMs',
  'multiplier',
  'maxDelayMs'
] as const);

export const CANDIDATE_BUDGET_KEY_ORDER = Object.freeze([
  'mode',
  'limitMicrousd'
] as const);

export const WORKFLOW_DECISION_RESULTS_KEY_ORDER = Object.freeze([
  'version',
  'fields',
  'bindings'
] as const);

export const WORKFLOW_DECISION_FIELD_KEY_ORDER = Object.freeze([
  'fieldId',
  'type',
  'required'
] as const);

export const WORKFLOW_DECISION_BINDING_KEY_ORDER = Object.freeze([
  'fieldId',
  'source'
] as const);

export const WORKFLOW_DECISION_BINDING_SOURCE_KEY_ORDER = Object.freeze([
  'kind',
  'nodeId',
  'fieldId'
] as const);

export const REPEAT_CONTROL_KEY_ORDER = Object.freeze([
  'version',
  'kind',
  'maxIterations',
  'until',
  'carry',
  'onExhausted'
] as const);

export const REPEAT_CARRY_MAPPING_KEY_ORDER = Object.freeze([
  'fieldId',
  'inputPortId'
] as const);

export const FOR_EACH_CONTROL_KEY_ORDER = Object.freeze([
  'version',
  'kind',
  'collection',
  'itemKeyField',
  'itemInputPortId',
  'maxItems',
  'onItemError'
] as const);

export const FOR_EACH_COLLECTION_SOURCE_KEY_ORDER = Object.freeze([
  'source',
  'nodeId',
  'portId'
] as const);

export const WORKFLOW_CONNECTION_KEY_ORDER = Object.freeze([
  'from',
  'to',
  'handoff',
  'condition',
  'priority',
  'isDefault',
  'selection'
] as const);

export const WORKFLOW_ENDPOINT_KEY_ORDER = Object.freeze([
  'nodeId',
  'portId',
  'kind'
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

export const WORKFLOW_BINDING_KEY_ORDER = Object.freeze([
  'kind',
  'nodeId',
  'inputKey',
  'portId',
  'outputKey',
  'sourcePortId',
  'type',
  'required',
  'label',
  'source',
  'selection'
] as const);

export const WORKFLOW_BINDING_SOURCE_KEY_ORDER = Object.freeze([
  'from',
  'nodeId',
  'portId'
] as const);

export const EXECUTION_DEFAULTS_KEY_ORDER = Object.freeze([
  'runner',
  'model',
  'effort',
  'timeoutSeconds'
] as const);

export const WORKFLOW_INCLUDED_KEY_ORDER = Object.freeze([
  'workflows',
  'phases'
] as const);

// --- Model Catalog document orders (feature 096, data-model.md "Model Catalog
// File") -----------------------------------------------------------------
//
// Flatter than the other three: no `metadata`/`spec` split, no `included` —
// Model Catalog has one writable layer and no cross-catalog references
// (FR-015), so neither concept applies. Same rule as WORKFLOW_* above: each
// order is also the reader's admitted-key set, so a key this format does not
// list here is a key the reader refuses.

export const MODEL_CATALOG_DOCUMENT_KEY_ORDER = Object.freeze([
  'apiVersion',
  'kind',
  'groups'
] as const);

export const MODEL_CATALOG_GROUP_KEY_ORDER = Object.freeze(['backend', 'models'] as const);

export type ScalarValue = string | number | boolean;

/**
 * The text that follows `key: ` or `- `. `ownerIndent` is the column the
 * construct that owns this scalar starts at, which is what a block literal
 * measures its body from — for an entry that is the key's indent, for a
 * sequence entry it is the dash's indent plus one level, because the dash
 * occupies exactly one level.
 */
function renderScalar(
  ownerIndent: string,
  value: ScalarValue,
  position: ScalarPosition = 'value'
): string {
  if (typeof value !== 'string') {
    return String(value);
  }
  const style = chooseScalarStyle(value, position);
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
  // The only `'item'` caller (feature 254, FR-009): a sequence item the scanner would read as a
  // mapping entry, such as `ollama:llama3`, is written quoted.
  return `${indent}- ${renderScalar(`${indent}${PHASE_YAML_INDENT}`, value, 'item')}\n`;
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

function emitTypedLeaf(indent: string, leaf: TypedLeaf): string {
  const nestedIndent = `${indent}${PHASE_YAML_INDENT}`;
  let out = emitKey(indent, 'left');
  out += emitMapping(nestedIndent, TYPED_OPERAND_KEY_ORDER, leaf.left);
  out += emitEntry(indent, 'operator', leaf.operator);
  if (leaf.right !== undefined) {
    out += Array.isArray(leaf.right)
      ? emitSequence(indent, 'right', leaf.right as readonly ScalarValue[])
      : emitEntry(indent, 'right', leaf.right as ScalarValue);
  }
  return out;
}

export function emitTypedCondition(indent: string, condition: TypedCondition): string {
  const nestedIndent = `${indent}${PHASE_YAML_INDENT}`;
  let out = emitEntry(indent, 'version', condition.version);
  out += emitEntry(indent, 'kind', condition.kind);
  out += emitKey(indent, 'test');
  const { test } = condition;
  if (isTypedLeafTest(test)) {
    out += emitTypedLeaf(nestedIndent, test);
  } else if ('all' in test) {
    out += emitMappingSequence(nestedIndent, 'all', test.all, emitTypedLeaf);
  } else {
    out += emitMappingSequence(nestedIndent, 'any', test.any, emitTypedLeaf);
  }
  return out;
}

function renderDecisionField(bodyIndent: string, field: DecisionField): string {
  let out = '';
  for (const key of DECISION_FIELD_KEY_ORDER) {
    if (key === 'selector') {
      out += emitSequence(bodyIndent, 'selector', field.selector);
      continue;
    }
    out += emitMapping(bodyIndent, [key], field);
  }
  return out;
}

export function emitResultContract(indent: string, contract: ResultContract): string {
  const nestedIndent = `${indent}${PHASE_YAML_INDENT}`;
  let out = '';
  for (const key of RESULT_CONTRACT_KEY_ORDER) {
    switch (key) {
      case 'version':
      case 'operator':
      case 'operatorVersion':
        out += emitMapping(indent, [key], contract);
        break;
      case 'fields':
        out += emitMappingSequence(indent, 'fields', contract.fields, renderDecisionField);
        break;
      case 'source':
        out += emitKey(indent, 'source');
        out += emitMapping(nestedIndent, RESULT_CONTRACT_SOURCE_KEY_ORDER, contract.source);
        break;
      case 'completion':
        out += emitKey(indent, 'completion');
        out += emitTypedCondition(nestedIndent, contract.completion);
        break;
    }
  }
  return out;
}

function renderCandidateSpec(bodyIndent: string, candidate: CandidateSpec): string {
  const nestedIndent = `${bodyIndent}${PHASE_YAML_INDENT}`;
  let out = '';
  for (const key of CANDIDATE_SPEC_KEY_ORDER) {
    if (key === 'retry') {
      if (candidate.retry !== undefined) {
        const retryBody = emitMapping(nestedIndent, CANDIDATE_RETRY_KEY_ORDER, candidate.retry);
        if (retryBody.length > 0) {
          out += emitKey(bodyIndent, 'retry') + retryBody;
        }
      }
      continue;
    }
    out += emitMapping(bodyIndent, [key], candidate);
  }
  return out;
}

export function emitCandidateBlockControl(
  indent: string,
  control: CandidateBlockControl
): string {
  const nestedIndent = `${indent}${PHASE_YAML_INDENT}`;
  let out = '';
  for (const key of CANDIDATE_BLOCK_CONTROL_KEY_ORDER) {
    switch (key) {
      case 'candidates':
        out += emitMappingSequence(indent, 'candidates', control.candidates, renderCandidateSpec);
        break;
      case 'budget':
        if (control.budget !== undefined) {
          out += emitKey(indent, 'budget');
          out += emitMapping(nestedIndent, CANDIDATE_BUDGET_KEY_ORDER, control.budget);
        }
        break;
      case 'version':
      case 'kind':
      case 'availabilityPolicy':
      case 'maxDispatches':
      case 'monitoringWindowMs':
        out += emitMapping(indent, [key], control);
        break;
    }
  }
  return out;
}

function renderWorkflowDecisionField(
  bodyIndent: string,
  field: WorkflowDecisionResultField
): string {
  return emitMapping(bodyIndent, WORKFLOW_DECISION_FIELD_KEY_ORDER, field);
}

function renderWorkflowDecisionBinding(
  bodyIndent: string,
  binding: DecisionResultBinding
): string {
  const nestedIndent = `${bodyIndent}${PHASE_YAML_INDENT}`;
  let out = '';
  for (const key of WORKFLOW_DECISION_BINDING_KEY_ORDER) {
    if (key === 'source') {
      out += emitKey(bodyIndent, 'source');
      out += emitMapping(
        nestedIndent,
        WORKFLOW_DECISION_BINDING_SOURCE_KEY_ORDER,
        binding.source
      );
      continue;
    }
    out += emitMapping(bodyIndent, [key], binding);
  }
  return out;
}

export function emitWorkflowDecisionResults(
  indent: string,
  decisionResults: WorkflowDecisionResults
): string {
  let out = '';
  for (const key of WORKFLOW_DECISION_RESULTS_KEY_ORDER) {
    switch (key) {
      case 'version':
        out += emitMapping(indent, [key], decisionResults);
        break;
      case 'fields':
        out += emitMappingSequence(
          indent,
          'fields',
          decisionResults.fields,
          renderWorkflowDecisionField
        );
        break;
      case 'bindings':
        out += emitMappingSequence(
          indent,
          'bindings',
          decisionResults.bindings,
          renderWorkflowDecisionBinding
        );
        break;
    }
  }
  return out;
}

function renderRepeatCarryMapping(bodyIndent: string, mapping: RepeatCarryMapping): string {
  return emitMapping(bodyIndent, REPEAT_CARRY_MAPPING_KEY_ORDER, mapping);
}

export function emitWorkflowNodeControl(indent: string, control: WorkflowNodeControl): string {
  const nestedIndent = `${indent}${PHASE_YAML_INDENT}`;
  if (control.kind === 'repeat') {
    let out = '';
    for (const key of REPEAT_CONTROL_KEY_ORDER) {
      switch (key) {
        case 'until':
          out += emitKey(indent, 'until');
          out += emitTypedCondition(nestedIndent, control.until);
          break;
        case 'carry':
          out += emitMappingSequence(indent, 'carry', control.carry, renderRepeatCarryMapping);
          break;
        case 'version':
        case 'kind':
        case 'maxIterations':
        case 'onExhausted':
          out += emitMapping(indent, [key], control);
          break;
      }
    }
    return out;
  }

  let out = '';
  for (const key of FOR_EACH_CONTROL_KEY_ORDER) {
    switch (key) {
      case 'collection':
        out += emitKey(indent, 'collection');
        out += emitMapping(nestedIndent, FOR_EACH_COLLECTION_SOURCE_KEY_ORDER, control.collection);
        break;
      case 'version':
      case 'kind':
      case 'itemKeyField':
      case 'itemInputPortId':
      case 'maxItems':
      case 'onItemError':
        out += emitMapping(indent, [key], control);
        break;
    }
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
  const resultContractBlock =
    body.spec.resultContract !== undefined
      ? emitKey(fieldIndent, 'resultContract') +
        emitResultContract(`${fieldIndent}${PHASE_YAML_INDENT}`, body.spec.resultContract)
      : '';
  return (
    emitKey(indent, 'metadata') +
    emitMapping(fieldIndent, METADATA_KEY_ORDER, body.metadata) +
    emitKey(indent, 'spec') +
    emitMapping(fieldIndent, SPEC_KEY_ORDER, scalarSpecView(body.spec)) +
    resultContractBlock
  );
}

/** The separator between capability members. One character, not in any member. */
export const CAPABILITY_SEPARATOR = ',';

/**
 * The spec as `emitMapping` needs it: every value a scalar.
 *
 * `capabilities` is the only field of the Phase spec that is not already one,
 * and it is encoded here rather than in `phase-yaml-mapper.ts` so that module
 * keeps the property it declares -- a rename and a regrouping, every value
 * carried verbatim. Encoding is a writer concern and lives with the writer.
 */
function scalarSpecView(spec: PhaseYamlSpec): object {
  const { capabilities, resultContract } = spec;
  if (capabilities === undefined && resultContract === undefined) return spec;
  return {
    ...spec,
    ...(capabilities !== undefined ? { capabilities: capabilities.join(CAPABILITY_SEPARATOR) } : {}),
    resultContract: undefined
  };
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
