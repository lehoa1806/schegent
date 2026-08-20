// Feature 083 (US4, T048) — condition authoring is a closed-set form, not a
// text field.
//
// The point of these assertions is FR-021: a condition is structured data and
// there is no expression to compile, evaluate, or sandbox. The strongest way to
// hold that is to make a free-text expression unauthorable in the first place,
// so every control that decides a condition's *meaning* — the operand source,
// the node, the comparison operator, and (for a run status) the value — must be
// a `<select>` whose options equal the closed contract set exactly.
//
// The one text input in a condition row is the literal being compared against,
// which FR-024 bounds to exactly that: a value, never an operator or a path.
//
// The component owns no rules. Arity, coercion, and literal parsing all live in
// `workflow-catalog-state.ts` (pinned by workflow-catalog-state.test.ts), so
// these tests assert the wiring: which control exists, what it offers, whether
// `readonly` disables it, and which callback it raises with which arguments.
//
// T057 extends this file with the node-row and reorder assertions.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WORKFLOW_CONDITION_OPERATORS,
  WORKFLOW_NODE_TERMINAL_STATUSES,
  type PortablePipelineDefinition,
  type WorkflowCondition,
  type WorkflowConnection,
  type WorkflowNode
} from '../../lib/snapshot-types';
import WorkflowGraphEditor from '../PipelineBuilderEditors/WorkflowGraphEditor.svelte';
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

const conditional = (condition: WorkflowCondition): WorkflowConnection => ({
  ...PLAIN,
  condition
});

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

/** Only the fields the Builder reads; the rest of the contract is not exercised here. */
const pipeline = (
  pipelineId: string,
  ports: Pick<PortablePipelineDefinition, 'inputs' | 'outputs'>
): PortablePipelineDefinition =>
  ({ pipelineId, name: pipelineId, version: 1, phaseIds: [], bindings: [], recommendedNext: [], ...ports }) as PortablePipelineDefinition;

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
  onnodeadd: vi.fn(),
  onnoderemove: vi.fn(),
  onnodemove: vi.fn(),
  onnodepatch: vi.fn(),
  onstarttoggle: vi.fn(),
  onconnectionadd: vi.fn(),
  onconnectionremove: vi.fn(),
  onconnectionmove: vi.fn(),
  onconnectionretarget: vi.fn(),
  onconditiontoggle: vi.fn(),
  onconditionpatch: vi.fn(),
  onconditionvalue: vi.fn(),
  onconditionvalueadd: vi.fn(),
  onconditionvalueremove: vi.fn()
});

const mount = (connections: readonly WorkflowConnection[], readonly = false) => {
  const spies = handlers();
  const rendered = render(WorkflowGraphEditor, {
    props: {
      nodes: NODES,
      connections,
      startNodeIds: ['draft'],
      pipelines: PIPELINES,
      nodeDefects: [],
      connectionDefects: [],
      readonly,
      ...spies
    }
  });
  return { ...rendered, spies };
};

const optionValues = (select: HTMLSelectElement): string[] =>
  Array.from(select.options).map((option) => option.value);

