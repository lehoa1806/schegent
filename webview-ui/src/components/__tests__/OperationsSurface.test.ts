// Feature 092 (T102, T103, T104, T105, FR-059, FR-060, FR-062, FR-065, SC-007,
// US5 scenarios 1, 4, 5, 6) — the surface that owns the drill-down location.
//
// `App.svelte` still routes to one `operations` component; which tier that
// component shows is a `DashboardLocation`, held here. These tests are about the
// *navigation*, not the tiers: each tier has its own suite, and what this one
// asserts is that moving between them is a navigation step with a remembered
// position, that a destination which no longer resolves lands somewhere with an
// explanation, and that a non-primary window can travel but not mutate.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import OperationsSurface from '../OperationsSurface.svelte';
import { buildInFlightRun, buildQueueRuntime } from '../../lib/__tests__/queue-runtime-fixture';
import { IDLE_GENERAL_SETTINGS } from '../../lib/snapshot-types';
import type {
  QueueItem,
  QueueRuntime,
  QueueSummary,
  WorkflowSnapshot
} from '../../lib/snapshot-types';

const postCommandSpy = vi.fn((..._args: readonly unknown[]) => ({ correlationId: 'corr-1' }));
vi.mock('../../lib/vscode-api', () => ({
  postCommand: (...args: unknown[]) => postCommandSpy(...args),
  onHostMessage: () => () => {},
  getWebviewState: () => undefined,
  setWebviewState: () => {}
}));

vi.mock('../../lib/use-confirm', () => ({
  useConfirm: vi.fn(async () => true)
}));

function task(id: string, overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id,
    label: `task ${id}`,
    enqueuedAt: '2026-08-12T00:00:00.000Z',
    startedAt: null,
    updatedAt: '2026-08-12T00:00:00.000Z',
    completedAt: null,
    status: 'pending',
    retryCount: 0,
    lastErrorSummary: null,
    pausedReason: null,
    currentPhase: null,
    position: 0,
    phaseProgress: null,
    ...overrides
  };
}

const QUEUES: readonly QueueRuntime[] = Object.freeze([
  buildQueueRuntime({
    queueId: 'default',
    name: 'Default',
    position: 0,
    lifecycle: 'active-empty',
    tasks: [task('d-1')]
  }),
  buildQueueRuntime({
    queueId: 'q-beta',
    name: 'nightly',
    position: 1,
    lifecycle: 'running',
    tasks: [task('r-1', { label: 'generate the RFC' })]
  })
]);

function summary(runtime: QueueRuntime): QueueSummary {
  return {
    id: runtime.queueId,
    name: runtime.name,
    position: runtime.position,
    state: 'active',
    pauseSource: null,
    schedule: null,
    taskCount: runtime.tasks.length,
    failurePolicy: 'halt-on-failure',
    failurePolicyOverride: null
  };
}

function buildSnapshot(queues: readonly QueueRuntime[] = QUEUES): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: 4,
    isPrimary: true,
    queues,
    queue: Object.freeze({
      inFlight: null,
      pending: Object.freeze([]),
      recent: Object.freeze([]),
      orderedItems: Object.freeze([]),
      queues: Object.freeze(queues.map(summary)),
      paused: false
    }),
    auditTail: Object.freeze([]),
    monitor: null,
    history: Object.freeze([]),
    producedAt: '2026-08-12T00:00:30.000Z',
    availablePipelines: Object.freeze([
      Object.freeze({ id: 'standard', name: 'Standard', phases: Object.freeze(['speckit-specify']) })
    ]),
    availablePhases: Object.freeze([]),
    availableModels: Object.freeze({ claude: [], codex: [], agy: [] }),
    availableBackends: Object.freeze(['claude']),
    generalSettings: IDLE_GENERAL_SETTINGS
  }) as unknown as WorkflowSnapshot;
}

