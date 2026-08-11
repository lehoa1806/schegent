// Feature 088 T046 — what the connected-run surface must and must not offer.
//
// Four properties, and each is a place where a plausible-looking view would be
// wrong rather than merely ugly:
//
//   * **The hydration gate** (FR-058). While the host reports `hydrating`, the
//     view shows a loading state and NO controls. A disabled control would be
//     wrong too: it says "this exists and is momentarily unavailable" about a
//     node set that has not been read yet.
//   * **The four node states** (FR-055) plus FR-055a's terminal readings. A
//     failed node stays failed; it does not read as `available` because a repeat
//     start happens to be legal on it.
//   * **No start control while a child is non-terminal** (FR-044, FR-057). The
//     host expresses this by folding an empty `actions` for every node, and the
//     view renders controls from `actions` alone — so this test pins that the
//     view adds nothing of its own.
//   * **Operator text is text** (FR-059).
//
// The host is stubbed at its single seam: `continueWorkflow` is the one webview
// call site for this family, so replacing it replaces the whole boundary, and
// the payload it receives is the assertable artifact — including the
// `expectedRevision` that is the family's only idempotency mechanism.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContinueWorkflowPayload, ContinueWorkflowResult } from '../../../lib/messages';
import type {
  ConnectedNodeProjection,
  ConnectedRunProjection,
  PipelineDefinition,
  QueueItem
} from '../../../lib/snapshot-types';

const continueSpy = vi.fn<(payload: ContinueWorkflowPayload) => Promise<ContinueWorkflowResult>>();
vi.mock('../../../lib/workflow-run-ipc', () => ({
  continueWorkflow: (payload: ContinueWorkflowPayload) => continueSpy(payload)
}));

// The overwrite decision inside the reused output section goes through the
// shared confirmation helper, as it does for the independent launcher.
const confirmSpy = vi.fn<() => Promise<boolean>>();
vi.mock('../../../lib/use-confirm', () => ({
  useConfirm: () => confirmSpy()
}));

// Late import so the component binds to the mocked call sites above.
import WorkflowRun from '../WorkflowRun.svelte';

const PIPELINE: PipelineDefinition = {
  id: 'analysis-pipeline',
  name: 'Analysis Pipeline',
  phases: ['speckit-specify', 'speckit-plan'],
  inputs: [
    { portId: 'topic', label: 'Topic', type: 'text', required: true },
    // Fed by an earlier Phase, never by the operator (FR-001a).
    { portId: 'carried', label: 'Carried context', type: 'pipeline-output' }
  ],
  outputs: [{ portId: 'report', label: 'Report', type: 'markdown' }]
};

function node(overrides: Partial<ConnectedNodeProjection> = {}): ConnectedNodeProjection {
  return {
    nodeId: 'node-a',
    pipelineId: 'analysis-pipeline',
    state: 'available',
    actions: ['start'],
    attemptCount: 0,
    ...overrides
  };
}

function run(overrides: Partial<ConnectedRunProjection> = {}): ConnectedRunProjection {
  return {
    connectedRunId: 'connected-run-1',
    workflowId: 'research-workflow',
    revision: 7,
    hydrating: false,
    nodes: [node()],
    ...overrides
  };
}

const QUEUE_ITEM: QueueItem = {
  id: 'queue-item-1',
  label: 'Analyse the corpus',
  enqueuedAt: '2026-01-01T00:00:00.000Z',
  startedAt: '2026-01-01T00:01:00.000Z',
  updatedAt: '2026-01-01T00:02:00.000Z',
  completedAt: null,
  status: 'in-flight',
  retryCount: 0,
  lastErrorSummary: null,
  pausedReason: null,
  currentPhase: 'speckit-plan',
  position: 0
};

const STARTED: ContinueWorkflowResult = {
  outcome: 'started',
  revision: 8,
  queueItemId: 'queue-item-2'
};

type Query = (id: string) => HTMLElement;

function mount(projection: ConnectedRunProjection, props: Record<string, unknown> = {}) {
  return render(WorkflowRun, {
    props: { run: projection, pipelines: [PIPELINE], queueItems: [QUEUE_ITEM], ...props }
  });
}

async function submit(getByTestId: Query): Promise<void> {
  await fireEvent.click(getByTestId('workflow-continuation-submit'));
  // The submit handler awaits the (stubbed) host before it settles, so let its
  // continuation run before the assertions read the DOM.
  await tick();
  await tick();
}

/** The single continuation the view put on the wire. */
function submitted(): ContinueWorkflowPayload {
  expect(continueSpy).toHaveBeenCalledTimes(1);
  return continueSpy.mock.calls[0]![0];
}

beforeEach(() => {
  continueSpy.mockReset();
  continueSpy.mockResolvedValue(STARTED);
  confirmSpy.mockReset();
  confirmSpy.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
});