describe('WorkflowGraphEditor connection rows', () => {
  it('renders an empty-state line when there are no connections', () => {
    const { getByTestId, queryByTestId } = mount([]);
    expect(getByTestId('workflow-connections-empty').textContent).toContain('No connections yet.');
    expect(queryByTestId('workflow-connection-0')).toBeNull();
  });

  it('shows both endpoints so the row is readable without opening the condition', () => {
    const { getByTestId } = mount([PLAIN]);
    const values = ['from-node', 'from-port', 'to-node', 'to-port'].map(
      (end) => (getByTestId(`workflow-connection-${end}-0`) as HTMLSelectElement).value
    );
    expect(values).toEqual(['draft', 'spec', 'ship', 'brief']);
  });

  it('offers no condition controls until the connection is marked conditional', () => {
    const { getByTestId, queryByTestId } = mount([PLAIN]);
    expect((getByTestId('workflow-condition-enabled-0') as HTMLInputElement).checked).toBe(false);
    expect(queryByTestId('workflow-condition-operator-0')).toBeNull();
    expect(queryByTestId('workflow-condition-source-0')).toBeNull();
  });

  it('raises the toggle with the checkbox state in both directions', async () => {
    const { getByTestId, spies } = mount([PLAIN]);
    await fireEvent.click(getByTestId('workflow-condition-enabled-0'));
    expect(spies.onconditiontoggle).toHaveBeenCalledWith(0, true);

    cleanup();
    const second = mount([conditional(STATUS_CONDITION)]);
    expect((second.getByTestId('workflow-condition-enabled-0') as HTMLInputElement).checked).toBe(
      true
    );
    await fireEvent.click(second.getByTestId('workflow-condition-enabled-0'));
    expect(second.spies.onconditiontoggle).toHaveBeenCalledWith(0, false);
  });
});

describe('condition controls are closed sets (FR-021)', () => {
  it('offers exactly the contract operators, in contract order', () => {
    const { getByTestId } = mount([conditional(STATUS_CONDITION)]);
    const operator = getByTestId('workflow-condition-operator-0') as HTMLSelectElement;
    expect(operator.tagName).toBe('SELECT');
    expect(optionValues(operator)).toEqual([...WORKFLOW_CONDITION_OPERATORS]);
    expect(operator.value).toBe('equals');
  });

  it('offers exactly the two operand sources', () => {
    const { getByTestId } = mount([conditional(STATUS_CONDITION)]);
    const source = getByTestId('workflow-condition-source-0') as HTMLSelectElement;
    expect(source.tagName).toBe('SELECT');
    expect(optionValues(source)).toEqual([...WORKFLOW_CONDITION_OPERAND_SOURCES]);
    expect(source.value).toBe('node-status');
  });

  it('offers exactly the graph node ids, so no unknown node can be named', () => {
    const { getByTestId } = mount([conditional(STATUS_CONDITION)]);
    const node = getByTestId('workflow-condition-node-0') as HTMLSelectElement;
    expect(node.tagName).toBe('SELECT');
    expect(optionValues(node)).toEqual(['draft', 'ship']);
    expect(node.value).toBe('draft');
  });

  it('compares a run status against a select over the terminal statuses only', () => {
    const { getByTestId, queryByTestId } = mount([conditional(STATUS_CONDITION)]);
    const value = getByTestId('workflow-condition-value-0-0') as HTMLSelectElement;
    expect(value.tagName).toBe('SELECT');
    expect(optionValues(value)).toEqual([...WORKFLOW_NODE_TERMINAL_STATUSES]);
    expect(value.value).toBe('completed');
    // A run-status row has no free-text control at all: no field, no literal.
    expect(queryByTestId('workflow-condition-field-0')).toBeNull();
  });

  it('gives an output-field operand a field name and a free-text literal, and nothing else', () => {
    const { getByTestId } = mount([conditional(OUTPUT_CONDITION)]);
    const field = getByTestId('workflow-condition-field-0') as HTMLInputElement;
    const value = getByTestId('workflow-condition-value-0-0') as HTMLInputElement;
    expect(field.tagName).toBe('INPUT');
    expect(field.value).toBe('risk');
    expect(value.tagName).toBe('INPUT');
    expect(value.value).toBe('high');
  });
});

