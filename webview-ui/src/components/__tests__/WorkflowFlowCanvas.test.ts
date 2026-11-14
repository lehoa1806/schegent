// The canvas Builder's surface: what is drawn, and how it is operated.
//
// Placement itself is pinned in `workflow-flow-layout.test.ts`, away from any
// markup. What is here is the wiring — which card exists, which chip a branch
// gets, which callback a control raises — plus the two properties the canvas
// inherited from the list Builder it replaced and could most easily have lost:
//
//   - FR-042 / SC-008: every affordance is on a natively-operable element with an
//     accessible name, and nothing needs a pointer. The reference design makes
//     drag the way to add and reorder; a drag is the one gesture a keyboard cannot
//     produce, so the operations live on buttons in the selected card's toolbar.
//     These assertions are what stop a drag handler appearing on the canvas.
//   - FR-044: a defective card is bordered AND badged AND described-by, because
//     colour alone reaches neither a screen reader nor a monochrome display.
//
// One property is genuinely new. The list Builder used `<ol>` to carry authored
// order to assistive technology; a flow is not a list, so what carries order now is
// DOM order, and DOM order is the run engine's offer order. That is asserted
// directly rather than assumed.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  PortablePhaseDefinition,
  PortablePipelineDefinition,
  PortableWorkflowDefinition,
  WorkflowConnection,
  WorkflowNode
} from '../../lib/snapshot-types';
import WorkflowFlowCanvas from '../PipelineBuilderEditors/WorkflowFlowCanvas.svelte';
import type { WorkflowFlowSelection } from '../PipelineBuilderEditors/workflow-flow-view';
import type { WorkflowDraftError } from '../PipelineBuilderEditors/workflow-catalog-state';

afterEach(cleanup);

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

const node = (nodeId: string, pipelineId = 'authoring'): WorkflowNode => ({ nodeId, pipelineId });

const edge = (
  from: string,
  to: string,
  extra: Partial<Omit<WorkflowConnection, 'from' | 'to'>> = {}
): WorkflowConnection => ({
  from: { nodeId: from, portId: 'spec' },
  to: { nodeId: to, portId: 'brief' },
  ...extra
});

interface MountOptions {
  nodes?: readonly WorkflowNode[];
  connections?: readonly WorkflowConnection[];
  startNodeIds?: readonly string[];
  readonly?: boolean;
  selection?: WorkflowFlowSelection | null;
  nodeDefects?: readonly (readonly WorkflowDraftError[])[];
  connectionDefects?: readonly (readonly WorkflowDraftError[])[];
}

const handlers = () => ({
  onselect: vi.fn(),
  oninsertafter: vi.fn(),
  onsplice: vi.fn(),
  onnodemove: vi.fn(),
  onnoderemove: vi.fn(),
  onbranchadd: vi.fn()
});

const mount = (options: MountOptions = {}) => {
  const spies = handlers();
  const rendered = render(WorkflowFlowCanvas, {
    props: {
      nodes: options.nodes ?? [node('draft'), node('ship', 'release')],
      connections: options.connections ?? [edge('draft', 'ship')],
      startNodeIds: options.startNodeIds ?? ['draft'],
      pipelines: PIPELINES,
      nodeDefects: options.nodeDefects ?? [],
      connectionDefects: options.connectionDefects ?? [],
      readonly: options.readonly ?? false,
      selection: options.selection ?? null,
      ...spies
    }
  });
  return { ...rendered, spies };
};

/** The node ids of the cards, in the order they appear in the document. */
const cardOrder = (container: Element): string[] =>
  Array.from(container.querySelectorAll('[data-testid^="workflow-node-title-"]')).map((element) =>
    element.textContent.trim()
  );

// Every element a keyboard user has to reach to author the graph.
const CONTROL_SELECTOR = 'button, select, input, textarea, [tabindex]';

const controlsIn = (root: Element): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR));

/**
 * The name a screen reader would announce, resolved in specification order for the
 * sources this canvas uses: an explicit `aria-label`, then a button's own content.
 * An icon button therefore only passes on the strength of its `aria-label`, which
 * is the point.
 */
const accessibleName = (control: HTMLElement): string => {
  const labelled = control.getAttribute('aria-label');
  if (labelled !== null) return labelled.trim();
  return control.textContent.trim();
};

