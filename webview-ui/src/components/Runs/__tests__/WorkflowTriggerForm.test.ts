// Feature 102 (T026, US3 — FR-012, FR-016, FR-017, FR-041, FR-043) — starting a
// Workflow from Runs.
//
// A launch names ONE start node, and `LaunchWorkflowPayload.request` is that
// node's Pipeline contract. Everything this file pins follows from those two
// facts:
//
//   * **The form asks for the start node's unsatisfied ports and no others**
//     (FR-016). Downstream nodes are asked as the run reaches them, along the
//     continuation path that already exists; collecting their answers here would
//     mean holding them between nodes, which FR-018 forbids.
//   * **The start node is chosen before the ports are asked for** when there is
//     more than one to choose from (FR-043), and the choices are named so they
//     can be told apart — including the node whose `label` is absent, which is
//     the case a naming scheme built on labels alone gets wrong.
//   * **The Pipeline id on the wire is the one the graph gives the node.** The
//     projection carries no node-to-Pipeline map, so the form joins the two; get
//     it wrong and the host refuses `pipeline-mismatch`, which is a refusal no
//     operator can act on.
//   * **The port set follows the projection, never a copy** (FR-017). A
//     connection landing on a port removes it from the derived set, and a form
//     open across that change must stop asking for it.
//
// The refusal assertions are the same shape as the Pipeline side's (FR-012): the
// host's words, one refusal at a time, no stack trace. The `rejected-validation`
// arm is asserted through its field errors rather than its name, because what an
// operator can act on is the message against the field.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Launchable } from '../../../lib/snapshot-types';
import {
  DRAFT_DEFINITION,
  RESEARCH,
  RESEARCH_GRAPH,
  REVIEW_DEFINITION,
  graphWithStarts
} from './launch-fixture';

const launchWorkflow = vi.fn();
vi.mock('../../../lib/workflow-run-ipc', () => ({
  launchWorkflow: (...args: readonly unknown[]) => launchWorkflow(...args),
  continueWorkflow: vi.fn()
}));

// Late import so the form binds to the stub above.
import WorkflowTriggerForm from '../WorkflowTriggerForm.svelte';

afterEach(() => {
  cleanup();
  launchWorkflow.mockReset();
});

const PIPELINES = [DRAFT_DEFINITION, REVIEW_DEFINITION];

/**
 * `node-a` and `node-c` sit on different Pipelines and their unsatisfied ports
 * are named differently, so "only the chosen node's ports" is an assertion about
 * the node and not about which port happens to be listed first.
 */
const DERIVED_INPUTS: Launchable['inputs'] = [
  { portId: 'seed', label: 'Seed', type: 'text', nodeId: 'node-a' },
  { portId: 'brief', label: 'Brief', type: 'local-file', nodeId: 'node-a' },
  { portId: 'draft', label: 'Draft', type: 'text', nodeId: 'node-c' }
];

function workflow(startNodeIds: readonly string[], inputs = DERIVED_INPUTS): Launchable {
  return { ...RESEARCH, inputs, startNodeIds };
}

function mount(entry: Launchable, graph = graphWithStarts(...(entry.startNodeIds ?? []))) {
  return render(WorkflowTriggerForm, {
    props: { entry, graph, pipelines: PIPELINES, onClose: () => {} }
  });
}

/** One start node, already chosen for the operator because there is no choice. */
function mountOneStart() {
  return mount(workflow(['node-a']));
}

async function chooseStart(view: ReturnType<typeof mount>, nodeId: string) {
  await fireEvent.click(view.getByTestId(`workflow-trigger-start-${nodeId}`));
}

async function submit(view: ReturnType<typeof mount>) {
  await fireEvent.click(view.getByTestId('workflow-trigger-submit'));
}

// ---------------------------------------------------------------------------
// FR-016 — the start node's unsatisfied ports, and only those
// ---------------------------------------------------------------------------