describe('condition edits are patches, never rewritten conditions', () => {
  it('patches the operand source', async () => {
    const { getByTestId, spies } = mount([conditional(STATUS_CONDITION)]);
    await fireEvent.change(getByTestId('workflow-condition-source-0'), {
      target: { value: 'node-output' }
    });
    expect(spies.onconditionpatch).toHaveBeenCalledWith(0, { source: 'node-output' });
  });

  it('patches the node', async () => {
    const { getByTestId, spies } = mount([conditional(STATUS_CONDITION)]);
    await fireEvent.change(getByTestId('workflow-condition-node-0'), {
      target: { value: 'ship' }
    });
    expect(spies.onconditionpatch).toHaveBeenCalledWith(0, { nodeId: 'ship' });
  });

  it('patches the operator', async () => {
    const { getByTestId, spies } = mount([conditional(STATUS_CONDITION)]);
    await fireEvent.change(getByTestId('workflow-condition-operator-0'), {
      target: { value: 'in' }
    });
    expect(spies.onconditionpatch).toHaveBeenCalledWith(0, { operator: 'in' });
  });

  it('patches the output field', async () => {
    const { getByTestId, spies } = mount([conditional(OUTPUT_CONDITION)]);
    await fireEvent.input(getByTestId('workflow-condition-field-0'), {
      target: { value: 'severity' }
    });
    expect(spies.onconditionpatch).toHaveBeenCalledWith(0, { field: 'severity' });
  });

  it('hands the literal control text through verbatim for the state module to read', async () => {
    const { getByTestId, spies } = mount([conditional(OUTPUT_CONDITION)]);
    await fireEvent.input(getByTestId('workflow-condition-value-0-0'), {
      target: { value: '12' }
    });
    expect(spies.onconditionvalue).toHaveBeenCalledWith(0, 0, '12');
  });

  it('addresses the right value slot when a list is authored', async () => {
    const listed = conditional({
      left: { source: 'node-output', nodeId: 'draft', field: 'risk' },
      operator: 'in',
      right: ['high', 'medium']
    });
    const { getByTestId, spies } = mount([listed]);
    expect((getByTestId('workflow-condition-value-0-1') as HTMLInputElement).value).toBe('medium');
    await fireEvent.input(getByTestId('workflow-condition-value-0-1'), {
      target: { value: 'low' }
    });
    expect(spies.onconditionvalue).toHaveBeenCalledWith(0, 1, 'low');
  });
});

describe('value-list affordances follow the operator arity', () => {
  const listed = (right: readonly string[]): WorkflowConnection =>
    conditional({
      left: { source: 'node-output', nodeId: 'draft', field: 'risk' },
      operator: 'in',
      right
    });

  it('offers add and remove only for a list operator', async () => {
    const { getByTestId, spies } = mount([listed(['high', 'medium'])]);
    await fireEvent.click(getByTestId('workflow-condition-add-value-0'));
    expect(spies.onconditionvalueadd).toHaveBeenCalledWith(0);
    await fireEvent.click(getByTestId('workflow-condition-remove-value-0-1'));
    expect(spies.onconditionvalueremove).toHaveBeenCalledWith(0, 1);
  });

  it('offers neither for a single-value operator', () => {
    const { queryByTestId } = mount([conditional(OUTPUT_CONDITION)]);
    expect(queryByTestId('workflow-condition-add-value-0')).toBeNull();
    expect(queryByTestId('workflow-condition-remove-value-0-0')).toBeNull();
  });

  it('withholds remove from the last entry, so no empty list can be authored', () => {
    const { getByTestId, queryByTestId } = mount([listed(['high'])]);
    expect(getByTestId('workflow-condition-value-0-0')).toBeTruthy();
    expect(queryByTestId('workflow-condition-remove-value-0-0')).toBeNull();
  });

  it('shows no value control at all for a no-operand operator', () => {
    const { getByTestId, queryByTestId } = mount([
      conditional({
        left: { source: 'node-output', nodeId: 'draft', field: 'risk' },
        operator: 'exists'
      })
    ]);
    expect(getByTestId('workflow-condition-operator-0')).toBeTruthy();
    expect(queryByTestId('workflow-condition-value-0-0')).toBeNull();
    expect(queryByTestId('workflow-condition-add-value-0')).toBeNull();
  });
});