/**
 * Focuses every enabled control under `root` and returns the test ids of the
 * disabled ones, sorted. Fails on any `tabindex`: a negative one removes the
 * control from the tab order entirely, a positive one reorders the whole page,
 * and neither belongs on the canvas.
 */
const disabledControlsIn = (root: Element): string[] => {
  const disabled: string[] = [];
  for (const control of controlsIn(root)) {
    expect(control.getAttribute('tabindex'), control.outerHTML).toBeNull();
    if (control.hasAttribute('disabled')) {
      disabled.push(control.getAttribute('data-testid') ?? control.outerHTML);
      continue;
    }
    control.focus();
    expect(control.ownerDocument.activeElement, control.outerHTML).toBe(control);
  }
  return disabled.sort();
};

describe('the canvas draws the graph', () => {
  it('renders one card per reachable node with an End terminal on the leaf', () => {
    const { getByTestId, queryByTestId } = mount();

    expect(getByTestId('workflow-node-0')).toBeTruthy();
    expect(getByTestId('workflow-node-1')).toBeTruthy();
    expect(getByTestId('workflow-end-ship')).toBeTruthy();
    // `draft` has an outgoing arm, so it is not a terminal.
    expect(queryByTestId('workflow-end-draft')).toBeNull();
  });

  it('titles a card by its label when it has one, and by its identifier otherwise', () => {
    const { getByTestId } = mount({
      nodes: [{ nodeId: 'draft', pipelineId: 'authoring', label: 'Write the spec' }, node('ship', 'release')]
    });

    expect(getByTestId('workflow-node-title-0').textContent.trim()).toBe('Write the spec');
    expect(getByTestId('workflow-node-title-1').textContent.trim()).toBe('ship');
  });

  it('shows the target identifier under the title, so two nodes running one Pipeline stay distinct', () => {
    const { getByTestId } = mount({
      nodes: [node('first'), node('second')],
      connections: [edge('first', 'second')]
    });

    expect(getByTestId('workflow-node-pipeline-0').textContent.trim()).toBe('authoring');
    expect(getByTestId('workflow-node-pipeline-1').textContent.trim()).toBe('authoring');
    expect(cardOrder(getByTestId('workflow-canvas'))).toEqual(['first', 'second']);
  });

  it('draws the cards in the engine’s offer order, which is what DOM order now carries', () => {
    const { getByTestId } = mount({
      nodes: [node('root'), node('low'), node('high')],
      connections: [edge('root', 'low', { priority: 9 }), edge('root', 'high', { priority: 1 })],
      startNodeIds: ['root']
    });

    // `high` has the lower priority number, so it is offered — and drawn — first.
    expect(cardOrder(getByTestId('workflow-canvas'))).toEqual(['root', 'high', 'low']);
  });

  it('renders an empty state rather than a blank canvas when there are no nodes', () => {
    const { getByTestId } = mount({ nodes: [], connections: [], startNodeIds: [] });

    expect(getByTestId('workflow-canvas-empty')).toBeTruthy();
  });
});

