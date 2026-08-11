// Feature 086 T011 — the Workflow package document, serialized (test-first).
//
// The shape under test is the shipped `WorkflowDefinition`, field for field
// (data-model.md §2.3) — not the source request's illustrative YAML, which
// disagrees with the catalog in five places and would each time have added a
// field the catalog cannot store. What the document carries is what a Workflow
// IS; anything else is a second source of truth with no home to be written back
// to.
//
// Three rules decide the bytes, and all three live in the module rather than in
// whichever order a caller happened to build the object:
//
//   * key order comes from the constants in `yaml-serializer.ts`;
//   * an empty list is OMITTED, never written as a childless key, because
//     `connections:` with nothing under it reads back as an empty MAPPING
//     (research R3, data-model.md §2.5);
//   * an absent optional stays absent — nothing is defaulted on the way out,
//     `version` least of all (FR-003a).
//
// Two absences are load-bearing enough to have their own tests. A connection
// carries no identifier of its own, and a Workflow's inputs and outputs are
// derived on read and never stored — a serialized copy of either would go stale
// the moment the graph changed shape (both standing hard rules).

import { describe, expect, it } from 'vitest';

import type { PipelineDefinition } from '../../../src/contracts/pipeline-definitions';
import {
  WORKFLOW_CONDITION_OPERATORS,
  WORKFLOW_SELECTION_RULES
} from '../../../src/contracts/workflow-definitions';
import type {
  WorkflowConnection,
  WorkflowDefinition
} from '../../../src/contracts/workflow-definitions';
import { DEFECT_FIELD_MAX } from '../../../src/services/process-yaml/phase-yaml-validator';
import { documentFromPipelineDefinition } from '../../../src/services/process-yaml/pipeline-document';
import type {
  WorkflowPackageResource,
  WorkflowPackageResult
} from '../../../src/services/process-yaml/workflow-document';
import {
  documentFromWorkflowDefinition,
  parseWorkflowPackage,
  serializeWorkflowDocument
} from '../../../src/services/process-yaml/workflow-document';
import { parseDocumentText } from '../../../src/services/process-yaml/yaml-parser';
import {
  PHASE_YAML_API_VERSION,
  WORKFLOW_YAML_KIND,
  type ImportDefect,
  type YamlMappingNode,
  type YamlNode
} from '../../../src/services/process-yaml/types';
import {
  WORKFLOW_CONDITION_KEY_ORDER,
  WORKFLOW_CONNECTION_KEY_ORDER,
  WORKFLOW_ENDPOINT_KEY_ORDER,
  WORKFLOW_INCLUDED_KEY_ORDER,
  WORKFLOW_METADATA_KEY_ORDER,
  WORKFLOW_NODE_KEY_ORDER,
  WORKFLOW_OPERAND_KEY_ORDER,
  WORKFLOW_PACKAGE_DOCUMENT_KEY_ORDER,
  WORKFLOW_SPEC_KEY_ORDER
} from '../../../src/services/process-yaml/yaml-serializer';

/** Serialize a definition the way export does: map, then emit. */
function emit(definition: WorkflowDefinition): string {
  return serializeWorkflowDocument(documentFromWorkflowDefinition(definition));
}

/** The same, with the resolved dependency payload an inclusion export supplies. */
function emitWith(
  definition: WorkflowDefinition,
  pipelines: readonly PipelineDefinition[]
): string {
  return serializeWorkflowDocument(documentFromWorkflowDefinition(definition, { pipelines }));
}

function parsed(text: string): YamlNode {
  const result = parseDocumentText(text);
  if (!result.ok) {
    throw new Error(`expected a parse, got ${result.refusal.code}: ${result.refusal.message}`);
  }
  return result.node;
}

function nodeAt(node: YamlNode, path: readonly (string | number)[]): YamlNode {
  let current = node;
  for (const step of path) {
    if (typeof step === 'number') {
      if (current.kind !== 'sequence') throw new Error(`expected a sequence at ${String(step)}`);
      const item = current.items[step];
      if (item === undefined) throw new Error(`missing item ${step}`);
      current = item;
      continue;
    }
    if (current.kind !== 'mapping') throw new Error(`expected a mapping at '${step}'`);
    const entry = current.entries.find((e) => e.key === step);
    if (!entry) throw new Error(`missing key '${step}'`);
    current = entry.value;
  }
  return current;
}

/** One scalar value out of a mapping, by key. */
function textAtKey(node: YamlNode, key: string): string {
  const value = nodeAt(node, [key]);
  if (value.kind !== 'scalar') throw new Error(`expected a scalar at '${key}'`);
  return value.value;
}

/** The keys a mapping declares, in written order. */
function keysOf(node: YamlNode): readonly string[] {
  if (node.kind !== 'mapping') throw new Error(`expected a mapping, got ${node.kind}`);
  return (node as YamlMappingNode).entries.map((entry) => entry.key);
}

/** Every key appearing in a document's text, at any depth. */
function documentKeys(text: string): readonly string[] {
  return [...text.matchAll(/^\s*(?:- )?([A-Za-z][\w-]*):/gm)].map((match) => match[1]!);
}

/** The smallest legal Workflow: identity, one node, one start. */
const MINIMAL: WorkflowDefinition = {
  workflowId: 'ship-it-flow',
  name: 'Ship It Flow',
  version: 1,
  nodes: [{ nodeId: 'draft', pipelineId: 'spec-authoring' }],
  connections: [],
  startNodeIds: ['draft']
};

/**
 * Every field the format carries. Two nodes name the same Pipeline deliberately:
 * a node is addressed by `nodeId` and never by `pipelineId`, so the repeat is
 * what proves the two are distinguished (FR-003 of feature 083, and the
 * de-duplication the closure walk owes FR-020 later).
 */
const FULL: WorkflowDefinition = {
  workflowId: 'ship-it-flow',
  name: 'Ship It Flow',
  description: 'Draft, then review.',
  version: 4,
  nodes: [
    { nodeId: 'draft', pipelineId: 'spec-authoring', label: 'Draft the spec' },
    { nodeId: 'review', pipelineId: 'spec-review' },
    { nodeId: 'redraft', pipelineId: 'spec-authoring' }
  ],
  connections: [
    {
      from: { nodeId: 'draft', portId: 'spec-document' },
      to: { nodeId: 'review', portId: 'spec' },
      condition: {
        left: { source: 'node-status', nodeId: 'draft' },
        operator: 'in',
        right: ['completed', 'partially-completed']
      },
      priority: 10,
      isDefault: false,
      selection: 'first'
    },
    {
      from: { nodeId: 'review', portId: 'verdict' },
      to: { nodeId: 'redraft', portId: 'spec' },
      condition: {
        left: { source: 'node-output', nodeId: 'review', field: 'verdict' },
        operator: 'equals',
        right: 'changes-requested'
      }
    },
    {
      from: { nodeId: 'review', portId: 'verdict' },
      to: { nodeId: 'redraft', portId: 'spec' },
      isDefault: true
    }
  ],
  startNodeIds: ['draft']
};