function mount(snapshot: WorkflowSnapshot = buildSnapshot()) {
  return render(OperationsSurface, { props: { snapshot } });
}

// Tier 2 and tier 3 are loaded on descent rather than at startup, so arriving at
// one is asynchronous and every assertion about a tier's *content* — including an
// assertion that some control is absent — has to wait for the tier itself.
// Asserting against the loading placeholder would pass vacuously.
const awaitTier = (view: ReturnType<typeof mount>, testId: string): Promise<HTMLElement> =>
  view.findByTestId(testId);

/** Tier 1 → tier 2 → tier 3, the path US5 scenario 1 walks. */
async function drillToRunDetail(view: ReturnType<typeof mount>): Promise<void> {
  await fireEvent.click(view.getByTestId('queue-card-q-beta'));
  await awaitTier(view, 'queue-detail-tier');
  await fireEvent.click(view.getByTestId('queue-task-row-r-1'));
  await awaitTier(view, 'run-detail-tier');
}

beforeAll(async () => {
  // Prime the module graph the two tiers pull in — tier 2's own row-list and
  // controls machinery, and the `WorkflowRun` topology view tier 3 mounts — so
  // the first descent in this file is not also paying Vite's one-off transform
  // cost. Without it the first
  // `findByTestId` races that cost against its own timeout under a loaded suite;
  // the tier still arrives through the `{#await}`, which is what is under test.
  await Promise.all([
    import('../drilldown/QueueDetailTier.svelte'),
    import('../drilldown/RunDetailTier.svelte')
  ]);
});

