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
  ConnectedInvocationProjection,
  ConnectedNodeProjection,
  ConnectedRunProjection,
  PipelineDefinition,
  QueueItem
} from '../../../lib/snapshot-types';

const continueSpy = vi.fn<(payload: ContinueWorkflowPayload) => Promise<ContinueWorkflowResult>>();
const controlSpy = vi.fn<(...args: readonly unknown[]) => Promise<ContinueWorkflowResult>>();
vi.mock('../../../lib/workflow-run-ipc', () => ({
  continueWorkflow: (payload: ContinueWorkflowPayload) => continueSpy(payload),
  controlWorkflowRun: (...args: readonly unknown[]) => controlSpy(...args)
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
  position: 0,
  phaseProgress: null
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
  controlSpy.mockReset();
  controlSpy.mockResolvedValue(STARTED);
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

describe('WorkflowRun — hierarchical invocation tree and controls (FR-R5-F06)', () => {
  function inv(
    overrides: Partial<ConnectedInvocationProjection> & Pick<ConnectedInvocationProjection, 'invocationId'>
  ): ConnectedInvocationProjection {
    return {
      parentInvocationId: null,
      workflowId: 'research-workflow',
      depth: 0,
      nodePath: 'research-workflow',
      status: 'in-flight',
      currentNodeId: null,
      activeAttemptId: null,
      activeAttemptIndex: null,
      waitingReason: null,
      pauseCause: null,
      failureReason: null,
      pendingRetryAt: null,
      pendingRetryCause: null,
      allowedActions: [],
      attempts: [],
      outputPortIds: [],
      ...overrides
    };
  }

  it('renders distinct invocationId and nodePath across repeated child Workflow occurrences and supports expand/collapse', async () => {
    const { getByTestId, queryByTestId } = mount(
      run({
        queueId: 'queue-bound-1',
        status: 'in-flight',
        rootInvocationId: 'inv-root',
        activeInvocationId: 'inv-child-2',
        recoveryDisposition: {
          status: 'clean-handoff',
          reason: 'Recovered cleanly after restart.',
          targetInvocationId: 'inv-child-2'
        },
        invocations: [
          inv({
            invocationId: 'inv-root',
            workflowName: 'Research Workflow',
            frozenVersionId: 'v3',
            currentNodeId: 'call-2',
            allowedActions: ['pause', 'cancel'],
            outputPortIds: ['final-summary']
          }),
          inv({
            invocationId: 'inv-child-1',
            parentInvocationId: 'inv-root',
            workflowId: 'sub-review',
            workflowName: 'Sub Review',
            frozenVersionId: 'v1',
            depth: 1,
            nodePath: 'research-workflow/call-1/sub-review',
            status: 'completed',
            attempts: [
              {
                attemptId: 'att-1',
                attemptIndex: 1,
                nodeId: 'review-step',
                nodeKind: 'phase',
                status: 'completed',
                startedAt: 1000,
                endedAt: 2000
              }
            ],
            outputPortIds: ['verdict']
          }),
          inv({
            invocationId: 'inv-child-2',
            parentInvocationId: 'inv-root',
            workflowId: 'sub-review',
            workflowName: 'Sub Review',
            frozenVersionId: 'v1',
            depth: 1,
            nodePath: 'research-workflow/call-2/sub-review',
            status: 'paused',
            currentNodeId: 'review-step',
            pauseCause: 'operator-pause',
            waitingReason: 'Paused by operator.',
            allowedActions: ['resume', 'cancel']
          })
        ]
      })
    );

    expect(getByTestId('workflow-run-queue').textContent).toContain('queue-bound-1');
    expect(getByTestId('workflow-run-overall-status').textContent).toBe('in-flight');
    expect(getByTestId('workflow-run-recovery-disposition').textContent).toContain(
      'clean-handoff'
    );
    expect(getByTestId('workflow-invocation-tree')).toBeTruthy();
    expect(getByTestId('workflow-invocation-id-inv-child-1').textContent).toBe('inv-child-1');
    expect(getByTestId('workflow-invocation-path-inv-child-1').textContent).toBe(
      'research-workflow/call-1/sub-review'
    );
    expect(getByTestId('workflow-invocation-id-inv-child-2').textContent).toBe('inv-child-2');
    expect(getByTestId('workflow-invocation-path-inv-child-2').textContent).toBe(
      'research-workflow/call-2/sub-review'
    );
    expect(getByTestId('workflow-invocation-diagnostic-inv-child-2').textContent).toContain(
      'operator-pause'
    );

    // Toggle collapse on inv-child-1
    expect(getByTestId('workflow-invocation-attempt-att-1')).toBeTruthy();
    await fireEvent.click(getByTestId('workflow-invocation-toggle-inv-child-1'));
    expect(queryByTestId('workflow-invocation-attempt-att-1')).toBeNull();
  });

  it('dispatches invocation-scoped control commands with expectedRevision and target invocationId', async () => {
    const { getByTestId } = mount(
      run({
        revision: 14,
        rootInvocationId: 'inv-root',
        invocations: [
          inv({
            invocationId: 'inv-root',
            currentNodeId: 'node-a',
            allowedActions: ['pause', 'cancel']
          })
        ]
      })
    );

    await fireEvent.click(getByTestId('workflow-invocation-action-inv-root-pause'));
    await tick();
    await tick();

    expect(continueSpy).toHaveBeenCalledTimes(1);
    expect(continueSpy.mock.calls[0]?.[0]).toMatchObject({
      connectedRunId: 'connected-run-1',
      expectedRevision: 14,
      invocationId: 'inv-root',
      operation: 'pause'
    });
  });

  it('renders pause explanation and guidance when an invocation is paused for recovery-uncertain-effect (FR-R5-F08)', () => {
    const { getByTestId } = mount(
      run({
        revision: 15,
        rootInvocationId: 'inv-root',
        invocations: [
          inv({
            invocationId: 'inv-root',
            status: 'paused',
            currentNodeId: 'node-a',
            pauseCause: 'recovery-uncertain-effect',
            pauseExplanation:
              'Paused during restart recovery because the active Phase attempt had no live queue task or verified settlement evidence.',
            pauseGuidance:
              'Inspect workspace outputs, then choose Resume (reconciles evidence before re-dispatching), Retry Phase, or Cancel.',
            allowedActions: ['resume', 'retry-phase', 'cancel']
          })
        ]
      })
    );

    const guidanceEl = getByTestId('workflow-invocation-pause-guidance-inv-root');
    expect(guidanceEl.textContent).toContain('Paused during restart recovery');
    expect(guidanceEl.textContent).toContain('Inspect workspace outputs');
  });
});

// Feature 265 BUG-001 (FR-009) — every node and attempt that names a Task the
// queue holds opens that Task, by pointer and by keyboard. A control is offered
// only where it can land: no attempt, a `workflow` attempt (it names a child
// invocation, not a Task), or a Task the queue no longer holds gets none.
describe('WorkflowRun — member Tasks open from the topology (Feature 265 BUG-001)', () => {
  const MEMBER: QueueItem = { ...QUEUE_ITEM, id: 'member-a1', status: 'completed', currentPhase: null };

  function memberRun(): ConnectedRunProjection {
    return run({
      nodes: [
        node({ nodeId: 'node-a', state: 'completed', actions: [], attemptCount: 1, latestQueueItemId: MEMBER.id }),
        node({ nodeId: 'node-b', state: 'unvisited', actions: [], attemptCount: 0 })
      ],
      invocations: [
        {
          invocationId: 'inv-root',
          parentInvocationId: null,
          workflowId: 'research-workflow',
          depth: 0,
          nodePath: 'research-workflow',
          status: 'in-flight',
          currentNodeId: 'node-a',
          activeAttemptId: null,
          activeAttemptIndex: null,
          allowedActions: [],
          waitingReason: null,
          pauseCause: null,
          failureReason: null,
          pendingRetryAt: null,
          pendingRetryCause: null,
          outputPortIds: [],
          attempts: [
            { attemptId: 'att-held', attemptIndex: 1, nodeId: 'node-a', nodeKind: 'phase', status: 'completed', startedAt: 1, endedAt: 2, queueItemId: MEMBER.id },
            { attemptId: 'att-child', attemptIndex: 1, nodeId: 'node-c', nodeKind: 'workflow', status: 'in-flight', startedAt: 3, childInvocationId: 'inv-child' },
            { attemptId: 'att-gone', attemptIndex: 2, nodeId: 'node-a', nodeKind: 'phase', status: 'failed', startedAt: 4, queueItemId: 'member-gone' }
          ]
        }
      ]
    });
  }

  function mountMembers(props: Record<string, unknown> = {}) {
    const onOpenTask = vi.fn<(queueItemId: string, returnKey: string) => void>();
    const view = mount(memberRun(), { queueItems: [MEMBER], onOpenTask, ...props });
    return { ...view, onOpenTask };
  }

  it('opens the latest attempt Task from its node row', async () => {
    const { getByTestId, onOpenTask } = mountMembers();
    await fireEvent.click(getByTestId(`workflow-node-run-label-${MEMBER.id}`));
    expect(onOpenTask).toHaveBeenCalledWith(MEMBER.id, 'node:node-a');
  });

  it('opens an attempt Task from its attempt row, through a real button', async () => {
    const { getByTestId, onOpenTask } = mountMembers();
    const open = getByTestId('workflow-invocation-attempt-open-att-held');
    expect(open.tagName).toBe('BUTTON');
    expect(open.getAttribute('type')).toBe('button');
    await fireEvent.click(open);
    expect(onOpenTask).toHaveBeenCalledWith(MEMBER.id, 'attempt:att-held');
  });

  it('offers no control for a node with no attempt, a workflow attempt, or a Task the queue does not hold', () => {
    const { getByTestId, queryByTestId } = mountMembers();
    expect(getByTestId('workflow-node-node-b').querySelector('button')).toBeNull();
    expect(queryByTestId('workflow-invocation-attempt-open-att-child')).toBeNull();
    expect(queryByTestId('workflow-invocation-attempt-open-att-gone')).toBeNull();
    expect(getByTestId('workflow-invocation-attempt-att-child').textContent).toContain('node-c');
    expect(getByTestId('workflow-invocation-attempt-att-gone').textContent).toContain('failed');
  });

  it('offers no open control at all when no opener is wired', () => {
    const { queryByTestId } = mount(memberRun(), { queueItems: [MEMBER] });
    expect(queryByTestId('workflow-invocation-attempt-open-att-held')).toBeNull();
    expect(queryByTestId(`workflow-node-run-label-${MEMBER.id}`)?.tagName).not.toBe('BUTTON');
  });

  it('returns focus to the attempt row that opened the Task', async () => {
    const { getByTestId } = mountMembers({ returnFocusKey: 'attempt:att-held' });
    await tick();
    expect(document.activeElement).toBe(getByTestId('workflow-invocation-attempt-open-att-held'));
  });

  it('returns focus to the node row that opened the Task', async () => {
    const { getByTestId } = mountMembers({ returnFocusKey: 'node:node-a' });
    await tick();
    expect(getByTestId('workflow-node-attempt-node-a').contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.tagName).toBe('BUTTON');
  });
});
