// Condition authoring is a closed-set form, not a text field.
//
// Carried over from the list Builder's `WorkflowGraphEditor` suite when the canvas
// replaced it: the surface moved from a connection row to the inspector, and none
// of the properties below moved with it. FR-021 is still the point — a condition is
// structured data and there is no expression to compile, evaluate, or sandbox — and
// the strongest way to hold it is still to make a free-text expression
// unauthorable, so every control that decides a condition's *meaning* (the operand
// source, the node, the comparison operator, and for a run status the value) must
// be a `<select>` whose options equal the closed contract set exactly.
//
// The one text input in a condition is the literal being compared against, which
// FR-024 bounds to exactly that: a value, never an operator or a path.
//
// The component owns no rules. Arity, coercion, literal parsing, and priority
// parsing all live in `workflow-catalog-state.ts` (pinned by
// `workflow-catalog-state.test.ts`), so these tests assert the wiring: which
// control exists, what it offers, whether `readonly` disables it, and which
// callback it raises with which arguments.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WORKFLOW_CONDITION_OPERATORS,
  WORKFLOW_NODE_TERMINAL_STATUSES,
  WORKFLOW_SELECTION_RULES,
  type PortablePipelineDefinition,
  type WorkflowCondition,
  type WorkflowConnection,
  type WorkflowNode
} from '../../lib/snapshot-types';
import WorkflowBranchInspector from '../PipelineBuilderEditors/WorkflowBranchInspector.svelte';
import type { MutableWorkflow } from '../PipelineBuilderEditors/types';
import {
  addWorkflowNode,
  makeNewWorkflowDraft,
  makeWorkflowNodeDraft,
  moveWorkflowNode,
  removeWorkflowNode,
  WORKFLOW_CONDITION_OPERAND_SOURCES
} from '../PipelineBuilderEditors/workflow-catalog-state';

afterEach(cleanup);

const NODES: readonly WorkflowNode[] = [
  { nodeId: 'draft', pipelineId: 'authoring' },
  { nodeId: 'ship', pipelineId: 'release' }
];

const PLAIN: WorkflowConnection = {
  from: { nodeId: 'draft', portId: 'spec' },
  to: { nodeId: 'ship', portId: 'brief' }
};

const conditional = (condition: WorkflowCondition): WorkflowConnection => ({ ...PLAIN, condition });

const STATUS_CONDITION: WorkflowCondition = {
  left: { source: 'node-status', nodeId: 'draft' },
  operator: 'equals',
  right: 'completed'
};

const OUTPUT_CONDITION: WorkflowCondition = {
  left: { source: 'node-output', nodeId: 'draft', field: 'risk' },
  operator: 'equals',
  right: 'high'
};

/** Only the fields the Builder reads; the rest of the contract is not exercised. */
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
  pipeline('authoring', {
    inputs: [{ portId: 'goal', label: 'Goal', type: 'text' }],
    outputs: [{ portId: 'spec', label: 'Spec', type: 'markdown' }]
  }),
  pipeline('release', {
    inputs: [{ portId: 'brief', label: 'Brief', type: 'text' }],
    outputs: [{ portId: 'tag', label: 'Tag', type: 'external-reference' }]
  })
];

const handlers = () => ({
  onretarget: vi.fn(),
  onpatch: vi.fn(),
  onconditiontoggle: vi.fn(),
  onconditionpatch: vi.fn(),
  onconditionvalue: vi.fn(),
  onconditionvalueadd: vi.fn(),
  onconditionvalueremove: vi.fn(),
  onmove: vi.fn(),
  onremove: vi.fn()
});

const mount = (
  connection: WorkflowConnection,
  readonly = false,
  nodes: readonly WorkflowNode[] = NODES
) => {
  const spies = handlers();
  const rendered = render(WorkflowBranchInspector, {
    props: {
      index: 0,
      connection,
      nodes,
      pipelines: PIPELINES,
      defects: [],
      readonly,
      connectionCount: 1,
      ...spies
    }
  });
  return { ...rendered, spies };
};

const optionValues = (select: HTMLSelectElement): string[] =>
  Array.from(select.options).map((option) => option.value);

