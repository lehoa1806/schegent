// The Workflow editor's "Add steps" palette (workflow_builder_redesign.html, 3.4).
//
// Mounted directly: the search, the collapse toggle, the `/` shortcut and each
// item's anatomy belong to this component. What a click adds to the graph is
// the graph's rule, and `PipelineBuilder.test.ts` covers it end to end.

import { cleanup, createEvent, fireEvent, render, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PortablePhaseDefinition, PortableWorkflowDefinition } from '../../lib/snapshot-types';
import WorkflowActionPalette from '../PipelineBuilderEditors/WorkflowActionPalette.svelte';

afterEach(cleanup);

const SPECIFY: PortablePhaseDefinition = {
  phaseId: 'speckit-specify',
  name: 'Specify',
  version: 1,
  description: 'Write the feature spec',
  runner: 'claude',
  model: 'opus',
  effort: 'high'
};

const TASKS: PortablePhaseDefinition = { phaseId: 'speckit-tasks', name: 'Tasks', version: 1 };

const REVIEW: PortableWorkflowDefinition = {
  workflowId: 'review-loop',
  name: 'Review loop',
  version: 1,
  inputs: [{ portId: 'tasks', label: 'Tasks', type: 'text' }],
  outputs: [{ portId: 'report', label: 'Report', type: 'markdown' }],
  nodes: [
    { nodeId: 'review', kind: 'phase', phaseId: 'speckit-specify' },
    { nodeId: 'fix', kind: 'phase', phaseId: 'speckit-tasks' }
  ],
  connections: [],
  startNodeIds: ['review']
};

const SELF: PortableWorkflowDefinition = {
  workflowId: 'design-then-build',
  name: 'Design then Build',
  version: 1,
  nodes: [{ nodeId: 'design', kind: 'phase', phaseId: 'speckit-specify' }],
  connections: [],
  startNodeIds: ['design']
};

interface Overrides {
  phases?: readonly PortablePhaseDefinition[];
  workflows?: readonly PortableWorkflowDefinition[];
  readonly?: boolean;
  splitTargetId?: string | null;
  collapsed?: boolean;
  ontoggle?: () => void;
}

function props(overrides: Overrides = {}) {
  return {
    pipelines: [],
    phases: [SPECIFY, TASKS],
    workflows: [REVIEW, SELF],
    currentWorkflowId: SELF.workflowId,
    readonly: false,
    splitTargetId: null,
    onaddnode: vi.fn(),
    onaddsplit: vi.fn(),
    ...overrides
  };
}

function part(item: HTMLElement, selector: string): string {
  return item.querySelector(selector)?.textContent.trim() ?? '';
}

function search(container: HTMLElement): HTMLInputElement {
  return within(container).getByRole('searchbox', { name: 'Search steps' });
}