describe('a card says what its target runs', () => {
  const renderWith = (extra: {
    nodes: readonly WorkflowNode[];
    phases?: readonly PortablePhaseDefinition[];
    workflows?: readonly PortableWorkflowDefinition[];
  }) =>
    render(WorkflowFlowCanvas, {
      props: {
        connections: [],
        startNodeIds: [extra.nodes[0].nodeId],
        pipelines: PIPELINES,
        nodeDefects: [],
        connectionDefects: [],
        readonly: false,
        selection: null,
        ...handlers(),
        ...extra
      }
    });

  it('reads a Phase’s runner, model and effort', () => {
    const { getByTestId } = renderWith({
      nodes: [{ nodeId: 'plan', kind: 'phase', phaseId: 'plan-change' }],
      phases: [
        { phaseId: 'plan-change', name: 'Plan', version: 1, runner: 'claude', model: 'opus', effort: 'high' }
      ]
    });

    expect(getByTestId('workflow-node-summary-0').textContent.trim()).toBe('claude · opus · high');
  });

  it('says a Phase that sets none of them inherits the Workflow’s defaults', () => {
    const { getByTestId } = renderWith({
      nodes: [{ nodeId: 'plan', kind: 'phase', phaseId: 'plan-change' }],
      phases: [{ phaseId: 'plan-change', name: 'Plan', version: 1 }]
    });

    expect(getByTestId('workflow-node-summary-0').textContent.trim()).toBe('inherits workflow defaults');
  });

  it('counts the steps of a child Workflow and the Phases of a Pipeline', () => {
    const { getByTestId } = renderWith({
      nodes: [{ nodeId: 'impl', kind: 'workflow', workflowId: 'implement-tasks' }, node('draft')],
      workflows: [
        {
          workflowId: 'implement-tasks',
          name: 'Implement tasks',
          version: 1,
          nodes: [node('a'), node('b'), node('c')],
          connections: [],
          startNodeIds: ['a']
        } as never
      ]
    });

    expect(getByTestId('workflow-node-summary-0').textContent.trim()).toBe('child Workflow · 3 steps');
    expect(getByTestId('workflow-node-summary-1').textContent.trim()).toBe('Pipeline · 0 Phases');
  });

  it('prints no summary for a target the catalog does not hold', () => {
    const { queryByTestId } = renderWith({
      nodes: [{ nodeId: 'plan', kind: 'phase', phaseId: 'gone' }]
    });

    expect(queryByTestId('workflow-node-summary-0')).toBeNull();
  });

  it('badges a child Workflow call that repeats or runs once per item', () => {
    const { getByTestId } = renderWith({
      nodes: [
        {
          nodeId: 'each',
          kind: 'workflow',
          workflowId: 'child',
          control: {
            version: 1,
            kind: 'for-each',
            collection: { source: 'workflow-input', portId: 'tasks' },
            itemInputPortId: 'task'
          }
        },
        {
          nodeId: 'again',
          kind: 'workflow',
          workflowId: 'child',
          control: { version: 1, kind: 'repeat', maxIterations: 3, carry: [] } as never
        }
      ]
    });

    expect(getByTestId('workflow-node-control-0').textContent.trim()).toBe('For each item');
    expect(getByTestId('workflow-node-control-1').textContent.trim()).toBe('Repeats up to 3 times');
  });
});

describe('branch chips read the arm they label', () => {
  it('labels a conditional arm with the comparison it makes', () => {
    const { getByTestId } = mount({
      connections: [
        edge('draft', 'ship', {
          condition: { left: { source: 'node-status', nodeId: 'draft' }, operator: 'equals', right: 'completed' }
        })
      ]
    });

    const chip = getByTestId('workflow-branch-0');
    expect(chip.textContent.trim()).toBe('draft status = completed');
    // The name says which arm it is; the visible words alone do not.
    expect(accessibleName(chip)).toBe('Branch from draft to ship: draft status = completed');
  });

  it('labels the fallback arm as the fallback it is', () => {
    const { getByTestId } = mount({ connections: [edge('draft', 'ship', { isDefault: true })] });

    expect(getByTestId('workflow-branch-0').textContent.trim()).toBe('Otherwise');
  });

  it('draws an unconditional arm as a bare line that can still be selected', () => {
    // Plain edges carry no label in the reference design. The line is still a
    // button: the inspector is where a condition is added, so an arm nobody can
    // select is an arm nobody can make conditional.
    const { getByTestId } = mount();
    const line = getByTestId('workflow-branch-0');

    expect(line.tagName).toBe('BUTTON');
    expect(line.textContent.trim()).toBe('');
    expect(accessibleName(line)).toBe('Connection from draft to ship');
  });

  it('marks an arm that waits for the operator', () => {
    const { getByTestId } = mount({
      connections: [
        edge('draft', 'ship', { handoff: 'manual' }),
        edge('draft', 'ship', {
          handoff: 'manual',
          condition: { left: { source: 'node-status', nodeId: 'draft' }, operator: 'equals', right: 'failed' }
        })
      ]
    });

    const plain = getByTestId('workflow-branch-0');
    expect(plain.textContent.trim()).toBe('Manual handoff');
    expect(accessibleName(plain)).toBe('Connection from draft to ship: manual handoff');
    expect(accessibleName(getByTestId('workflow-branch-1'))).toBe(
      'Branch from draft to ship: draft status = failed, manual handoff'
    );
  });

  it('selects the connection when its chip is activated', async () => {
    const { getByTestId, spies } = mount();
    await fireEvent.click(getByTestId('workflow-branch-0'));

    expect(spies.onselect).toHaveBeenCalledWith({ kind: 'connection', index: 0 });
  });

  it('draws a jump reference instead of a second copy of a join node', () => {
    const { getByTestId, container } = mount({
      nodes: [node('root'), node('left'), node('right'), node('join')],
      connections: [edge('root', 'left'), edge('root', 'right'), edge('left', 'join'), edge('right', 'join')],
      startNodeIds: ['root']
    });

    expect(cardOrder(getByTestId('workflow-canvas')).filter((id) => id === 'join')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid^="workflow-jump-"]')).toHaveLength(1);
  });
});