/**
 * The two distinct Pipelines `FULL.nodes` names, with the ports its connections
 * actually address and the types the frozen compatibility table admits — so the
 * fixture is a graph that resolves rather than one that only looks like it. One
 * carries a binding and an optional-bearing port, the other does not, so the
 * included bodies exercise more than one `spec` shape rather than the same twice.
 */
const AUTHORING_PIPELINE: PipelineDefinition = {
  pipelineId: 'spec-authoring',
  name: 'Spec Authoring',
  version: 2,
  phaseIds: ['specify'],
  inputs: [
    { portId: 'brief', label: 'Brief', type: 'text', required: true },
    // Fed by `review.verdict`, whose `structured-data` maps to `pipeline-output`.
    { portId: 'spec', label: 'Prior verdict', type: 'pipeline-output' }
  ],
  outputs: [{ portId: 'spec-document', label: 'Spec', type: 'markdown' }],
  bindings: [
    {
      kind: 'input',
      phaseIndex: 0,
      inputKey: 'brief',
      source: { from: 'pipeline-input', portId: 'brief' }
    }
  ],
  recommendedNext: []
};

const REVIEW_PIPELINE: PipelineDefinition = {
  pipelineId: 'spec-review',
  name: 'Spec Review',
  description: 'Read it back.',
  version: 1,
  phaseIds: ['analyze'],
  // `spec` accepts the draft's markdown; `verdict` is structured so the
  // `node-output` condition in `FULL` has a field to read.
  inputs: [{ portId: 'spec', label: 'Spec', type: 'text' }],
  outputs: [{ portId: 'verdict', label: 'Verdict', type: 'structured-data' }],
  bindings: [],
  recommendedNext: []
};

/** `FULL` with `connections` replaced, keeping every node the endpoints name. */
function withConnections(connections: readonly WorkflowConnection[]): WorkflowDefinition {
  return { ...FULL, connections };
}

/** A connection between the two nodes every fixture declares. */
function connection(overrides: Partial<WorkflowConnection> = {}): WorkflowConnection {
  return {
    from: { nodeId: 'draft', portId: 'spec-document' },
    to: { nodeId: 'review', portId: 'spec' },
    ...overrides
  };
}

/**
 * The values written for one key, in document order. The optional `- ` matches
 * `documentKeys` above: a key that leads a sequence item is still that key, and a
 * scan that missed it would quietly report the wrong lines.
 */
function valuesFor(text: string, key: string): readonly string[] {
  return [...text.matchAll(new RegExp(`^\\s*(?:- )?${key}: (.+)$`, 'gm'))].map(
    (match) => match[1]!
  );
}

/**
 * The literal `spec.nodes` block — its key line through the line before whichever
 * sibling key follows it. Compared as TEXT, not as a tree, because FR-009's claim
 * is about the bytes: an inclusion export must leave every node reference exactly
 * where a references-only export wrote it.
 */
function nodesBlock(text: string): string {
  const start = text.indexOf('  nodes:\n');
  if (start < 0) throw new Error('expected a nodes block');
  const ends = ['  connections:\n', '  startNodeIds:\n']
    .map((key) => text.indexOf(key, start))
    .filter((index) => index > start);
  if (ends.length === 0) throw new Error('expected a sibling key after nodes');
  return text.slice(start, Math.min(...ends));
}

describe('Feature 086 — the Workflow document declares what it is (§2.1)', () => {
  it('carries the shared apiVersion and the third kind', () => {
    const document = documentFromWorkflowDefinition(MINIMAL);
    expect(document.apiVersion).toBe(PHASE_YAML_API_VERSION);
    expect(document.kind).toBe('Workflow');
    // One format, three kinds — the version and the 1 MiB bound are shared, not
    // re-declared (data-model.md §2.1).
    expect(WORKFLOW_YAML_KIND).toBe('Workflow');
    expect(PHASE_YAML_API_VERSION).toBe('schegent/v1');
  });

  it('writes the root keys in the declared order', () => {
    expect(keysOf(parsed(emit(FULL)))).toEqual(
      WORKFLOW_PACKAGE_DOCUMENT_KEY_ORDER.filter((key) => key !== 'included')
    );
  });

  it('renames only the identity field and carries every other value verbatim', () => {
    // `workflowId` becomes `metadata.id` because the document already names the
    // resource under `kind` (data-model.md §2.2). That rename is the only one.
    const document = documentFromWorkflowDefinition(FULL);
    expect(document.metadata).toEqual({
      id: 'ship-it-flow',
      name: 'Ship It Flow',
      description: 'Draft, then review.',
      version: 4
    });
    expect(keysOf(nodeAt(parsed(emit(FULL)), ['metadata']))).toEqual([
      ...WORKFLOW_METADATA_KEY_ORDER
    ]);
  });

  it('carries version verbatim rather than defaulting an absent one', () => {
    // FR-003a. Defaulting to 1 would stamp a number the author never wrote and
    // make the round trip lossy; the shipped Pipeline reader presence-checks it
    // for exactly this reason.
    expect(valuesFor(emit({ ...MINIMAL, version: 97 }), 'version')).toEqual(['97']);
    expect(valuesFor(emit(FULL), 'version')).toEqual(['4']);
  });

  it('key order comes from the module, not from the object it was handed', () => {
    const reversed = {
      startNodeIds: FULL.startNodeIds,
      connections: FULL.connections,
      nodes: FULL.nodes,
      version: FULL.version,
      description: FULL.description,
      name: FULL.name,
      workflowId: FULL.workflowId
    } as WorkflowDefinition;
    expect(emit(reversed)).toBe(emit(FULL));
  });
});

