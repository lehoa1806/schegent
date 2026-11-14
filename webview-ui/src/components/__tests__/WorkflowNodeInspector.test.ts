// The inspector of one step: a head that names it, and its settings in four tabs.
//
// The tabs follow the product's roving contract (FR-R4-F08, as on the run detail
// tabs): one Tab stop, arrow keys, Home and End, and focus moves with the selection.
// The Control tab offers Once, Repeat and For each as one choice, and asks before a
// switch would discard the settings of the control the step already carries.

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WorkflowInspector from '../PipelineBuilderEditors/WorkflowInspector.svelte';
import type { PortableWorkflowDefinition, WorkflowNode } from '../../lib/snapshot-types';
import type { MutableWorkflow } from '../PipelineBuilderEditors/types';
import type { AnchoredWorkflowDefects } from '../PipelineBuilderEditors/workflow-catalog-state';
import { defaultForEachControl, defaultRepeatControl } from '../PipelineBuilderEditors/workflow-node-control';

afterEach(() => {
  cleanup();
});

const EMPTY_DEFECTS: AnchoredWorkflowDefects = { byNode: [], byConnection: [], rest: [] };

const CHILD: PortableWorkflowDefinition = {
  workflowId: 'wf-child-review',
  name: 'Child Review Workflow',
  version: 1,
  inputs: [
    { portId: 'feedback', label: 'Feedback', type: 'text', required: true },
    { portId: 'attempt-note', label: 'Attempt Note', type: 'text', required: false }
  ],
  outputs: [{ portId: 'verdict', label: 'Verdict', type: 'markdown' }],
  nodes: [{ nodeId: 'n1', kind: 'phase', phaseId: 'phase-review' }],
  connections: [],
  startNodeIds: ['n1'],
  decisionResults: {
    version: 1,
    fields: [{ fieldId: 'approved', type: 'boolean', required: true }],
    bindings: [{ fieldId: 'approved', source: { kind: 'node-result', nodeId: 'n1', fieldId: 'approved' } }]
  }
};

function makeRow(childOverrides: Partial<WorkflowNode> = {}): MutableWorkflow {
  return {
    workflowId: 'wf-parent',
    name: 'Parent Workflow',
    description: '',
    version: 1,
    nodes: [
      { nodeId: 'node-review', kind: 'workflow', workflowId: 'wf-child-review', ...childOverrides },
      { nodeId: 'node-plan', kind: 'phase', phaseId: 'phase-plan', label: 'Plan the work' },
      { nodeId: 'node-second', kind: 'workflow', workflowId: 'wf-child-review' }
    ],
    connections: [],
    bindings: [
      { kind: 'input', nodeId: 'node-review', inputKey: 'feedback', source: { from: 'workflow-input', portId: 'brief' } }
    ],
    startNodeIds: ['node-review'],
    sourceKey: 'wf-parent',
    sourceStatus: 'effective',
    sourceErrors: [],
    persisted: true,
    derivedInputs: [],
    derivedOutputs: []
  };
}

function renderInspector(options: { row?: MutableWorkflow; index?: number; editable?: boolean } = {}) {
  const onnodepatch = vi.fn();
  const onselectworkflow = vi.fn();
  const props = {
    row: options.row ?? makeRow(),
    selection: { kind: 'node', index: options.index ?? 0 } as const,
    pipelines: [],
    phases: [{ phaseId: 'phase-plan', name: 'Plan', version: 1 }],
    workflows: [CHILD],
    defects: EMPTY_DEFECTS,
    editable: options.editable ?? true,
    onworkflowpatch: vi.fn(),
    onnodepatch,
    onstarttoggle: vi.fn(),
    onbranchadd: vi.fn(),
    onretarget: vi.fn(),
    onconnectionpatch: vi.fn(),
    onconditiontoggle: vi.fn(),
    onconditionpatch: vi.fn(),
    onconditionvalue: vi.fn(),
    onconditionvalueadd: vi.fn(),
    onconditionvalueremove: vi.fn(),
    onconnectionmove: vi.fn(),
    onconnectionremove: vi.fn(),
    onselectworkflow
  };
  const view = render(WorkflowInspector, { props });
  return { ...view, props, onnodepatch, onselectworkflow };
}