describe('readonly withholds every affordance', () => {
  const listedStatus = conditional({
    left: { source: 'node-status', nodeId: 'draft' },
    operator: 'in',
    right: ['completed', 'failed']
  });

  it('disables the selects and checkbox', () => {
    const { getByTestId } = mount([listedStatus], true);
    for (const id of [
      'workflow-condition-enabled-0',
      'workflow-condition-source-0',
      'workflow-condition-node-0',
      'workflow-condition-operator-0',
      'workflow-condition-value-0-0'
    ]) {
      expect((getByTestId(id) as HTMLInputElement | HTMLSelectElement).disabled).toBe(true);
    }
  });

  it('marks the text controls read-only rather than merely styling them', () => {
    const { getByTestId } = mount([conditional(OUTPUT_CONDITION)], true);
    expect((getByTestId('workflow-condition-field-0') as HTMLInputElement).readOnly).toBe(true);
    expect((getByTestId('workflow-condition-value-0-0') as HTMLInputElement).readOnly).toBe(true);
  });

  it('withholds the value add and remove buttons entirely', () => {
    const { queryByTestId } = mount([listedStatus], true);
    expect(queryByTestId('workflow-condition-add-value-0')).toBeNull();
    expect(queryByTestId('workflow-condition-remove-value-0-1')).toBeNull();
  });
});

// Feature 083 (US5, T057, FR-042/SC-008) — the Builder is operable without a
// pointer, and says what each control is for.
//
// These assertions are deliberately structural rather than behavioural: the
// platform already gives a `<button>` Enter/Space activation and a `<select>`
// arrow-key operation, so the way to hold FR-042 is to keep every affordance on
// a natively-operable element with an accessible name — not to re-implement
// keyboard handling on a `<div>` and test the handler. Anything that would
// require a pointer (a drag handle, a `mousedown`-only control, a
// `tabindex="-1"` target) is what these tests are here to catch.

/** Every element a keyboard user has to reach to author the graph. */
const CONTROL_SELECTOR = 'button, select, input, textarea, [tabindex]';

const controlsIn = (row: Element): HTMLElement[] =>
  Array.from(row.querySelectorAll<HTMLElement>(CONTROL_SELECTOR));

/**
 * The name a screen reader would announce, resolved in specification order for
 * the three sources this Builder uses: an explicit `aria-label`, a button's own
 * content, then the text of a wrapping `<label>`. A glyph button such as `↑`
 * therefore only passes on the strength of its `aria-label`, which is the point.
 */
const accessibleName = (control: HTMLElement): string => {
  const labelled = control.getAttribute('aria-label');
  if (labelled !== null) return labelled.trim();
  if (control.tagName === 'BUTTON') return (control.textContent ?? '').trim();
  return (control.closest('label')?.textContent ?? '').trim();
};

/**
 * Reorder at the ends of a list is correctly unavailable, and a disabled
 * control is correctly outside the tab order. Nothing else may be disabled: the
 * set is spelled out so a control that quietly goes dead is a failure, not a
 * skipped assertion.
 */
const BOUNDARY_DISABLED = [
  'workflow-connection-down-0',
  'workflow-connection-up-0',
  'workflow-node-up-0'
];

