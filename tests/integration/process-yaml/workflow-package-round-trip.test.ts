// Feature 086 T063-T066 — a round trip preserves graph semantics.
//
// Three properties, and they fail differently, which is why all three are here:
//
//   text  → resources → text     must be byte-identical (T063). Catches a reader
//                                that drops a field the writer emits, and a
//                                writer whose key order or scalar style is not a
//                                function of the value alone.
//   value → text       → value   must be deeply equal (T063). Catches the
//                                opposite: a writer that emits something the
//                                reader reads back as a DIFFERENT value — a
//                                `right: 3` re-typed to `"3"`, an omitted list
//                                read as absent rather than empty, a priority
//                                renumbered.
//   document → catalog → document must round-trip through an actual import
//                                (T064). The two properties above are internal to
//                                `workflow-document.ts`; this one puts the
//                                catalog validators, the precedence resolver, and
//                                the export selector in the loop, which is what
//                                FR-061 actually claims.
//
// Any one direction alone passes on a symmetric mistake. All three over the same
// corpus is what makes "a round trip preserves graph semantics" checkable rather
// than asserted.
//
// The corpus is deliberately made of documents this project WROTE — every fixture
// comes out of `serializeWorkflowDocument`, so a fixture cannot drift from the
// emitter and quietly stop testing the thing it names. The one hand-written
// document below exists to prove that is not circular.

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolvePipelineCatalog } from '../../../src/config/pipeline-catalog';
import { resolvePhaseCatalog } from '../../../src/config/process-catalog';
import type {
  PipelineDefinition,
  PipelineInputPort,
  PipelineOutputPort
} from '../../../src/contracts/pipeline-definitions';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import type {
  WorkflowConnection,
  WorkflowDefinition,
  WorkflowDefinitionScope,
  WorkflowNode
} from '../../../src/contracts/workflow-definitions';
import {
  WORKFLOW_CONDITION_OPERATORS,
  WORKFLOW_SELECTION_RULES
} from '../../../src/contracts/workflow-definitions';
import { phaseDefinitionFromDocument } from '../../../src/services/process-yaml/phase-yaml-mapper';
import type { WorkflowInclusion } from '../../../src/services/process-yaml/workflow-document';
import {
  documentFromWorkflowDefinition,
  parseWorkflowPackage,
  serializeWorkflowDocument
} from '../../../src/services/process-yaml/workflow-document';
import { selectWorkflowForExport } from '../../../src/services/process-yaml/workflow-export-selection';
import { parseDocumentText } from '../../../src/services/process-yaml/yaml-parser';

// ---------------------------------------------------------------------------
// The loop, in both directions
// ---------------------------------------------------------------------------

/**
 * Which dependency levels a document carries (FR-015, FR-017, FR-019).
 *
 * Not a boolean, because a Workflow has two dependency classes and three legal
 * answers: carry neither, carry the compositions, carry the closure. The middle
 * mode is the one a boolean would erase.
 */
type Mode = 'references' | 'pipelines' | 'closure';

interface ReadPackage {
  readonly workflow: WorkflowDefinition;
  readonly pipelines: readonly PipelineDefinition[];
  readonly phases: readonly PhaseDefinition[];
}

/** Read a document the way preflight does, insisting every resource is valid. */
function readPackage(text: string): ReadPackage {
  const parsed = parseDocumentText(text);
  if (!parsed.ok) {
    throw new Error(`did not parse: ${parsed.refusal.code} ${parsed.refusal.message}`);
  }
  const result = parseWorkflowPackage(parsed.node);
  if (!result.ok) throw new Error(`refused: ${result.refusal.code} ${result.refusal.message}`);

  let workflow: WorkflowDefinition | null = null;
  const pipelines: PipelineDefinition[] = [];
  const phases: PhaseDefinition[] = [];
  for (const resource of result.resources) {
    if (!resource.ok) {
      throw new Error(
        `invalid ${resource.resourceKind} ${resource.resourceId ?? '<no id>'}: ` +
          resource.defects.map((defect) => `${defect.field}/${defect.code}`).join(', ')
      );
    }
    if (resource.resourceKind === 'workflow') workflow = resource.definition;
    else if (resource.resourceKind === 'pipeline') pipelines.push(resource.definition);
    else phases.push(phaseDefinitionFromDocument(resource.document));
  }
  if (workflow === null) throw new Error('no root Workflow in the document');
  return { workflow, pipelines, phases };
}

/** The inclusion a mode asks for, built from whatever the document itself carried. */
function inclusionOf(
  pipelines: readonly PipelineDefinition[],
  phases: readonly PhaseDefinition[],
  mode: Mode
): WorkflowInclusion | undefined {
  if (mode === 'references') return undefined;
  if (mode === 'pipelines') return { pipelines };
  return { pipelines, phases };
}

/** Write what was read, with the same inclusion choice the document made. */
function writePackage(read: ReadPackage, mode: Mode): string {
  return serializeWorkflowDocument(
    documentFromWorkflowDefinition(read.workflow, inclusionOf(read.pipelines, read.phases, mode))
  );
}

// ---------------------------------------------------------------------------
// Definitions worth round-tripping
// ---------------------------------------------------------------------------

const PHASES: readonly PhaseDefinition[] = Object.freeze([
  Object.freeze({
    phaseId: 'draft',
    name: 'Draft',
    version: 2,
    description: 'Draft the spec.',
    instruction: 'Draft the spec, then stop.',
    model: 'opus',
    effort: 'high',
    timeoutSeconds: 900,
    loopable: true,
    // Carried verbatim and never read on this path (project rule on retryCondition).
    retryCondition: 'exitCode != 0 && attempt < 3',
    isRequired: true,
    runner: 'claude'
  }) as PhaseDefinition,
  Object.freeze({
    phaseId: 'review',
    name: 'Review',
    version: 3,
    skill: 'speckit-analyze'
  }) as PhaseDefinition,
  Object.freeze({
    phaseId: 'ship',
    name: 'Ship',
    version: 1,
    instruction: 'Ship it.'
  }) as PhaseDefinition
]);