const tabNames = () => screen.getAllByRole('tab').map((tab) => tab.textContent.trim());
const selectedTab = () => screen.getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true');
const radio = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('the step head', () => {
  it('names the step, says what it runs and leads back to the Workflow', async () => {
    const { onselectworkflow } = renderInspector({ row: makeRow({ label: 'Review loop' }) });
    expect(screen.getByRole('heading', { level: 2 }).textContent.trim()).toBe('Review loop');
    expect(screen.getByTestId('workflow-node-inspector-0').textContent).toContain('Child Workflow step');
    expect(screen.getByTestId('workflow-node-inspector-id').textContent).toBe('node-review');
    const back = screen.getByRole('button', { name: 'Back to the Workflow' });
    expect(back.getAttribute('data-testid')).toBe('workflow-settings-btn');
    await fireEvent.click(back);
    expect(onselectworkflow).toHaveBeenCalledTimes(1);
  });

  it('falls back to the step id and names a Phase step as one', () => {
    renderInspector({ index: 1 });
    expect(screen.getByRole('heading', { level: 2 }).textContent.trim()).toBe('Plan the work');
    expect(screen.getByTestId('workflow-node-inspector-1').textContent).toContain('Phase step');
  });
});

describe('the step tabs', () => {
  it('lists four tabs with the Step tab selected and its panel the only one shown', () => {
    renderInspector();
    expect(screen.getByRole('tablist').getAttribute('aria-label')).toBe('Step settings');
    expect(tabNames()).toEqual(['Step', 'Data', 'Control', 'Advanced']);
    for (const tab of screen.getAllByRole('tab')) {
      const selected = tab.getAttribute('aria-selected') === 'true';
      expect(tab.getAttribute('tabindex'), `${tab.textContent} is a Tab stop only when selected`).toBe(selected ? '0' : '-1');
      const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
      expect(panel?.getAttribute('role')).toBe('tabpanel');
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);
      expect(panel?.hidden, `${tab.textContent} panel is shown only when selected`).toBe(!selected);
    }
    expect(selectedTab()?.textContent.trim()).toBe('Step');
  });

  it('opens a tab on click', async () => {
    renderInspector();
    await fireEvent.click(screen.getByRole('tab', { name: 'Data' }));
    expect(selectedTab()?.textContent.trim()).toBe('Data');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(screen.getByRole('tab', { name: 'Data' }).id);
  });

  it('moves with the arrow keys, Home and End, and focuses the tab it lands on', async () => {
    renderInspector();
    const order: string[] = [];
    for (const key of ['ArrowRight', 'ArrowRight', 'End', 'ArrowRight', 'ArrowLeft', 'Home']) {
      const from = selectedTab();
      if (from === undefined) throw new Error('no selected tab');
      await fireEvent.keyDown(from, { key });
      await settle();
      expect(document.activeElement, `${key} focuses the selected tab`).toBe(selectedTab());
      order.push(selectedTab()?.textContent.trim() ?? '');
    }
    expect(order).toEqual(['Data', 'Control', 'Advanced', 'Step', 'Advanced', 'Step']);
  });

  it('leaves other keys alone', async () => {
    renderInspector();
    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    screen.getByRole('tab', { name: 'Step' }).dispatchEvent(event);
    await settle();
    expect(event.defaultPrevented).toBe(false);
    expect(selectedTab()?.textContent.trim()).toBe('Step');
  });

  it('keeps the open tab across steps, but leaves Control for a step that cannot loop', async () => {
    const view = renderInspector();
    await fireEvent.click(screen.getByRole('tab', { name: 'Control' }));
    await view.rerender({ ...view.props, selection: { kind: 'node', index: 2 } });
    expect(selectedTab()?.textContent.trim(), 'another child Workflow step keeps Control').toBe('Control');
    await view.rerender({ ...view.props, selection: { kind: 'node', index: 1 } });
    expect(selectedTab()?.textContent.trim(), 'a Phase step goes back to Step').toBe('Step');
  });
});