describe('Feature 086 — the authored graph (§2.3)', () => {
  it('emits the minimal document with every empty list omitted', () => {
    expect(emit(MINIMAL)).toBe(
      [
        'apiVersion: schegent/v1',
        'kind: Workflow',
        'metadata:',
        '  id: ship-it-flow',
        '  name: Ship It Flow',
        '  version: 1',
        'spec:',
        '  nodes:',
        '    - nodeId: draft',
        '      pipelineId: spec-authoring',
        '  startNodeIds:',
        '    - draft',
        ''
      ].join('\n')
    );
  });

  it('emits every field of a full graph, in order, at the declared depths', () => {
    expect(emit(FULL)).toBe(
      [
        'apiVersion: schegent/v1',
        'kind: Workflow',
        'metadata:',
        '  id: ship-it-flow',
        '  name: Ship It Flow',
        '  description: Draft, then review.',
        '  version: 4',
        'spec:',
        '  nodes:',
        '    - nodeId: draft',
        '      pipelineId: spec-authoring',
        '      label: Draft the spec',
        '    - nodeId: review',
        '      pipelineId: spec-review',
        '    - nodeId: redraft',
        '      pipelineId: spec-authoring',
        '  connections:',
        '    - from:',
        '        nodeId: draft',
        '        portId: spec-document',
        '      to:',
        '        nodeId: review',
        '        portId: spec',
        '      condition:',
        '        left:',
        '          source: node-status',
        '          nodeId: draft',
        '        operator: in',
        '        right:',
        '          - completed',
        '          - partially-completed',
        '      priority: 10',
        '      isDefault: false',
        '      selection: first',
        '    - from:',
        '        nodeId: review',
        '        portId: verdict',
        '      to:',
        '        nodeId: redraft',
        '        portId: spec',
        '      condition:',
        '        left:',
        '          source: node-output',
        '          nodeId: review',
        '          field: verdict',
        '        operator: equals',
        '        right: changes-requested',
        '    - from:',
        '        nodeId: review',
        '        portId: verdict',
        '      to:',
        '        nodeId: redraft',
        '        portId: spec',
        '      isDefault: true',
        '  startNodeIds:',
        '    - draft',
        ''
      ].join('\n')
    );
  });

  it('writes the spec keys in the declared order and keeps authored node order', () => {
    const spec = nodeAt(parsed(emit(FULL)), ['spec']);
    expect(keysOf(spec)).toEqual([...WORKFLOW_SPEC_KEY_ORDER]);
    expect(keysOf(nodeAt(spec, ['nodes', 0]))).toEqual([...WORKFLOW_NODE_KEY_ORDER]);
    // Read from the tree rather than by scanning `nodeId:` lines, which a
    // connection endpoint and a condition operand also write.
    const nodes = nodeAt(spec, ['nodes']);
    if (nodes.kind !== 'sequence') throw new Error('expected a sequence');
    expect(nodes.items.map((item) => textAtKey(item, 'nodeId'))).toEqual([
      'draft',
      'review',
      'redraft'
    ]);
  });

  it('omits an absent node label rather than writing a bare key', () => {
    expect(keysOf(nodeAt(parsed(emit(FULL)), ['spec', 'nodes', 1]))).toEqual([
      'nodeId',
      'pipelineId'
    ]);
  });

  it('writes both endpoints as structured mappings, never as a dotted string', () => {
    // A dotted `draft.spec-document` needs a splitter, and an id containing a
    // dot would silently mis-split (data-model.md §2.6).
    const first = nodeAt(parsed(emit(FULL)), ['spec', 'connections', 0]);
    for (const side of ['from', 'to'] as const) {
      expect(keysOf(nodeAt(first, [side]))).toEqual([...WORKFLOW_ENDPOINT_KEY_ORDER]);
    }
    expect(emit(FULL)).not.toMatch(/^\s*(?:from|to): \S/m);
  });

  it('gives a connection no identifier of its own', () => {
    // Positional addressing is for defect reporting only and MUST NOT leak into
    // the document (standing hard rule). Every key a connection writes is one
    // the declared order names.
    const connections = nodeAt(parsed(emit(FULL)), ['spec', 'connections']);
    if (connections.kind !== 'sequence') throw new Error('expected a sequence');
    for (const item of connections.items) {
      for (const key of keysOf(item)) {
        expect(WORKFLOW_CONNECTION_KEY_ORDER).toContain(key);
      }
    }
    expect(documentKeys(emit(FULL))).not.toContain('connectionId');
  });

  it('writes priority and isDefault, including the false a default marker turns off', () => {
    // `isDefault: false` is written because the definition carries it; only an
    // ABSENT optional is omitted. Collapsing a written false into absence would
    // silently rewrite the operator's graph on the way out.
    expect(valuesFor(emit(FULL), 'priority')).toEqual(['10']);
    expect(valuesFor(emit(FULL), 'isDefault')).toEqual(['false', 'true']);
  });

  it('emits every operator in the closed set', () => {
    const text = emit(
      withConnections(
        WORKFLOW_CONDITION_OPERATORS.map((operator) =>
          connection({
            condition: {
              left: {
                source: 'node-output',
                nodeId: 'draft',
                field: 'verdict'
              },
              operator,
              ...(operator === 'exists' ? {} : { right: operator === 'in' ? ['a'] : 'a' })
            }
          })
        )
      )
    );
    expect(valuesFor(text, 'operator')).toEqual([...WORKFLOW_CONDITION_OPERATORS]);
  });

  it('emits both operand variants, with field present only on node-output', () => {
    const text = emit(
      withConnections([
        connection({
          condition: {
            left: { source: 'node-output', nodeId: 'draft', field: 'verdict' },
            operator: 'exists'
          }
        }),
        connection({
          condition: {
            left: { source: 'node-status', nodeId: 'draft' },
            operator: 'exists'
          }
        })
      ])
    );
    const tree = parsed(text);
    expect(keysOf(nodeAt(tree, ['spec', 'connections', 0, 'condition', 'left']))).toEqual([
      ...WORKFLOW_OPERAND_KEY_ORDER
    ]);
    expect(keysOf(nodeAt(tree, ['spec', 'connections', 1, 'condition', 'left']))).toEqual([
      'source',
      'nodeId'
    ]);
    expect(keysOf(nodeAt(tree, ['spec', 'connections', 0, 'condition']))).toEqual([
      'left',
      'operator'
    ]);
  });

  it('emits all three right arities, and every literal type, as the author wrote them', () => {
    // `exists` takes none, `in` takes the bounded block sequence, everything else
    // takes one. Arity is the validator's rule; the writer carries what it is
    // handed, including a number and a boolean, which must stay bare so a reader
    // sees the same type back (data-model.md §2.3).
    const text = emit(
      withConnections([
        connection({
          condition: {
            left: { source: 'node-status', nodeId: 'draft' },
            operator: 'exists'
          }
        }),
        connection({
          condition: {
            left: { source: 'node-output', nodeId: 'draft', field: 'count' },
            operator: 'greaterThan',
            right: 3
          }
        }),
        connection({
          condition: {
            left: { source: 'node-output', nodeId: 'draft', field: 'ok' },
            operator: 'equals',
            right: true
          }
        }),
        connection({
          condition: {
            left: { source: 'node-status', nodeId: 'draft' },
            operator: 'in',
            right: ['completed', 'canceled']
          }
        })
      ])
    );
    const tree = parsed(text);
    expect(keysOf(nodeAt(tree, ['spec', 'connections', 0, 'condition']))).not.toContain('right');
    expect(valuesFor(text, 'right')).toEqual(['3', 'true']);
    const list = nodeAt(tree, ['spec', 'connections', 3, 'condition', 'right']);
    if (list.kind !== 'sequence') throw new Error('expected a sequence');
    expect(list.items.map((item) => (item.kind === 'scalar' ? item.value : null))).toEqual([
      'completed',
      'canceled'
    ]);
  });

  it('emits every selection rule', () => {
    const text = emit(
      withConnections(WORKFLOW_SELECTION_RULES.map((selection) => connection({ selection })))
    );
    expect(valuesFor(text, 'selection')).toEqual([...WORKFLOW_SELECTION_RULES]);
    expect(keysOf(nodeAt(parsed(text), ['spec', 'connections', 0]))).toEqual([
      'from',
      'to',
      'selection'
    ]);
  });
});