describe('WorkflowRun — the hydration gate (FR-058)', () => {
  it('shows a loading state and no node list while hydrating', () => {
    const { getByTestId, queryByTestId } = mount(run({ hydrating: true }));

    expect(getByTestId('workflow-run-hydrating')).toBeTruthy();
    expect(queryByTestId('workflow-node-states')).toBeNull();
  });

  it('offers no action while hydrating, not even a disabled one', () => {
    const { container } = mount(
      run({ hydrating: true, nodes: [node({ actions: ['start', 'restart'] })] })
    );

    // A speculative action set is the failure this gate exists to prevent: no
    // control at all, rather than a disabled one, because the node set has not
    // been read yet.
    expect(container.querySelectorAll('button').length).toBe(0);
  });

  it('renders the nodes once hydration completes', () => {
    const { getByTestId } = mount(run());

    expect(getByTestId('workflow-node-states')).toBeTruthy();
    expect(getByTestId('workflow-node-state-node-a').textContent?.trim()).toBe('available');
  });
});

describe('WorkflowRun — node states (FR-055, FR-055a)', () => {
  it('distinguishes completed, available, blocked, and unvisited', () => {
    const { getByTestId } = mount(
      run({
        nodes: [
          node({ nodeId: 'done', state: 'completed', actions: [], attemptCount: 1 }),
          node({ nodeId: 'next', state: 'available', actions: ['start'] }),
          node({ nodeId: 'skipped', state: 'blocked', actions: [] }),
          node({ nodeId: 'later', state: 'unvisited', actions: [] })
        ]
      })
    );

    expect(getByTestId('workflow-node-state-done').textContent?.trim()).toBe('completed');
    expect(getByTestId('workflow-node-state-next').textContent?.trim()).toBe('available');
    expect(getByTestId('workflow-node-state-skipped').textContent?.trim()).toBe('blocked');
    expect(getByTestId('workflow-node-state-later').textContent?.trim()).toBe('unvisited');
  });

  it('keeps a terminal node in its terminal state even when a repeat start is legal', () => {
    const { getByTestId } = mount(
      run({ nodes: [node({ nodeId: 'ran', state: 'failed', actions: ['restart'], attemptCount: 2 })] })
    );

    // FR-055a: the restart is an action on a failed node, not a fifth state.
    expect(getByTestId('workflow-node-state-ran').textContent?.trim()).toBe('failed');
    expect(getByTestId('workflow-node-action-ran-restart')).toBeTruthy();
  });

  it('reuses the existing Run surface for a node that has attempted (FR-056)', () => {
    const { getByTestId } = mount(
      run({
        nodes: [
          node({ state: 'in-flight', actions: [], attemptCount: 1, latestQueueItemId: 'queue-item-1' })
        ]
      })
    );

    // The row comes from the shared queue-item component, not a parallel
    // implementation of Pipeline/Phase/log rendering.
    expect(getByTestId('workflow-node-attempt-node-a')).toBeTruthy();
    expect(getByTestId('workflow-node-run-queue-item-1')).toBeTruthy();
  });

  it('says an attempt is still arriving when the queue projection has not caught up', () => {
    const { getByTestId, queryByTestId } = mount(
      run({
        nodes: [node({ state: 'in-flight', actions: [], attemptCount: 1, latestQueueItemId: 'not-yet' })]
      })
    );

    expect(getByTestId('workflow-node-attempt-pending-node-a')).toBeTruthy();
    expect(queryByTestId('workflow-node-attempt-node-a')).toBeNull();
  });
});

describe('WorkflowRun — only legal controls (FR-044, FR-057)', () => {
  it('offers no start control while a child is non-terminal', () => {
    // What the host folds while a child runs: every node carries an empty
    // action set, including the successors that would otherwise be available.
    const { container, queryByTestId } = mount(
      run({
        nodes: [
          node({ nodeId: 'running', state: 'in-flight', actions: [], attemptCount: 1 }),
          node({ nodeId: 'next', state: 'available', actions: [] })
        ]
      })
    );

    expect(queryByTestId('workflow-node-action-next-start')).toBeNull();
    expect(queryByTestId('workflow-node-action-running-restart')).toBeNull();
    expect(container.querySelectorAll('.node-action').length).toBe(0);
  });

  it('closes the composer when the refreshed projection stops offering the node', async () => {
    const { getByTestId, queryByTestId, rerender } = mount(run());

    await fireEvent.click(getByTestId('workflow-node-action-node-a-start'));
    expect(getByTestId('workflow-continuation')).toBeTruthy();

    await rerender({
      run: run({ revision: 8, nodes: [node({ state: 'in-flight', actions: [], attemptCount: 1 })] }),
      pipelines: [PIPELINE],
      queueItems: [QUEUE_ITEM]
    });

    expect(queryByTestId('workflow-continuation')).toBeNull();
  });

  it('says so rather than composing when the node names an unresolvable Pipeline', async () => {
    const { getByTestId, queryByTestId } = mount(run(), { pipelines: [] });

    await fireEvent.click(getByTestId('workflow-node-action-node-a-start'));

    expect(getByTestId('workflow-run-unresolved-pipeline')).toBeTruthy();
    expect(queryByTestId('workflow-continuation')).toBeNull();
  });
});