describe('the Data tab', () => {
  it('lists where each input of the child Workflow comes from, and what the step puts out', async () => {
    renderInspector();
    await fireEvent.click(screen.getByRole('tab', { name: 'Data' }));
    expect(screen.getByTestId('workflow-node-input-0-feedback').textContent).toContain('Workflow input brief');
    expect(screen.getByTestId('workflow-node-input-0-attempt-note').textContent).toContain('Not bound');
    expect(screen.getByTestId('workflow-node-ports-0').textContent).toContain('verdict');
  });
});

describe('the Control tab', () => {
  async function openControl(options: Parameters<typeof renderInspector>[0] = {}) {
    const view = renderInspector(options);
    await fireEvent.click(screen.getByRole('tab', { name: 'Control' }));
    return view;
  }

  it('offers the three ways a step runs, with the current one chosen', async () => {
    await openControl();
    expect(screen.getByRole('group', { name: 'How this step runs' })).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    const once = screen.getByRole('radio', { name: 'Once', description: 'Run the step a single time.' }) as HTMLInputElement;
    expect(once.checked).toBe(true);
    expect(screen.getByRole('radio', { name: 'Repeat until…', description: 'Rerun until a result field matches, up to a cap.' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'For each…', description: 'Run once per item of a collection, in order.' })).toBeTruthy();
  });

  it('switches a step that runs once straight away', async () => {
    const { onnodepatch } = await openControl();
    await fireEvent.click(screen.getByRole('radio', { name: 'Repeat until…' }));
    expect(onnodepatch).toHaveBeenCalledWith(0, { control: defaultRepeatControl(CHILD) });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('asks before a switch discards the settings of the current control, and switches on Switch', async () => {
    const { onnodepatch } = await openControl({ row: makeRow({ control: defaultRepeatControl(CHILD) }) });
    await fireEvent.click(screen.getByRole('radio', { name: 'For each…' }));
    expect(onnodepatch).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('Switching discards the Repeat settings.');
    expect(radio('toggle-foreach-control').checked).toBe(true);
    await fireEvent.click(screen.getByTestId('workflow-node-control-switch-0'));
    expect(onnodepatch).toHaveBeenCalledWith(0, { control: defaultForEachControl(CHILD) });
    expect(defaultForEachControl(CHILD).itemInputPortId).toBe('feedback');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('asks before clearing a control, and keeps it on Keep', async () => {
    const { onnodepatch } = await openControl({ row: makeRow({ control: defaultForEachControl(CHILD) }) });
    await fireEvent.click(screen.getByRole('radio', { name: 'Once' }));
    expect(screen.getByRole('alert').textContent).toContain('Switching discards the For each settings.');
    await fireEvent.click(screen.getByTestId('workflow-node-control-keep-0'));
    await settle();
    expect(onnodepatch).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(radio('toggle-foreach-control').checked).toBe(true);
    expect(radio('workflow-node-control-once-0').checked).toBe(false);
    expect(document.activeElement, 'focus returns to the kept choice').toBe(radio('toggle-foreach-control'));
  });

  it('offers Repeat and For each only on a child Workflow step', async () => {
    await openControl({ index: 1 });
    expect(radio('workflow-node-control-once-1').disabled).toBe(false);
    expect(radio('toggle-repeat-control').disabled).toBe(true);
    expect(radio('toggle-foreach-control').disabled).toBe(true);
    expect(screen.getByTestId('workflow-node-inspector-1').textContent).toContain('Repeat and For each apply to child Workflow steps.');
  });

  it('locks the choice when the Workflow is read-only', async () => {
    await openControl({ editable: false });
    for (const input of screen.getAllByRole('radio')) expect((input as HTMLInputElement).disabled).toBe(true);
  });
});
