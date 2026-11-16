// The inspector of one step: a head that names it, and its settings in four tabs.
//
// The tabs follow the product's roving contract (FR-R4-F08, as on the run detail
// tabs): one Tab stop, arrow keys, Home and End, and focus moves with the selection.
// The Control tab offers Once, Repeat and For each as one choice, and asks before a
// switch would discard the settings of the control the step already carries.

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WorkflowInspector from '../PipelineBuilderEditors/WorkflowInspector.svelte';
import {
  MAX_FOR_EACH_MAX_ITEMS,
  MAX_REPEAT_ITERATIONS,
  MIN_FOR_EACH_MAX_ITEMS,
  MIN_REPEAT_ITERATIONS,
  type PortablePipelineDefinition,
  type PortableWorkflowDefinition,
  type WorkflowNode
} from '../../lib/snapshot-types';
import type { MutableWorkflow } from '../PipelineBuilderEditors/types';
import type { VisibleWorkflowDefects } from '../PipelineBuilderEditors/workflow-catalog-state';
import { defaultForEachControl, defaultRepeatControl } from '../PipelineBuilderEditors/workflow-node-control';

afterEach(() => {
  cleanup();
});

const EMPTY_DEFECTS: VisibleWorkflowDefects = { byNode: [], byConnection: [], rest: [], hiddenChecks: 0 };

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