function pipeline(
  pipelineId: string,
  name: string,
  version: number,
  phaseIds: readonly string[],
  inputs: readonly PipelineInputPort[],
  outputs: readonly PipelineOutputPort[]
): PipelineDefinition {
  return Object.freeze({
    pipelineId,
    name,
    version,
    phaseIds: Object.freeze([...phaseIds]),
    inputs: Object.freeze([...inputs]),
    outputs: Object.freeze([...outputs]),
    bindings: Object.freeze([]),
    recommendedNext: Object.freeze([])
  }) as PipelineDefinition;
}

/**
 * `required` is stated on every port rather than omitted: the catalog validator
 * materializes an absent `required` to `true`, so a port authored without it is
 * rewritten once on the way back out. That rewrite is a Pipeline-level rule, and
 * 085 pins it where it belongs; a Workflow fixture that tripped it would fail
 * these byte assertions for a reason that has nothing to do with the graph.
 */
const AUTHORING = pipeline(
  'spec-authoring',
  'Spec Authoring',
  2,
  ['draft'],
  [{ portId: 'brief', label: 'Brief', type: 'text', required: true }],
  [
    { portId: 'spec', label: 'Spec', type: 'markdown' },
    // The structured output a `node-output` condition operand reads a field from.
    { portId: 'report', label: 'Report', type: 'structured-data' }
  ]
);

const REVIEW = pipeline(
  'spec-review',
  'Spec Review',
  4,
  ['review'],
  [{ portId: 'draft', label: 'Draft', type: 'text', required: true }],
  [
    { portId: 'notes', label: 'Notes', type: 'markdown' },
    { portId: 'verdict', label: 'Verdict', type: 'structured-data' },
    // The collection output, so `file-set` → `local-folder` can demand a rule.
    { portId: 'bundle', label: 'Bundle', type: 'file-set' }
  ]
);

/**
 * The sink, with one input port per outgoing branch below.
 *
 * A port takes exactly one producer, so covering ten connections needs ten
 * distinct targets — which is also why this Pipeline is named by two nodes
 * rather than one (FR-062, asserted directly further down).
 */
const PUBLISH = pipeline(
  'publish',
  'Publish',
  1,
  ['ship'],
  [
    { portId: 'text-in', label: 'Text in', type: 'text', required: true },
    { portId: 'alt-in', label: 'Alt in', type: 'source', required: false },
    { portId: 'folder-in', label: 'Folder in', type: 'local-folder', required: false },
    { portId: 'folder-alt', label: 'Folder alt', type: 'local-folder', required: false },
    { portId: 'list-in', label: 'List in', type: 'source-list', required: false }
  ],
  [{ portId: 'link', label: 'Link', type: 'external-reference' }]
);

const PIPELINES: readonly PipelineDefinition[] = Object.freeze([AUTHORING, REVIEW, PUBLISH]);

/**
 * A label the emitter must write as a block literal.
 *
 * Multi-line, no carriage return, no trailing newline, first line does not open
 * with whitespace — the exact shape `blockLiteralIsLossless` admits. It sits on
 * the third key of a node, i.e. inside a sequence item, which is where a block
 * scalar's indentation is easiest to get wrong in both directions.
 */
const BLOCK_LABEL = 'Review the spec\nthen decide';

const NODES: readonly WorkflowNode[] = Object.freeze([
  Object.freeze({ nodeId: 'author', pipelineId: 'spec-authoring' }),
  Object.freeze({ nodeId: 'gate', pipelineId: 'spec-review', label: BLOCK_LABEL }),
  // FR-062 — two nodes, one Pipeline, distinct identities.
  Object.freeze({ nodeId: 'publish-a', pipelineId: 'publish', label: 'Publish A' }),
  Object.freeze({ nodeId: 'publish-b', pipelineId: 'publish', label: 'Publish B' })
]) as readonly WorkflowNode[];

/**
 * Every enumerated feature of a connection, in one graph that also validates.
 *
 * All eight operators, both operand sources, all three `right` arities (absent,
 * scalar, list), all three selection rules, string / number / boolean literals,
 * `priority` present and absent, `isDefault` in both values. Every conditional
 * branch leaves `gate`, so `anc[gate] ∪ {gate}` is `{author, gate}` and both
 * operand nodes are in scope; every branch lands on a different input port, so
 * no port takes two producers.
 */
