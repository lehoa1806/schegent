// Feature 083 (US1, T037) — Workflow Builder draft state.
//
// The module is plain TypeScript precisely so these rules are testable without a
// DOM. Three things are pinned here:
//
//   - authored node and connection order survives every draft operation
//     (FR-049) — add appends, edit replaces in place, remove closes the gap, and
//     nothing sorts;
//   - a host defect anchors to the control that produced it by parsing the field
//     path the host emits (`connections[2].to`, `nodes[0].nodeId`), with an
//     unrecognized or out-of-range path falling back to the Workflow level
//     rather than being dropped;
//   - the save row carries exactly the authored contract fields, so no
//     projection-only value (source status, scope badge, derived ports) can ride
//     back to the host.

import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_CONDITION_OPERATORS,
  WORKFLOW_NODE_TERMINAL_STATUSES,
  type PortablePipelineDefinition,
  type WorkflowCatalogSourceProjection,
  type WorkflowCondition,
  type WorkflowConditionOperator
} from '../../lib/snapshot-types';
import {
  addWorkflowBranch,
  addWorkflowConditionValue,
  addWorkflowConnection,
  addWorkflowNode,
  insertWorkflowNodeAfter,
  spliceWorkflowNodeIntoConnection,
  conditionRightArity,
  conditionValues,
  formatWorkflowConditionLiteral,
  formatWorkflowSaveRejection,
  isWorkflowDirty,
  makeNewWorkflowDraft,
  makeWorkflowCondition,
  parseWorkflowConditionLiteral,
  removeWorkflowConditionValue,
  removeWorkflowConnection,
  removeWorkflowNode,
  sourceRecordToMutableWorkflow,
  toSaveWorkflowRow,
  updateWorkflowCondition,
  updateWorkflowConditionValue,
  updateWorkflowConnection,
  updateWorkflowNode,
  validateWorkflowDraft,
  workflowErrorAnchor,
  WORKFLOW_CONDITION_OPERAND_SOURCES,
  type WorkflowConditionRightArity,
  type WorkflowDraftError
} from '../PipelineBuilderEditors/workflow-catalog-state';
import type { MutableWorkflow } from '../PipelineBuilderEditors/types';

const RECORD: WorkflowCatalogSourceProjection = {
  key: 'release-train::0',
  workflowId: 'release-train',
  status: 'effective',
  definition: {
    workflowId: 'release-train',
    name: 'Release Train',
    description: 'Draft, then ship.',
    version: 2,
    // Deliberately not in dependency order: `ship` is listed first.
    nodes: [
      { nodeId: 'ship', pipelineId: 'release-pipeline' },
      { nodeId: 'draft', pipelineId: 'spec-pipeline' }
    ],
    connections: [
      { from: { nodeId: 'draft', portId: 'spec' }, to: { nodeId: 'ship', portId: 'brief' } }
    ],
    startNodeIds: ['draft']
  },
  display: {},
  errors: [],
  derivedInputs: [{ nodeId: 'draft', portId: 'goal', label: 'Goal', type: 'text' }],
  derivedOutputs: [{ nodeId: 'ship', portId: 'log', label: 'Log', type: 'markdown' }]
};

const row = (): MutableWorkflow => sourceRecordToMutableWorkflow(RECORD);

const error = (field: string): WorkflowDraftError => ({
  field,
  code: 'invalid-pattern',
  message: 'nope'
});