describe('Feature 086 — absent versus empty (FR-011, §2.5)', () => {
  it('omits an empty connections list, leaving nothing a reader could mistake for a value', () => {
    const text = emit(MINIMAL);
    expect(documentKeys(text)).not.toContain('connections');
    // The other half of FR-011 — an absent list-typed key reading back as `[]`
    // rather than as `undefined` — is the reader's rule, and the Workflow reader
    // arrives with US4 (T029, T034). What export owes it is an UNAMBIGUOUS
    // absence: no childless `connections:` for the reader to see as an empty
    // mapping (research R3), so the only thing it can read is nothing at all.
    expect(keysOf(nodeAt(parsed(text), ['spec']))).toEqual(['nodes', 'startNodeIds']);
  });

  it('still writes nodes and startNodeIds, which have no empty form', () => {
    // Exempt from the omission rule by §2.5: a Workflow with neither is not a
    // Workflow, so their absence is a defect rather than an empty list. A writer
    // that omitted them would produce a document its own reader must reject.
    const keys = documentKeys(emit(MINIMAL));
    expect(keys).toContain('nodes');
    expect(keys).toContain('startNodeIds');
  });

  it('omits an absent description rather than defaulting it', () => {
    expect(documentKeys(emit(MINIMAL))).not.toContain('description');
  });
});

describe('Feature 086 — what the document deliberately does not carry (§2.6)', () => {
  it('never writes a Workflow inputs or outputs section', () => {
    // Derived on read by `workflow-derived-ports.ts` and projection-only. A
    // serialized copy would be a second source of truth that goes stale the
    // moment a node's Pipeline changes shape (standing hard rule).
    const keys = documentKeys(emit(FULL));
    expect(keys).not.toContain('inputs');
    expect(keys).not.toContain('outputs');
  });

  it('emits no key outside the Workflow key orders, at any depth', () => {
    const authorized = new Set<string>([
      ...WORKFLOW_PACKAGE_DOCUMENT_KEY_ORDER,
      ...WORKFLOW_METADATA_KEY_ORDER,
      ...WORKFLOW_SPEC_KEY_ORDER,
      ...WORKFLOW_NODE_KEY_ORDER,
      ...WORKFLOW_CONNECTION_KEY_ORDER,
      ...WORKFLOW_ENDPOINT_KEY_ORDER,
      ...WORKFLOW_CONDITION_KEY_ORDER,
      ...WORKFLOW_OPERAND_KEY_ORDER
    ]);
    const keys = documentKeys(emit(FULL));
    expect([...new Set(keys)].filter((key) => !authorized.has(key))).toEqual([]);
    // The scan must find keys, or the assertion above is vacuous.
    expect(keys.length).toBeGreaterThan(20);
  });

  it('names none of the five forms the source request illustrated', () => {
    // Each is a field the catalog cannot store, so writing one would create a
    // value with no home to be read back into (data-model.md §2.6).
    const keys = new Set(documentKeys(emit(FULL)));
    for (const absent of ['connectionId', 'path', 'output', 'value', 'transition']) {
      expect(keys.has(absent), `document must not carry '${absent}'`).toBe(false);
    }
  });
});

// Feature 086 T019 — `included.pipelines`, the middle inclusion mode (US2).
//
// Inclusion is ADDITIVE. FR-009's second clause is the whole rule: a node keeps
// referencing its Pipeline by identifier, and the payload arrives beside the
// graph as a lookup table. It is not an optimization to inline a definition at
// the one node that names it — a Workflow may name one Pipeline from several
// nodes (FR-062), so an inline form has no single home, and a reader that
// accepted one would be reading a shape the catalog cannot store back.
//
// That makes the references-only bytes a PREFIX of the inclusion bytes, which is
// asserted directly below: `included` is appended after `spec`, and nothing
// above it moves.

