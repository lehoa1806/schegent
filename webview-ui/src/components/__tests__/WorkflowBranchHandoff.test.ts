// The branch inspector's head and its handoff choice.
//
// The head names the branch by the two steps it joins, or by its step and the
// return, and leads back to the Workflow. Handoff is a choice of two, so it is a pair of radios: continue on its
// own, or pause until the operator continues the handoff. Either way the patch is
// the one the select raised before, `{ handoff }`.

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConnection, WorkflowNode } from '../../lib/snapshot-types';
import WorkflowBranchInspector from '../PipelineBuilderEditors/WorkflowBranchInspector.svelte';

afterEach(cleanup);

const NODES: readonly WorkflowNode[] = [
  { nodeId: 'plan', kind: 'phase', phaseId: 'p-plan', label: 'Plan the work' },
  { nodeId: 'ship', kind: 'phase', phaseId: 'p-ship' }
];

const PLAIN: WorkflowConnection = { from: { nodeId: 'plan' }, to: { nodeId: 'ship' } };

function mount(connection: WorkflowConnection, options: { readonly?: boolean; onback?: () => void } = {}) {
  const onpatch = vi.fn();
  render(WorkflowBranchInspector, {
    props: {
      index: 0,
      connection,
      nodes: NODES,
      pipelines: [],
      defects: [],
      readonly: options.readonly ?? false,
      connectionCount: 2,
      onretarget: vi.fn(),
      onpatch,
      onconditiontoggle: vi.fn(),
      onconditionpatch: vi.fn(),
      onconditionvalue: vi.fn(),
      onconditionvalueadd: vi.fn(),
      onconditionvalueremove: vi.fn(),
      onmove: vi.fn(),
      onremove: vi.fn(),
      onback: options.onback
    }
  });
  return { onpatch };
}

const radio = (name: string) => screen.getByRole('radio', { name }) as HTMLInputElement;

describe('the branch head', () => {
  it('names the branch and the two steps it joins', () => {
    mount(PLAIN);
    expect(screen.getByRole('heading', { level: 2 }).textContent.trim()).toBe('Branch 1');
    expect(screen.getByTestId('workflow-branch-inspector-0').textContent).toContain('Plan the work → ship');
  });

  it('names a return by its step and the return, not by the step its endpoint names', () => {
    // The run engine reads a return's endpoint without its node, as the canvas
    // draws the arm: into a Return pill, not into that step's card.
    mount({ from: { nodeId: 'plan' }, to: { nodeId: 'ship', kind: 'return' } });
    const text = screen.getByTestId('workflow-branch-inspector-0').textContent;
    expect(text).toContain('Plan the work → Return');
    expect(text).not.toContain('→ ship');
  });

  it('leads back to the Workflow when the inspector offers a way back', async () => {
    const onback = vi.fn();
    mount(PLAIN, { onback });
    const back = screen.getByRole('button', { name: 'Back to the Workflow' });
    expect(back.getAttribute('data-testid')).toBe('workflow-settings-btn');
    await fireEvent.click(back);
    expect(onback).toHaveBeenCalledTimes(1);
  });

  it('has no back button without a way back', () => {
    mount(PLAIN);
    expect(screen.queryByRole('button', { name: 'Back to the Workflow' })).toBeNull();
  });
});

describe('the handoff choice', () => {
  it('continues automatically unless the branch says otherwise', () => {
    mount(PLAIN);
    expect(screen.getByRole('group', { name: 'Handoff' }).getAttribute('data-testid')).toBe('workflow-connection-handoff-0');
    expect(radio('Continue automatically').checked).toBe(true);
    expect(radio('Wait for the operator').checked).toBe(false);
  });

  it('patches the handoff either way', async () => {
    const { onpatch } = mount(PLAIN);
    await fireEvent.click(radio('Wait for the operator'));
    expect(onpatch).toHaveBeenCalledWith(0, { handoff: 'manual' });
    cleanup();
    const manual = mount({ ...PLAIN, handoff: 'manual' });
    expect(radio('Wait for the operator').checked).toBe(true);
    await fireEvent.click(radio('Continue automatically'));
    expect(manual.onpatch).toHaveBeenCalledWith(0, { handoff: 'auto' });
  });

  it('says what waiting means', () => {
    mount(PLAIN);
    expect(
      screen.getByRole('radio', {
        name: 'Wait for the operator',
        description: 'The run pauses here until someone chooses Continue Handoff.'
      })
    ).toBeTruthy();
  });

  it('locks both choices when the Workflow is read-only', () => {
    mount(PLAIN, { readonly: true });
    expect(radio('Continue automatically').disabled).toBe(true);
    expect(radio('Wait for the operator').disabled).toBe(true);
  });
});

describe('the branch actions', () => {
  it('draws the move and delete actions as icons with their names kept', () => {
    mount(PLAIN);
    for (const testId of ['workflow-connection-up-0', 'workflow-connection-down-0', 'workflow-connection-remove-0']) {
      const button = screen.getByTestId(testId);
      expect(button.getAttribute('type'), `${testId} is not a submit button`).toBe('button');
      expect(button.querySelector('svg use'), `${testId} draws a sprite icon`).not.toBeNull();
    }
    expect(screen.getByRole('button', { name: 'Move branch 1 earlier' }).textContent.trim()).toBe('');
    expect(screen.getByRole('button', { name: 'Move branch 1 later' }).textContent.trim()).toBe('');
    expect(screen.getByRole('button', { name: 'Delete this branch' })).toBeTruthy();
  });

  it('labels the priority with the order it sets', () => {
    mount(PLAIN);
    expect(screen.getByLabelText('Priority (lower is checked first)').getAttribute('data-testid')).toBe(
      'workflow-connection-priority-0'
    );
  });
});