describe('sourceRecordToMutableWorkflow', () => {
  it('carries the authored graph and the source metadata the Library renders', () => {
    // Feature 099 (T496f, FR-042) — `scope` was the projection metadata the
    // Library rendered as a badge, and it goes with the layer tier. `sourceKey`
    // stays and is what distinguishes two rows claiming one id.
    const workflow = row();
    expect(workflow.workflowId).toBe('release-train');
    expect(workflow.version).toBe(2);
    expect(workflow.sourceStatus).toBe('effective');
    expect(workflow.sourceKey).toBe('release-train::0');
    expect(workflow.persisted).toBe(true);
    expect(workflow.nodes.map((node) => node.nodeId)).toEqual(['ship', 'draft']);
  });

  it('copies the nested graph rather than aliasing the projection', () => {
    const workflow = row();
    // Structural equality but no shared references, down to the endpoints: the
    // projection is host-owned and a draft edit must not reach into it.
    expect(workflow.nodes[0]).toEqual(RECORD.definition?.nodes[0]);
    expect(workflow.nodes[0]).not.toBe(RECORD.definition?.nodes[0]);
    expect(workflow.connections[0]).not.toBe(RECORD.definition?.connections[0]);
    expect(workflow.connections[0].from).not.toBe(RECORD.definition?.connections[0].from);
    expect(workflow.startNodeIds).not.toBe(RECORD.definition?.startNodeIds);
  });

  it('falls back to the authored display scalars when the record failed to parse', () => {
    const invalid: WorkflowCatalogSourceProjection = {
      ...RECORD,
      status: 'invalid',
      definition: null,
      display: { workflowId: 'broken', name: 'Broken', version: 3 },
      errors: [{ field: 'nodes', code: 'non-empty-required', message: 'needs a node' }]
    };
    const workflow = sourceRecordToMutableWorkflow(invalid);
    // An empty row would silently discard what the operator typed.
    expect(workflow.workflowId).toBe('broken');
    expect(workflow.name).toBe('Broken');
    expect(workflow.version).toBe(3);
    expect(workflow.nodes).toEqual([]);
    expect(workflow.sourceErrors).toHaveLength(1);
  });
});

describe('toSaveWorkflowRow', () => {
  it('emits only the authored contract fields', () => {
    expect(Object.keys(toSaveWorkflowRow(row())).sort()).toEqual([
      'connections',
      'description',
      'name',
      'nodes',
      'startNodeIds',
      'version',
      'workflowId'
    ]);
  });

  it('omits an empty description rather than sending a blank string', () => {
    const workflow = { ...row(), description: '   ' };
    expect('description' in toSaveWorkflowRow(workflow)).toBe(false);
  });

  it('preserves authored node and connection order (FR-049)', () => {
    const saved = toSaveWorkflowRow(row());
    expect(saved.nodes.map((node) => node.nodeId)).toEqual(['ship', 'draft']);
    expect(saved.startNodeIds).toEqual(['draft']);
  });
});

describe('node and connection row editing', () => {
  it('appends a node at the end and leaves the existing order alone', () => {
    const next = addWorkflowNode(row(), { nodeId: 'audit', pipelineId: 'audit-pipeline' });
    expect(next.nodes.map((node) => node.nodeId)).toEqual(['ship', 'draft', 'audit']);
  });

  it('edits a node in place without moving it', () => {
    const next = updateWorkflowNode(row(), 0, { pipelineId: 'other-pipeline' });
    expect(next.nodes[0]).toEqual({ nodeId: 'ship', pipelineId: 'other-pipeline' });
    expect(next.nodes.map((node) => node.nodeId)).toEqual(['ship', 'draft']);
  });

  it('drops a node and every connection and allowed start that named it', () => {
    const next = removeWorkflowNode(row(), 1);
    expect(next.nodes.map((node) => node.nodeId)).toEqual(['ship']);
    // Leaving the dangling edge behind would send the host a graph the operator
    // never authored and get the whole layer rejected.
    expect(next.connections).toEqual([]);
    expect(next.startNodeIds).toEqual([]);
  });

  it('appends and edits connections in place, and removes by position', () => {
    const added = addWorkflowConnection(row(), {
      from: { nodeId: 'ship', portId: 'log' },
      to: { nodeId: 'draft', portId: 'goal' }
    });
    expect(added.connections).toHaveLength(2);
    expect(added.connections[1].from.portId).toBe('log');

    const edited = updateWorkflowConnection(added, 0, { priority: 5 });
    expect(edited.connections[0].priority).toBe(5);
    expect(edited.connections[0].from).toEqual({ nodeId: 'draft', portId: 'spec' });
    expect(edited.connections[1].from.portId).toBe('log');

    expect(removeWorkflowConnection(edited, 0).connections).toHaveLength(1);
  });

  it('ignores an out-of-range index instead of corrupting the draft', () => {
    const base = row();
    expect(updateWorkflowNode(base, 9, { pipelineId: 'x' }).nodes).toEqual(base.nodes);
    expect(removeWorkflowNode(base, -1).nodes).toEqual(base.nodes);
    expect(updateWorkflowConnection(base, 9, { priority: 1 }).connections).toEqual(
      base.connections
    );
    expect(removeWorkflowConnection(base, 9).connections).toEqual(base.connections);
  });
});