describe('Feature 086 — the included section carries whole Pipelines (US2)', () => {
  const BOTH = [AUTHORING_PIPELINE, REVIEW_PIPELINE] as const;

  it('never emits an included section for a references-only document (FR-015)', () => {
    // Not an empty one, not a null one: the key is absent from the document and
    // from the bytes. A references-only export is defined by that absence, which
    // is also what lets it succeed when the Pipelines do not resolve (FR-016) —
    // it makes no claim about them.
    const document = documentFromWorkflowDefinition(FULL);
    expect(Object.keys(document)).toEqual(['apiVersion', 'kind', 'metadata', 'spec']);
    expect('included' in document).toBe(false);
    expect(emit(FULL)).not.toContain('included');
  });

  it('gives each included Pipeline the same metadata and spec the single-Pipeline document defines', () => {
    // FR-008 — not a similar shape, the SAME one, built by the same mapper and
    // compared against it. A field the single-Pipeline document learns to carry
    // is carried here too without this test being edited.
    const document = documentFromWorkflowDefinition(FULL, { pipelines: BOTH });
    const bodies = document.included?.pipelines ?? [];
    expect(bodies).toHaveLength(2);
    for (const [index, pipeline] of BOTH.entries()) {
      const standalone = documentFromPipelineDefinition(pipeline);
      expect(bodies[index]).toEqual({
        metadata: standalone.metadata,
        spec: standalone.spec
      });
    }
  });

  it('does not repeat apiVersion or kind inside an included Pipeline', () => {
    // FR-002 — the package already declared exactly one root. A second
    // declaration under `included` would be a second root in one document.
    const document = documentFromWorkflowDefinition(FULL, { pipelines: BOTH });
    for (const body of document.included?.pipelines ?? []) {
      expect(Object.keys(body)).toEqual(['metadata', 'spec']);
    }
    const text = emitWith(FULL, BOTH);
    // `apiVersion` appears nowhere else in the format, so one occurrence
    // anywhere is the whole check. `kind:` is also a binding field, so the root
    // declaration is pinned by column and a re-declared kind by value.
    expect(text.match(/apiVersion:/g)).toHaveLength(1);
    expect(text.match(/^kind:/gm)).toHaveLength(1);
    expect(text.match(/kind: Workflow/g)).toHaveLength(1);
    expect(text).not.toContain('kind: Pipeline');
    expect(text).not.toContain('kind: Phase');
  });

  it('carries no Phase definition in this mode (FR-017)', () => {
    const document = documentFromWorkflowDefinition(FULL, { pipelines: BOTH });
    // The declared order names both dependency classes; this mode writes the
    // first and omits the second, rather than writing it empty.
    expect(keysOf(nodeAt(parsed(emitWith(FULL, BOTH)), ['included']))).toEqual(
      WORKFLOW_INCLUDED_KEY_ORDER.filter((key) => key !== 'phases')
    );
    expect('phases' in (document.included ?? {})).toBe(false);
    const keys = documentKeys(emitWith(FULL, BOTH));
    // `phaseIds` is a Pipeline's own reference list and belongs here; `phaseId`
    // is a Phase document's identity key and is the thing that must be absent.
    expect(keys).toContain('phaseIds');
    expect(keys).not.toContain('phaseId');
    expect(keys).not.toContain('phases');
    expect(keys).not.toContain('instruction');
  });

  it('writes the root keys in the declared order, with included last', () => {
    expect(keysOf(parsed(emitWith(FULL, BOTH)))).toEqual([...WORKFLOW_PACKAGE_DOCUMENT_KEY_ORDER]);
  });

  it('writes each distinct referenced Pipeline once, in first-mention order (FR-017)', () => {
    // `FULL.nodes` names spec-authoring, spec-review, spec-authoring. Three
    // nodes, two definitions, and the repeat collapses onto its first mention
    // rather than appearing again at the end.
    const document = documentFromWorkflowDefinition(FULL, { pipelines: BOTH });
    expect(document.included?.pipelines.map((body) => body.metadata.id)).toEqual([
      'spec-authoring',
      'spec-review'
    ]);
  });

  it('derives that order from nodes, not from the order the Pipelines arrived in', () => {
    // The caller's array is a lookup. Handing it back reversed must not reorder
    // the document, or two installations that resolved their catalogs in
    // different orders would export different bytes for the same Workflow
    // (FR-021).
    expect(emitWith(FULL, [REVIEW_PIPELINE, AUTHORING_PIPELINE])).toBe(emitWith(FULL, BOTH));
  });

  it('includes only what the nodes name, however much the caller supplies', () => {
    // The payload is addressed by the graph, so an over-supplying caller cannot
    // widen the document. `MINIMAL` names one Pipeline from its single node.
    const document = documentFromWorkflowDefinition(MINIMAL, {
      pipelines: BOTH
    });
    expect(document.included?.pipelines.map((body) => body.metadata.id)).toEqual([
      'spec-authoring'
    ]);
  });

  it('leaves every node reference byte-for-byte identical (FR-009)', () => {
    // The second clause of FR-009, asserted as a diff: inclusion ADDS a section
    // and never rewrites a `pipelineId` into an inline anonymous definition. The
    // whole references-only document is a prefix of the inclusion one, so the
    // graph above `included` provably did not move.
    const references = emit(FULL);
    const withPipelines = emitWith(FULL, BOTH);
    expect(nodesBlock(withPipelines)).toBe(nodesBlock(references));
    expect(withPipelines.startsWith(references)).toBe(true);
    expect(withPipelines.length).toBeGreaterThan(references.length);
  });

  it('leaves spec authoritative and unchanged when definitions are included', () => {
    const withInclusion = documentFromWorkflowDefinition(FULL, {
      pipelines: BOTH
    });
    expect(withInclusion.spec).toEqual(documentFromWorkflowDefinition(FULL).spec);
    // Two nodes on one Pipeline stay two nodes (FR-062): de-duplication happens
    // in the payload and never in the graph.
    expect(withInclusion.spec.nodes.map((node) => node.pipelineId)).toEqual([
      'spec-authoring',
      'spec-review',
      'spec-authoring'
    ]);
  });

  it('emits the included section after spec, in the declared shape', () => {
    expect(emitWith(FULL, BOTH)).toContain(
      [
        '  startNodeIds:',
        '    - draft',
        'included:',
        '  pipelines:',
        '    - metadata:',
        '        id: spec-authoring',
        '        name: Spec Authoring',
        '        version: 2',
        '      spec:',
        '        phaseIds:',
        '          - specify',
        '        inputs:',
        '          - portId: brief',
        '            label: Brief',
        '            type: text',
        '            required: true',
        '          - portId: spec',
        '            label: Prior verdict',
        '            type: pipeline-output',
        '        outputs:',
        '          - portId: spec-document',
        '            label: Spec',
        '            type: markdown',
        '        bindings:',
        '          - kind: input',
        '            phaseIndex: 0',
        '            inputKey: brief',
        '            source:',
        '              from: pipeline-input',
        '              portId: brief',
        '    - metadata:',
        '        id: spec-review',
        '        name: Spec Review',
        '        version: 1',
        '        description: Read it back.',
        '      spec:',
        '        phaseIds:',
        '          - analyze',
        '        inputs:',
        '          - portId: spec',
        '            label: Spec',
        '            type: text',
        '        outputs:',
        '          - portId: verdict',
        '            label: Verdict',
        '            type: structured-data',
        ''
      ].join('\n')
    );
  });

  it('omits the key entirely when the inclusion resolves to no Pipelines', () => {
    // The same rule as an empty list: a childless `included:` reads back as an
    // empty mapping, not as the absence it represents (research R3).
    const document = documentFromWorkflowDefinition(MINIMAL, { pipelines: [] });
    expect('included' in document).toBe(false);
    expect(emitWith(MINIMAL, [])).toBe(emit(MINIMAL));
  });

  it('is deterministic — the same inclusion emits the same bytes (FR-021)', () => {
    expect(emitWith(FULL, BOTH)).toBe(emitWith(FULL, BOTH));
  });
});

// ---------------------------------------------------------------------------
// Reading a Workflow package back — feature 086 T029, T030 (US4)
// ---------------------------------------------------------------------------
//
// The read side mirrors the shipped Pipeline reader exactly, one level up: the
// envelope is gated first and refuses the whole document, then every declared
// resource is classified independently and reports EVERY defect it has rather
// than the first (FR-028).
//
// What this file does NOT assert is the other half of a Workflow's validity.
// A connection naming an undeclared node, and a port the referenced Pipeline
// does not expose, are both `unresolved-endpoint` from `validateWorkflowGraph` —
// they need the Pipeline catalog, which a parser does not have and must not
// acquire. FR-041 puts them after resolution, so they are asserted in
// `package-resolver.test.ts` where the graph validator is the single detector.
// A second endpoint check here could disagree with the one guarding the save
// gate, which is the whole reason the split exists.

/** Read a package the way preflight does: parse the tree, then classify it. */
function readPackage(text: string): WorkflowPackageResult {
  const result = parseDocumentText(text);
  if (!result.ok) {
    throw new Error(`fixture did not parse: ${result.refusal.code} ${result.refusal.message}`);
  }
  return parseWorkflowPackage(result.node);
}

/** The classified resources of a package whose envelope was accepted. */
function resourcesOf(text: string): readonly WorkflowPackageResource[] {
  const result = readPackage(text);
  if (!result.ok) {
    throw new Error(`expected the envelope to be accepted, got ${result.refusal.code}`);
  }
  return result.resources;
}

/** The defects of the resource at `index`, which the caller expects to be invalid. */
function defectsOf(text: string, index = 0): readonly ImportDefect[] {
  const resource = resourcesOf(text)[index];
  if (resource === undefined) throw new Error(`no resource at index ${index}`);
  if (resource.ok) throw new Error(`expected resource ${index} to be invalid`);
  return resource.defects;
}