describe('the ports a Workflow trigger asks for (FR-016)', () => {
  it('asks for the start node ports no connection supplies', () => {
    const { getByTestId } = mountOneStart();

    expect(getByTestId('run-input-seed')).toBeTruthy();
    expect(getByTestId('run-input-brief')).toBeTruthy();
  });

  it('asks for nothing belonging to another node', () => {
    // `draft` is a real unsatisfied port of this graph — it is simply not this
    // node's. It is asked for when the run reaches `node-c`, not now.
    const { queryByTestId } = mountOneStart();

    expect(queryByTestId('run-input-draft')).toBeNull();
  });

  it('says so plainly when the start node has no unsatisfied ports', () => {
    const { getByTestId, queryByTestId } = mount(workflow(['node-b'], []));

    expect(getByTestId('workflow-trigger-no-inputs')).toBeTruthy();
    expect(queryByTestId('run-input-seed')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FR-043 — which start node, asked only when there is a choice
// ---------------------------------------------------------------------------

describe('choosing a start node (FR-043)', () => {
  it('asks nothing when the Workflow declares exactly one', () => {
    const { queryByTestId, getByTestId } = mountOneStart();

    expect(queryByTestId('workflow-trigger-start-question')).toBeNull();
    expect(getByTestId('run-input-seed')).toBeTruthy();
  });

  it('asks which node before asking for any port when it declares more than one', () => {
    const { getByTestId, queryByTestId } = mount(workflow(['node-a', 'node-c']));

    expect(getByTestId('workflow-trigger-start-question')).toBeTruthy();
    expect(queryByTestId('run-input-seed')).toBeNull();
    expect(queryByTestId('run-input-draft')).toBeNull();
    expect(queryByTestId('workflow-trigger-submit')).toBeNull();
  });

  it('names the choices so they can be told apart, label or no label', () => {
    // `node-c` carries no label. A choice list built on labels alone would offer
    // a blank one, so the node id is what every choice is guaranteed to carry.
    const { getByTestId } = mount(workflow(['node-a', 'node-c']));

    const first = getByTestId('workflow-trigger-start-node-a').textContent ?? '';
    const second = getByTestId('workflow-trigger-start-node-c').textContent ?? '';

    expect(first).toContain('Draft the report');
    expect(first).toContain('node-a');
    expect(second).toContain('node-c');
    expect(first.trim()).not.toBe(second.trim());
  });

  it('asks for the chosen node ports once a choice is made', async () => {
    const view = mount(workflow(['node-a', 'node-c']));

    await chooseStart(view, 'node-c');

    expect(view.getByTestId('run-input-draft')).toBeTruthy();
    expect(view.queryByTestId('run-input-seed')).toBeNull();
    expect(view.queryByTestId('run-input-brief')).toBeNull();
  });

  it('sends the node the operator chose, with that node Pipeline', async () => {
    launchWorkflow.mockResolvedValue({
      outcome: 'started',
      connectedRunId: 'connected-1',
      revision: 1,
      queueItemId: 'queue-1'
    });
    const view = mount(workflow(['node-a', 'node-c']));

    await chooseStart(view, 'node-c');
    await submit(view);

    expect(launchWorkflow).toHaveBeenCalledTimes(1);
    expect(launchWorkflow.mock.calls[0][0]).toMatchObject({
      workflowId: 'analysis-pipeline',
      startNodeId: 'node-c',
      request: { pipelineId: 'review-pipeline' }
    });
  });
});

// ---------------------------------------------------------------------------
// FR-017 — the port set is the current graph, not a remembered one
// ---------------------------------------------------------------------------

describe('the port set follows the graph (FR-017)', () => {
  it('drops a port a connection now supplies, under a live form', async () => {
    const entry = workflow(['node-a']);
    const { getByTestId, queryByTestId, rerender } = mount(entry);
    expect(getByTestId('run-input-brief')).toBeTruthy();

    // A connection landed on `brief`, so the projection no longer derives it.
    await rerender({
      entry: workflow(['node-a'], [DERIVED_INPUTS[0]!, DERIVED_INPUTS[2]!]),
      graph: graphWithStarts('node-a'),
      pipelines: PIPELINES,
      onClose: () => {}
    });

    expect(queryByTestId('run-input-brief')).toBeNull();
    expect(getByTestId('run-input-seed')).toBeTruthy();
  });

  it('lets go of a chosen start node the graph no longer starts from', async () => {
    const view = mount(workflow(['node-a', 'node-c']));
    await chooseStart(view, 'node-c');
    expect(view.getByTestId('run-input-draft')).toBeTruthy();

    await view.rerender({
      entry: workflow(['node-a', 'node-b']),
      graph: graphWithStarts('node-a', 'node-b'),
      pipelines: PIPELINES,
      onClose: () => {}
    });

    expect(view.queryByTestId('run-input-draft')).toBeNull();
    expect(view.getByTestId('workflow-trigger-start-question')).toBeTruthy();
  });

  it('states what it cannot do when the graph has not resolved here', () => {
    const { getByTestId, queryByTestId } = render(WorkflowTriggerForm, {
      props: {
        entry: workflow(['node-a']),
        graph: undefined,
        pipelines: PIPELINES,
        onClose: () => {}
      }
    });

    expect(getByTestId('workflow-trigger-unresolved')).toBeTruthy();
    expect(queryByTestId('workflow-trigger-submit')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FR-041 — path inputs go through the path that already exists
// ---------------------------------------------------------------------------

describe('file and folder ports (FR-041)', () => {
  it('renders a path port through the same contract section as every other port', () => {
    // Reuse is the requirement: a second control for path ports would be a
    // second place the rule below could break.
    const { getByTestId } = mountOneStart();

    expect(getByTestId('run-launcher-contract')).toBeTruthy();
    expect(getByTestId('run-input-brief').tagName.toLowerCase()).toBe('input');
    expect((getByTestId('run-input-brief') as HTMLInputElement).value).toBe('');
  });

  it('names no location of its own when the operator named none', async () => {
    launchWorkflow.mockResolvedValue({
      outcome: 'started',
      connectedRunId: 'connected-2',
      revision: 1,
      queueItemId: 'queue-2'
    });
    const view = mountOneStart();

    await submit(view);

    const payload = launchWorkflow.mock.calls[0][0] as {
      request: { inputs: readonly { portId: string }[] };
    };
    expect(payload.request.inputs.map((input) => input.portId)).not.toContain('brief');
  });

  it('sends what the operator typed, exactly as typed', async () => {
    launchWorkflow.mockResolvedValue({
      outcome: 'started',
      connectedRunId: 'connected-3',
      revision: 1,
      queueItemId: 'queue-3'
    });
    const view = mountOneStart();

    await fireEvent.input(view.getByTestId('run-input-brief'), {
      target: { value: 'notes/brief.md' }
    });
    await submit(view);

    const payload = launchWorkflow.mock.calls[0][0] as {
      request: { inputs: readonly { portId: string; value: string }[] };
    };
    expect(payload.request.inputs).toContainEqual({
      portId: 'brief',
      type: 'local-file',
      value: 'notes/brief.md'
    });
  });
});

// ---------------------------------------------------------------------------
// FR-012 — the refusal an operator reads is the host's
// ---------------------------------------------------------------------------

describe('what the host says back (FR-012)', () => {
  it('states the reason and what to do about it', async () => {
    launchWorkflow.mockResolvedValue({
      outcome: 'rejected-definition',
      reason: 'no-workspace-root'
    });
    const view = mountOneStart();

    await submit(view);

    const status = view.getByTestId('workflow-trigger-status').textContent ?? '';
    expect(status.toLowerCase()).toContain('folder');
    expect(status.toLowerCase()).toContain('open');
  });

  it('renders a field refusal against the field it names', async () => {
    launchWorkflow.mockResolvedValue({
      outcome: 'rejected-validation',
      errors: [{ field: 'inputs.seed', code: 'missing-required-input', message: 'Seed is required.' }]
    });
    const view = mountOneStart();

    await submit(view);

    expect(view.getByTestId('run-launcher-error-inputs.seed').textContent).toContain(
      'Seed is required.'
    );
  });

  it('replaces the previous refusal rather than stacking a second beside it', async () => {
    launchWorkflow.mockResolvedValueOnce({
      outcome: 'rejected-definition',
      reason: 'node-not-startable'
    });
    launchWorkflow.mockResolvedValueOnce({
      outcome: 'rejected-queue',
      reason: 'queue-refused',
      detail: 'the queue is paused'
    });
    const view = mountOneStart();

    await submit(view);
    await submit(view);

    const status = view.getByTestId('workflow-trigger-status').textContent ?? '';
    expect(status).toContain('the queue is paused');
    expect(status.toLowerCase()).not.toContain('start node');
  });

  it('shows no stack trace or bare error identifier', async () => {
    launchWorkflow.mockResolvedValue({
      outcome: 'rejected-queue',
      reason: 'queue-refused',
      detail: 'no-host-response'
    });
    const view = mountOneStart();

    await submit(view);
    const text = view.container.textContent ?? '';

    expect(text).not.toContain('Error:');
    expect(text).not.toMatch(/\bat\s+\w+\s+\(/);
    expect(text).not.toMatch(/\.[jt]s:\d+/);
  });
});

// ---------------------------------------------------------------------------
// The one call site
// ---------------------------------------------------------------------------

describe('submission routes through the shared helper', () => {
  it('names the Workflow, the start node, and that node Pipeline', async () => {
    launchWorkflow.mockResolvedValue({
      outcome: 'started',
      connectedRunId: 'connected-4',
      revision: 1,
      queueItemId: 'queue-4'
    });
    const view = mountOneStart();

    await fireEvent.input(view.getByTestId('run-input-seed'), {
      target: { value: 'the corpus' }
    });
    await submit(view);

    expect(launchWorkflow.mock.calls[0][0]).toMatchObject({
      workflowId: RESEARCH_GRAPH.workflowId,
      startNodeId: 'node-a',
      request: {
        pipelineId: 'draft-pipeline',
        inputs: [{ portId: 'seed', type: 'text', value: 'the corpus' }]
      }
    });
  });

  it('withholds the control only while a launch is in flight', async () => {
    // The one reason a submission may bar its own control: a second press would
    // open a second connected run. It is a fact about the request, never a
    // verdict on the values (FR-011).
    let answer: (result: unknown) => void = () => {};
    launchWorkflow.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    const view = mountOneStart();
    const control = view.getByTestId('workflow-trigger-submit') as HTMLButtonElement;

    expect(control.disabled).toBe(false);
    await submit(view);
    expect(control.disabled).toBe(true);

    answer({ outcome: 'started', connectedRunId: 'c', revision: 1, queueItemId: 'q' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(control.disabled).toBe(false);
  });
});