function renderInspector(
  options: { row?: MutableWorkflow; index?: number; editable?: boolean; pipelines?: readonly PortablePipelineDefinition[] } = {}
) {
  const onnodepatch = vi.fn();
  const onselectworkflow = vi.fn();
  const props = {
    row: options.row ?? makeRow(),
    selection: { kind: 'node', index: options.index ?? 0 } as const,
    pipelines: options.pipelines ?? [],
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

// Finding 147 — the port wrote the step inspector's words after the workflow builder mockup:
// each tab's section heads, the names of its fields, its notes and its empty states. Each
// tabpanel is named by its tab, so a field is found by its own label, never by a tab's word.
const labelled = (text: string) => screen.getByLabelText(text).getAttribute('data-testid');
const expectLabels = (expected: Readonly<Record<string, string>>) => {
  const found = Object.fromEntries(Object.keys(expected).map((label) => [label, labelled(label)]));
  expect(found).toEqual(expected);
};
const sectionHeadings = () => screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent.trim());
const optionTexts = (testId: string) =>
  Array.from((screen.getByTestId(testId) as HTMLSelectElement).options, (option) => option.textContent.trim());

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

describe('the Step tab', () => {
  it('heads what the step runs and how, and names its fields, notes and branch action', () => {
    renderInspector();
    expect(sectionHeadings()).toEqual(['Runs', 'Execution']);
    expectLabels({
      'Step type': 'workflow-node-kind-select-0',
      'Child Workflow': 'workflow-node-workflow-select-0',
      'Label on canvas': 'workflow-node-label-0',
      'Start step (the Workflow may begin here)': 'workflow-node-start-0'
    });
    expect(optionTexts('workflow-node-kind-select-0')).toEqual(['Phase', 'Child Workflow']);
    expect(screen.getByText('Changing what this step runs keeps its connections.')).toBeTruthy();
    expect(screen.getByText('Each step of the child Workflow uses its own settings.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add a branch from this step' }).getAttribute('data-testid')).toBe(
      'workflow-node-branch-add-0'
    );
  });

  it('lists a target the catalog lacks first, marked not effective', async () => {
    const base = makeRow({ workflowId: 'wf-gone' });
    const row = {
      ...base,
      nodes: base.nodes.map((node) => (node.nodeId === 'node-plan' ? { ...node, phaseId: 'phase-gone' } : node))
    };
    const view = renderInspector({ row });
    expect(optionTexts('workflow-node-workflow-select-0')).toEqual(['wf-gone (not effective)', 'Child Review Workflow']);

    await view.rerender({ ...view.props, selection: { kind: 'node', index: 1 } });
    expectLabels({ Phase: 'workflow-node-phase-select-1' });
    expect(optionTexts('workflow-node-phase-select-1')).toEqual(['phase-gone (not effective)', 'Plan']);
  });

  it('names the Pipeline a Pipeline step runs', () => {
    const base = makeRow();
    renderInspector({ row: { ...base, nodes: [...base.nodes, { nodeId: 'node-build', pipelineId: 'pl-build' }] }, index: 3 });
    expect(screen.getByText('Pipeline', { selector: 'dt' }).nextElementSibling?.textContent).toBe('pl-build');
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

  it('heads the inputs and outputs, names the columns and says which unbound input is optional', async () => {
    renderInspector({ row: { ...makeRow(), bindings: [] } });
    await fireEvent.click(screen.getByRole('tab', { name: 'Data' }));
    expect(sectionHeadings()).toEqual(['Inputs', 'Outputs']);
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent.trim())).toEqual(['Input', 'Comes from']);
    const cells = (testId: string) => Array.from(screen.getByTestId(testId).children, (cell) => cell.textContent.trim());
    expect(cells('workflow-node-input-0-feedback')).toEqual(['feedback', 'Not bound']);
    expect(cells('workflow-node-input-0-attempt-note')).toEqual(['attempt-note', 'Not bound (optional)']);
    expect(screen.getByText("Bindings are edited in the Workflow's Inputs and outputs.")).toBeTruthy();
  });

  // The host requires only a child Workflow's inputs (`missing-required-input`). An
  // unbound input of a Pipeline step becomes an optional input of the launch, so it is
  // optional here whatever its Pipeline declares.
  it('calls an unbound input of a Pipeline step optional', async () => {
    const base = makeRow();
    const build = {
      pipelineId: 'pl-build', name: 'Build', version: 1, phaseIds: [], bindings: [], recommendedNext: [],
      inputs: [{ portId: 'spec', label: 'Spec', type: 'text', required: true }],
      outputs: []
    } as unknown as PortablePipelineDefinition;
    renderInspector({
      row: { ...base, nodes: [...base.nodes, { nodeId: 'node-build', pipelineId: 'pl-build' }] },
      index: 3,
      pipelines: [build]
    });
    await fireEvent.click(screen.getByRole('tab', { name: 'Data' }));
    const cells = Array.from(screen.getByTestId('workflow-node-input-3-spec').children, (cell) => cell.textContent.trim());
    expect(cells).toEqual(['spec', 'Not bound (optional)']);
  });

  it('says so when a step declares no inputs and no outputs', async () => {
    renderInspector({ index: 1 });
    await fireEvent.click(screen.getByRole('tab', { name: 'Data' }));
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('No inputs are declared or bound.')).toBeTruthy();
    expect(screen.getByTestId('workflow-node-ports-1').textContent.trim()).toBe('No outputs are declared.');
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

  it('heads the Repeat settings and names each field, with the bounds on iterations', async () => {
    await openControl({ row: makeRow({ control: defaultRepeatControl(CHILD) }) });
    expect(sectionHeadings()).toEqual(['Repeat']);
    expectLabels({
      'Until result field': 'repeat-until-field',
      Comparison: 'repeat-until-operator',
      Value: 'repeat-until-value',
      [`Max iterations (${MIN_REPEAT_ITERATIONS}–${MAX_REPEAT_ITERATIONS})`]: 'repeat-max-iterations',
      'When the iterations run out': 'repeat-on-exhausted'
    });
    expect(screen.getByRole('heading', { level: 4 }).textContent.trim()).toBe('Carried into the next iteration');
    expect(screen.getByText("Nothing is carried: every iteration gets the step's own inputs.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add a carry mapping' }).getAttribute('data-testid')).toBe('add-repeat-carry');
  });

  it('names a carry mapping’s fields, and numbers them by row', async () => {
    const control = { ...defaultRepeatControl(CHILD), carry: [{ fieldId: 'notes', inputPortId: 'feedback' }] };
    await openControl({ row: makeRow({ control }) });
    expectLabels({ 'Result field': 'repeat-carry-field-0', 'Child input': 'repeat-carry-port-0' });
    expect(screen.getByRole('textbox', { name: 'Result field, carry 1' })).toBe(screen.getByTestId('repeat-carry-field-0'));
    expect(screen.getByRole('textbox', { name: 'Child input, carry 1' })).toBe(screen.getByTestId('repeat-carry-port-0'));
    expect(screen.getByRole('button', { name: 'Remove carry mapping 1' }).getAttribute('data-testid')).toBe(
      'remove-repeat-carry-0'
    );
    expect(screen.queryByText("Nothing is carried: every iteration gets the step's own inputs.")).toBeNull();
  });

  it('heads the For each settings and names each field, asking for a step only to read its output', async () => {
    const view = await openControl({ row: makeRow({ control: defaultForEachControl(CHILD) }) });
    expect(sectionHeadings()).toEqual(['For each']);
    expectLabels({
      'Collection from': 'foreach-collection-source',
      'Collection port': 'foreach-collection-port-id',
      'Child input for each item (a required text input)': 'foreach-item-input-port-id',
      'Item key field (optional)': 'foreach-item-key-field',
      [`Max items (${MIN_FOR_EACH_MAX_ITEMS}–${MAX_FOR_EACH_MAX_ITEMS})`]: 'foreach-max-items',
      'When an item fails': 'foreach-on-item-error'
    });
    expect(screen.queryByLabelText('Step id')).toBeNull();

    const fromStep = {
      ...defaultForEachControl(CHILD),
      collection: { source: 'node-output', nodeId: 'node-plan', portId: 'items' } as const
    };
    await view.rerender({ ...view.props, row: makeRow({ control: fromStep }) });
    expectLabels({ 'Step id': 'foreach-collection-node-id' });
  });
});

describe('the Advanced tab', () => {
  it('heads the step’s identity and names its id', async () => {
    renderInspector();
    await fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }));
    expect(sectionHeadings()).toEqual(['Identity']);
    expect(screen.getByText('Node id', { selector: 'dt' }).nextElementSibling?.textContent).toBe('node-review');
  });
});