describe('makeNewWorkflowDraft', () => {
  it('produces an unsaved row with a free identifier', () => {
    // Feature 099 (T496f, FR-042, FR-043) — the target-scope argument left with
    // the picker that supplied it; a draft has one catalog to land in. What the
    // helper still decides is that the id is free and the row is unsaved.
    const draft = makeNewWorkflowDraft(['new-workflow']);
    expect(draft.persisted).toBe(false);
    expect(draft.workflowId).not.toBe('new-workflow');
    expect(draft.nodes).toEqual([]);
    expect(draft.startNodeIds).toEqual([]);
  });
});

describe('workflowErrorAnchor', () => {
  const workflow = row();

  it.each([['workflowId'], ['name'], ['description'], ['version']])(
    'anchors the scalar %s beside its own control',
    (field) => {
      expect(workflowErrorAnchor(error(field), workflow)).toEqual({ kind: 'field', field });
    }
  );

  it.each([
    ['nodes[1].nodeId', 1],
    ['nodes[0].pipelineId', 0],
    ['nodes[0]', 0]
  ])('anchors %s to its node row', (field, index) => {
    expect(workflowErrorAnchor(error(field), workflow)).toEqual({ kind: 'node', index });
  });

  it.each([
    ['connections[0].to', 0],
    ['connections[0].condition.left.nodeId', 0],
    ['connections[0].selection', 0]
  ])('anchors %s to its connection row', (field, index) => {
    expect(workflowErrorAnchor(error(field), workflow)).toEqual({ kind: 'connection', index });
  });

  it('anchors the allowed-start set and its entries to the start control', () => {
    expect(workflowErrorAnchor(error('startNodeIds'), workflow)).toEqual({ kind: 'starts' });
    expect(workflowErrorAnchor(error('startNodeIds[0]'), workflow)).toEqual({ kind: 'starts' });
  });

  it('anchors the whole-list codes to their list rather than to a row', () => {
    expect(workflowErrorAnchor(error('nodes'), workflow)).toEqual({ kind: 'node-list' });
    expect(workflowErrorAnchor(error('connections'), workflow)).toEqual({
      kind: 'connection-list'
    });
  });

  it('falls back to the Workflow level for an out-of-range or unknown path', () => {
    // Never dropped: an error with nowhere of its own to land stays visible.
    expect(workflowErrorAnchor(error('nodes[42].nodeId'), workflow)).toEqual({ kind: 'workflow' });
    expect(workflowErrorAnchor(error('connections[42].to'), workflow)).toEqual({
      kind: 'workflow'
    });
    expect(workflowErrorAnchor(error('somethingElse'), workflow)).toEqual({ kind: 'workflow' });
  });
});

describe('validateWorkflowDraft', () => {
  it('accepts a complete draft', () => {
    expect(validateWorkflowDraft(row(), [])).toEqual([]);
  });

  it.each([
    ['Bad Id', 'workflowId', 'invalid-pattern'],
    ['', 'workflowId', 'invalid-pattern']
  ])('rejects the identifier %s', (workflowId, field, code) => {
    const errors = validateWorkflowDraft({ ...row(), workflowId, persisted: false }, []);
    expect(errors).toContainEqual(expect.objectContaining({ field, code }));
  });

  it('rejects an identifier already taken in the target scope, but only for a draft', () => {
    const taken = ['release-train'];
    expect(validateWorkflowDraft({ ...row(), persisted: false }, taken)).toContainEqual(
      expect.objectContaining({ field: 'workflowId', code: 'duplicate-id' })
    );
    // A persisted row keeps its own id; that is not a collision with itself.
    expect(validateWorkflowDraft(row(), taken)).toEqual([]);
  });

  it('requires a name and at least one node', () => {
    const errors = validateWorkflowDraft(
      { ...row(), name: '  ', nodes: [], connections: [], startNodeIds: [] },
      []
    );
    // No `startNodeIds` entry: with no nodes there is nothing to choose from, so
    // asking the operator to pick a start would be an unsatisfiable instruction.
    expect(errors.map((entry) => entry.field).sort()).toEqual(['name', 'nodes']);
  });

  it('requires an allowed start once the graph has nodes', () => {
    expect(validateWorkflowDraft({ ...row(), startNodeIds: [] }, [])).toEqual([
      expect.objectContaining({ field: 'startNodeIds', code: 'invalid-start-set' })
    ]);
  });

  it('reports a duplicate node id, which the host would reject anyway (FR-009)', () => {
    const workflow = row();
    workflow.nodes[1] = { nodeId: 'ship', pipelineId: 'spec-pipeline' };
    expect(validateWorkflowDraft(workflow, [])).toContainEqual(
      expect.objectContaining({ field: 'nodes[1].nodeId', code: 'duplicate-node-id' })
    );
  });
});