describe('the canvas offers the two insertion gestures', () => {
  it('appends downstream from the `+` below a terminal card', async () => {
    const { getByTestId, spies } = mount();
    await fireEvent.click(getByTestId('workflow-insert-after-ship'));

    expect(spies.oninsertafter).toHaveBeenCalledWith('ship');
  });

  it('splices onto the arm from the `+` on a branch', async () => {
    const { getByTestId, spies } = mount();
    await fireEvent.click(getByTestId('workflow-splice-0'));

    // Splices rather than forks: the arm still leads where it led.
    expect(spies.onsplice).toHaveBeenCalledWith(0);
  });

  it('offers no `+` below a card that already has arms', () => {
    const { queryByTestId } = mount();

    expect(queryByTestId('workflow-insert-after-draft')).toBeNull();
  });
});

describe('a node that cannot run still renders (FR-044)', () => {
  it('lists a node no start reaches in its own lane, with the reason', () => {
    const { getByTestId } = mount({
      nodes: [node('draft'), node('orphan')],
      connections: [],
      startNodeIds: ['draft']
    });

    const note = getByTestId('workflow-lane-detached-note');
    expect(getByTestId('workflow-lane-detached')).toBeTruthy();
    // Says what is wrong AND that it blocks the save.
    expect(note.textContent).toMatch(/before saving/i);
  });

  it('explains the missing start when no node is reachable at all', () => {
    const { getByTestId, queryByTestId } = mount({
      nodes: [node('draft')],
      connections: [],
      startNodeIds: []
    });

    expect(queryByTestId('workflow-lane-flow')).toBeNull();
    expect(getByTestId('workflow-lane-detached-note').textContent).toMatch(/no start node/i);
  });

  it('badges a card whose Pipeline the effective catalog does not hold', () => {
    const { getByTestId } = mount({
      nodes: [node('draft', 'deleted-pipeline')],
      connections: [],
      startNodeIds: ['draft']
    });

    expect(getByTestId('workflow-node-unknown-pipeline-0')).toBeTruthy();
    // The identifier still shows: that is the defect the operator has to act on.
    expect(getByTestId('workflow-node-pipeline-0').textContent.trim()).toBe('deleted-pipeline');
  });

  it('badges every member of a cycle', () => {
    const { getByTestId } = mount({
      nodes: [node('a'), node('b')],
      connections: [edge('a', 'b'), edge('b', 'a')],
      startNodeIds: ['a']
    });

    expect(getByTestId('workflow-node-cycle-0')).toBeTruthy();
    expect(getByTestId('workflow-node-cycle-1')).toBeTruthy();
  });

  it('marks a defective card by border, badge, and description together', () => {
    const defect: WorkflowDraftError = { field: 'nodes[0]', code: 'x', message: 'broken' };
    const { getByTestId } = mount({ nodeDefects: [[defect]] });
    const card = getByTestId('workflow-node-0');

    expect(card.getAttribute('data-invalid')).toBe('true');
    expect(card.getAttribute('aria-describedby')).toBe('workflow-node-defects-0');
    expect(card.textContent).toContain('1 issue');
    expect(document.getElementById('workflow-node-defects-0')?.textContent).toContain('broken');
  });

  it('marks a defective branch chip the same way', () => {
    const defect: WorkflowDraftError = { field: 'connections[0].to', code: 'x', message: 'broken' };
    const { getByTestId } = mount({ connectionDefects: [[defect]] });
    const arm = getByTestId('workflow-branch-0');

    expect(arm.getAttribute('data-invalid')).toBe('true');
    // A plain arm draws no chip, so a red line would be its only cue. The defect
    // gives it a chip that says so, and the name carries the same words.
    expect(arm.textContent.trim()).toBe('1 issue');
    expect(accessibleName(arm)).toBe('Connection from draft to ship, 1 issue');
  });
});