const CONNECTIONS: readonly WorkflowConnection[] = Object.freeze([
  // 0 — the only edge into the branching node, and the only unconditional one.
  Object.freeze({
    from: Object.freeze({ nodeId: 'author', portId: 'spec' }),
    to: Object.freeze({ nodeId: 'gate', portId: 'draft' })
  }),
  // 1 — equals, node-output operand, string literal.
  Object.freeze({
    from: Object.freeze({ nodeId: 'gate', portId: 'notes' }),
    to: Object.freeze({ nodeId: 'publish-a', portId: 'text-in' }),
    condition: Object.freeze({
      left: Object.freeze({ source: 'node-output', nodeId: 'author', field: 'report.status' }),
      operator: 'equals',
      right: 'ok'
    }),
    priority: 40
  }),
  // 2 — notEquals, node-status operand, and the explicit non-default.
  Object.freeze({
    from: Object.freeze({ nodeId: 'gate', portId: 'notes' }),
    to: Object.freeze({ nodeId: 'publish-a', portId: 'alt-in' }),
    condition: Object.freeze({
      left: Object.freeze({ source: 'node-status', nodeId: 'author' }),
      operator: 'notEquals',
      right: 'failed'
    }),
    priority: 35,
    isDefault: false
  }),
  // 3 — greaterThan, numeric literal, and `first` on a collection-to-scalar edge.
  Object.freeze({
    from: Object.freeze({ nodeId: 'gate', portId: 'bundle' }),
    to: Object.freeze({ nodeId: 'publish-a', portId: 'folder-in' }),
    condition: Object.freeze({
      left: Object.freeze({ source: 'node-output', nodeId: 'gate', field: 'verdict.score' }),
      operator: 'greaterThan',
      right: 3
    }),
    priority: 30,
    selection: 'first'
  }),
  // 4 — greaterThanOrEqual, a fractional threshold, and `last`.
  Object.freeze({
    from: Object.freeze({ nodeId: 'gate', portId: 'bundle' }),
    to: Object.freeze({ nodeId: 'publish-a', portId: 'folder-alt' }),
    condition: Object.freeze({
      left: Object.freeze({ source: 'node-output', nodeId: 'gate', field: 'verdict.score' }),
      operator: 'greaterThanOrEqual',
      right: 0.75
    }),
    priority: 25,
    selection: 'last'
  }),
  // 5 — in, the list arity, node-status right, and `exactlyOne`.
  Object.freeze({
    from: Object.freeze({ nodeId: 'gate', portId: 'bundle' }),
    to: Object.freeze({ nodeId: 'publish-b', portId: 'folder-in' }),
    condition: Object.freeze({
      left: Object.freeze({ source: 'node-status', nodeId: 'gate' }),
      operator: 'in',
      right: Object.freeze(['completed', 'canceled'])
    }),
    priority: 20,
    selection: 'exactlyOne'
  }),
  // 6 — exists, the absent arity, the single default branch, no priority.
  Object.freeze({
    from: Object.freeze({ nodeId: 'gate', portId: 'bundle' }),
    to: Object.freeze({ nodeId: 'publish-a', portId: 'list-in' }),
    condition: Object.freeze({
      left: Object.freeze({ source: 'node-output', nodeId: 'author', field: 'report.artifact' }),
      operator: 'exists'
    }),
    isDefault: true
  }),
  // 7 — lessThan.
  Object.freeze({
    from: Object.freeze({ nodeId: 'gate', portId: 'notes' }),
    to: Object.freeze({ nodeId: 'publish-b', portId: 'text-in' }),
    condition: Object.freeze({
      left: Object.freeze({ source: 'node-output', nodeId: 'gate', field: 'verdict.score' }),
      operator: 'lessThan',
      right: 9
    }),
    priority: 10
  }),
  // 8 — lessThanOrEqual.
  Object.freeze({
    from: Object.freeze({ nodeId: 'gate', portId: 'notes' }),
    to: Object.freeze({ nodeId: 'publish-b', portId: 'alt-in' }),
    condition: Object.freeze({
      left: Object.freeze({ source: 'node-output', nodeId: 'author', field: 'report.count' }),
      operator: 'lessThanOrEqual',
      right: 7
    }),
    priority: 5
  }),
  // 9 — a boolean literal, which the reader types back from the bare word `true`.
  Object.freeze({
    from: Object.freeze({ nodeId: 'gate', portId: 'bundle' }),
    to: Object.freeze({ nodeId: 'publish-b', portId: 'folder-alt' }),
    condition: Object.freeze({
      left: Object.freeze({ source: 'node-output', nodeId: 'gate', field: 'verdict.ready' }),
      operator: 'equals',
      right: true
    }),
    selection: 'first'
  })
]) as readonly WorkflowConnection[];

const EVERYTHING: WorkflowDefinition = Object.freeze({
  workflowId: 'ship-it',
  name: 'Ship It',
  version: 7,
  description: 'Author, review, publish twice.',
  nodes: NODES,
  connections: CONNECTIONS,
  startNodeIds: Object.freeze(['author'])
}) as WorkflowDefinition;

/** The absent-list end of the rule: one node, no connections, no description. */
const MINIMAL: WorkflowDefinition = Object.freeze({
  workflowId: 'bare',
  name: 'Bare',
  version: 1,
  nodes: Object.freeze([Object.freeze({ nodeId: 'only', pipelineId: 'spec-authoring' })]),
  connections: Object.freeze([]),
  startNodeIds: Object.freeze(['only'])
}) as WorkflowDefinition;

/** Two start ids, in an order that is the documented tie-break rather than a set. */
const TWO_STARTS: WorkflowDefinition = Object.freeze({
  ...MINIMAL,
  workflowId: 'two-starts',
  name: 'Two Starts',
  nodes: Object.freeze([
    Object.freeze({ nodeId: 'second', pipelineId: 'spec-review' }),
    Object.freeze({ nodeId: 'first', pipelineId: 'spec-authoring' })
  ]),
  startNodeIds: Object.freeze(['second', 'first'])
}) as WorkflowDefinition;

/**
 * The smallest graph carrying one condition, so a scalar-typing probe can vary
 * the `right` line of a document the emitter itself wrote.
 */
const PROBE: WorkflowDefinition = Object.freeze({
  workflowId: 'probe',
  name: 'Probe',
  version: 1,
  nodes: Object.freeze([
    Object.freeze({ nodeId: 'src', pipelineId: 'spec-authoring' }),
    Object.freeze({ nodeId: 'dst', pipelineId: 'spec-review' })
  ]),
  connections: Object.freeze([
    Object.freeze({
      from: Object.freeze({ nodeId: 'src', portId: 'spec' }),
      to: Object.freeze({ nodeId: 'dst', portId: 'draft' }),
      condition: Object.freeze({
        left: Object.freeze({ source: 'node-output', nodeId: 'src', field: 'report.score' }),
        operator: 'greaterThan',
        right: 0
      })
    })
  ]),
  startNodeIds: Object.freeze(['src'])
}) as WorkflowDefinition;

interface Fixture {
  readonly label: string;
  readonly definition: WorkflowDefinition;
  readonly mode: Mode;
}

const CORPUS: readonly Fixture[] = Object.freeze([
  { label: 'every field, closure included', definition: EVERYTHING, mode: 'closure' },
  { label: 'every field, pipelines included', definition: EVERYTHING, mode: 'pipelines' },
  { label: 'every field, references only', definition: EVERYTHING, mode: 'references' },
  { label: 'nothing optional, references only', definition: MINIMAL, mode: 'references' },
  { label: 'nothing optional, pipelines included', definition: MINIMAL, mode: 'pipelines' },
  { label: 'nothing optional, closure included', definition: MINIMAL, mode: 'closure' },
  { label: 'two declared starts, closure included', definition: TWO_STARTS, mode: 'closure' }
]);