/** `field/code` pairs — what a defect assertion is actually about. */
function codesOf(found: readonly ImportDefect[]): readonly string[] {
  return found.map((entry) => `${entry.field}/${entry.code}`);
}

const WELL_FORMED_WORKFLOW_METADATA = [
  'id: ship-it-flow',
  'name: Ship It Flow',
  'version: 1'
] as const;

const WELL_FORMED_WORKFLOW_SPEC = [
  'nodes:',
  '  - nodeId: draft',
  '    pipelineId: spec-authoring',
  'startNodeIds:',
  '  - draft'
] as const;

/**
 * One `included` entry at the indent the emitter writes it, so a fixture and an
 * exported document are the same shape rather than two conventions. Both kinds
 * sit at the same depth — the section key differs, the body does not.
 */
function includedBody(
  metadata: readonly string[],
  spec: readonly string[]
): readonly string[] {
  return [
    '    - metadata:',
    ...metadata.map((line) => `        ${line}`),
    '      spec:',
    ...spec.map((line) => `        ${line}`)
  ];
}

const INCLUDED_PIPELINE = includedBody(
  ['id: spec-authoring', 'name: Spec Authoring', 'version: 2'],
  ['phaseIds:', '  - specify']
);

const INCLUDED_PHASE = includedBody(
  ['phaseId: specify', 'name: Specify', 'version: 2'],
  ['instruction: Write the spec.']
);

/**
 * A Workflow package document, defaulting to a well-formed one so a fixture
 * states only its defect. `included` follows `WORKFLOW_INCLUDED_KEY_ORDER`, and
 * a section is written only when the caller supplies it — an empty one is a
 * different document (FR-015).
 */
function wf(body: {
  readonly apiVersion?: string | null;
  readonly kind?: string | null;
  readonly metadata?: readonly string[];
  readonly spec?: readonly string[];
  readonly pipelines?: readonly (readonly string[])[];
  readonly phases?: readonly (readonly string[])[];
}): string {
  const lines: string[] = [];
  if (body.apiVersion !== null) lines.push(`apiVersion: ${body.apiVersion ?? 'schegent/v1'}`);
  if (body.kind !== null) lines.push(`kind: ${body.kind ?? 'Workflow'}`);
  lines.push('metadata:');
  for (const line of body.metadata ?? WELL_FORMED_WORKFLOW_METADATA) lines.push(`  ${line}`);
  lines.push('spec:');
  for (const line of body.spec ?? WELL_FORMED_WORKFLOW_SPEC) lines.push(`  ${line}`);
  if (body.pipelines !== undefined || body.phases !== undefined) {
    lines.push('included:');
    if (body.pipelines !== undefined) lines.push('  pipelines:', ...body.pipelines.flat());
    if (body.phases !== undefined) lines.push('  phases:', ...body.phases.flat());
  }
  return `${lines.join('\n')}\n`;
}

/** A `spec` whose one connection is built from the caller's lines. */
function specWithConnection(connectionLines: readonly string[]): readonly string[] {
  return [
    'nodes:',
    '  - nodeId: draft',
    '    pipelineId: spec-authoring',
    '  - nodeId: review',
    '    pipelineId: spec-review',
    'connections:',
    ...connectionLines,
    'startNodeIds:',
    '  - draft'
  ];
}

/** The endpoints every §3.3 fixture shares, so each states only its own field. */
const CONNECTION_ENDPOINTS = [
  '  - from:',
  '      nodeId: draft',
  '      portId: spec-document',
  '    to:',
  '      nodeId: review',
  '      portId: spec'
] as const;