describe('the Builder is operable by keyboard alone (FR-042, SC-008)', () => {
  it('presents nodes and connections as ordered lists, each labelled', () => {
    const { getByTestId, container } = mount([PLAIN]);
    for (const testid of ['workflow-nodes', 'workflow-connections']) {
      const list = getByTestId(testid);
      // `<ol>` rather than `<ul>` or a stack of `<div>`s: the authored order is
      // part of the definition's meaning (FR-049), and the ordered-list role is
      // what carries the position and the count to assistive technology.
      expect(list.tagName, `${testid} must be an ordered list`).toBe('OL');
      const labelledBy = list.getAttribute('aria-labelledby');
      expect(labelledBy, `${testid} must name its label`).not.toBeNull();
      const label = container.ownerDocument.getElementById(labelledBy as string);
      expect(label?.textContent?.trim()).toBeTruthy();
    }
  });

  it('labels every control in a node row and a connection row', () => {
    const { getByTestId } = mount([PLAIN]);
    for (const testid of ['workflow-node-0', 'workflow-connection-0']) {
      const controls = controlsIn(getByTestId(testid));
      expect(controls.length, `${testid} must offer controls to label`).toBeGreaterThan(0);
      for (const control of controls) {
        expect(accessibleName(control), `${testid}: ${control.outerHTML}`).not.toBe('');
      }
    }
  });

  it('keeps every control reachable by Tab and focusable', () => {
    const { getByTestId } = mount([PLAIN]);
    const disabled: string[] = [];
    for (const testid of ['workflow-node-0', 'workflow-connection-0']) {
      for (const control of controlsIn(getByTestId(testid))) {
        // A negative tabindex removes the control from the tab order entirely;
        // a positive one reorders the whole page. Neither belongs on a row.
        expect(control.getAttribute('tabindex'), control.outerHTML).toBeNull();
        if (control.hasAttribute('disabled')) {
          disabled.push(control.getAttribute('data-testid') ?? control.outerHTML);
          continue;
        }
        control.focus();
        expect(control.ownerDocument.activeElement, control.outerHTML).toBe(control);
      }
    }
    expect(disabled.sort()).toEqual(BOUNDARY_DISABLED);
  });

  it('offers reorder as buttons, so it needs no pointer at all', async () => {
    const { getByTestId, spies } = mount([PLAIN, { ...PLAIN, to: { nodeId: 'draft', portId: 'goal' } }]);
    for (const testid of ['workflow-node-up-1', 'workflow-node-down-0', 'workflow-connection-up-1', 'workflow-connection-down-0']) {
      const control = getByTestId(testid);
      // A `<button>` is activated by Enter and Space by the platform; a drag
      // handle would be the only way to express the move and would exclude
      // every pointerless operator.
      expect(control.tagName, testid).toBe('BUTTON');
      expect(accessibleName(control), testid).not.toBe('');
    }
    await fireEvent.click(getByTestId('workflow-node-down-0'));
    expect(spies.onnodemove).toHaveBeenCalledWith(0, 1);
    await fireEvent.click(getByTestId('workflow-connection-up-1'));
    expect(spies.onconnectionmove).toHaveBeenCalledWith(1, -1);
  });

  it('disables the reorder control at the end of the run it cannot leave', () => {
    const { getByTestId } = mount([PLAIN]);
    expect((getByTestId('workflow-node-up-0') as HTMLButtonElement).disabled).toBe(true);
    expect((getByTestId('workflow-node-down-1') as HTMLButtonElement).disabled).toBe(true);
    expect((getByTestId('workflow-connection-up-0') as HTMLButtonElement).disabled).toBe(true);
    expect((getByTestId('workflow-connection-down-0') as HTMLButtonElement).disabled).toBe(true);
  });

  it('exposes no drag affordance and no pointer-only handler', () => {
    const { container } = mount([PLAIN]);
    expect(container.querySelectorAll('[draggable="true"]')).toHaveLength(0);
    // A control that only answers to a pointer is unreachable from a keyboard
    // however well it is labelled.
    expect(container.querySelectorAll('[onmousedown], [onmouseup], [ondragstart]')).toHaveLength(0);
  });

  it('raises add and remove from labelled buttons on both lists', async () => {
    const { getByTestId, spies } = mount([PLAIN]);
    for (const testid of ['workflow-node-add', 'workflow-connection-add', 'workflow-node-remove-0', 'workflow-connection-remove-0']) {
      const control = getByTestId(testid);
      expect(control.tagName, testid).toBe('BUTTON');
      expect(accessibleName(control), testid).not.toBe('');
    }
    await fireEvent.click(getByTestId('workflow-node-add'));
    expect(spies.onnodeadd).toHaveBeenCalled();
    await fireEvent.click(getByTestId('workflow-connection-add'));
    expect(spies.onconnectionadd).toHaveBeenCalled();
    await fireEvent.click(getByTestId('workflow-node-remove-0'));
    expect(spies.onnoderemove).toHaveBeenCalledWith(0);
  });

  it('withholds every editing control when the row is read-only', () => {
    const { queryByTestId } = mount([PLAIN], true);
    for (const testid of ['workflow-node-add', 'workflow-node-up-0', 'workflow-node-remove-0', 'workflow-connection-add', 'workflow-connection-up-0', 'workflow-connection-remove-0']) {
      expect(queryByTestId(testid), testid).toBeNull();
    }
  });
});