describe('branch endpoints', () => {
  it('shows both endpoints as selects over the graph, so nothing unknown is authorable', () => {
    const { getByTestId } = mount(PLAIN);

    expect((getByTestId('workflow-connection-from-node-0') as HTMLSelectElement).value).toBe('draft');
    expect((getByTestId('workflow-connection-from-port-0') as HTMLSelectElement).value).toBe('spec');
    expect((getByTestId('workflow-connection-to-node-0') as HTMLSelectElement).value).toBe('ship');
    expect((getByTestId('workflow-connection-to-port-0') as HTMLSelectElement).value).toBe('brief');
  });

  it('offers only the ports the endpoint node’s Pipeline declares', () => {
    const { getByTestId } = mount(PLAIN);

    expect(optionValues(getByTestId('workflow-connection-from-port-0') as HTMLSelectElement)).toEqual(['spec']);
    expect(optionValues(getByTestId('workflow-connection-to-port-0') as HTMLSelectElement)).toEqual(['brief']);
  });

  it('raises a retarget naming the end and the patched field', async () => {
    const { getByTestId, spies } = mount(PLAIN);

    await fireEvent.change(getByTestId('workflow-connection-to-node-0'), {
      target: { value: 'draft' }
    });
    expect(spies.onretarget).toHaveBeenCalledWith(0, 'to', { nodeId: 'draft' });
  });

  it('offers no condition controls until the branch is marked conditional', () => {
    const { queryByTestId, getByTestId } = mount(PLAIN);

    expect((getByTestId('workflow-condition-enabled-0') as HTMLInputElement).checked).toBe(false);
    expect(queryByTestId('workflow-condition-source-0')).toBeNull();
    expect(queryByTestId('workflow-condition-operator-0')).toBeNull();
  });

  it('raises the toggle with the checkbox state in both directions', async () => {
    const { getByTestId, spies } = mount(PLAIN);
    await fireEvent.click(getByTestId('workflow-condition-enabled-0'));
    expect(spies.onconditiontoggle).toHaveBeenLastCalledWith(0, true);

    cleanup();
    const { getByTestId: get2, spies: spies2 } = mount(conditional(STATUS_CONDITION));
    expect((get2('workflow-condition-enabled-0') as HTMLInputElement).checked).toBe(true);
    await fireEvent.click(get2('workflow-condition-enabled-0'));
    expect(spies2.onconditiontoggle).toHaveBeenLastCalledWith(0, false);
  });
});

describe('condition controls are closed sets (FR-021)', () => {
  it('offers exactly the contract operators, in contract order', () => {
    const { getByTestId } = mount(conditional(STATUS_CONDITION));

    expect(optionValues(getByTestId('workflow-condition-operator-0') as HTMLSelectElement)).toEqual([
      ...WORKFLOW_CONDITION_OPERATORS
    ]);
  });

  it('offers exactly the two operand sources', () => {
    const { getByTestId } = mount(conditional(STATUS_CONDITION));

    expect(optionValues(getByTestId('workflow-condition-source-0') as HTMLSelectElement)).toEqual([
      ...WORKFLOW_CONDITION_OPERAND_SOURCES
    ]);
  });

  it('offers exactly the graph node ids, so no unknown node can be named', () => {
    const { getByTestId } = mount(conditional(STATUS_CONDITION));

    expect(optionValues(getByTestId('workflow-condition-node-0') as HTMLSelectElement)).toEqual([
      'draft',
      'ship'
    ]);
  });

  it('compares a run status against a select over the terminal statuses only', () => {
    const { getByTestId } = mount(conditional(STATUS_CONDITION));
    const value = getByTestId('workflow-condition-value-0-0') as HTMLSelectElement;

    expect(value.tagName).toBe('SELECT');
    expect(optionValues(value)).toEqual([...WORKFLOW_NODE_TERMINAL_STATUSES]);
  });

  it('gives an output-field operand a field name and a free-text literal, and nothing else', () => {
    const { getByTestId } = mount(conditional(OUTPUT_CONDITION));

    expect((getByTestId('workflow-condition-field-0') as HTMLInputElement).value).toBe('risk');
    const value = getByTestId('workflow-condition-value-0-0') as HTMLInputElement;
    expect(value.tagName).toBe('INPUT');
    expect(value.value).toBe('high');
  });

  it('hides the field control for a run-status operand, which addresses none', () => {
    const { queryByTestId } = mount(conditional(STATUS_CONDITION));

    expect(queryByTestId('workflow-condition-field-0')).toBeNull();
  });
});