describe('WorkflowActionPalette', () => {
  it('names itself "Add steps" and heads each group', () => {
    const { getByRole } = render(WorkflowActionPalette, { props: props() });

    expect(getByRole('complementary', { name: 'Add steps' })).toBeTruthy();
    expect(getByRole('group', { name: 'Phases' })).toBeTruthy();
    expect(getByRole('group', { name: 'Workflows' })).toBeTruthy();
    expect(getByRole('group', { name: 'Logic' })).toBeTruthy();
  });

  it("shows a Phase's name, its id, and its description with its run settings", () => {
    const { getByTestId } = render(WorkflowActionPalette, { props: props() });

    const item = getByTestId('workflow-palette-phase-speckit-specify');
    expect(part(item, '.t')).toBe('Specify');
    expect(part(item, '.d.mono')).toBe('speckit-specify');
    expect(part(item, '.d:not(.mono)')).toBe('Write the feature spec · claude · opus · high');
    expect(item.querySelector('.kicon.k-phase')).not.toBeNull();
  });

  it('omits the detail line of a Phase that declares nothing to show', () => {
    const { getByTestId } = render(WorkflowActionPalette, { props: props() });

    const item = getByTestId('workflow-palette-phase-speckit-tasks');
    expect(part(item, '.d.mono')).toBe('speckit-tasks');
    expect(item.querySelector('.d:not(.mono)')).toBeNull();
  });

  it("shows a child Workflow's steps and ports, and never offers the open Workflow", () => {
    const { getByTestId, queryByTestId } = render(WorkflowActionPalette, { props: props() });

    const item = getByTestId('workflow-palette-workflow-review-loop');
    expect(part(item, '.t')).toBe('Review loop');
    expect(part(item, '.d.mono')).toBe('review-loop');
    expect(part(item, '.d:not(.mono)')).toBe('2 steps · in: tasks · out: report');
    expect(item.querySelector('.kicon.k-workflow')).not.toBeNull();
    expect(queryByTestId('workflow-palette-workflow-design-then-build')).toBeNull();
  });

  it('filters every group by name, id or detail, ignoring case', async () => {
    const { container, queryByTestId, queryByRole } = render(WorkflowActionPalette, {
      props: props()
    });

    await fireEvent.input(search(container), { target: { value: 'TASKS' } });
    expect(queryByTestId('workflow-palette-phase-speckit-tasks')).not.toBeNull();
    expect(queryByTestId('workflow-palette-workflow-review-loop')).not.toBeNull();
    expect(queryByTestId('workflow-palette-phase-speckit-specify')).toBeNull();
    expect(queryByRole('group', { name: 'Logic' })).toBeNull();

    await fireEvent.input(search(container), { target: { value: 'opus' } });
    expect(queryByTestId('workflow-palette-phase-speckit-specify')).not.toBeNull();
    expect(queryByTestId('workflow-palette-phase-speckit-tasks')).toBeNull();
    expect(queryByRole('group', { name: 'Workflows' })).toBeNull();

    await fireEvent.input(search(container), { target: { value: 'split' } });
    expect(queryByTestId('workflow-palette-split')).not.toBeNull();
    expect(queryByRole('group', { name: 'Phases' })).toBeNull();
  });

  it('says so when no step matches the search', async () => {
    const { container, getByText, queryAllByRole } = render(WorkflowActionPalette, {
      props: props()
    });

    await fireEvent.input(search(container), { target: { value: 'zzz' } });
    expect(getByText('No step matches "zzz".')).toBeTruthy();
    expect(queryAllByRole('group')).toHaveLength(0);
  });

  it('keeps Logic and reports an empty catalog when nothing else is effective', () => {
    const { getByTestId, getByRole } = render(WorkflowActionPalette, {
      props: props({ phases: [], workflows: [SELF] })
    });

    expect(getByTestId('workflow-palette-empty').textContent.trim()).toBe(
      'No effective Phases or Workflows'
    );
    expect(getByRole('group', { name: 'Logic' })).toBeTruthy();
  });

  it('disables every item when read-only, and Split until a node is selected', async () => {
    const { getByTestId, rerender } = render(WorkflowActionPalette, {
      props: props({ readonly: true })
    });

    expect((getByTestId('workflow-palette-phase-speckit-specify') as HTMLButtonElement).disabled).toBe(true);
    const split = getByTestId('workflow-palette-split') as HTMLButtonElement;
    expect(split.disabled).toBe(true);
    expect(part(split, '.d')).toBe('Select or add a node first');
    expect(split.querySelector('.kicon.k-logic')).not.toBeNull();

    await rerender(props({ splitTargetId: 'design' }));
    expect((getByTestId('workflow-palette-split') as HTMLButtonElement).disabled).toBe(false);
    expect(part(getByTestId('workflow-palette-split'), '.d')).toBe('Add branch on design');
  });

  it('collapses and expands through its toggle', async () => {
    const ontoggle = vi.fn();
    const { getByRole, getByTestId, rerender } = render(WorkflowActionPalette, {
      props: props({ ontoggle })
    });

    const collapse = getByRole('button', { name: 'Collapse the Add steps panel' });
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    const body = document.getElementById(collapse.getAttribute('aria-controls') ?? '');
    expect(body?.hidden).toBe(false);
    await fireEvent.click(collapse);
    expect(ontoggle).toHaveBeenCalledTimes(1);

    await rerender(props({ ontoggle, collapsed: true }));
    const expand = getByRole('button', { name: 'Expand the Add steps panel' });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    expect(body?.hidden).toBe(true);
    expect(getByTestId('workflow-action-palette').classList.contains('collapsed')).toBe(true);
  });

  it('offers no toggle when the caller cannot collapse it', () => {
    const { queryByRole } = render(WorkflowActionPalette, { props: props() });

    expect(queryByRole('button', { name: /Add steps panel/ })).toBeNull();
  });

  it('moves focus to the search on "/" unless the operator is typing', async () => {
    const { container } = render(WorkflowActionPalette, { props: props() });
    const input = search(container);

    const press = createEvent.keyDown(document.body, { key: '/' });
    await fireEvent(document.body, press);
    expect(press.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);

    const typed = createEvent.keyDown(input, { key: '/' });
    await fireEvent(input, typed);
    expect(typed.defaultPrevented).toBe(false);
  });

  it('expands a collapsed palette on "/"', async () => {
    const ontoggle = vi.fn();
    render(WorkflowActionPalette, { props: props({ ontoggle, collapsed: true }) });

    const press = createEvent.keyDown(document.body, { key: '/' });
    await fireEvent(document.body, press);
    expect(press.defaultPrevented).toBe(true);
    expect(ontoggle).toHaveBeenCalledTimes(1);
  });
});