beforeEach(() => {
  postCommandSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('OperationsSurface — drilling in and back out (FR-060, SC-007)', () => {
  it('lands on the Queues tier', () => {
    const { getByTestId, queryByTestId } = mount();

    expect(getByTestId('queues-tier')).not.toBeNull();
    expect(queryByTestId('queue-detail-tier')).toBeNull();
    expect(queryByTestId('run-detail-tier')).toBeNull();
  });

  it('opens the Queue Detail tier for the queue that was selected', async () => {
    const view = mount();

    await fireEvent.click(view.getByTestId('queue-card-q-beta'));

    expect(await awaitTier(view, 'queue-detail-tier')).not.toBeNull();
    expect(view.getByTestId('queue-detail-title').textContent).toContain('nightly');
    // A navigation step replaces the tier; it is not a pane toggled open beside it.
    expect(view.queryByTestId('queues-tier')).toBeNull();
  });

  it('opens the Run Detail tier for the Run that was selected', async () => {
    const view = mount();

    await drillToRunDetail(view);

    expect(view.getByTestId('run-detail-tier')).not.toBeNull();
    expect(view.getByTestId('run-detail-prompt').textContent).toContain('generate the RFC');
    expect(view.queryByTestId('queue-detail-tier')).toBeNull();
  });

  it('walks back one tier at a time rather than jumping to the root', async () => {
    const view = mount();
    await drillToRunDetail(view);

    await fireEvent.click(view.getByTestId('run-detail-back'));
    expect(await awaitTier(view, 'queue-detail-tier')).not.toBeNull();
    expect(view.queryByTestId('queues-tier')).toBeNull();

    await fireEvent.click(view.getByTestId('queue-detail-back'));
    expect(view.getByTestId('queues-tier')).not.toBeNull();
  });

  it('restores the tier’s remembered scroll position on the way back (SC-007)', async () => {
    const view = mount();
    const scroller = view.getByTestId('operations-scroll');
    // jsdom reports 0 for every layout read, so the surface must record what it
    // is told rather than what it can measure; the assertion is that whatever it
    // recorded is written back.
    Object.defineProperty(scroller, 'scrollTop', { value: 240, writable: true });
    await fireEvent.scroll(scroller);

    await fireEvent.click(view.getByTestId('queue-card-q-beta'));
    await awaitTier(view, 'queue-detail-tier');
    (view.getByTestId('operations-scroll') as HTMLElement).scrollTop = 0;
    await fireEvent.click(view.getByTestId('queue-detail-back'));

    expect((view.getByTestId('operations-scroll') as HTMLElement).scrollTop).toBe(240);
  });

  it('restores the selection the operator left behind on the parent tier', async () => {
    const view = mount();

    await fireEvent.click(view.getByTestId('queue-card-q-beta'));
    await awaitTier(view, 'queue-detail-tier');
    await fireEvent.click(view.getByTestId('queue-detail-back'));

    expect(
      view.getByTestId('queue-card-q-beta').getAttribute('data-selected')
    ).toBe('true');
    expect(view.getByTestId('queue-card-default').getAttribute('data-selected')).toBe('false');
  });
});

describe('OperationsSurface — keyboard operability (FR-059)', () => {
  it('drills in from the keyboard alone', async () => {
    const view = mount();

    await fireEvent.keyDown(view.getByTestId('queue-card-q-beta'), { key: 'Enter' });
    expect(await awaitTier(view, 'queue-detail-tier')).not.toBeNull();

    await fireEvent.keyDown(view.getByTestId('queue-task-row-r-1'), { key: 'Enter' });
    expect(await awaitTier(view, 'run-detail-tier')).not.toBeNull();
  });

  it('walks back from the keyboard alone', async () => {
    const view = mount();
    await drillToRunDetail(view);

    await fireEvent.keyDown(view.getByTestId('run-detail-back'), { key: 'Enter' });
    expect(await awaitTier(view, 'queue-detail-tier')).not.toBeNull();
  });

  it('gives every navigation affordance a real button so focus and activation are native', async () => {
    const view = mount();

    expect(view.getByTestId('queue-card-q-beta').tagName).toBe('BUTTON');
    await fireEvent.click(view.getByTestId('queue-card-q-beta'));
    await awaitTier(view, 'queue-detail-tier');
    expect(view.getByTestId('queue-detail-back').tagName).toBe('BUTTON');
    expect(view.getByTestId('queue-task-row-r-1').tagName).toBe('BUTTON');
  });

  it('exposes exactly one main landmark at every tier', async () => {
    const view = mount();
    expect(view.container.querySelectorAll('main')).toHaveLength(1);

    await fireEvent.click(view.getByTestId('queue-card-q-beta'));
    await awaitTier(view, 'queue-detail-tier');
    expect(view.container.querySelectorAll('main')).toHaveLength(1);

    await fireEvent.click(view.getByTestId('queue-task-row-r-1'));
    await awaitTier(view, 'run-detail-tier');
    expect(view.container.querySelectorAll('main')).toHaveLength(1);
  });
});

describe('OperationsSurface — a destination that no longer resolves (FR-062)', () => {
  it('falls back to the Queues tier when the queue is deleted underneath it', async () => {
    const view = mount();
    await fireEvent.click(view.getByTestId('queue-card-q-beta'));
    await awaitTier(view, 'queue-detail-tier');

    await view.rerender({ snapshot: buildSnapshot([QUEUES[0]]) });

    expect(view.getByTestId('queues-tier')).not.toBeNull();
    expect(view.queryByTestId('queue-detail-tier')).toBeNull();
  });

  it('explains the fallback rather than silently relocating the operator', async () => {
    const view = mount();
    await fireEvent.click(view.getByTestId('queue-card-q-beta'));
    await awaitTier(view, 'queue-detail-tier');

    await view.rerender({ snapshot: buildSnapshot([QUEUES[0]]) });

    expect(view.getByTestId('operations-fallback-notice').textContent).toMatch(
      /no longer|not available/i
    );
  });

  it('falls back one tier — to Queue Detail — when only the Run is gone', async () => {
    const view = mount();
    await drillToRunDetail(view);

    await view.rerender({
      snapshot: buildSnapshot([
        QUEUES[0],
        buildQueueRuntime({
          queueId: 'q-beta',
          name: 'nightly',
          position: 1,
          lifecycle: 'active-empty',
          tasks: []
        })
      ])
    });

    expect(await awaitTier(view, 'queue-detail-tier')).not.toBeNull();
    expect(view.queryByTestId('run-detail-tier')).toBeNull();
    expect(view.getByTestId('operations-fallback-notice')).not.toBeNull();
  });

  it('clears the explanation once the operator navigates again', async () => {
    const view = mount();
    await fireEvent.click(view.getByTestId('queue-card-q-beta'));
    await awaitTier(view, 'queue-detail-tier');
    await view.rerender({ snapshot: buildSnapshot([QUEUES[0]]) });
    expect(view.getByTestId('operations-fallback-notice')).not.toBeNull();

    await fireEvent.click(view.getByTestId('queue-card-default'));
    await awaitTier(view, 'queue-detail-tier');

    expect(view.queryByTestId('operations-fallback-notice')).toBeNull();
  });
});

describe('OperationsSurface — a non-primary window (FR-065)', () => {
  function readOnly(): WorkflowSnapshot {
    return { ...buildSnapshot(), isPrimary: false } as WorkflowSnapshot;
  }

  it('still lets the operator travel every tier', async () => {
    const view = mount(readOnly());

    await fireEvent.click(view.getByTestId('queue-card-q-beta'));
    expect(await awaitTier(view, 'queue-detail-tier')).not.toBeNull();

    await fireEvent.click(view.getByTestId('queue-task-row-r-1'));
    await awaitTier(view, 'run-detail-tier');
    expect(view.getByTestId('run-detail-prompt')).not.toBeNull();
  });

  it('offers no mutating control on any tier', async () => {
    const view = mount(readOnly());
    expect(view.queryByTestId('queue-create')).toBeNull();

    await fireEvent.click(view.getByTestId('queue-card-q-beta'));
    await awaitTier(view, 'queue-detail-tier');
    expect(view.queryByTestId('queue-config-open')).toBeNull();

    await fireEvent.click(view.getByTestId('queue-task-row-r-1'));
    await awaitTier(view, 'run-detail-tier');
    expect(view.queryByTestId('run-detail-controls')).toBeNull();
  });

  it('posts no command while travelling', async () => {
    const view = mount(readOnly());

    await drillToRunDetail(view);
    await fireEvent.click(view.getByTestId('run-detail-back'));
    await awaitTier(view, 'queue-detail-tier');

    expect(postCommandSpy).not.toHaveBeenCalled();
  });
});

// Feature 265 BUG-001 (FR-009) — a Workflow run's member Tasks are reachable
// from its topology, and Back walks Task → run → Queue Detail. The fixture is a
// run with two attempts at one node (`m-a1` failed, `m-a2` completed), a node
// that never ran, a `workflow` attempt (no Task), and an attempt whose Task the
// queue no longer holds.
describe('OperationsSurface — member Tasks of a Workflow run (Feature 265 BUG-001)', () => {
  const RUN_ID = 'cr-1';
  const WORKFLOW_ID = 'wf-feature';

  /** `executing` adds an in-flight member `m-live` at node `plan`, the queue's executing Task. */
  function memberSnapshot(executing = false): WorkflowSnapshot {
    const live = task('m-live', { status: 'in-flight', position: 3, currentPhase: 'plan', currentPipelineId: 'plan' });
    const queues = [
      QUEUES[0]!,
      buildQueueRuntime({
        queueId: 'q-beta',
        name: 'nightly',
        position: 1,
        lifecycle: 'running',
        tasks: [
          task('m-a1', { status: 'failed', position: 0, currentPipelineId: 'specify' }),
          task('m-a2', { status: 'completed', position: 1, currentPipelineId: 'specify' }),
          task('r-1', { label: 'generate the RFC', position: 2 }),
          ...(executing ? [live] : [])
        ],
        ...(executing
          ? { inFlightRun: buildInFlightRun({ feature: { id: live.id, label: live.label, startedAt: '2026-08-12T00:00:10.000Z' } }) }
          : {})
      })
    ];
    const run = {
      connectedRunId: RUN_ID,
      workflowId: WORKFLOW_ID,
      revision: 3,
      hydrating: false,
      queueId: 'q-beta',
      status: 'in-flight',
      rootInvocationId: 'inv-root',
      nodes: [
        { nodeId: 'specify', pipelineId: 'specify', state: 'completed', actions: [], attemptCount: 2, latestQueueItemId: 'm-a2' },
        executing
          ? { nodeId: 'plan', pipelineId: 'plan', state: 'in-flight', actions: [], attemptCount: 1, latestQueueItemId: 'm-live' }
          : { nodeId: 'plan', pipelineId: 'plan', state: 'unvisited', actions: [], attemptCount: 0 }
      ],
      invocations: [
        {
          invocationId: 'inv-root',
          parentInvocationId: null,
          workflowId: WORKFLOW_ID,
          depth: 0,
          nodePath: WORKFLOW_ID,
          status: 'in-flight',
          currentNodeId: 'specify',
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
            { attemptId: 'a1', attemptIndex: 1, nodeId: 'specify', nodeKind: 'phase', status: 'failed', startedAt: 1, endedAt: 2, queueItemId: 'm-a1' },
            { attemptId: 'a2', attemptIndex: 2, nodeId: 'specify', nodeKind: 'phase', status: 'completed', startedAt: 3, endedAt: 4, queueItemId: 'm-a2' },
            { attemptId: 'a-child', attemptIndex: 1, nodeId: 'review', nodeKind: 'workflow', status: 'in-flight', startedAt: 5, childInvocationId: 'inv-child' },
            { attemptId: 'a-gone', attemptIndex: 3, nodeId: 'specify', nodeKind: 'phase', status: 'failed', startedAt: 6, queueItemId: 'm-gone' }
          ]
        }
      ]
    };
    return { ...buildSnapshot(queues), connectedRuns: [run] } as unknown as WorkflowSnapshot;
  }

  async function openRun(view: ReturnType<typeof mount>): Promise<void> {
    await fireEvent.click(view.getByTestId('queue-card-q-beta'));
    await awaitTier(view, 'queue-detail-tier');
    await fireEvent.click(view.getByTestId(`queue-run-row-${RUN_ID}`));
    await awaitTier(view, 'workflow-run');
  }

  /** The tier that shows a Task, as opposed to the run's topology. */
  async function awaitTaskTier(view: ReturnType<typeof mount>): Promise<void> {
    await awaitTier(view, 'run-tab-log');
    expect(view.queryByTestId('workflow-run')).toBeNull();
  }

  it('opens the latest attempt Task from its node row, and Back names the Workflow', async () => {
    const view = mount(memberSnapshot());
    await openRun(view);
    await fireEvent.click(view.getByTestId('workflow-node-run-label-m-a2'));
    await awaitTaskTier(view);
    expect(view.getByTestId('run-detail-back').textContent).toContain(WORKFLOW_ID);
    expect(view.getByTestId('run-detail-back').textContent).not.toContain('nightly');
  });

  it('opens the latest attempt Task directly from its step header button and restores focus on Back (BUG-002)', async () => {
    const view = mount(memberSnapshot());
    await openRun(view);
    await fireEvent.click(view.getByTestId('workflow-node-id-specify'));
    await awaitTaskTier(view);
    expect(view.getByTestId('run-detail-back').textContent).toContain(WORKFLOW_ID);
    expect(view.queryByTestId('phase-log-empty-no-phase')).toBeNull();

    await fireEvent.click(view.getByTestId('run-detail-back'));
    const headBtn = await awaitTier(view, 'workflow-node-id-specify');
    await vi.waitFor(() => expect(document.activeElement).toBe(headBtn));
  });

  it('opens an earlier attempt Task from its attempt row', async () => {
    const view = mount(memberSnapshot());
    await openRun(view);
    await fireEvent.click(view.getByTestId('workflow-invocation-attempt-open-a1'));
    await awaitTaskTier(view);
    expect(view.getByTestId('run-detail-back').textContent).toContain(WORKFLOW_ID);
  });

  it('walks Back to the topology with focus on the opening row, then to Queue Detail with the run marked', async () => {
    const view = mount(memberSnapshot());
    await openRun(view);
    await fireEvent.click(view.getByTestId('workflow-invocation-attempt-open-a1'));
    await awaitTaskTier(view);

    await fireEvent.click(view.getByTestId('run-detail-back'));
    const opener = await awaitTier(view, 'workflow-invocation-attempt-open-a1');
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));

    await fireEvent.click(view.getByTestId('run-detail-back'));
    await awaitTier(view, 'queue-detail-tier');
    expect(view.getByTestId(`queue-run-row-${RUN_ID}`).getAttribute('data-selected')).toBe('true');
  });

  it('offers no control for a node that never ran, a workflow attempt, or a Task the queue does not hold', async () => {
    const view = mount(memberSnapshot());
    await openRun(view);
    expect(view.getByTestId('workflow-node-plan').querySelector('button')).toBeNull();
    expect(view.queryByTestId('workflow-invocation-attempt-open-a-child')).toBeNull();
    expect(view.queryByTestId('workflow-invocation-attempt-open-a-gone')).toBeNull();
  });

  it('starts a Task opened from the topology on its Log tab after another Task was left on Outputs', async () => {
    const view = mount(memberSnapshot());
    await openRun(view);
    await fireEvent.click(view.getByTestId('workflow-node-run-label-m-a2'));
    await awaitTaskTier(view);
    await fireEvent.click(view.getByTestId('run-tab-outputs'));
    expect(view.getByTestId('run-tab-outputs').getAttribute('aria-selected')).toBe('true');

    await fireEvent.click(view.getByTestId('run-detail-back'));
    await awaitTier(view, 'workflow-run');
    await fireEvent.click(view.getByTestId('workflow-invocation-attempt-open-a1'));
    await awaitTaskTier(view);
    expect(view.getByTestId('run-tab-log').getAttribute('aria-selected')).toBe('true');
  });

  // T014 (FR-010, SC-006) — the log route BUG-001's decision selected: the member
  // Task's own tier, with its phase strip and log feed. The Workflow tier itself
  // still renders neither (092 T101's pin in `RunDetailTier.test.ts`).
  it('shows an executing member its phase progression and log feed, and the Workflow tier neither', async () => {
    const view = mount(memberSnapshot(true));
    await openRun(view);
    expect(view.queryByTestId('dashboard-phase-progression')).toBeNull();
    expect(view.queryByTestId('phase-log-feed')).toBeNull();

    await fireEvent.click(view.getByTestId('workflow-node-run-label-m-live'));
    await awaitTaskTier(view);
    expect(view.getByTestId('dashboard-phase-progression')).toBeTruthy();
    expect(view.getByTestId('phase-log-feed')).toBeTruthy();
    expect(view.getByTestId('run-streaming-badge')).toBeTruthy();
  });

  it('still names the queue on Back for a Task opened from Queue Detail', async () => {
    const view = mount(memberSnapshot());
    await fireEvent.click(view.getByTestId('queue-card-q-beta'));
    await awaitTier(view, 'queue-detail-tier');
    await fireEvent.click(view.getByTestId('queue-task-row-r-1'));
    await awaitTaskTier(view);
    expect(view.getByTestId('run-detail-back').textContent).toContain('nightly');
    expect(view.getByTestId('run-detail-back').textContent).not.toContain(WORKFLOW_ID);
  });
});