function documentFor(fixture: Fixture): string {
  return serializeWorkflowDocument(
    documentFromWorkflowDefinition(fixture.definition, inclusionOf(PIPELINES, PHASES, fixture.mode))
  );
}

// ---------------------------------------------------------------------------
// T063 — both directions
// ---------------------------------------------------------------------------

describe('Feature 086 T063 — a document survives being read and written (FR-021)', () => {
  for (const fixture of CORPUS) {
    it(`re-emits '${fixture.label}' byte for byte`, () => {
      const original = documentFor(fixture);
      expect(writePackage(readPackage(original), fixture.mode)).toBe(original);
    });
  }

  it('re-emits a hand-written document, so the corpus is not just self-consistent', () => {
    // Typed out rather than generated. If the emitter's key order, indentation,
    // or block-scalar rule drifted, this fails while a generated corpus would
    // happily agree with the drift.
    const HAND_WRITTEN = [
      'apiVersion: schegent/v1',
      'kind: Workflow',
      'metadata:',
      '  id: hand-written',
      '  name: Hand Written',
      '  description: Typed by a person.',
      '  version: 3',
      'spec:',
      '  nodes:',
      '    - nodeId: one',
      '      pipelineId: spec-authoring',
      '    - nodeId: two',
      '      pipelineId: spec-review',
      '      label: |-',
      '        Review the spec',
      '        then decide',
      '  connections:',
      '    - from:',
      '        nodeId: one',
      '        portId: spec',
      '      to:',
      '        nodeId: two',
      '        portId: draft',
      '      condition:',
      '        left:',
      '          source: node-output',
      '          nodeId: one',
      '          field: report.status',
      '        operator: in',
      '        right:',
      '          - ok',
      '          - fine',
      '      priority: 5',
      '      isDefault: true',
      '  startNodeIds:',
      '    - one',
      'included:',
      '  pipelines:',
      '    - metadata:',
      '        id: spec-authoring',
      '        name: Spec Authoring',
      '        version: 2',
      '      spec:',
      '        phaseIds:',
      '          - draft',
      '        inputs:',
      '          - portId: brief',
      '            label: Brief',
      '            type: text',
      '            required: true',
      '        outputs:',
      '          - portId: spec',
      '            label: Spec',
      '            type: markdown',
      '          - portId: report',
      '            label: Report',
      '            type: structured-data',
      '    - metadata:',
      '        id: spec-review',
      '        name: Spec Review',
      '        version: 4',
      '      spec:',
      '        phaseIds:',
      '          - review',
      '        inputs:',
      '          - portId: draft',
      '            label: Draft',
      '            type: text',
      '            required: true',
      '        outputs:',
      '          - portId: notes',
      '            label: Notes',
      '            type: markdown',
      '  phases:',
      '    - metadata:',
      '        phaseId: draft',
      '        name: Draft',
      '        version: 2',
      '      spec:',
      '        instruction: Draft the spec.',
      '    - metadata:',
      '        phaseId: review',
      '        name: Review',
      '        version: 3',
      '      spec:',
      '        skill: speckit-analyze',
      ''
    ].join('\n');

    expect(writePackage(readPackage(HAND_WRITTEN), 'closure')).toBe(HAND_WRITTEN);
  });

  for (const fixture of CORPUS) {
    it(`reads '${fixture.label}' back to the same definition`, () => {
      const read = readPackage(documentFor(fixture));
      expect(read.workflow).toEqual(fixture.definition);
    });
  }

  it('carries every operator through, not a representative one', () => {
    const read = readPackage(documentFor(CORPUS[0]!));
    const operators = read.workflow.connections.flatMap((connection) =>
      connection.condition === undefined ? [] : [connection.condition.operator]
    );
    expect(new Set(operators)).toEqual(new Set(WORKFLOW_CONDITION_OPERATORS));
  });

  it('carries both operand sources and all three `right` arities', () => {
    const conditions = readPackage(documentFor(CORPUS[0]!))
      .workflow.connections.map((connection) => connection.condition)
      .filter((condition) => condition !== undefined);
    expect(new Set(conditions.map((condition) => condition!.left.source))).toEqual(
      new Set(['node-output', 'node-status'])
    );
    expect(conditions.some((condition) => condition!.right === undefined)).toBe(true);
    expect(conditions.some((condition) => Array.isArray(condition!.right))).toBe(true);
    expect(
      conditions.some(
        (condition) => condition!.right !== undefined && !Array.isArray(condition!.right)
      )
    ).toBe(true);
  });

  it('carries every selection rule through', () => {
    const read = readPackage(documentFor(CORPUS[0]!));
    const rules = read.workflow.connections.flatMap((connection) =>
      connection.selection === undefined ? [] : [connection.selection]
    );
    expect(new Set(rules)).toEqual(new Set(WORKFLOW_SELECTION_RULES));
  });

  it('keeps a literal typed as authored — a number a number, a boolean a boolean', () => {
    // The one place the reader types a scalar. A `right: 3` re-read as `'3'` would
    // make a numeric comparison compare text, and the graph validator would not
    // notice: a string is a legal literal too.
    const read = readPackage(documentFor(CORPUS[0]!));
    const rightOf = (operator: string): unknown =>
      read.workflow.connections.find((connection) => connection.condition?.operator === operator)
        ?.condition?.right;
    expect(rightOf('greaterThan')).toBe(3);
    expect(rightOf('lessThan')).toBe(9);
    expect(rightOf('notEquals')).toBe('failed');
    expect(read.workflow.connections[9]?.condition?.right).toBe(true);
  });

  it('keeps a fractional literal a number, not the text that spells it', () => {
    // `right` is the first field in the format where a number and the string that
    // spells it are BOTH legal values, so a reader that types only integers turns
    // `greaterThanOrEqual 0.75` into a comparison against text — and no validator
    // downstream can tell, because a string literal is legal too.
    const read = readPackage(documentFor(CORPUS[0]!));
    const right = read.workflow.connections[4]?.condition?.right;
    expect(right).toBe(0.75);
    expect(typeof right).toBe('number');
  });

  it('types an unquoted numeric scalar exactly when it writes back unchanged', () => {
    // The rule, stated as the property rather than as a pattern: the reader types
    // a scalar only when the number it would produce re-emits to those same
    // bytes. That makes it the emitter's inverse by construction, so a form the
    // emitter never produces stays text instead of being guessed at.
    const baseline = serializeWorkflowDocument(documentFromWorkflowDefinition(PROBE));
    const conditionRight = (literal: string): unknown => {
      const text = baseline.replace('        right: 0\n', `        right: ${literal}\n`);
      expect(text).not.toBe(baseline);
      const parsed = parseDocumentText(text);
      if (!parsed.ok) throw new Error(`did not parse: ${parsed.refusal.code}`);
      const result = parseWorkflowPackage(parsed.node);
      if (!result.ok) throw new Error(`refused: ${result.refusal.code}`);
      const [root] = result.resources;
      if (root === undefined || !root.ok || root.resourceKind !== 'workflow') {
        throw new Error('root Workflow did not validate');
      }
      return root.definition.connections[0]?.condition?.right;
    };

    // Canonical finite forms type, whether or not they are integers.
    expect(conditionRight('0.75')).toBe(0.75);
    expect(conditionRight('-2.5')).toBe(-2.5);
    expect(conditionRight('1e+30')).toBe(1e30);
    expect(conditionRight('4')).toBe(4);

    // A form the emitter never produces stays the text it was written as, rather
    // than being guessed at: none of these can have been a number on the way out.
    for (const literal of ['1.50', '0x1f', 'NaN', 'Infinity', '1:30']) {
      expect(conditionRight(literal)).toBe(literal);
    }

    // The two exceptions, and they are the integer arm's, not the new one's: a
    // sign-prefixed or zero-padded integer has read as an integer since 084. That
    // is a normalization rather than a loss — the value means what the document
    // said — and what matters is that it converges, which the next case asserts.
    expect(conditionRight('+1')).toBe(1);
    expect(conditionRight('007')).toBe(7);
  });

  it('normalizes a non-canonical integer form once, then is stable', () => {
    const baseline = serializeWorkflowDocument(documentFromWorkflowDefinition(PROBE));
    const authored = baseline.replace('        right: 0\n', '        right: +007\n');
    const once = writePackage(readPackage(authored), 'references');
    expect(once).not.toBe(authored);
    expect(once).toContain('        right: 7\n');
    expect(writePackage(readPackage(once), 'references')).toBe(once);
  });

  it('writes a `|-` label and reads it back unchanged', () => {
    const text = documentFor(CORPUS[0]!);
    expect(text).toContain('      label: |-\n        Review the spec\n        then decide\n');
    const read = readPackage(text);
    expect(read.workflow.nodes[1]?.label).toBe(BLOCK_LABEL);
  });

  it('is stable under repetition — writing twice produces the same bytes', () => {
    // FR-021 is a statement about the value, not about a first render. A cached or
    // mutated intermediate would show up here and nowhere else.
    const once = documentFor(CORPUS[0]!);
    expect(documentFor(CORPUS[0]!)).toBe(once);
    expect(writePackage(readPackage(once), 'closure')).toBe(once);
  });
});