describe('isWorkflowDirty', () => {
  it('compares the save shape, not the projection metadata', () => {
    expect(isWorkflowDirty(row(), null)).toBe(true);
    expect(isWorkflowDirty(row(), row())).toBe(false);
    expect(isWorkflowDirty({ ...row(), sourceStatus: 'invalid' }, row())).toBe(false);
    expect(isWorkflowDirty({ ...row(), name: 'Renamed' }, row())).toBe(true);
  });
});

describe('formatWorkflowSaveRejection', () => {
  it('lists the first few host defects and counts the rest', () => {
    const message = formatWorkflowSaveRejection('workflow-validation', {
      errors: [
        { workflowId: 'release-train', field: 'connections[0].to', message: 'unknown port' },
        { workflowId: 'release-train', field: 'nodes[0].pipelineId', message: 'unknown Pipeline' },
        { workflowId: 'release-train', field: 'startNodeIds', message: 'no start' },
        { workflowId: 'release-train', field: 'name', message: 'too long' }
      ],
      total: 9
    });
    expect(message).toContain('connections[0].to: unknown port');
    // 9 defects found, 4 forwarded — the count comes from the host's total, not
    // from the length of the truncated list.
    expect(message).toContain('+5 more');
  });

  it('states the recovery for a stale catalog and the suppression for a cycle', () => {
    expect(formatWorkflowSaveRejection('stale-catalog', undefined)).toContain('reapply');
    // Narrow on purpose: a cycle suppresses only the ancestry check, so the
    // notice must not claim condition checking as a whole was skipped.
    const message = formatWorkflowSaveRejection('workflow-validation', {
      errors: [{ field: 'connections[1]', code: 'graph-cycle', message: 'cycle' }],
      ancestryChecksSuppressed: true
    });
    expect(message).toContain('reads only an earlier node');
    expect(message).toContain('Cut the cycle');
  });

  it('passes an unrecognized reason through unchanged', () => {
    expect(formatWorkflowSaveRejection('trust-denied', undefined)).toBe('trust-denied');
  });
});

