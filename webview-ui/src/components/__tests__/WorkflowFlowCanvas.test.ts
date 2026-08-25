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
//     produce, so the six-dot handle here is decoration and the operations live on
//     buttons. These assertions are what stop a real drag handler appearing on it.
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
  PortablePipelineDefinition,
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

  it('shows the Pipeline as the body, so two nodes running one Pipeline stay distinct', () => {
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

describe('branch chips read the arm they label', () => {
  it('labels a conditional arm with the comparison it makes', () => {
    const { getByTestId } = mount({
      connections: [
        edge('draft', 'ship', {
          condition: { left: { source: 'node-status', nodeId: 'draft' }, operator: 'equals', right: 'completed' }
        })
      ]
    });

    expect(getByTestId('workflow-branch-0').textContent.trim()).toBe('draft status = completed');
  });

  it('labels the fallback arm as the fallback it is', () => {
    const { getByTestId } = mount({ connections: [edge('draft', 'ship', { isDefault: true })] });

    expect(getByTestId('workflow-branch-0').textContent.trim()).toBe('Otherwise');
  });

  it('gives an unconditional arm a quiet chip rather than no chip at all', () => {
    // A bare line would be the one edge on the canvas the operator could not click,
    // and the inspector is where a condition is added.
    const { getByTestId } = mount();

    expect(getByTestId('workflow-branch-0').textContent.trim()).toBe('Always');
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
    expect(card.textContent).toContain('Error');
  });

  it('marks a defective branch chip the same way', () => {
    const defect: WorkflowDraftError = { field: 'connections[0].to', code: 'x', message: 'broken' };
    const { getByTestId } = mount({ connectionDefects: [[defect]] });

    expect(getByTestId('workflow-branch-0').getAttribute('data-invalid')).toBe('true');
  });
});

// Every element a keyboard user has to reach to author the graph.
const CONTROL_SELECTOR = 'button, select, input, textarea, [tabindex]';

const controlsIn = (root: Element): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR));

/**
 * The name a screen reader would announce, resolved in specification order for the
 * sources this canvas uses: an explicit `aria-label`, then a button's own content.
 * A glyph button such as `↑` therefore only passes on the strength of its
 * `aria-label`, which is the point.
 */
const accessibleName = (control: HTMLElement): string => {
  const labelled = control.getAttribute('aria-label');
  if (labelled !== null) return labelled.trim();
  return (control.textContent ?? '').trim();
};

describe('the canvas is operable by keyboard alone (FR-042, SC-008)', () => {
  it('names every control it renders', () => {
    const { getByTestId } = mount();

    const controls = controlsIn(getByTestId('workflow-canvas'));
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(accessibleName(control), control.outerHTML).not.toBe('');
    }
  });

  it('keeps every enabled control reachable by Tab and focusable', () => {
    const { getByTestId } = mount();
    const disabled: string[] = [];

    for (const control of controlsIn(getByTestId('workflow-canvas'))) {
      // A negative tabindex removes the control from the tab order entirely; a
      // positive one reorders the whole page. Neither belongs on the canvas.
      expect(control.getAttribute('tabindex'), control.outerHTML).toBeNull();
      if (control.hasAttribute('disabled')) {
        disabled.push(control.getAttribute('data-testid') ?? control.outerHTML);
        continue;
      }
      control.focus();
      expect(control.ownerDocument.activeElement, control.outerHTML).toBe(control);
    }

    // Reorder at the ends of the node list is correctly unavailable. The set is
    // spelled out so a control that quietly goes dead is a failure, not a skip.
    expect(disabled.sort()).toEqual(['workflow-node-down-1', 'workflow-node-up-0']);
  });

  it('offers reorder as buttons, so it needs no pointer at all', async () => {
    const { getByTestId, spies } = mount();

    for (const testid of ['workflow-node-down-0', 'workflow-node-up-1']) {
      const control = getByTestId(testid);
      // A `<button>` is activated by Enter and Space by the platform.
      expect(control.tagName, testid).toBe('BUTTON');
      expect(accessibleName(control), testid).not.toBe('');
    }
    await fireEvent.click(getByTestId('workflow-node-down-0'));
    expect(spies.onnodemove).toHaveBeenCalledWith(0, 1);
  });

  it('exposes no drag affordance and no pointer-only handler', () => {
    const { container } = mount();

    // The six-dot handle is decoration; these are what keep it that way.
    expect(container.querySelectorAll('[draggable="true"]')).toHaveLength(0);
    expect(container.querySelectorAll('[onmousedown], [onmouseup], [ondragstart]')).toHaveLength(0);
  });

  it('hides the decorative handle from assistive technology', () => {
    const { container } = mount();
    const handles = container.querySelectorAll('.wf-handle');

    expect(handles.length).toBeGreaterThan(0);
    for (const handle of handles) {
      expect(handle.getAttribute('aria-hidden')).toBe('true');
    }
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

describe('readonly withholds every editing affordance', () => {
  it('renders the flow but none of the controls that would change it', () => {
    const { queryByTestId, getByTestId } = mount({ readonly: true });

    // Still readable — a stored Workflow is viewable, just not editable (FR-026).
    expect(getByTestId('workflow-node-0')).toBeTruthy();
    expect(getByTestId('workflow-branch-0')).toBeTruthy();
    for (const testid of [
      'workflow-insert-after-ship',
      'workflow-splice-0',
      'workflow-node-up-1',
      'workflow-node-down-0',
      'workflow-node-remove-0'
    ]) {
      expect(queryByTestId(testid), testid).toBeNull();
    }
  });

  it('still lets a card and a branch be selected, because reading is not editing', async () => {
    const { getByTestId, spies } = mount({ readonly: true });
    await fireEvent.click(getByTestId('workflow-node-0'));
    await fireEvent.click(getByTestId('workflow-branch-0'));

    expect(spies.onselect).toHaveBeenCalledWith({ kind: 'node', index: 0 });
    expect(spies.onselect).toHaveBeenCalledWith({ kind: 'connection', index: 0 });
  });
});