describe('Feature 086 T063 — absent and empty are the same document (research R3)', () => {
  it('writes no key at all for an empty connection list', () => {
    // A bare `connections:` would read back as an empty MAPPING, not an empty
    // list, so the omission is the rule rather than a cosmetic choice.
    const text = documentFor({ label: '', definition: MINIMAL, mode: 'references' });
    expect(text).not.toContain('connections:');
    expect(text).toContain('nodes:');
    expect(text).toContain('startNodeIds:');
  });

  it('reads an omitted connection list back as an empty list', () => {
    const read = readPackage(documentFor({ label: '', definition: MINIMAL, mode: 'references' }));
    expect(read.workflow.connections).toEqual([]);
  });

  it('writes no `included` key for a references-only export (FR-015)', () => {
    const text = documentFor({ label: '', definition: EVERYTHING, mode: 'references' });
    expect(text).not.toContain('included');
  });

  it('writes no `included.phases` key for the middle mode (FR-019)', () => {
    const text = documentFor({ label: '', definition: EVERYTHING, mode: 'pipelines' });
    expect(text).toContain('included:');
    expect(text).toContain('  pipelines:');
    expect(text).not.toContain('  phases:');
    expect(readPackage(text).phases).toEqual([]);
  });

  it('distinguishes an absent optional scalar from an empty one', () => {
    // `description` absent must not become `description: ''` on the way out, and
    // an authored empty string is a value the catalog refuses — so the two cannot
    // be collapsed into one representation.
    const text = documentFor({ label: '', definition: MINIMAL, mode: 'references' });
    expect(text).not.toContain('description');
    expect(readPackage(text).workflow).not.toHaveProperty('description');
  });

  it('derives inclusion from the graph, not from what the caller supplied', () => {
    // MINIMAL names one Pipeline; over-supplying all three cannot widen the
    // document, and the Phase section follows the Pipelines rather than the array.
    const read = readPackage(documentFor({ label: '', definition: MINIMAL, mode: 'closure' }));
    expect(read.pipelines.map((item) => item.pipelineId)).toEqual(['spec-authoring']);
    expect(read.phases.map((item) => item.phaseId)).toEqual(['draft']);
  });

  it('writes a Pipeline named twice exactly once in `included` (FR-020)', () => {
    const read = readPackage(documentFor(CORPUS[0]!));
    expect(read.pipelines.map((item) => item.pipelineId)).toEqual([
      'spec-authoring',
      'spec-review',
      'publish'
    ]);
    expect(read.phases.map((item) => item.phaseId)).toEqual(['draft', 'review', 'ship']);
  });
});