describe('WorkflowRun — the continuation composer (FR-035 to FR-039, FR-046)', () => {
  it('projects the node Pipeline contract, omitting the phase-fed port', async () => {
    const { getByTestId, queryByTestId } = mount(run());

    await fireEvent.click(getByTestId('workflow-node-action-node-a-start'));

    expect(getByTestId('run-input-topic')).toBeTruthy();
    expect(queryByTestId('run-input-carried')).toBeNull();
  });

  it('prefills from the incoming bindings and lets the operator replace the value', async () => {
    const { getByTestId } = mount(run(), {
      prefillFor: () => ({ topic: 'carried topic' })
    });

    await fireEvent.click(getByTestId('workflow-node-action-node-a-start'));
    expect((getByTestId('run-input-topic') as HTMLInputElement).value).toBe('carried topic');

    await fireEvent.input(getByTestId('run-input-topic'), { target: { value: 'my own topic' } });
    await submit(getByTestId);

    // FR-039: the host receives what the operator entered, never the prefill.
    expect(submitted().request.inputs).toEqual([
      { portId: 'topic', type: 'text', value: 'my own topic' }
    ]);
  });

  it('echoes the revision the view was rendered from (FR-046)', async () => {
    const { getByTestId } = mount(run({ revision: 12 }));

    await fireEvent.click(getByTestId('workflow-node-action-node-a-start'));
    await fireEvent.input(getByTestId('run-input-topic'), { target: { value: 'topic' } });
    await submit(getByTestId);

    const payload = submitted();
    expect(payload.connectedRunId).toBe('connected-run-1');
    expect(payload.expectedRevision).toBe(12);
    expect(payload.nodeId).toBe('node-a');
    expect(payload.request.pipelineId).toBe('analysis-pipeline');
  });

  it('submits an incomplete composition and renders the refusal per field (FR-045)', async () => {
    continueSpy.mockResolvedValue({
      outcome: 'rejected-validation',
      errors: [
        { field: 'inputs.topic', code: 'missing-required-input', message: 'Topic is required.' }
      ]
    });
    const { getByTestId } = mount(run());

    await fireEvent.click(getByTestId('workflow-node-action-node-a-start'));
    await submit(getByTestId);

    expect(getByTestId('run-launcher-error-inputs.topic').textContent).toContain(
      'Topic is required.'
    );
  });

  it('reports a stale refusal as a refreshed run rather than a field problem', async () => {
    continueSpy.mockResolvedValue({
      outcome: 'rejected-stale',
      projection: run({ revision: 9 })
    });
    const { getByTestId } = mount(run());

    await fireEvent.click(getByTestId('workflow-node-action-node-a-start'));
    await submit(getByTestId);

    expect(getByTestId('workflow-continuation-status').textContent).toContain('moved on');
  });

  it('reports a non-terminal child as the run-state refusal it is', async () => {
    continueSpy.mockResolvedValue({
      outcome: 'rejected-state',
      reason: 'child-not-terminal',
      projection: run()
    });
    const { getByTestId } = mount(run());

    await fireEvent.click(getByTestId('workflow-node-action-node-a-start'));
    await submit(getByTestId);

    expect(getByTestId('workflow-continuation-status').textContent).toContain('still working');
  });

  it('reports the started child once the composer closes itself', async () => {
    const { getByTestId } = mount(run());

    await fireEvent.click(getByTestId('workflow-node-action-node-a-start'));
    await fireEvent.input(getByTestId('run-input-topic'), { target: { value: 'topic' } });
    await submit(getByTestId);

    expect(getByTestId('workflow-run-status').textContent).toContain('queue-item-2');
  });
});

describe('WorkflowRun — operator text is text (FR-059)', () => {
  it('carries instructions verbatim and never interprets them as markup', async () => {
    const markup = '<img src=x onerror="alert(1)"> **not bold**';
    const { getByTestId, container } = mount(run());

    await fireEvent.click(getByTestId('workflow-node-action-node-a-start'));
    await fireEvent.input(getByTestId('run-supplemental-instruction'), {
      target: { value: markup }
    });
    await submit(getByTestId);

    expect(submitted().request.instructions).toBe(markup);
    // Nothing the operator typed became an element.
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders an identifier that looks like markup as text', () => {
    const hostile = '<b>node</b>';
    const { getByTestId, container } = mount(
      run({ workflowId: hostile, nodes: [node({ nodeId: hostile, actions: [] })] })
    );

    expect(getByTestId('workflow-run-title').textContent).toBe(hostile);
    expect(getByTestId(`workflow-node-id-${hostile}`).textContent).toBe(hostile);
    expect(container.querySelector('b')).toBeNull();
  });
});