// Feature 083 (US5, T058, FR-043/SC-010) — editing the node list moves rows and
// nothing else.
//
// This is the counterpart of the Pipeline binding rule in CLAUDE.md: a binding
// addresses its Phase by `phaseIndex`, so every reorder, insert, and remove has
// to remap each endpoint before revalidating. A Workflow connection addresses
// its node by `nodeId`, so there is no remap step here to forget — and the way
// to keep it that way is to fail the moment an identifier moves with the row.
//
// The edits run through the real state functions rather than through spies, so
// what is pinned is the behaviour the Builder's callbacks actually invoke; the
// component is then rendered on the result to confirm the endpoints still
// resolve to the nodes the operator authored.

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
  const { getByTestId } = mountGraph(workflow);
  return ['from-node', 'from-port', 'to-node', 'to-port'].map(
    (end) => (getByTestId(`workflow-connection-${end}-0`) as HTMLSelectElement).value
  );
};

const mountGraph = (workflow: MutableWorkflow) =>
  render(WorkflowGraphEditor, {
    props: {
      nodes: workflow.nodes,
      connections: workflow.connections,
      startNodeIds: workflow.startNodeIds,
      pipelines: PIPELINES,
      nodeDefects: [],
      connectionDefects: [],
      readonly: false,
      ...handlers()
    }
  });

describe('identifiers survive every list edit (FR-043, SC-010)', () => {
  it('reorders a node without touching a single identifier or endpoint', () => {
    const before = draft();
    const after = moveWorkflowNode(before, 0, 1);

    expect(after.nodes.map((node) => node.nodeId)).toEqual(['ship', 'draft']);
    // Position changed; identity did not. A `phaseIndex`-style endpoint would
    // now be pointing at the wrong node.
    expect(endpointsOf(after)).toEqual(endpointsOf(before));
    expect(after.startNodeIds).toEqual(before.startNodeIds);
    expect(renderedEndpoints(after)).toEqual(['draft', 'spec', 'ship', 'brief']);
  });

  it('inserts a node without renaming any node that was already there', () => {
    const before = draft();
    const inserted = makeWorkflowNodeDraft(before, 'authoring');
    const after = addWorkflowNode(before, inserted);

    expect(after.nodes.slice(0, 2)).toEqual(before.nodes);
    // The new id is free in this graph, so no existing node had to move aside.
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

    // `ship` was removed at step three, so `draft` and the inserted node remain
    // under the identifiers they started with, in the order the edits left them.
    expect(after.nodes.map((node) => node.nodeId)).toEqual([inserted.nodeId, 'draft']);
    // Every endpoint named `ship`, which is gone; nothing was retargeted onto a
    // surviving node to keep the edge alive.
    expect(after.connections).toEqual([]);
    // 100% of surviving identifiers, in the sense SC-010 means it.
    const survivors = after.nodes.map((node) => node.nodeId);
    expect(survivors.filter((id) => id === 'draft' || id === inserted.nodeId)).toEqual(survivors);
  });
});