// Feature 083 (US4, T048) — condition authoring.
//
// What matters here is what the operator *cannot* do. A condition is structured
// data (FR-021): there is no expression to type, so every choice that decides
// meaning comes from a closed set and the only free text left is the value being
// compared against. These cases pin those sets, the right-operand arity rule
// (FR-024), and the coercions that keep a draft authorable while the operator
// switches operator or operand source — a switch that left the draft in a shape
// the host rejects would put a defect on screen the operator did not cause.
describe('condition authoring (T048)', () => {
  const conditional = (condition: WorkflowCondition) =>
    updateWorkflowConnection(row(), 0, { condition });
  const conditionOf = (workflow: MutableWorkflow) => workflow.connections[0].condition;

  const OUTPUT_EQUALS: WorkflowCondition = {
    left: { source: 'node-output', nodeId: 'draft', field: 'risk' },
    operator: 'equals',
    right: 'high'
  };

  it('offers exactly the two operand sources the contract declares', () => {
    expect(WORKFLOW_CONDITION_OPERAND_SOURCES).toEqual(['node-output', 'node-status']);
  });

  it('assigns a right-operand arity to every operator the contract declares (FR-024)', () => {
    // The `Record` makes omitting an operator a compile error; the key check
    // catches one *removed* from the contract, which the type cannot.
    const ARITY: Record<WorkflowConditionOperator, WorkflowConditionRightArity> = {
      equals: 'one',
      notEquals: 'one',
      in: 'list',
      exists: 'none',
      greaterThan: 'one',
      greaterThanOrEqual: 'one',
      lessThan: 'one',
      lessThanOrEqual: 'one'
    };
    expect(Object.keys(ARITY).sort()).toEqual([...WORKFLOW_CONDITION_OPERATORS].sort());
    for (const operator of WORKFLOW_CONDITION_OPERATORS) {
      expect(conditionRightArity(operator)).toBe(ARITY[operator]);
    }
  });

  it('seeds a new condition that is valid against any node', () => {
    // `node-status` on purpose: `node-output` additionally requires the source
    // Pipeline to declare a structured output port and a field name, so it would
    // be rejected the moment it appeared.
    const condition = makeWorkflowCondition('draft');
    expect(condition).toEqual({
      left: { source: 'node-status', nodeId: 'draft' },
      operator: 'equals',
      right: 'completed'
    });
    // No expression key exists to carry authored text — the shape has no room.
    expect(Object.keys(condition).sort()).toEqual(['left', 'operator', 'right']);
    expect(Object.keys(condition.left).sort()).toEqual(['nodeId', 'source']);
  });

  it('rides back to the host verbatim, and clearing removes the key entirely', () => {
    const enabled = conditional(OUTPUT_EQUALS);
    expect(toSaveWorkflowRow(enabled).connections[0].condition).toEqual(OUTPUT_EQUALS);

    const cleared = updateWorkflowConnection(enabled, 0, { condition: undefined });
    // `condition: undefined` would serialize the key; absence is what the host
    // reads as "unconditional".
    expect('condition' in toSaveWorkflowRow(cleared).connections[0]).toBe(false);
  });

  it('leaves the draft untouched for an out-of-range index or an unconditional edge', () => {
    const unconditional = row();
    expect(updateWorkflowCondition(unconditional, 0, { operator: 'exists' })).toBe(unconditional);
    const enabled = conditional(OUTPUT_EQUALS);
    expect(updateWorkflowCondition(enabled, 7, { operator: 'exists' })).toBe(enabled);
  });

  it('re-shapes the right operand when the operator changes arity', () => {
    const scalar = conditional(OUTPUT_EQUALS);

    const exists = updateWorkflowCondition(scalar, 0, { operator: 'exists' });
    expect(conditionOf(exists)).toEqual({ left: OUTPUT_EQUALS.left, operator: 'exists' });
    expect('right' in conditionOf(exists)!).toBe(false);

    // Back from `exists`: a missing right operand is itself a defect, so one is
    // seeded rather than left for the host to reject.
    expect(conditionOf(updateWorkflowCondition(exists, 0, { operator: 'equals' }))?.right).toBe('');

    // An empty `in` list is rejected by the host, so the scalar is wrapped.
    const list = updateWorkflowCondition(scalar, 0, { operator: 'in' });
    expect(conditionOf(list)?.right).toEqual(['high']);
    expect(conditionOf(updateWorkflowCondition(exists, 0, { operator: 'in' }))?.right).toEqual(['']);

    // And narrowing back takes the first authored value, not the whole list.
    const widened = updateWorkflowConditionValue(addWorkflowConditionValue(list, 0), 0, 1, 'low');
    expect(conditionOf(widened)?.right).toEqual(['high', 'low']);
    expect(conditionOf(updateWorkflowCondition(widened, 0, { operator: 'notEquals' }))?.right).toBe(
      'high'
    );
  });

  it('re-shapes the operand when the source changes, keeping the node', () => {
    const output = conditional(OUTPUT_EQUALS);
    const status = updateWorkflowCondition(output, 0, { source: 'node-status' });
    // The `node-status` shape has no field, and `high` is not a run status.
    expect(conditionOf(status)?.left).toEqual({ source: 'node-status', nodeId: 'draft' });
    expect(conditionOf(status)?.right).toBe('completed');

    const back = updateWorkflowCondition(status, 0, { source: 'node-output' });
    expect(conditionOf(back)?.left).toEqual({
      source: 'node-output',
      nodeId: 'draft',
      field: ''
    });
    // Nothing coerces a `node-output` literal, so the status value survives.
    expect(conditionOf(back)?.right).toBe('completed');
  });

  it('keeps a right operand the new source still allows', () => {
    const failed = conditional({ ...OUTPUT_EQUALS, right: 'failed' });
    expect(conditionOf(updateWorkflowCondition(failed, 0, { source: 'node-status' }))?.right).toBe(
      'failed'
    );
    const mixed = conditional({
      left: OUTPUT_EQUALS.left,
      operator: 'in',
      right: ['completed', 'high']
    });
    expect(
      conditionOf(updateWorkflowCondition(mixed, 0, { source: 'node-status' }))?.right
    ).toEqual(['completed']);
    const none = conditional({ left: OUTPUT_EQUALS.left, operator: 'in', right: ['high'] });
    // Filtering everything out would leave the empty list the host rejects.
    expect(conditionOf(updateWorkflowCondition(none, 0, { source: 'node-status' }))?.right).toEqual([
      'completed'
    ]);
  });

  it('retargets the node and edits the field without disturbing the rest', () => {
    const connection = { ...row().connections[0], condition: OUTPUT_EQUALS, priority: 20 };
    const workflow = updateWorkflowConnection(row(), 0, connection);

    const retargeted = updateWorkflowCondition(workflow, 0, { nodeId: 'ship' });
    expect(conditionOf(retargeted)?.left).toEqual({
      source: 'node-output',
      nodeId: 'ship',
      field: 'risk'
    });
    expect(retargeted.connections[0].priority).toBe(20);

    expect(conditionOf(updateWorkflowCondition(workflow, 0, { field: 'severity' }))?.left).toEqual({
      source: 'node-output',
      nodeId: 'draft',
      field: 'severity'
    });

    // A `node-status` operand has no field, so the patch has nowhere to land.
    const status = conditional(makeWorkflowCondition('draft'));
    expect(conditionOf(updateWorkflowCondition(status, 0, { field: 'risk' }))?.left).toEqual({
      source: 'node-status',
      nodeId: 'draft'
    });
  });

  it('reads the right operand as a list whatever its authored form', () => {
    expect(conditionValues(OUTPUT_EQUALS)).toEqual(['high']);
    expect(conditionValues({ left: OUTPUT_EQUALS.left, operator: 'exists' })).toEqual([]);
    expect(
      conditionValues({ left: OUTPUT_EQUALS.left, operator: 'in', right: ['a', 'b'] })
    ).toEqual(['a', 'b']);
  });

  it('edits one value at a time, and never empties an `in` list', () => {
    const list = conditional({ left: OUTPUT_EQUALS.left, operator: 'in', right: ['high'] });

    const added = addWorkflowConditionValue(list, 0);
    expect(conditionOf(added)?.right).toEqual(['high', '']);
    expect(conditionOf(updateWorkflowConditionValue(added, 0, 1, 'low'))?.right).toEqual([
      'high',
      'low'
    ]);
    expect(conditionOf(removeWorkflowConditionValue(added, 0, 0))?.right).toEqual(['']);
    // Removing the last one would author the empty list the host rejects.
    expect(removeWorkflowConditionValue(list, 0, 0)).toBe(list);

    // A scalar operator has exactly one slot, addressed as index 0.
    const scalar = conditional(OUTPUT_EQUALS);
    expect(conditionOf(updateWorkflowConditionValue(scalar, 0, 0, 'low'))?.right).toBe('low');
    expect(updateWorkflowConditionValue(scalar, 0, 1, 'low')).toBe(scalar);
    // `exists` has no slot at all.
    const exists = conditional({ left: OUTPUT_EQUALS.left, operator: 'exists' });
    expect(addWorkflowConditionValue(exists, 0)).toBe(exists);
    expect(updateWorkflowConditionValue(exists, 0, 0, 'low')).toBe(exists);
  });

  it('seeds a new `in` value the current source allows', () => {
    const status = conditional({
      left: { source: 'node-status', nodeId: 'draft' },
      operator: 'in',
      right: ['completed']
    });
    expect(conditionOf(addWorkflowConditionValue(status, 0))?.right).toEqual([
      'completed',
      'completed'
    ]);
  });

  it('reads typed text as a scalar literal, and shows it back unchanged', () => {
    // A comparison against a number or a boolean is meaningless if the value is
    // kept as text, so `5` and `true` are read as what they spell. The cost is
    // that the *string* "5" is not authorable through this control.
    expect(parseWorkflowConditionLiteral('true')).toBe(true);
    expect(parseWorkflowConditionLiteral('false')).toBe(false);
    expect(parseWorkflowConditionLiteral('5')).toBe(5);
    expect(parseWorkflowConditionLiteral('-2.5')).toBe(-2.5);
    expect(parseWorkflowConditionLiteral('  7  ')).toBe(7);
    // Anything else is the operator's text, kept verbatim — including the shapes
    // a looser rule would silently reinterpret.
    expect(parseWorkflowConditionLiteral('high')).toBe('high');
    expect(parseWorkflowConditionLiteral('')).toBe('');
    expect(parseWorkflowConditionLiteral('0x10')).toBe('0x10');
    expect(parseWorkflowConditionLiteral('007')).toBe('007');
    expect(parseWorkflowConditionLiteral('5 apples')).toBe('5 apples');
    expect(parseWorkflowConditionLiteral('TRUE')).toBe('TRUE');

    for (const text of ['true', 'false', '5', '-2.5', 'high', '']) {
      expect(formatWorkflowConditionLiteral(parseWorkflowConditionLiteral(text))).toBe(text);
    }
    expect(formatWorkflowConditionLiteral(undefined)).toBe('');
  });

  it('only ever authors a status the contract calls terminal', () => {
    // The status control is a select over this set, and every coercion above
    // falls back into it — there is no path that stores `running`.
    expect(WORKFLOW_NODE_TERMINAL_STATUSES).toEqual(['completed', 'failed', 'canceled']);
    const status = updateWorkflowCondition(conditional(OUTPUT_EQUALS), 0, {
      source: 'node-status'
    });
    const values = conditionValues(conditionOf(status)!);
    expect(values.every((value) => WORKFLOW_NODE_TERMINAL_STATUSES.includes(value as never))).toBe(
      true
    );
  });
});