describe('condition edits are patches, never rewritten conditions', () => {
  it('patches the operand source', async () => {
    const { getByTestId, spies } = mount(conditional(STATUS_CONDITION));
    await fireEvent.change(getByTestId('workflow-condition-source-0'), {
      target: { value: 'node-output' }
    });
    expect(spies.onconditionpatch).toHaveBeenCalledWith(0, { source: 'node-output' });
  });

  it('patches the node', async () => {
    const { getByTestId, spies } = mount(conditional(STATUS_CONDITION));
    await fireEvent.change(getByTestId('workflow-condition-node-0'), { target: { value: 'ship' } });
    expect(spies.onconditionpatch).toHaveBeenCalledWith(0, { nodeId: 'ship' });
  });

  it('patches the operator', async () => {
    const { getByTestId, spies } = mount(conditional(STATUS_CONDITION));
    await fireEvent.change(getByTestId('workflow-condition-operator-0'), {
      target: { value: 'notEquals' }
    });
    expect(spies.onconditionpatch).toHaveBeenCalledWith(0, { operator: 'notEquals' });
  });

  it('patches the output field', async () => {
    const { getByTestId, spies } = mount(conditional(OUTPUT_CONDITION));
    await fireEvent.input(getByTestId('workflow-condition-field-0'), { target: { value: 'score' } });
    expect(spies.onconditionpatch).toHaveBeenCalledWith(0, { field: 'score' });
  });

  it('hands the literal control text through verbatim for the state module to read', async () => {
    const { getByTestId, spies } = mount(conditional(OUTPUT_CONDITION));
    await fireEvent.input(getByTestId('workflow-condition-value-0-0'), { target: { value: '42' } });
    // Not `42` — parsing is the state module's rule, and doing it here would be a
    // second copy of it.
    expect(spies.onconditionvalue).toHaveBeenCalledWith(0, 0, '42');
  });

  it('addresses the right value slot when a list is authored', async () => {
    const { getByTestId, spies } = mount(
      conditional({
        left: { source: 'node-output', nodeId: 'draft', field: 'risk' },
        operator: 'in',
        right: ['low', 'high']
      })
    );
    await fireEvent.input(getByTestId('workflow-condition-value-0-1'), { target: { value: 'mid' } });
    expect(spies.onconditionvalue).toHaveBeenCalledWith(0, 1, 'mid');
  });
});

describe('value-list affordances follow the operator arity', () => {
  const withOperator = (operator: WorkflowCondition['operator'], right?: WorkflowCondition['right']) =>
    conditional({
      left: { source: 'node-output', nodeId: 'draft', field: 'risk' },
      operator,
      ...(right !== undefined ? { right } : {})
    });

  it('offers add and remove only for a list operator', async () => {
    const { getByTestId, spies } = mount(withOperator('in', ['low', 'high']));

    await fireEvent.click(getByTestId('workflow-condition-add-value-0'));
    expect(spies.onconditionvalueadd).toHaveBeenCalledWith(0);
    await fireEvent.click(getByTestId('workflow-condition-remove-value-0-1'));
    expect(spies.onconditionvalueremove).toHaveBeenCalledWith(0, 1);
  });

  it('offers neither for a single-value operator', () => {
    const { queryByTestId } = mount(withOperator('equals', 'high'));

    expect(queryByTestId('workflow-condition-add-value-0')).toBeNull();
    expect(queryByTestId('workflow-condition-remove-value-0-0')).toBeNull();
  });

  it('withholds remove from the last entry, so no empty list can be authored', () => {
    const { queryByTestId } = mount(withOperator('in', ['only']));

    expect(queryByTestId('workflow-condition-remove-value-0-0')).toBeNull();
  });

  it('shows no value control at all for a no-operand operator', () => {
    const { queryByTestId } = mount(withOperator('exists'));

    expect(queryByTestId('workflow-condition-value-0-0')).toBeNull();
  });
});

