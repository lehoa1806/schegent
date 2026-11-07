// Feature 086 T063-T066 / Feature 263 (FR-R5-F04) — a round trip preserves graph semantics.
//
// Three properties, and they fail differently, which is why all three are here:
//
//   text  -> resources -> text     must be byte-identical (T063). Catches a reader
//                                  that drops a field the writer emits, and a
//                                  writer whose key order or scalar style is not a
//                                  function of the value alone.
//   value -> text      -> value    must be deeply equal (T063). Catches the
//                                  opposite: a writer that emits something the
//                                  reader reads back as a DIFFERENT value — a
//                                  `right: 3` re-typed to `"3"`, an omitted list
//                                  read as absent rather than empty, a priority
//                                  renumbered.
//   document -> catalog -> document must round-trip through an actual import
//                                  (T064). The two properties above are internal to
//                                  `workflow-document.ts`; this one puts the
//                                  catalog validators, the precedence resolver, and
//                                  the export selector in the loop, which is what
//                                  FR-061 actually claims.

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FIXTURE_REVISION } from '../../fixtures/catalog-snapshot-fixture';

import { resolveWorkflowCatalog } from '../../../src/config/workflow-catalog';
import { resolvePhaseCatalog } from '../../../src/config/process-catalog';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import type {
  WorkflowConnection,
  WorkflowDefinition,
  WorkflowInputPort,
  WorkflowNode,
  WorkflowOutputPort
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
 * Which dependency levels a document carries (FR-015, FR-019, FR-R5-F04).
 *
 * Two legal answers under F04: `references` (`references-only`) and `closure`
 * (`include-closure`, carrying both `included.workflows` and `included.phases`).
 */
type Mode = 'references' | 'closure';

interface ReadPackage {
  readonly workflow: WorkflowDefinition;
  readonly workflows: readonly WorkflowDefinition[];
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
  const workflows: WorkflowDefinition[] = [];
  const phases: PhaseDefinition[] = [];
  for (const resource of result.resources) {
    if (!resource.ok) {
      throw new Error(
        `invalid ${resource.resourceKind} ${resource.resourceId ?? '<no id>'}: ` +
          resource.defects.map((defect) => `${defect.field}/${defect.code}`).join(', ')
      );
    }
    if (resource.resourceKind === 'workflow') {
      if (workflow === null) workflow = resource.definition;
      else workflows.push(resource.definition);
    } else {
      phases.push(phaseDefinitionFromDocument(resource.document));
    }
  }
  if (workflow === null) throw new Error('no root Workflow in the document');
  return { workflow, workflows, phases };
}

/** The inclusion a mode asks for, built from whatever the document itself carried. */
function inclusionOf(
  workflows: readonly WorkflowDefinition[],
  phases: readonly PhaseDefinition[],
  mode: Mode
): WorkflowInclusion | undefined {
  if (mode === 'references') return undefined;
  return { workflows, phases };
}

/** Write what was read, with the same inclusion choice the document made. */
function writePackage(read: ReadPackage, mode: Mode): string {
  return serializeWorkflowDocument(
    documentFromWorkflowDefinition(read.workflow, inclusionOf(read.workflows, read.phases, mode))
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

function childWorkflow(
  workflowId: string,
  name: string,
  version: number,
  phaseId: string,
  inputs: readonly WorkflowInputPort[],
  outputs: readonly WorkflowOutputPort[]
): WorkflowDefinition {
  return Object.freeze({
    workflowId,
    name,
    version,
    ...(inputs.length > 0 ? { inputs: Object.freeze([...inputs]) } : {}),
    ...(outputs.length > 0 ? { outputs: Object.freeze([...outputs]) } : {}),
    nodes: Object.freeze([Object.freeze({ nodeId: 'step', kind: 'phase', phaseId })]),
    connections: Object.freeze([]),
    startNodeIds: Object.freeze(['step'])
  }) as WorkflowDefinition;
}

const AUTHORING = childWorkflow(
  'spec-authoring',
  'Spec Authoring',
  2,
  'draft',
  [{ portId: 'brief', label: 'Brief', type: 'text', required: false }],
  [
    { portId: 'spec', label: 'Spec', type: 'markdown', required: false },
    { portId: 'report', label: 'Report', type: 'structured-data', required: false }
  ]
);

const REVIEW = childWorkflow(
  'spec-review',
  'Spec Review',
  4,
  'review',
  [{ portId: 'draft', label: 'Draft', type: 'text', required: false }],
  [
    { portId: 'notes', label: 'Notes', type: 'markdown', required: false },
    { portId: 'verdict', label: 'Verdict', type: 'structured-data', required: false },
    { portId: 'bundle', label: 'Bundle', type: 'file-set', required: false }
  ]
);

const PUBLISH = childWorkflow(
  'publish',
  'Publish',
  1,
  'ship',
  [
    { portId: 'text-in', label: 'Text in', type: 'text', required: false },
    { portId: 'alt-in', label: 'Alt in', type: 'source', required: false },
    { portId: 'folder-in', label: 'Folder in', type: 'local-folder', required: false },
    { portId: 'folder-alt', label: 'Folder alt', type: 'local-folder', required: false },
    { portId: 'list-in', label: 'List in', type: 'source-list', required: false }
  ],
  [{ portId: 'link', label: 'Link', type: 'external-reference', required: false }]
);

/** Grandchild and child for 3-level nested Workflow closure verification (FR-R5-F04). */
const LEAF_WORKFLOW: WorkflowDefinition = Object.freeze({
  workflowId: 'leaf-flow',
  name: 'Leaf Flow',
  version: 1,
  outputs: Object.freeze([{ portId: 'leaf-out', label: 'Leaf Out', type: 'markdown', required: false }]),
  nodes: Object.freeze([Object.freeze({ nodeId: 'step', kind: 'phase', phaseId: 'draft' })]),
  connections: Object.freeze([]),
  startNodeIds: Object.freeze(['step'])
}) as WorkflowDefinition;

const MID_WORKFLOW: WorkflowDefinition = Object.freeze({
  workflowId: 'mid-flow',
  name: 'Mid Flow',
  version: 2,
  outputs: Object.freeze([{ portId: 'mid-out', label: 'Mid Out', type: 'markdown' }]),
  nodes: Object.freeze([
    Object.freeze({ nodeId: 'leaf', kind: 'workflow', workflowId: 'leaf-flow' }),
    Object.freeze({ nodeId: 'check', kind: 'phase', phaseId: 'review' })
  ]),
  connections: Object.freeze([
    Object.freeze({
      from: Object.freeze({ nodeId: 'leaf', portId: 'leaf-out' }),
      to: Object.freeze({ nodeId: 'check' })
    })
  ]),
  bindings: Object.freeze([
    Object.freeze({
      kind: 'output',
      portId: 'mid-out',
      nodeId: 'leaf',
      sourcePortId: 'leaf-out'
    })
  ]),
  startNodeIds: Object.freeze(['leaf'])
}) as WorkflowDefinition;

const CHILD_WORKFLOWS: readonly WorkflowDefinition[] = Object.freeze([
  AUTHORING,
  REVIEW,
  PUBLISH,
  MID_WORKFLOW,
  LEAF_WORKFLOW
]);

const BLOCK_LABEL = 'Review the spec\nthen decide';

const NODES: readonly WorkflowNode[] = Object.freeze([
  Object.freeze({ nodeId: 'author', kind: 'workflow', workflowId: 'spec-authoring' }),
  Object.freeze({
    nodeId: 'gate',
    kind: 'workflow',
    workflowId: 'spec-review',
    label: BLOCK_LABEL
  }),
  // FR-062 — two nodes, one child Workflow, distinct identities.
  Object.freeze({
    nodeId: 'publish-a',
    kind: 'workflow',
    workflowId: 'publish',
    label: 'Publish A'
  }),
  Object.freeze({
    nodeId: 'publish-b',
    kind: 'workflow',
    workflowId: 'publish',
    label: 'Publish B'
  })
]) as readonly WorkflowNode[];

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

const TEXT_REPLACEMENTS: Readonly<
  Partial<Record<number, { operator: 'equals' | 'notEquals'; right: string }>>
> = {
  3: { operator: 'equals', right: 'high' },
  4: { operator: 'notEquals', right: 'low' },
  7: { operator: 'equals', right: 'nine' },
  8: { operator: 'notEquals', right: 'seven' },
  9: { operator: 'equals', right: 'ready' }
};

const IMPORTABLE: WorkflowDefinition = Object.freeze({
  workflowId: 'ship-it',
  name: 'Ship It',
  version: 7,
  description: 'Author, review, publish twice.',
  nodes: NODES,
  connections: Object.freeze(
    CONNECTIONS.map((connection, index) => {
      const replacement = TEXT_REPLACEMENTS[index];
      if (replacement === undefined) return connection;
      return Object.freeze({
        ...connection,
        condition: Object.freeze({ ...connection.condition, ...replacement })
      }) as WorkflowConnection;
    })
  ),
  startNodeIds: Object.freeze(['author'])
}) as WorkflowDefinition;

/** The absent-list end of the rule: one node, no connections, no description. */
const MINIMAL: WorkflowDefinition = Object.freeze({
  workflowId: 'bare',
  name: 'Bare',
  version: 1,
  nodes: Object.freeze([
    Object.freeze({ nodeId: 'only', kind: 'workflow', workflowId: 'spec-authoring' })
  ]),
  connections: Object.freeze([]),
  startNodeIds: Object.freeze(['only'])
}) as WorkflowDefinition;

/** Two start ids, in an order that is the documented tie-break rather than a set. */
const TWO_STARTS: WorkflowDefinition = Object.freeze({
  ...MINIMAL,
  workflowId: 'two-starts',
  name: 'Two Starts',
  nodes: Object.freeze([
    Object.freeze({ nodeId: 'second', kind: 'workflow', workflowId: 'spec-review' }),
    Object.freeze({ nodeId: 'first', kind: 'workflow', workflowId: 'spec-authoring' })
  ]),
  startNodeIds: Object.freeze(['second', 'first'])
}) as WorkflowDefinition;

/**
 * 3-level nested composable Workflow with inputs, outputs, bindings, handoff,
 * return endpoint, executionDefaults, and recommendedNext (FR-R5-F04).
 */
const THREE_LEVEL: WorkflowDefinition = Object.freeze({
  workflowId: 'three-level-root',
  name: 'Three Level Root',
  version: 4,
  description: 'Three-level composable Workflow.',
  inputs: Object.freeze([
    Object.freeze({
      portId: 'prompt',
      label: 'Prompt',
      type: 'text',
      required: true,
      description: 'Top-level prompt.'
    })
  ]),
  outputs: Object.freeze([
    Object.freeze({
      portId: 'final-doc',
      label: 'Final Doc',
      type: 'markdown',
      required: true,
      description: 'Published markdown.'
    })
  ]),
  nodes: Object.freeze([
    Object.freeze({ nodeId: 'mid', kind: 'workflow', workflowId: 'mid-flow' }),
    Object.freeze({ nodeId: 'ship-node', kind: 'phase', phaseId: 'ship' })
  ]),
  connections: Object.freeze([
    Object.freeze({
      from: Object.freeze({ nodeId: 'mid', portId: 'mid-out' }),
      to: Object.freeze({ nodeId: 'ship-node' }),
      handoff: 'auto'
    }),
    Object.freeze({
      from: Object.freeze({ nodeId: 'ship-node' }),
      to: Object.freeze({ nodeId: 'return', kind: 'return' })
    })
  ]),
  bindings: Object.freeze([
    Object.freeze({
      kind: 'input',
      nodeId: 'ship-node',
      inputKey: 'prompt',
      type: 'text',
      required: true,
      source: Object.freeze({ from: 'workflow-input', portId: 'prompt' })
    }),
    Object.freeze({
      kind: 'output',
      portId: 'final-doc',
      nodeId: 'mid',
      sourcePortId: 'mid-out',
      label: 'Final Doc Output'
    })
  ]),
  startNodeIds: Object.freeze(['mid']),
  executionDefaults: Object.freeze({
    runner: 'claude',
    model: 'sonnet',
    effort: 'medium',
    timeoutSeconds: 600
  }),
  recommendedNext: Object.freeze(['ship-it'])
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
    Object.freeze({ nodeId: 'src', kind: 'workflow', workflowId: 'spec-authoring' }),
    Object.freeze({ nodeId: 'dst', kind: 'workflow', workflowId: 'spec-review' })
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
  { label: 'every field, references only', definition: EVERYTHING, mode: 'references' },
  { label: 'nothing optional, references only', definition: MINIMAL, mode: 'references' },
  { label: 'nothing optional, closure included', definition: MINIMAL, mode: 'closure' },
  { label: 'two declared starts, closure included', definition: TWO_STARTS, mode: 'closure' },
  { label: 'three-level nesting with composable fields', definition: THREE_LEVEL, mode: 'closure' }
]);

const IMPORT_CORPUS: readonly Fixture[] = Object.freeze(
  CORPUS.map((fixture) =>
    fixture.definition === EVERYTHING ? { ...fixture, definition: IMPORTABLE } : fixture
  )
);

function documentFor(fixture: Fixture): string {
  return serializeWorkflowDocument(
    documentFromWorkflowDefinition(
      fixture.definition,
      inclusionOf(CHILD_WORKFLOWS, PHASES, fixture.mode)
    )
  );
}

// ---------------------------------------------------------------------------
// T063 — both directions
// ---------------------------------------------------------------------------

describe('Feature 086 T063 / Feature 263 — a document survives being read and written (FR-021)', () => {
  for (const fixture of CORPUS) {
    it(`re-emits '${fixture.label}' byte for byte`, () => {
      const original = documentFor(fixture);
      expect(writePackage(readPackage(original), fixture.mode)).toBe(original);
    });
  }

  it('re-emits a hand-written document, so the corpus is not just self-consistent', () => {
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
      '      kind: workflow',
      '      workflowId: spec-authoring',
      '    - nodeId: two',
      '      kind: workflow',
      '      workflowId: spec-review',
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
      '  workflows:',
      '    - metadata:',
      '        id: spec-authoring',
      '        name: Spec Authoring',
      '        version: 2',
      '      spec:',
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
      '        nodes:',
      '          - nodeId: step',
      '            kind: phase',
      '            phaseId: draft',
      '        startNodeIds:',
      '          - step',
      '    - metadata:',
      '        id: spec-review',
      '        name: Spec Review',
      '        version: 4',
      '      spec:',
      '        inputs:',
      '          - portId: draft',
      '            label: Draft',
      '            type: text',
      '            required: true',
      '        outputs:',
      '          - portId: notes',
      '            label: Notes',
      '            type: markdown',
      '        nodes:',
      '          - nodeId: step',
      '            kind: phase',
      '            phaseId: review',
      '        startNodeIds:',
      '          - step',
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
    const read = readPackage(documentFor(CORPUS[0]!));
    const right = read.workflow.connections[4]?.condition?.right;
    expect(right).toBe(0.75);
    expect(typeof right).toBe('number');
  });

  it('types an unquoted numeric scalar exactly when it writes back unchanged', () => {
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

    expect(conditionRight('0.75')).toBe(0.75);
    expect(conditionRight('-2.5')).toBe(-2.5);
    expect(conditionRight('1e+30')).toBe(1e30);
    expect(conditionRight('4')).toBe(4);

    for (const literal of ['1.50', '0x1f', 'NaN', 'Infinity', '1:30']) {
      expect(conditionRight(literal)).toBe(literal);
    }

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
    const once = documentFor(CORPUS[0]!);
    expect(documentFor(CORPUS[0]!)).toBe(once);
    expect(writePackage(readPackage(once), 'closure')).toBe(once);
  });
});

describe('Feature 086 T063 / Feature 263 — absent and empty are the same document (research R3)', () => {
  it('writes no key at all for an empty connection list', () => {
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

  it('distinguishes an absent optional scalar from an empty one', () => {
    const text = documentFor({ label: '', definition: MINIMAL, mode: 'references' });
    expect(text).not.toContain('description');
    expect(readPackage(text).workflow).not.toHaveProperty('description'); // 2026-09-06 coincidental: a parsed workflow definition, not the CmdStart IPC command
  });

  it('derives inclusion from the graph, not from what the caller supplied', () => {
    const read = readPackage(documentFor({ label: '', definition: MINIMAL, mode: 'closure' }));
    expect(read.workflows.map((item) => item.workflowId)).toEqual(['spec-authoring']);
    expect(read.phases.map((item) => item.phaseId)).toEqual(['draft']);
  });

  it('emits 3-level nested child Workflows in pre-order depth-first order and Phases in first-encountered order', () => {
    const read = readPackage(documentFor({ label: '', definition: THREE_LEVEL, mode: 'closure' }));
    expect(read.workflows.map((item) => item.workflowId)).toEqual(['mid-flow', 'leaf-flow']);
    // THREE_LEVEL directly references `ship`; `mid-flow` references `review`; `leaf-flow` references `draft`
    expect(read.phases.map((item) => item.phaseId)).toEqual(['ship', 'review', 'draft']);
  });

  it('writes a child Workflow named twice exactly once in `included` (FR-020)', () => {
    const read = readPackage(documentFor(CORPUS[0]!));
    expect(read.workflows.map((item) => item.workflowId)).toEqual([
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
          documentFromWorkflowDefinition(
            definition,
            inclusionOf(CHILD_WORKFLOWS, PHASES, 'closure')
          )
        )
      );
      expect(read.workflow.version).toBe(version);
    });
  }

  it('does not renumber an included child Workflow or Phase either', () => {
    const read = readPackage(documentFor(CORPUS[0]!));
    expect(read.workflows.map((item) => item.version)).toEqual([2, 4, 1]);
    expect(read.phases.map((item) => item.version)).toEqual([2, 3, 1]);
  });

  it('refuses a document that declares no version rather than defaulting it', () => {
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
        '      kind: workflow',
        '      workflowId: spec-authoring',
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

/** No rename: a Workflow row already stores `workflowId`. */
function workflowRow(definition: WorkflowDefinition): Record<string, unknown> {
  return { ...definition };
}

interface Imported {
  readonly workflow: WorkflowDefinition;
  readonly workflows: readonly WorkflowDefinition[];
  readonly phases: readonly PhaseDefinition[];
}

/**
 * Import a package into an empty catalog, then ask the exporter for it back.
 */
function importAndSelect(read: ReadPackage, mode: Mode): Imported {
  const phases = mode === 'closure' ? read.phases : PHASES;
  const childWorkflows = mode === 'references' ? CHILD_WORKFLOWS : read.workflows;

  const phaseCatalog = resolvePhaseCatalog({
    rows: phases.map(phaseRow),
    revision: FIXTURE_REVISION
  });
  const workflowRows = [
    ...childWorkflows.map(workflowRow),
    workflowRow(read.workflow)
  ];
  const workflowCatalog = resolveWorkflowCatalog({
    rows: workflowRows,
    revision: FIXTURE_REVISION,
    phaseCatalog: {
      effective: phaseCatalog.effective,
      records: phaseCatalog.records
    }
  });
  const selection = selectWorkflowForExport({
    rows: workflowRows,
    phaseCatalog: {
      effective: phaseCatalog.effective,
      records: phaseCatalog.records
    },
    workflowId: read.workflow.workflowId
  });
  if (selection.outcome !== 'selected') {
    throw new Error(`not exportable after import: ${selection.reason}`);
  }
  return {
    workflow: selection.definition,
    workflows: workflowCatalog.effective.filter(
      (wf) => wf.workflowId !== read.workflow.workflowId
    ),
    phases: phaseCatalog.effective
  };
}

describe('Feature 086 T064 / Feature 263 — import then re-export is an identity (FR-061, SC-017)', () => {
  for (const fixture of IMPORT_CORPUS) {
    it(`re-exports '${fixture.label}' to the same bytes`, () => {
      const original = documentFor(fixture);
      const read = readPackage(original);
      const imported = importAndSelect(read, fixture.mode);
      expect(writePackage({ ...read, workflow: imported.workflow }, fixture.mode)).toBe(original);
    });
  }

  for (const fixture of IMPORT_CORPUS) {
    it(`re-exports '${fixture.label}' to the same definition`, () => {
      const imported = importAndSelect(readPackage(documentFor(fixture)), fixture.mode);
      expect(imported.workflow).toEqual(fixture.definition);
    });
  }

  for (const fixture of IMPORT_CORPUS) {
    it(`re-exports '${fixture.label}' from catalog-resolved dependencies to a fixed point`, () => {
      const imported = importAndSelect(readPackage(documentFor(fixture)), fixture.mode);
      const once = serializeWorkflowDocument(
        documentFromWorkflowDefinition(
          imported.workflow,
          inclusionOf(imported.workflows, imported.phases, fixture.mode)
        )
      );
      expect(writePackage(readPackage(once), fixture.mode)).toBe(once);
    });
  }

  it('preserves every property FR-061 enumerates, field by field', () => {
    const imported = importAndSelect(readPackage(documentFor(IMPORT_CORPUS[0]!)), 'closure');
    const round = imported.workflow;

    expect(round.nodes.map((node) => node.nodeId)).toEqual(
      IMPORTABLE.nodes.map((node) => node.nodeId)
    );
    expect(round.nodes.map((node) => node.workflowId)).toEqual(
      IMPORTABLE.nodes.map((node) => node.workflowId)
    );
    expect(round.nodes.map((node) => node.label)).toEqual(
      IMPORTABLE.nodes.map((node) => node.label)
    );

    const endpoints = (definition: WorkflowDefinition) =>
      definition.connections.map(
        (connection) =>
          `${connection.from.nodeId}.${connection.from.portId ?? ''}->${connection.to.nodeId}.${connection.to.portId ?? ''}`
      );
    expect(endpoints(round)).toEqual(endpoints(IMPORTABLE));

    expect(round.connections.map((connection) => connection.condition)).toEqual(
      IMPORTABLE.connections.map((connection) => connection.condition)
    );
    expect(round.connections.map((connection) => connection.priority)).toEqual(
      IMPORTABLE.connections.map((connection) => connection.priority)
    );
    expect(round.connections.map((connection) => connection.isDefault)).toEqual(
      IMPORTABLE.connections.map((connection) => connection.isDefault)
    );
    expect(round.connections.map((connection) => connection.selection)).toEqual(
      IMPORTABLE.connections.map((connection) => connection.selection)
    );

    expect(round.startNodeIds).toEqual(IMPORTABLE.startNodeIds);
    expect(round.version).toBe(IMPORTABLE.version);
  });

  it('keeps `isDefault: false` distinct from an absent marker', () => {
    const imported = importAndSelect(readPackage(documentFor(IMPORT_CORPUS[0]!)), 'closure');
    expect(imported.workflow.connections[2]?.isDefault).toBe(false);
    expect(imported.workflow.connections[6]?.isDefault).toBe(true);
    expect(imported.workflow.connections[0]).not.toHaveProperty('isDefault');
  });
});

// ---------------------------------------------------------------------------
// T065 — two nodes on one child Workflow, and authored order
// ---------------------------------------------------------------------------

describe('Feature 086 T065 / Feature 263 — one child Workflow, two nodes (FR-062)', () => {
  it('keeps two nodes naming the same child Workflow as two distinct nodes', () => {
    const imported = importAndSelect(readPackage(documentFor(IMPORT_CORPUS[0]!)), 'closure');
    const onPublish = imported.workflow.nodes.filter((node) => node.workflowId === 'publish');
    expect(onPublish.map((node) => node.nodeId)).toEqual(['publish-a', 'publish-b']);
    expect(onPublish.map((node) => node.label)).toEqual(['Publish A', 'Publish B']);
  });

  it('keeps their connections addressed to the right one of the two', () => {
    const imported = importAndSelect(readPackage(documentFor(IMPORT_CORPUS[0]!)), 'closure');
    const targets = imported.workflow.connections
      .filter((connection) => connection.to.nodeId.startsWith('publish-'))
      .map((connection) => `${connection.to.nodeId}.${connection.to.portId ?? ''}`);
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

  it('writes the shared child Workflow once while both nodes keep naming it', () => {
    const read = readPackage(documentFor(CORPUS[0]!));
    const text = documentFor(CORPUS[0]!);
    expect(read.workflows.filter((item) => item.workflowId === 'publish')).toHaveLength(1);
    expect(text.match(/workflowId: publish$/gm)).toHaveLength(2);
  });
});

describe('Feature 086 T065 — authored order survives, because it is the tie-break (FR-063)', () => {
  it('keeps node order as authored rather than sorted', () => {
    const imported = importAndSelect(readPackage(documentFor(IMPORT_CORPUS[0]!)), 'closure');
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
    expect(imported.workflow.startNodeIds).not.toEqual(['first', 'second']);
  });

  it('keeps connection order as authored, which decides equal priorities', () => {
    const imported = importAndSelect(readPackage(documentFor(IMPORT_CORPUS[0]!)), 'closure');
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
    const TIED: WorkflowDefinition = Object.freeze({
      ...IMPORTABLE,
      workflowId: 'tied',
      name: 'Tied',
      connections: Object.freeze(
        IMPORTABLE.connections.map((connection, index) =>
          index === 0 ? connection : Object.freeze({ ...connection, priority: 10 })
        )
      )
    }) as WorkflowDefinition;

    const fixture: Fixture = { label: '', definition: TIED, mode: 'closure' };
    const imported = importAndSelect(readPackage(documentFor(fixture)), 'closure');
    expect(
      imported.workflow.connections.map(
        (connection) => `${connection.to.nodeId}.${connection.to.portId ?? ''}`
      )
    ).toEqual(
      TIED.connections.map((connection) => `${connection.to.nodeId}.${connection.to.portId ?? ''}`)
    );
  });
});

// ---------------------------------------------------------------------------
// T066 — a condition is data, and nothing on this path executes it
// ---------------------------------------------------------------------------

describe('Feature 086 T066 — a condition survives intact (FR-006, SC-021)', () => {
  it('keeps every operand, operator, and literal', () => {
    const imported = importAndSelect(readPackage(documentFor(IMPORT_CORPUS[0]!)), 'closure');
    for (const [index, connection] of imported.workflow.connections.entries()) {
      expect(connection.condition).toEqual(IMPORTABLE.connections[index]?.condition);
    }
  });

  it('keeps a list literal a list of the same length and order', () => {
    const imported = importAndSelect(readPackage(documentFor(IMPORT_CORPUS[0]!)), 'closure');
    expect(imported.workflow.connections[5]?.condition?.right).toEqual(['completed', 'canceled']);
  });

  it('leaves `exists` with no right operand rather than a falsy one', () => {
    const imported = importAndSelect(readPackage(documentFor(IMPORT_CORPUS[0]!)), 'closure');
    const condition = imported.workflow.connections[6]?.condition;
    expect(condition?.operator).toBe('exists');
    expect(condition).not.toHaveProperty('right');
  });

  it('emits a condition as three keys of structured data, never as an expression', () => {
    const text = documentFor(CORPUS[0]!);
    expect(text).toContain('      condition:\n        left:\n          source: node-output\n');
    expect(text).toContain('        operator: equals\n');
    expect(text).not.toMatch(/condition:[ \t]*\S/);
  });
});

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
    const specifiers = importSpecifiers(moduleSource(relativePath));
    expect(specifiers.length).toBeGreaterThan(0);
  });

  it.each(CONDITION_MODULES)('%s imports only relative project modules', (relativePath) => {
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
      expect(pattern.test(sample)).toBe(true);
    }
  );

  it('treats an expression library as foreign and a project module as project', () => {
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

// ---------------------------------------------------------------------------
// Feature 254 (FR-R4-F07, C9; contract C1, C2; FR-026, FR-027) — the corpus cases whose condition can
// never match are serializer fixtures, not importable Workflows
// ---------------------------------------------------------------------------

describe('Feature 254 C9 — the unsupported corpus conditions are refused on import', () => {
  const UNSUPPORTED_INDEXES = [3, 4, 7, 8, 9] as const;

  function catalogVerdict(definition: WorkflowDefinition) {
    const phaseCatalog = resolvePhaseCatalog({
      rows: PHASES.map(phaseRow),
      revision: FIXTURE_REVISION
    });
    return resolveWorkflowCatalog({
      rows: [...CHILD_WORKFLOWS.map(workflowRow), workflowRow(definition)],
      revision: FIXTURE_REVISION,
      phaseCatalog: { effective: phaseCatalog.effective, records: phaseCatalog.records }
    });
  }

  it('marks the Workflow invalid, with one defect at each unsupported connection and no other', () => {
    const record = catalogVerdict(EVERYTHING).records.find(
      (r) => r.workflowId === EVERYTHING.workflowId
    );
    expect(record?.status).toBe('invalid');
    const errors = record?.errors ?? [];
    const unsupported = errors.filter((error) => error.code === 'condition-comparison-unsupported');
    expect(unsupported.map((error) => error.field)).toEqual(
      UNSUPPORTED_INDEXES.map((index) => `connections[${index}].condition`)
    );
    expect(errors.map((error) => error.code)).toEqual(
      UNSUPPORTED_INDEXES.map(() => 'condition-comparison-unsupported')
    );
  });

  it('cannot be selected for export while it carries them', () => {
    const phaseCatalog = resolvePhaseCatalog({
      rows: PHASES.map(phaseRow),
      revision: FIXTURE_REVISION
    });
    const selection = selectWorkflowForExport({
      rows: [...CHILD_WORKFLOWS.map(workflowRow), workflowRow(EVERYTHING)],
      phaseCatalog: { effective: phaseCatalog.effective, records: phaseCatalog.records },
      workflowId: EVERYTHING.workflowId
    });
    expect(selection.outcome).not.toBe('selected');
  });

  it('is a valid Workflow once the five conditions are made text comparisons (the control)', () => {
    const record = catalogVerdict(IMPORTABLE).records.find(
      (r) => r.workflowId === IMPORTABLE.workflowId
    );
    expect(record?.status).toBe('effective');
    expect(record?.errors).toEqual([]);
  });

  it('keeps the serializer faithful to the unsupported operators regardless', () => {
    const read = readPackage(
      documentFor({ label: 'every field', definition: EVERYTHING, mode: 'closure' })
    );
    for (const index of UNSUPPORTED_INDEXES) {
      expect(read.workflow.connections.at(index)?.condition).toEqual(
        EVERYTHING.connections.at(index)?.condition
      );
    }
  });
});

// Feature 285 (OD-2, FR-011): export takes the validator default. A stored row with a retired
// Pipeline node cannot be parsed for export, so it is never selected. The refusal is the
// selection's own `does-not-resolve` reason, as before the default changed; the field-level
// reason (`legacy-pipeline-field`) is what the headless surface reports.
describe('a stored Workflow with a retired Pipeline node (feature 285)', () => {
  it('is not selected for export', () => {
    const selection = selectWorkflowForExport({
      rows: [
        {
          id: 'legacy-export',
          name: 'Legacy Export',
          version: 1,
          nodes: [{ nodeId: 'a', pipelineId: 'standard' }],
          connections: [],
          startNodeIds: ['a']
        }
      ],
      workflowId: 'legacy-export'
    });
    expect(selection).toEqual({ outcome: 'unavailable', reason: 'does-not-resolve' });
  });
});