describe('the canvas is operable by keyboard alone (FR-042, SC-008)', () => {
  it('names every control it renders', () => {
    const { getByTestId } = mount({ selection: { kind: 'node', index: 0 } });

    const controls = controlsIn(getByTestId('workflow-canvas'));
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(accessibleName(control), control.outerHTML).not.toBe('');
    }
  });

  it('keeps every enabled control reachable by Tab and focusable', async () => {
    const { getByTestId, rerender } = mount({ selection: { kind: 'node', index: 0 } });

    // Reorder at the ends of the node list is correctly unavailable. The set is
    // spelled out so a control that quietly goes dead is a failure, not a skip.
    expect(disabledControlsIn(getByTestId('workflow-canvas'))).toEqual(['workflow-node-up-0']);

    await rerender({ selection: { kind: 'node', index: 1 } });
    expect(disabledControlsIn(getByTestId('workflow-canvas'))).toEqual(['workflow-node-down-1']);
  });

  it('offers reorder as buttons, so it needs no pointer at all', async () => {
    const { getByTestId, rerender, spies } = mount({ selection: { kind: 'node', index: 0 } });

    const later = getByTestId('workflow-node-down-0');
    // A `<button>` is activated by Enter and Space by the platform.
    expect(later.tagName).toBe('BUTTON');
    expect(accessibleName(later)).toBe('Move draft later');
    await fireEvent.click(later);
    expect(spies.onnodemove).toHaveBeenCalledWith(0, 1);

    await rerender({ selection: { kind: 'node', index: 1 } });
    const earlier = getByTestId('workflow-node-up-1');
    expect(earlier.tagName).toBe('BUTTON');
    expect(accessibleName(earlier)).toBe('Move ship earlier');
    await fireEvent.click(earlier);
    expect(spies.onnodemove).toHaveBeenCalledWith(1, -1);
  });

  it('exposes no drag affordance and no pointer-only handler', () => {
    const { container } = mount({ selection: { kind: 'node', index: 0 } });

    // Reorder is the toolbar's buttons; these keep a drag from creeping back in.
    expect(container.querySelectorAll('[draggable="true"]')).toHaveLength(0);
    expect(container.querySelectorAll('[onmousedown], [onmouseup], [ondragstart]')).toHaveLength(0);
  });

  it('puts a selected card’s operations in a group named for that card', async () => {
    const { queryByRole, getByRole, rerender, spies } = mount();
    // Nothing selected, nothing to act on.
    expect(queryByRole('group', { name: /^Actions for / })).toBeNull();

    await rerender({ selection: { kind: 'node', index: 1 } });
    const actions = getByRole('group', { name: 'Actions for ship' });
    const buttons = Array.from(actions.querySelectorAll<HTMLElement>('button'));
    expect(buttons.map(accessibleName)).toEqual(['Move ship earlier', 'Move ship later', 'Delete ship']);
    // Each button is a Tab stop of its own (the Tab test above), and no arrow key moves between
    // them. A toolbar promises one Tab stop and arrow keys, so the buttons are not one.
    expect(queryByRole('toolbar')).toBeNull();

    await fireEvent.click(buttons[2]);
    expect(spies.onnoderemove).toHaveBeenCalledWith(1);
  });

  it('reports the selected card as pressed', () => {
    const { getByTestId } = mount({ selection: { kind: 'node', index: 1 } });

    expect(getByTestId('workflow-node-0').getAttribute('aria-pressed')).toBe('false');
    expect(getByTestId('workflow-node-1').getAttribute('aria-pressed')).toBe('true');
  });

  it('selects a node when its card is activated', async () => {
    const { getByTestId, spies } = mount();
    await fireEvent.click(getByTestId('workflow-node-1'));

    expect(spies.onselect).toHaveBeenCalledWith({ kind: 'node', index: 1 });
  });
});