// The offer order the canvas draws, and the rule the host demands for a collection
// output feeding a single input. None of the three was authorable in the list
// Builder; the canvas renders what they decide, and `addWorkflowBranch` seeds a
// fallback arm, so a flag with no control to clear it would be a trap.
describe('branch metadata the canvas renders', () => {
  it('sets and clears the fallback flag, sending undefined rather than false', async () => {
    const { getByTestId, spies } = mount(PLAIN);
    await fireEvent.click(getByTestId('workflow-connection-default-0'));
    expect(spies.onpatch).toHaveBeenLastCalledWith(0, { isDefault: true });

    cleanup();
    const { getByTestId: get2, spies: spies2 } = mount({ ...PLAIN, isDefault: true });
    await fireEvent.click(get2('workflow-connection-default-0'));
    // `undefined`, not `false`: the contract's absent-means-not-a-fallback reading
    // is what `copyConnection` preserves, and a literal `false` would be authored.
    expect(spies2.onpatch).toHaveBeenLastCalledWith(0, { isDefault: undefined });
  });

  it('treats a blank priority as unset rather than as zero', async () => {
    const { getByTestId, spies } = mount({ ...PLAIN, priority: 2 });
    await fireEvent.input(getByTestId('workflow-connection-priority-0'), { target: { value: '' } });
    // Unset sorts LAST; zero would sort first. The distinction is the whole
    // reason blank is not coerced.
    expect(spies.onpatch).toHaveBeenLastCalledWith(0, { priority: undefined });
  });

  it('offers exactly the contract selection rules, plus an explicit unset', () => {
    const { getByTestId } = mount(PLAIN);

    expect(optionValues(getByTestId('workflow-connection-selection-0') as HTMLSelectElement)).toEqual([
      '',
      ...WORKFLOW_SELECTION_RULES
    ]);
  });

  it('sends undefined for the unset selection rule', async () => {
    const { getByTestId, spies } = mount({ ...PLAIN, selection: 'first' });
    await fireEvent.change(getByTestId('workflow-connection-selection-0'), {
      target: { value: '' }
    });
    expect(spies.onpatch).toHaveBeenLastCalledWith(0, { selection: undefined });
  });
});

describe('readonly withholds every affordance', () => {
  const LIST_CONDITION = conditional({
    left: { source: 'node-output', nodeId: 'draft', field: 'risk' },
    operator: 'in',
    right: ['low', 'high']
  });

  it('disables the selects and checkboxes', () => {
    const { getByTestId } = mount(LIST_CONDITION, true);

    for (const testid of [
      'workflow-connection-from-node-0',
      'workflow-connection-to-node-0',
      'workflow-condition-enabled-0',
      'workflow-condition-source-0',
      'workflow-condition-node-0',
      'workflow-condition-operator-0',
      'workflow-connection-default-0',
      'workflow-connection-selection-0'
    ]) {
      expect((getByTestId(testid) as HTMLInputElement).disabled, testid).toBe(true);
    }
  });

  it('marks the text controls read-only rather than merely styling them', () => {
    const { getByTestId } = mount(LIST_CONDITION, true);

    for (const testid of [
      'workflow-condition-field-0',
      'workflow-condition-value-0-0',
      'workflow-connection-priority-0'
    ]) {
      expect((getByTestId(testid) as HTMLInputElement).readOnly, testid).toBe(true);
    }
  });

  it('withholds the value, reorder, and delete controls entirely', () => {
    const { queryByTestId } = mount(LIST_CONDITION, true);

    for (const testid of [
      'workflow-condition-add-value-0',
      'workflow-condition-remove-value-0-0',
      'workflow-connection-up-0',
      'workflow-connection-down-0',
      'workflow-connection-remove-0'
    ]) {
      expect(queryByTestId(testid), testid).toBeNull();
    }
  });
});

// Feature 083 (US5, T058, FR-043/SC-010) — editing the node list moves rows and
// nothing else. Carried over from the list Builder unchanged in substance: the
// edits run through the real state functions, and the inspector is then rendered
// on the result to confirm the endpoints still resolve to the nodes the operator
// authored.
//
// This is the counterpart of the Pipeline binding rule in AGENTS.md: a binding
// addresses its Phase by `phaseIndex`, so every reorder, insert, and remove has to
// remap each endpoint. A Workflow connection addresses its node by `nodeId`, so
// there is no remap step to forget — and the way to keep it that way is to fail
// the moment an identifier moves with the row.