describe('Feature 086 T063 — a declared version is stored exactly as declared (FR-003a)', () => {
  const VERSIONS = [1, 2, 7, 41, 999] as const;

  for (const version of VERSIONS) {
    it(`stores version ${version} unchanged through the loop`, () => {
      const definition = { ...MINIMAL, version } as WorkflowDefinition;
      const read = readPackage(
        serializeWorkflowDocument(
          documentFromWorkflowDefinition(definition, inclusionOf(PIPELINES, PHASES, 'closure'))
        )
      );
      expect(read.workflow.version).toBe(version);
    });
  }

  it('does not renumber an included Pipeline or Phase either', () => {
    // The failure this guards is a real one on the single-resource path: a
    // `create` mutation renumbers to 1, which is why import declares
    // `import-package` instead. Here it would show as a version nobody wrote.
    const read = readPackage(documentFor(CORPUS[0]!));
    expect(read.pipelines.map((item) => item.version)).toEqual([2, 4, 1]);
    expect(read.phases.map((item) => item.version)).toEqual([2, 3, 1]);
  });

  it('refuses a document that declares no version rather than defaulting it', () => {
    // Defaulting is right for a catalog row an operator is editing and wrong on an
    // imported document: it would invent a version the author never wrote and make
    // the round trip lossy.
    const parsed = parseDocumentText(
      [
        'apiVersion: schegent/v1',
        'kind: Workflow',
        'metadata:',
        '  id: no-version',
        '  name: No Version',
        'spec:',
        '  nodes:',
        '    - nodeId: only',
        '      pipelineId: spec-authoring',
        '  startNodeIds:',
        '    - only',
        ''
      ].join('\n')
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = parseWorkflowPackage(parsed.node);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [root] = result.resources;
    expect(root?.ok).toBe(false);
    if (root === undefined || root.ok) return;
    expect(root.defects.map((defect) => `${defect.field}/${defect.code}`)).toContain(
      'version/required'
    );
  });
});

// ---------------------------------------------------------------------------
// T064 — the same claim, but through an actual import
// ---------------------------------------------------------------------------

function phaseRow(definition: PhaseDefinition): Record<string, unknown> {
  const { phaseId, ...rest } = definition;
  return { id: phaseId, ...rest };
}

function pipelineRow(definition: PipelineDefinition): Record<string, unknown> {
  const { pipelineId, phaseIds, ...rest } = definition;
  return { id: pipelineId, phases: [...phaseIds], ...rest };
}

/** No rename: a Workflow row already stores `workflowId`. */
function workflowRow(definition: WorkflowDefinition): Record<string, unknown> {
  return { ...definition };
}

interface Imported {
  readonly workflow: WorkflowDefinition;
  readonly scope: WorkflowDefinitionScope;
  readonly pipelines: readonly PipelineDefinition[];
  readonly phases: readonly PhaseDefinition[];
}

/**
 * Import a package into an empty catalog, then ask the exporter for it back.
 *
 * The catalog starts empty in every layer and receives exactly this document's
 * rows. Whatever the document did NOT carry is what "compatible" means — it is
 * seeded from the fixture constants, standing in for definitions the operator
 * already had; whatever the document DID carry arrives having gone through the
 * document text, which is the half FR-061 is about.
 */
function importAndSelect(read: ReadPackage, mode: Mode): Imported {
  const phases = mode === 'closure' ? read.phases : PHASES;
  const pipelines = mode === 'references' ? PIPELINES : read.pipelines;

  const phaseCatalog = resolvePhaseCatalog({
    builtIn: [],
    user: phases.map(phaseRow),
    workspace: []
  });
  const pipelineCatalog = resolvePipelineCatalog({
    builtIn: [],
    user: pipelines.map(pipelineRow),
    workspace: [],
    phaseCatalog: phaseCatalog.effective
  });
  const selection = selectWorkflowForExport({
    builtIn: [],
    user: [workflowRow(read.workflow)],
    workspace: undefined,
    pipelineCatalog: {
      effective: pipelineCatalog.effective,
      records: pipelineCatalog.records
    },
    workflowId: read.workflow.workflowId
  });
  if (selection.outcome !== 'selected') {
    throw new Error(`not exportable after import: ${selection.reason}`);
  }
  return {
    workflow: selection.definition,
    scope: selection.scope,
    pipelines: pipelineCatalog.effective,
    phases: phaseCatalog.effective
  };
}

describe('Feature 086 T064 — import then re-export is an identity (FR-061, SC-017)', () => {
  for (const fixture of CORPUS) {
    it(`re-exports '${fixture.label}' to the same bytes`, () => {
      // Verified by comparison, not inspection: the definition the catalog
      // resolved after the import is substituted into the same document the
      // export wrote, and the bytes must not move. Dependency-level default
      // materialization is a Pipeline/Phase rule that 084 and 085 pin, so the
      // document's own dependency sections are reused here and the Workflow half
      // is what varies.
      const original = documentFor(fixture);
      const read = readPackage(original);
      const imported = importAndSelect(read, fixture.mode);
      expect(writePackage({ ...read, workflow: imported.workflow }, fixture.mode)).toBe(original);
    });
  }

  for (const fixture of CORPUS) {
    it(`re-exports '${fixture.label}' to the same definition`, () => {
      const imported = importAndSelect(readPackage(documentFor(fixture)), fixture.mode);
      expect(imported.workflow).toEqual(fixture.definition);
      expect(imported.scope).toBe('user');
    });
  }

  for (const fixture of CORPUS) {
    it(`re-exports '${fixture.label}' from catalog-resolved dependencies to a fixed point`, () => {
      // The whole document this time, dependency sections included, rebuilt from
      // the resolved catalog rather than from the text it came out of. The claim
      // here is convergence: whatever normalization a layer applies, it applies
      // once.
      const imported = importAndSelect(readPackage(documentFor(fixture)), fixture.mode);
      const once = serializeWorkflowDocument(
        documentFromWorkflowDefinition(
          imported.workflow,
          inclusionOf(imported.pipelines, imported.phases, fixture.mode)
        )
      );
      expect(writePackage(readPackage(once), fixture.mode)).toBe(once);
    });
  }

  it('preserves every property FR-061 enumerates, field by field', () => {
    const imported = importAndSelect(readPackage(documentFor(CORPUS[0]!)), 'closure');
    const round = imported.workflow;

    // node identities and their Pipeline references
    expect(round.nodes.map((node) => node.nodeId)).toEqual(
      EVERYTHING.nodes.map((node) => node.nodeId)
    );
    expect(round.nodes.map((node) => node.pipelineId)).toEqual(
      EVERYTHING.nodes.map((node) => node.pipelineId)
    );
    expect(round.nodes.map((node) => node.label)).toEqual(
      EVERYTHING.nodes.map((node) => node.label)
    );

    // port-to-port connections
    const endpoints = (definition: WorkflowDefinition) =>
      definition.connections.map(
        (connection) =>
          `${connection.from.nodeId}.${connection.from.portId}->${connection.to.nodeId}.${connection.to.portId}`
      );
    expect(endpoints(round)).toEqual(endpoints(EVERYTHING));

    // conditions, priorities, default markers, selection rules
    expect(round.connections.map((connection) => connection.condition)).toEqual(
      EVERYTHING.connections.map((connection) => connection.condition)
    );
    expect(round.connections.map((connection) => connection.priority)).toEqual(
      EVERYTHING.connections.map((connection) => connection.priority)
    );
    expect(round.connections.map((connection) => connection.isDefault)).toEqual(
      EVERYTHING.connections.map((connection) => connection.isDefault)
    );
    expect(round.connections.map((connection) => connection.selection)).toEqual(
      EVERYTHING.connections.map((connection) => connection.selection)
    );

    // allowed starts and the declared version
    expect(round.startNodeIds).toEqual(EVERYTHING.startNodeIds);
    expect(round.version).toBe(EVERYTHING.version);
  });

  it('keeps `isDefault: false` distinct from an absent marker', () => {
    // The value most easily lost, because `false` and absent behave identically at
    // run time — and differ the moment an operator opens the row to edit it.
    const imported = importAndSelect(readPackage(documentFor(CORPUS[0]!)), 'closure');
    expect(imported.workflow.connections[2]?.isDefault).toBe(false);
    expect(imported.workflow.connections[6]?.isDefault).toBe(true);
    expect(imported.workflow.connections[0]).not.toHaveProperty('isDefault');
  });
});

// ---------------------------------------------------------------------------
// T065 — two nodes on one Pipeline, and authored order
// ---------------------------------------------------------------------------

describe('Feature 086 T065 — one Pipeline, two nodes (FR-062)', () => {
  it('keeps two nodes naming the same Pipeline as two distinct nodes', () => {
    const imported = importAndSelect(readPackage(documentFor(CORPUS[0]!)), 'closure');
    const onPublish = imported.workflow.nodes.filter((node) => node.pipelineId === 'publish');
    expect(onPublish.map((node) => node.nodeId)).toEqual(['publish-a', 'publish-b']);
    expect(onPublish.map((node) => node.label)).toEqual(['Publish A', 'Publish B']);
  });

  it('keeps their connections addressed to the right one of the two', () => {
    // The failure this guards is a collapse to one node, which would not lose a
    // connection — it would silently retarget one branch onto the other node.
    const imported = importAndSelect(readPackage(documentFor(CORPUS[0]!)), 'closure');
    const targets = imported.workflow.connections
      .filter((connection) => connection.to.nodeId.startsWith('publish-'))
      .map((connection) => `${connection.to.nodeId}.${connection.to.portId}`);
    expect(targets).toEqual([
      'publish-a.text-in',
      'publish-a.alt-in',
      'publish-a.folder-in',
      'publish-a.folder-alt',
      'publish-b.folder-in',
      'publish-a.list-in',
      'publish-b.text-in',
      'publish-b.alt-in',
      'publish-b.folder-alt'
    ]);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it('writes the shared Pipeline once while both nodes keep naming it', () => {
    const read = readPackage(documentFor(CORPUS[0]!));
    const text = documentFor(CORPUS[0]!);
    expect(read.pipelines.filter((item) => item.pipelineId === 'publish')).toHaveLength(1);
    expect(text.match(/pipelineId: publish$/gm)).toHaveLength(2);
  });
});

describe('Feature 086 T065 — authored order survives, because it is the tie-break (FR-063)', () => {
  it('keeps node order as authored rather than sorted', () => {
    // `publish-a` before `publish-b` is alphabetical by accident; TWO_STARTS below
    // is the fixture where sorted and authored disagree.
    const imported = importAndSelect(readPackage(documentFor(CORPUS[0]!)), 'closure');
    expect(imported.workflow.nodes.map((node) => node.nodeId)).toEqual([
      'author',
      'gate',
      'publish-a',
      'publish-b'
    ]);
  });

  it('keeps a deliberately unsorted node and start order', () => {
    const fixture: Fixture = { label: '', definition: TWO_STARTS, mode: 'closure' };
    const imported = importAndSelect(readPackage(documentFor(fixture)), 'closure');
    expect(imported.workflow.nodes.map((node) => node.nodeId)).toEqual(['second', 'first']);
    expect(imported.workflow.startNodeIds).toEqual(['second', 'first']);
    // Not the sorted order, which is what a set-valued round trip would produce.
    expect(imported.workflow.startNodeIds).not.toEqual(['first', 'second']);
  });

  it('keeps connection order as authored, which decides equal priorities', () => {
    const imported = importAndSelect(readPackage(documentFor(CORPUS[0]!)), 'closure');
    expect(imported.workflow.connections.map((connection) => connection.priority)).toEqual([
      undefined,
      40,
      35,
      30,
      25,
      20,
      undefined,
      10,
      5,
      undefined
    ]);
  });

  it('keeps two equal-priority branches in the order they were authored', () => {
    // Order is load-bearing only where priorities tie, so the fixture ties them.
    const TIED: WorkflowDefinition = Object.freeze({
      ...EVERYTHING,
      workflowId: 'tied',
      name: 'Tied',
      connections: Object.freeze(
        CONNECTIONS.map((connection, index) =>
          index === 0 ? connection : Object.freeze({ ...connection, priority: 10 })
        )
      )
    }) as WorkflowDefinition;

    const fixture: Fixture = { label: '', definition: TIED, mode: 'closure' };
    const imported = importAndSelect(readPackage(documentFor(fixture)), 'closure');
    expect(
      imported.workflow.connections.map(
        (connection) => `${connection.to.nodeId}.${connection.to.portId}`
      )
    ).toEqual(
      TIED.connections.map((connection) => `${connection.to.nodeId}.${connection.to.portId}`)
    );
  });
});

// ---------------------------------------------------------------------------
// T066 — a condition is data, and nothing on this path executes it
// ---------------------------------------------------------------------------

describe('Feature 086 T066 — a condition survives intact (FR-006, SC-021)', () => {
  it('keeps every operand, operator, and literal', () => {
    const imported = importAndSelect(readPackage(documentFor(CORPUS[0]!)), 'closure');
    for (const [index, connection] of imported.workflow.connections.entries()) {
      expect(connection.condition).toEqual(EVERYTHING.connections[index]?.condition);
    }
  });

  it('keeps a list literal a list of the same length and order', () => {
    const imported = importAndSelect(readPackage(documentFor(CORPUS[0]!)), 'closure');
    expect(imported.workflow.connections[5]?.condition?.right).toEqual(['completed', 'canceled']);
  });

  it('leaves `exists` with no right operand rather than a falsy one', () => {
    // A reader that materialized `right: null` or `right: ''` would turn the
    // absent arity into a comparison against nothing.
    const imported = importAndSelect(readPackage(documentFor(CORPUS[0]!)), 'closure');
    const condition = imported.workflow.connections[6]?.condition;
    expect(condition?.operator).toBe('exists');
    expect(condition).not.toHaveProperty('right');
  });

  it('emits a condition as three keys of structured data, never as an expression', () => {
    // What a string form would look like in the bytes. The document must carry
    // the operator as its own key, not embedded in a sentence to be parsed back.
    const text = documentFor(CORPUS[0]!);
    expect(text).toContain('      condition:\n        left:\n          source: node-output\n');
    expect(text).toContain('        operator: equals\n');
    // Nothing shares the `condition:` line — a string form would have to.
    expect(text).not.toMatch(/condition:[ \t]*\S/);
  });
});

/**
 * The exchange-path modules that see a condition. `workflow-document.ts` maps and
 * classifies it, `workflow-export-closure.ts` walks the graph it hangs off,
 * `workflow-export-selection.ts` resolves the Workflow that carries it,
 * `yaml-serializer.ts` writes it, and `package-reader.ts` reads it back.
 */
const CONDITION_MODULES = [
  'src/services/process-yaml/workflow-document.ts',
  'src/services/process-yaml/workflow-export-closure.ts',
  'src/services/process-yaml/workflow-export-selection.ts',
  'src/services/process-yaml/yaml-serializer.ts',
  'src/services/process-yaml/package-reader.ts'
] as const;

const REPO_ROOT = resolvePath(__dirname, '..', '..', '..');

function moduleSource(relativePath: string): string {
  return readFileSync(resolvePath(REPO_ROOT, relativePath), 'utf8');
}

function importSpecifiers(source: string): string[] {
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];
  const specifiers: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

const isProjectRelative = (specifier: string): boolean => specifier.startsWith('.');

const FORBIDDEN_CONSTRUCTS = [
  { label: 'eval', pattern: /\beval\s*\(/, sample: 'eval(authored)' },
  { label: 'the Function constructor', pattern: /\bFunction\s*\(/, sample: 'new Function(src)' },
  { label: 'constructor access', pattern: /\.constructor\b/, sample: 'x.constructor("y")' },
  { label: 'dynamic import', pattern: /(^|[^.\w])import\s*\(/, sample: 'await import(name)' },
  { label: 'require', pattern: /\brequire\s*\(/, sample: "require('jsonata')" },
  { label: 'the vm module', pattern: /\bnode:vm\b|['"]vm['"]/, sample: "import 'node:vm'" }
] as const;

describe('Feature 086 T066 — no code path can execute a condition (FR-006, SC-021)', () => {
  it.each(CONDITION_MODULES)('finds the imports it is meant to inspect in %s', (relativePath) => {
    // The vacuity guard for the check below: a module the scanner cannot read, or
    // a specifier pattern that stopped matching, would make "imports only
    // relative project modules" pass by finding nothing at all.
    const specifiers = importSpecifiers(moduleSource(relativePath));
    expect(specifiers.length).toBeGreaterThan(0);
  });

  it.each(CONDITION_MODULES)('%s imports only relative project modules', (relativePath) => {
    // A parser or expression evaluator would arrive as a dependency. Refusing
    // every non-relative specifier makes that visible without maintaining a
    // denylist of library names.
    const foreign = importSpecifiers(moduleSource(relativePath)).filter(
      (specifier) => !isProjectRelative(specifier)
    );
    expect(foreign).toEqual([]);
  });

  it.each(CONDITION_MODULES)('%s contains no way to execute authored text', (relativePath) => {
    const source = moduleSource(relativePath);
    const found = FORBIDDEN_CONSTRUCTS.filter((construct) => construct.pattern.test(source)).map(
      (construct) => construct.label
    );
    expect(found).toEqual([]);
  });

  it.each(FORBIDDEN_CONSTRUCTS)(
    'the $label matcher recognizes its own construct',
    ({ pattern, sample }) => {
      // The negative control: a typo in a pattern above would make the scan
      // vacuously true, and this is the only thing that would notice.
      expect(pattern.test(sample)).toBe(true);
    }
  );

  it('treats an expression library as foreign and a project module as project', () => {
    // The other half of the control: the relative-import rule has to actually
    // reject the specifiers it exists to reject.
    for (const specifier of [
      'jsonata',
      'expr-eval',
      'handlebars',
      'nunjucks',
      'jexl',
      'acorn',
      'node:vm',
      'mathjs'
    ]) {
      expect(isProjectRelative(specifier)).toBe(false);
    }
    for (const specifier of [
      './workflow-export-closure',
      '../../contracts/workflow-definitions',
      './yaml-serializer'
    ]) {
      expect(isProjectRelative(specifier)).toBe(true);
    }
  });
});