// Decision 6 — the builder mockup deletes the selected step on Delete or Backspace. Here the
// keys act from the selected card alone: its own button, its toolbar, its preview line.
describe('Delete and Backspace delete the selected card, from the card alone', () => {
  it.each(['Delete', 'Backspace'])('deletes the selected node on %s', async (key) => {
    const { getByTestId, spies } = mount({ selection: { kind: 'node', index: 1 } });

    await fireEvent.keyDown(getByTestId('workflow-node-1'), { key });

    expect(spies.onnoderemove).toHaveBeenCalledTimes(1);
    expect(spies.onnoderemove).toHaveBeenCalledWith(1);
  });

  it('takes the key from the card’s toolbar too, and marks it handled', async () => {
    const { getByTestId, spies } = mount({ selection: { kind: 'node', index: 1 } });

    // `fireEvent` answers false when a handler called `preventDefault`.
    expect(await fireEvent.keyDown(getByTestId('workflow-node-up-1'), { key: 'Delete' })).toBe(false);
    expect(spies.onnoderemove).toHaveBeenCalledWith(1);
  });

  it('deletes nothing from a card that is not selected', async () => {
    const { getByTestId, spies } = mount({ selection: { kind: 'node', index: 1 } });

    await fireEvent.keyDown(getByTestId('workflow-node-0'), { key: 'Delete' });

    expect(spies.onnoderemove).not.toHaveBeenCalled();
  });

  it('deletes nothing while a branch is selected', async () => {
    const { getByTestId, spies } = mount({ selection: { kind: 'connection', index: 0 } });

    await fireEvent.keyDown(getByTestId('workflow-branch-0'), { key: 'Delete' });
    await fireEvent.keyDown(getByTestId('workflow-node-0'), { key: 'Backspace' });

    expect(spies.onnoderemove).not.toHaveBeenCalled();
  });

  it('deletes nothing in a read-only Workflow', async () => {
    const { getByTestId, spies } = mount({ readonly: true, selection: { kind: 'node', index: 0 } });

    await fireEvent.keyDown(getByTestId('workflow-node-0'), { key: 'Delete' });

    expect(spies.onnoderemove).not.toHaveBeenCalled();
  });

  it('leaves a key held with a modifier, or held down, to whatever else wants it', async () => {
    const { getByTestId, spies } = mount({ selection: { kind: 'node', index: 0 } });
    const card = getByTestId('workflow-node-0');

    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
      expect(await fireEvent.keyDown(card, { key: 'Delete', [modifier]: true }), modifier).toBe(true);
    }
    expect(await fireEvent.keyDown(card, { key: 'Backspace', repeat: true })).toBe(true);
    expect(await fireEvent.keyDown(card, { key: 'Enter' })).toBe(true);

    expect(spies.onnoderemove).not.toHaveBeenCalled();
  });
});

describe('readonly withholds every editing affordance', () => {
  it('renders the flow but none of the controls that would change it', () => {
    const { queryByTestId, queryByRole, getByTestId } = mount({
      readonly: true,
      selection: { kind: 'node', index: 0 }
    });

    // Still readable — a stored Workflow is viewable, just not editable (FR-026).
    expect(getByTestId('workflow-node-0')).toBeTruthy();
    expect(getByTestId('workflow-branch-0')).toBeTruthy();
    for (const testid of [
      'workflow-insert-after-ship',
      'workflow-splice-0',
      'workflow-node-up-0',
      'workflow-node-down-0',
      'workflow-node-remove-0'
    ]) {
      expect(queryByTestId(testid), testid).toBeNull();
    }
    expect(queryByRole('group', { name: /^Actions for / })).toBeNull();
  });

  it('still lets a card and a branch be selected, because reading is not editing', async () => {
    const { getByTestId, spies } = mount({ readonly: true });
    await fireEvent.click(getByTestId('workflow-node-0'));
    await fireEvent.click(getByTestId('workflow-branch-0'));

    expect(spies.onselect).toHaveBeenCalledWith({ kind: 'node', index: 0 });
    expect(spies.onselect).toHaveBeenCalledWith({ kind: 'connection', index: 0 });
  });

  it('renders phase repetition policy summary on Phase-kind node cards (FR-R5-F23)', () => {
    const rendered = render(WorkflowFlowCanvas, {
      props: {
        nodes: [{ nodeId: 'verify-step', kind: 'phase', phaseId: 'phase-verify' }],
        connections: [],
        startNodeIds: ['verify-step'],
        pipelines: PIPELINES,
        phases: [
          {
            phaseId: 'phase-verify',
            name: 'Verify Phase',
            description: 'Verify',
            prompt: 'Check',
            retryCondition: 'failures > 0',
            onRetryCap: 'continue-degraded'
          } as never
        ],
        nodeDefects: [],
        connectionDefects: [],
        readonly: false,
        selection: null,
        ...handlers()
      }
    });
    expect(rendered.getByTestId('workflow-node-retry-policy-0').textContent.trim()).toBe(
      'Repeats on failures > 0 · on cap: continue-degraded'
    );
  });
});