const draft = (): MutableWorkflow => ({
  ...makeNewWorkflowDraft([]),
  nodes: [
    { nodeId: 'draft', pipelineId: 'authoring' },
    { nodeId: 'ship', pipelineId: 'release' }
  ],
  connections: [PLAIN],
  startNodeIds: ['draft']
});

const endpointsOf = (workflow: MutableWorkflow): string[] =>
  workflow.connections.flatMap((connection) => [
    `${connection.from.nodeId}.${connection.from.portId}`,
    `${connection.to.nodeId}.${connection.to.portId}`
  ]);

const renderedEndpoints = (workflow: MutableWorkflow): string[] => {
  const { getByTestId } = mount(workflow.connections[0], false, workflow.nodes);
  return ['from-node', 'from-port', 'to-node', 'to-port'].map(
    (end) => (getByTestId(`workflow-connection-${end}-0`) as HTMLSelectElement).value
  );
};

describe('identifiers survive every list edit (FR-043, SC-010)', () => {
  it('reorders a node without touching a single identifier or endpoint', () => {
    const before = draft();
    const after = moveWorkflowNode(before, 0, 1);

    expect(after.nodes.map((node) => node.nodeId)).toEqual(['ship', 'draft']);
    // Position changed; identity did not. A `phaseIndex`-style endpoint would now
    // be pointing at the wrong node.
    expect(endpointsOf(after)).toEqual(endpointsOf(before));
    expect(after.startNodeIds).toEqual(before.startNodeIds);
    expect(renderedEndpoints(after)).toEqual(['draft', 'spec', 'ship', 'brief']);
  });

  it('inserts a node without renaming any node that was already there', () => {
    const before = draft();
    const inserted = makeWorkflowNodeDraft(before, 'authoring');
    const after = addWorkflowNode(before, inserted);

    expect(after.nodes.slice(0, 2)).toEqual(before.nodes);
    expect(before.nodes.some((node) => node.nodeId === inserted.nodeId)).toBe(false);
    expect(endpointsOf(after)).toEqual(endpointsOf(before));
    expect(renderedEndpoints(after)).toEqual(['draft', 'spec', 'ship', 'brief']);
  });

  it('removes a node and leaves every surviving identifier intact', () => {
    const before = addWorkflowNode(draft(), { nodeId: 'audit', pipelineId: 'release' });
    const after = removeWorkflowNode(before, 0);

    expect(after.nodes.map((node) => node.nodeId)).toEqual(['ship', 'audit']);
    // The connection named the removed node, so it goes with it — dropping the
    // edge is the only correct answer, and it must not silently retarget.
    expect(after.connections).toEqual([]);
    expect(after.startNodeIds).toEqual([]);
  });

  it('keeps connections that name no removed node exactly as authored', () => {
    const before: MutableWorkflow = {
      ...draft(),
      nodes: [
        { nodeId: 'draft', pipelineId: 'authoring' },
        { nodeId: 'ship', pipelineId: 'release' },
        { nodeId: 'audit', pipelineId: 'release' }
      ]
    };
    const after = removeWorkflowNode(before, 2);

    expect(after.nodes.map((node) => node.nodeId)).toEqual(['draft', 'ship']);
    expect(after.connections).toEqual(before.connections);
    expect(renderedEndpoints(after)).toEqual(['draft', 'spec', 'ship', 'brief']);
  });

  it('survives a whole editing session — move, insert, remove, move again', () => {
    const before = draft();
    const inserted = makeWorkflowNodeDraft(before, 'authoring');
    const after = moveWorkflowNode(
      removeWorkflowNode(addWorkflowNode(moveWorkflowNode(before, 0, 1), inserted), 0),
      0,
      1
    );

    expect(after.nodes.map((node) => node.nodeId)).toEqual([inserted.nodeId, 'draft']);
    expect(after.connections).toEqual([]);
    const survivors = after.nodes.map((node) => node.nodeId);
    expect(survivors.filter((id) => id === 'draft' || id === inserted.nodeId)).toEqual(survivors);
  });
});