// The canvas Builder's two composite edits (see `workflow-flow-layout.ts` for the
// layout half). Both exist because the canvas offers one gesture where the list
// Builder offered two controls, and a gesture that lands as two separate edits
// renders an intermediate graph the operator never authored.
describe('canvas composite edits', () => {
  const pipeline = (
    pipelineId: string,
    ports: Pick<PortablePipelineDefinition, 'inputs' | 'outputs'>
  ): PortablePipelineDefinition =>
    ({
      pipelineId,
      name: pipelineId,
      version: 1,
      phaseIds: [],
      bindings: [],
      recommendedNext: [],
      ...ports
    }) as PortablePipelineDefinition;

  const PIPELINES: readonly PortablePipelineDefinition[] = [
    pipeline('spec-pipeline', {
      inputs: [{ portId: 'goal', label: 'Goal', type: 'text' }],
      outputs: [{ portId: 'spec', label: 'Spec', type: 'markdown' }]
    }),
    pipeline('release-pipeline', {
      inputs: [{ portId: 'brief', label: 'Brief', type: 'text' }],
      outputs: [{ portId: 'log', label: 'Log', type: 'markdown' }]
    }),
    pipeline('portless', { inputs: [], outputs: [] })
  ];

  describe('insertWorkflowNodeAfter', () => {
    it('appends the node and one connection wiring the source to it', () => {
      const next = insertWorkflowNodeAfter(row(), 'draft', 'release-pipeline', PIPELINES);

      expect(next.nodes).toHaveLength(3);
      const added = next.nodes[2];
      expect(added.pipelineId).toBe('release-pipeline');
      expect(next.connections).toHaveLength(2);
      expect(next.connections[1]).toEqual({
        from: { nodeId: 'draft', portId: 'spec' },
        to: { nodeId: added.nodeId, portId: 'brief' }
      });
    });

    it('never reuses an existing node identifier', () => {
      const once = insertWorkflowNodeAfter(row(), 'draft', 'spec-pipeline', PIPELINES);
      const twice = insertWorkflowNodeAfter(once, 'draft', 'spec-pipeline', PIPELINES);

      const ids = twice.nodes.map((node) => node.nodeId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('leaves the draft untouched when the source node is not in it', () => {
      const before = row();
      expect(insertWorkflowNodeAfter(before, 'ghost', 'spec-pipeline', PIPELINES)).toEqual(before);
    });

    it('seeds empty port ids rather than throwing when a Pipeline declares none', () => {
      const next = insertWorkflowNodeAfter(row(), 'draft', 'portless', PIPELINES);

      // The host answers this with `unresolved-endpoint`; the point is that the
      // connection exists and is visible enough to retarget.
      expect(next.connections[1].to.portId).toBe('');
    });
  });

  describe('spliceWorkflowNodeIntoConnection', () => {
    it('retargets the arm at the new node and carries on to the original target', () => {
      const next = spliceWorkflowNodeIntoConnection(row(), 0, 'release-pipeline', PIPELINES);
      const added = next.nodes[2];

      expect(next.connections).toHaveLength(2);
      expect(next.connections[0]).toEqual({
        from: { nodeId: 'draft', portId: 'spec' },
        to: { nodeId: added.nodeId, portId: 'brief' }
      });
      expect(next.connections[1]).toEqual({
        from: { nodeId: added.nodeId, portId: 'log' },
        to: { nodeId: 'ship', portId: 'brief' }
      });
    });

    it('keeps the spliced arm branch metadata upstream and does not copy it downstream', () => {
      // The condition and the fallback marker say when THIS branch is taken, which
      // inserting a node on it did not change. Copying them downstream would
      // evaluate the condition twice and break one-default-per-source-node.
      const branching = updateWorkflowConnection(row(), 0, {
        condition: makeWorkflowCondition('draft'),
        isDefault: true,
        priority: 3
      });

      const next = spliceWorkflowNodeIntoConnection(branching, 0, 'release-pipeline', PIPELINES);

      expect(next.connections[0].condition).toBeDefined();
      expect(next.connections[0].isDefault).toBe(true);
      expect(next.connections[0].priority).toBe(3);
      expect(next.connections[1].condition).toBeUndefined();
      expect(next.connections[1].isDefault).toBeUndefined();
      expect(next.connections[1].priority).toBeUndefined();
    });

    it('leaves a self-connection alone rather than turning it into a longer cycle', () => {
      const selfEdge = addWorkflowConnection(row(), {
        from: { nodeId: 'draft', portId: 'spec' },
        to: { nodeId: 'draft', portId: 'goal' }
      });

      expect(spliceWorkflowNodeIntoConnection(selfEdge, 1, 'spec-pipeline', PIPELINES)).toEqual(
        selfEdge
      );
    });

    it('is a no-op for a connection index the draft does not hold', () => {
      const before = row();
      expect(spliceWorkflowNodeIntoConnection(before, 7, 'spec-pipeline', PIPELINES)).toEqual(
        before
      );
    });
  });

  describe('addWorkflowBranch', () => {
    it('does not mark the first arm on a node as the default', () => {
      // `ship` has no outgoing connection in the fixture.
      const next = addWorkflowBranch(row(), 'ship', PIPELINES);

      expect(next.connections).toHaveLength(2);
      expect(next.connections[1].from.nodeId).toBe('ship');
      expect(next.connections[1].isDefault).toBeUndefined();
    });

    it('seeds the second arm as the default, which is what makes a split terminate', () => {
      const next = addWorkflowBranch(row(), 'draft', PIPELINES);

      expect(next.connections[1].isDefault).toBe(true);
    });

    it('stops seeding a default once the node already has one', () => {
      const twoArms = addWorkflowBranch(row(), 'draft', PIPELINES);
      const threeArms = addWorkflowBranch(twoArms, 'draft', PIPELINES);

      expect(threeArms.connections.filter((edge) => edge.isDefault === true)).toHaveLength(1);
    });

    it('seeds a target that is not the source when another node exists', () => {
      const next = addWorkflowBranch(row(), 'draft', PIPELINES);

      expect(next.connections[1].to.nodeId).not.toBe('draft');
    });

    it('leaves the draft untouched when the source node is not in it', () => {
      const before = row();
      expect(addWorkflowBranch(before, 'ghost', PIPELINES)).toEqual(before);
    });
  });
});