describe('Feature 086 T029 — the envelope decides whether anything is classified', () => {
  it('classifies one resource per declaration, root first then each section', () => {
    // The baseline every defect test below is read against. Without it, those
    // assertions could all pass on a reader that refused everything.
    //
    // The order is the reader's order, and it is the document's: the root, then
    // `included.pipelines`, then `included.phases` — `WORKFLOW_INCLUDED_KEY_ORDER`
    // on read as well as on write.
    const found = resourcesOf(wf({ pipelines: [INCLUDED_PIPELINE], phases: [INCLUDED_PHASE] }));

    expect(found.map((resource) => resource.resourceKind)).toEqual([
      'workflow',
      'pipeline',
      'phase'
    ]);
    expect(found.every((resource) => resource.ok)).toBe(true);
  });

  it('reads a references-only document, which declares no dependencies at all', () => {
    const found = resourcesOf(wf({}));
    expect(found.map((resource) => resource.resourceKind)).toEqual(['workflow']);
    expect(found[0]?.ok).toBe(true);
  });

  it('reads the middle depth, which carries Pipelines and no Phases', () => {
    const found = resourcesOf(wf({ pipelines: [INCLUDED_PIPELINE] }));
    expect(found.map((resource) => resource.resourceKind)).toEqual(['workflow', 'pipeline']);
  });

  it('checks the version before the kind, so an unknown format is not misreported', () => {
    // A document from a format this build does not read is reported as such,
    // rather than as an unsupported kind that happens to be spelled in it.
    const result = readPackage(wf({ apiVersion: 'schegent/v2', kind: 'Nonsense' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('unsupported-version');
  });

  it('produces no resources at all when the document itself is refused (FR-026)', () => {
    // A document-level refusal is not a resource with defects. Nothing is
    // classified, so there is nothing a partial plan could be built from.
    for (const text of [
      wf({ apiVersion: null }),
      wf({ apiVersion: 'schegent/v2' }),
      wf({ kind: null }),
      wf({ kind: 'Pipeline' })
    ]) {
      const result = readPackage(text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect('resources' in result).toBe(false);
    }
  });
});

describe('Feature 086 T029 — an invalid Workflow names every defect, not the first (FR-028)', () => {
  it('reports metadata and graph defects together in one pass', () => {
    // Five problems, one read. An operator fixing this document sees the whole
    // list rather than peeling it one error per attempt, which is the entire
    // point of FR-028 — and is why neither a failed section nor a dropped
    // connection may short-circuit what follows it.
    const found = codesOf(
      defectsOf(
        wf({
          metadata: ['id: ship-it-flow', 'name: Ship It Flow', 'author: someone'],
          spec: [
            'nodes:',
            '  - nodeId: draft',
            '    pipelineId: spec-authoring',
            '  - nodeId: draft',
            '    pipelineId: spec-review',
            'connections:',
            ...CONNECTION_ENDPOINTS,
            '    condition:',
            '      left:',
            '        source: telepathy',
            '      operator: equals',
            '      right: changes-requested',
            'startNodeIds:',
            '  - nowhere'
          ]
        })
      )
    );

    expect(found).toEqual(
      expect.arrayContaining([
        // FR-003a, SC-017a — absent, not defaulted. The catalog defaults an
        // absent version to 1, which is right for a row an operator is editing
        // and lossy on a document someone else wrote.
        'version/required',
        'author/unknown-field',
        'nodes[1].nodeId/duplicate-node-id',
        'connections[0].condition.left.source/condition-operand-unknown',
        'startNodeIds[0]/invalid-start-set'
      ])
    );
  });

  it('reports an empty start set, which cannot co-occur with a dangling one', () => {
    // Two different mistakes about the same field: `startNodeIds: []` names
    // nothing to begin at, a dangling entry names the wrong thing. A document
    // has one or the other, never both, so this is its own case rather than a
    // sixth entry in the list above.
    const found = codesOf(
      defectsOf(wf({ spec: ['nodes:', '  - nodeId: draft', '    pipelineId: spec-authoring'] }))
    );
    expect(found).toContain('startNodeIds/invalid-start-set');
  });

  it('reports every defective node and connection, not the first of each list', () => {
    const found = codesOf(
      defectsOf(
        wf({
          spec: [
            'nodes:',
            '  - nodeId: Not Valid',
            '    pipelineId: spec-authoring',
            '  - nodeId: review',
            '    pipelineId: Not Valid',
            'connections:',
            ...CONNECTION_ENDPOINTS,
            '    priority: high',
            ...CONNECTION_ENDPOINTS,
            '    selection: whichever',
            'startNodeIds:',
            '  - review'
          ]
        })
      )
    );
    expect(found).toEqual(
      expect.arrayContaining([
        'nodes[0].nodeId/invalid-pattern',
        'nodes[1].pipelineId/invalid-pattern',
        'connections[0].priority/invalid-range',
        'connections[1].selection/invalid-enum'
      ])
    );
  });

  it('names a Pipeline reference that is not an identifier rather than resolving it', () => {
    // FR-009 of feature 085, unchanged one level up: a reference is a plain
    // identifier, and a path-shaped one is refused as a malformed id. It is
    // never opened, joined, or resolved as a location, and the refusal does not
    // echo the path back.
    const found = defectsOf(
      wf({
        spec: [
          'nodes:',
          '  - nodeId: draft',
          '    pipelineId: ../../etc/passwd',
          'startNodeIds:',
          '  - draft'
        ]
      })
    );
    expect(codesOf(found)).toContain('nodes[0].pipelineId/invalid-pattern');
    for (const entry of found) {
      expect(entry.message).not.toContain('/etc/passwd');
    }
  });

  it('carries the declared id when it is well formed, and null when it is not', () => {
    // The operator has to be able to tell which resource the defects belong to,
    // so a bad version must not also hide which Workflow is at fault.
    const withId = resourcesOf(wf({ metadata: ['id: ship-it-flow', 'name: Ship It Flow'] }))[0];
    expect(withId?.ok).toBe(false);
    if (withId !== undefined && !withId.ok) expect(withId.resourceId).toBe('ship-it-flow');

    const withoutId = resourcesOf(wf({ metadata: ['name: Ship It Flow', 'version: 1'] }))[0];
    expect(withoutId?.ok).toBe(false);
    if (withoutId !== undefined && !withoutId.ok) expect(withoutId.resourceId).toBeNull();
  });

  it('reports a connection path in full rather than truncating it', () => {
    // `connections[0].condition.left.source` is 36 characters — longer than the
    // 32 the shipped exchange reader bounded a defect field to, which would hand
    // the operator `connections[0].condition.left.so` and no way to find the
    // field. The catalog validator already widened its own cap to 48 for exactly
    // this shape; the reader quoting it back must be at least as wide.
    const found = defectsOf(
      wf({
        spec: specWithConnection([
          ...CONNECTION_ENDPOINTS,
          '    condition:',
          '      left:',
          '        source: telepathy',
          '      operator: equals',
          '      right: yes'
        ])
      })
    );
    expect(codesOf(found)).toContain('connections[0].condition.left.source/condition-operand-unknown');
  });

  it('bounds every defect field so a document cannot inject a wall of text', () => {
    // Bounded, and bounded at the shared constant rather than at a number
    // written twice — an author-supplied key is still author-supplied however
    // deep the format's own paths go.
    const found = defectsOf(wf({ metadata: [...WELL_FORMED_WORKFLOW_METADATA, `${'k'.repeat(200)}: v`] }));
    expect(found.length).toBeGreaterThan(0);
    for (const entry of found) {
      expect(entry.field.length).toBeLessThanOrEqual(DEFECT_FIELD_MAX);
      expect(entry.code.length).toBeLessThanOrEqual(64);
      expect(entry.message.length).toBeLessThanOrEqual(512);
    }
  });

  it('classifies every declared resource even when the root Workflow is invalid', () => {
    // FR-024's rule, one level up: one defective resource does not silence the
    // others, in either direction.
    const found = resourcesOf(
      wf({
        metadata: ['id: Not Valid', 'name: Ship It Flow', 'version: 1'],
        pipelines: [INCLUDED_PIPELINE, includedBody(['id: broken', 'version: 0'], ['phaseIds:'])],
        phases: [INCLUDED_PHASE]
      })
    );
    expect(found.map((resource) => resource.resourceKind)).toEqual([
      'workflow',
      'pipeline',
      'pipeline',
      'phase'
    ]);
    expect(found.map((resource) => resource.ok)).toEqual([false, true, false, true]);
  });

  it('gives an included Pipeline exactly the defects a root Pipeline document would', () => {
    // Not a similar list, the SAME one — produced by the shipped Pipeline rules
    // rather than by a second copy of them (FR-008 on read). A rule the Pipeline
    // reader gains is gained here too, without this test being edited.
    const packaged = resourcesOf(
      wf({
        pipelines: [
          includedBody(
            ['id: Not Valid', 'version: 0', 'author: someone'],
            ['phaseIds:', '  - specify', 'executionDefaults:', '  effort: extreme']
          )
        ]
      })
    )[1];

    expect(packaged?.ok).toBe(false);
    if (packaged !== undefined && !packaged.ok) {
      expect(codesOf(packaged.defects)).toEqual(
        expect.arrayContaining([
          'id/invalid-pattern',
          'name/invalid-length',
          'version/positive-integer-required',
          'author/unknown-field',
          'executionDefaults.effort/invalid-enum'
        ])
      );
    }
  });

  it('gives an included Phase exactly the defects a standalone Phase document would', () => {
    const packaged = resourcesOf(
      wf({ phases: [includedBody(['phaseId: Not Valid', 'version: 0'], ['effort: extreme'])] })
    )[1];

    expect(packaged?.ok).toBe(false);
    if (packaged !== undefined && !packaged.ok) {
      expect(codesOf(packaged.defects)).toEqual(
        expect.arrayContaining(['phaseId/invalid-pattern', 'version/positive-integer-required'])
      );
    }
  });
});

describe('Feature 086 T030 — the closed format admits no field outside it (§3.3)', () => {
  // Each row of the table is a shape the source request sketched or a projection
  // the catalog derives. None is an omission to be forgiven: a document written
  // against the wrong mental model must fail visibly rather than import with its
  // meaning quietly dropped, which is the difference between refusing a field
  // and accepting it and throwing it away.

  it('refuses a connection identifier, because a shipped connection has none', () => {
    expect(
      codesOf(defectsOf(wf({ spec: specWithConnection([...CONNECTION_ENDPOINTS, '    connectionId: c1']) })))
    ).toContain('connections[0].connectionId/unknown-field');
  });

  it('refuses a dotted endpoint string, which would silently mis-split an id', () => {
    // An endpoint is structured `{ nodeId, portId }`. `draft.spec-document` is
    // one string, and an id containing a dot would split in the wrong place —
    // so the string is refused rather than parsed. Asserted on each side, because
    // the two are read by the same helper and a check on one only would not say so.
    const dotted: Readonly<Record<'from' | 'to', readonly string[]>> = {
      from: [
        '  - from: draft.spec-document',
        '    to:',
        '      nodeId: review',
        '      portId: spec'
      ],
      to: ['  - from:', '      nodeId: draft', '      portId: spec-document', '    to: review.spec']
    };
    for (const key of ['from', 'to'] as const) {
      const found = codesOf(defectsOf(wf({ spec: specWithConnection(dotted[key]) })));
      expect(found).toContain(`connections[0].${key}/object-required`);
    }
  });

  it('refuses a JSONPath condition, because a path is an expression language', () => {
    // The standing hard rule: a condition has no string form, no parser, and no
    // evaluator. `$.status` is refused as a field the format does not admit —
    // there is nothing here that could evaluate it even if it were kept.
    const found = codesOf(
      defectsOf(
        wf({
          spec: specWithConnection([
            ...CONNECTION_ENDPOINTS,
            '    condition:',
            '      path: "$.status"',
            '      operator: equals',
            '      right: completed'
          ])
        })
      )
    );
    expect(found).toContain('connections[0].condition.path/unsupported-condition');
  });

  it('refuses the pre-structural condition spellings that `left` and `right` superseded', () => {
    for (const key of ['output', 'value'] as const) {
      const found = codesOf(
        defectsOf(
          wf({
            spec: specWithConnection([
              ...CONNECTION_ENDPOINTS,
              '    condition:',
              `      ${key}: verdict`,
              '      left:',
              '        source: node-status',
              '        nodeId: draft',
              '      operator: equals',
              '      right: completed'
            ])
          })
        )
      );
      expect(found).toContain(`connections[0].condition.${key}/unsupported-condition`);
    }
  });

  it('refuses `transition`, which is not in the shipped type', () => {
    expect(
      codesOf(defectsOf(wf({ spec: [...WELL_FORMED_WORKFLOW_SPEC, 'transition: manual'] })))
    ).toContain('transition/unknown-field');
  });

  it('refuses stored ports, because a Workflow derives them on read', () => {
    // The standing hard rule: a Workflow's inputs and outputs are the unbound
    // ports of its node Pipelines, derived by `workflow-derived-ports.ts`. A
    // stored copy is a second source of truth that goes stale the moment a node's
    // Pipeline changes shape — so the format refuses it on read as well as never
    // writing it.
    const found = codesOf(
      defectsOf(
        wf({
          spec: [
            ...WELL_FORMED_WORKFLOW_SPEC,
            'inputs:',
            '  - portId: brief',
            '    label: Brief',
            '    type: text',
            'outputs:',
            '  - portId: spec',
            '    label: Spec',
            '    type: markdown'
          ]
        })
      )
    );
    expect(found).toContain('inputs/unknown-field');
    expect(found).toContain('outputs/unknown-field');
  });

  it('refuses an inline Pipeline body on a node, in place of or beside its reference', () => {
    // FR-009's read half. Export never rewrites a `pipelineId` into an inline
    // anonymous definition; this is the same claim on the untrusted-document
    // path, where the document was not written by this extension. An anonymous
    // Pipeline has no id to plan a row for and no catalog row to be written
    // back to, so admitting one would import a definition nothing owns.
    const inline = [
      '  - nodeId: draft',
      '    pipeline:',
      '      name: Anonymous',
      '      phaseIds:',
      '        - specify'
    ];

    const insteadOf = codesOf(defectsOf(wf({ spec: ['nodes:', ...inline, 'startNodeIds:', '  - draft'] })));
    expect(insteadOf).toContain('nodes[0].pipeline/unknown-field');

    const alongside = codesOf(
      defectsOf(
        wf({
          spec: [
            'nodes:',
            '  - nodeId: draft',
            '    pipelineId: spec-authoring',
            '    pipeline:',
            '      name: Anonymous',
            'startNodeIds:',
            '  - draft'
          ]
        })
      )
    );
    expect(alongside).toContain('nodes[0].pipeline/unknown-field');
  });

  it('refuses a stray key at every depth the format has, not just the top', () => {
    // One document, one assertion per depth: root, metadata, spec, node,
    // connection, endpoint, condition, operand. A reader that admitted keys
    // loosely at any one of them would drop meaning silently there.
    const found = codesOf(
      defectsOf(
        wf({
          metadata: [...WELL_FORMED_WORKFLOW_METADATA, 'owner: someone'],
          spec: [
            'nodes:',
            '  - nodeId: draft',
            '    pipelineId: spec-authoring',
            '    retries: 3',
            '  - nodeId: review',
            '    pipelineId: spec-review',
            'connections:',
            '  - from:',
            '      nodeId: draft',
            '      portId: spec-document',
            '      transform: uppercase',
            '    to:',
            '      nodeId: review',
            '      portId: spec',
            '    condition:',
            '      left:',
            '        source: node-status',
            '        nodeId: draft',
            '        window: 5m',
            '      operator: equals',
            '      right: completed',
            '    onFailure: retry',
            'startNodeIds:',
            '  - draft'
          ]
        })
      )
    );

    expect(found).toEqual(
      expect.arrayContaining([
        'owner/unknown-field',
        'nodes[0].retries/unknown-field',
        'connections[0].from.transform/unknown-field',
        'connections[0].condition.left.window/unsupported-condition',
        'connections[0].onFailure/unknown-field'
      ])
    );
  });

  it('keeps `__proto__` an ordinary key rather than setting a prototype', () => {
    // The document is untrusted input, and every mapping below the admitted key
    // sets is forwarded wholesale to the catalog validator. A prototype-bearing
    // mapping would escape both the unknown-field scan and `Object.keys`, so the
    // reader synthesizes prototype-less mappings and the key is reported like
    // any other stray one.
    const found = codesOf(
      defectsOf(
        wf({
          spec: [
            'nodes:',
            '  - nodeId: draft',
            '    pipelineId: spec-authoring',
            '    __proto__: polluted',
            'startNodeIds:',
            '  - draft'
          ]
        })
      )
    );
    expect(found).toContain('nodes[0].__proto__/unknown-field');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
