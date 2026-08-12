// Feature 092 (T101, FR-058, FR-059, FR-062, FR-065, FR-066, US5 scenario 4) —
// tier 3 of the drill-down: one Run.
//
// One destination, two renderings, chosen by what backs the Run. The
// Workflow-backed rendering mounts feature 091's topology view — these tests
// assert that component's own test ids precisely so a re-implementation would
// fail them (FR-066); the Pipeline-backed rendering shows the prompt, the live
// feed, the phase progression and the Task's lifecycle controls.
//
// Every reading is scoped to the queue in the destination. A Run's feed must not
// pick up the workspace's most recent activity, which is what the deleted v3 root
// singulars would have given it (FR-051, FR-052).

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import RunDetailTier from '../RunDetailTier.svelte';
import { buildQueueRuntime } from '../../../lib/__tests__/queue-runtime-fixture';
import { IDLE_DELAYED_RETRY, IDLE_GENERAL_SETTINGS } from '../../../lib/snapshot-types';
import type {
  ConnectedRunProjection,
  PhaseTile,
  QueueItem,
  WorkflowSnapshot
} from '../../../lib/snapshot-types';

const postCommandSpy = vi.fn((..._args: readonly unknown[]) => ({ correlationId: 'corr-1' }));
vi.mock('../../../lib/vscode-api', () => ({
  postCommand: (...args: unknown[]) => postCommandSpy(...args),
  onHostMessage: () => () => {},
  getWebviewState: () => undefined,
  setWebviewState: () => {}
}));

vi.mock('../../../lib/use-confirm', () => ({
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
    ...overrides
  };
}

function phase(name: string, order: number, state: PhaseTile['state']): PhaseTile {
  return {
    name,
    order,
    state,
    iteration: 1,
    lastResult: null,
    elapsedMs: 0,
    subProgress: null
  };
}

const PHASES: readonly PhaseTile[] = Object.freeze([
  phase('speckit-specify', 1, 'completed'),
  phase('speckit-plan', 2, 'active')
]);

function buildSnapshot(overrides: {
  readonly tasks?: readonly QueueItem[];
  readonly connectedRuns?: readonly ConnectedRunProjection[];
  readonly liveSummary?: string;
  readonly inFlightTaskId?: string;
}): WorkflowSnapshot {
  const tasks = overrides.tasks ?? [];
  return Object.freeze({
    schemaVersion: 4,
    isPrimary: true,
    queues: Object.freeze([
      buildQueueRuntime({
        queueId: 'default',
        name: 'Default',
        position: 0,
        lifecycle: 'active-empty',
        tasks: [task('other-queue-task')]
      }),
      buildQueueRuntime({
        queueId: 'q-beta',
        name: 'nightly',
        position: 1,
        lifecycle: 'running',
        phases: PHASES,
        tasks,
        ...(overrides.inFlightTaskId !== undefined
          ? {
              inFlightRun: {
                runId: 'run-1',
                status: 'running' as const,
                feature: {
                  id: overrides.inFlightTaskId,
                  label: 'live one',
                  startedAt: '2026-08-12T00:00:00.000Z'
                },
                pipeline: null,
                elapsedMs: 30_000,
                liveActivity: {
                  summary: overrides.liveSummary ?? 'plan-iteration-2',
                  category: 'phase-transition' as const,
                  lastEventAt: '2026-08-12T00:00:30.000Z',
                  freshness: 'live' as const,
                  staleSeconds: 0
                },
                delayedRetry: IDLE_DELAYED_RETRY,
                resumeTargetPhaseId: null,
                outputs: []
              }
            }
          : {})
      })
    ]),
    queue: Object.freeze({
      inFlight: null,
      pending: Object.freeze([]),
      recent: Object.freeze([]),
      orderedItems: Object.freeze([]),
      paused: false
    }),
    ...(overrides.connectedRuns !== undefined
      ? { connectedRuns: overrides.connectedRuns }
      : {}),
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

function mount(
  snapshot: WorkflowSnapshot,
  props: {
    readonly queueId?: string;
    readonly runId?: string;
    readonly isPrimary?: boolean;
    readonly onBack?: () => void;
  } = {}
) {
  return render(RunDetailTier, {
    props: {
      snapshot,
      queueId: props.queueId ?? 'q-beta',
      runId: props.runId ?? 'r-1',
      isPrimary: props.isPrimary ?? true,
      onBack: props.onBack ?? (() => {})
    }
  });
}

const CONNECTED_RUN: ConnectedRunProjection = Object.freeze({
  connectedRunId: 'cr-1',
  workflowId: 'wf-release',
  revision: 2,
  hydrating: false,
  nodes: Object.freeze([
    {
      nodeId: 'n-0',
      pipelineId: 'standard',
      state: 'completed' as const,
      actions: Object.freeze([]),
      attemptCount: 1,
      latestQueueItemId: 'member'
    }
  ])
});

beforeEach(() => {
  postCommandSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('RunDetailTier — Workflow-backed rendering (FR-058, FR-066)', () => {
  it('mounts the relocated topology view rather than a re-implementation', () => {
    const { getByTestId } = mount(
      buildSnapshot({ tasks: [task('member')], connectedRuns: [CONNECTED_RUN] }),
      { runId: 'cr-1' }
    );

    // These ids belong to feature 091's WorkflowRun.svelte. A tier that drew its
    // own topology would not produce them.
    expect(getByTestId('workflow-run')).not.toBeNull();
    expect(getByTestId('workflow-run-title').textContent).toContain('wf-release');
    expect(getByTestId('workflow-run-id').textContent).toContain('cr-1');
  });

  it('does not render the Pipeline-backed phase progression for a Workflow-backed Run', () => {
    const { queryByTestId } = mount(
      buildSnapshot({ tasks: [task('member')], connectedRuns: [CONNECTED_RUN] }),
      { runId: 'cr-1' }
    );

    expect(queryByTestId('dashboard-phase-progression')).toBeNull();
  });
});

describe('RunDetailTier — Pipeline-backed rendering (FR-058)', () => {
  it('shows the Run’s prompt', () => {
    const { getByTestId } = mount(
      buildSnapshot({ tasks: [task('r-1', { label: 'generate the RFC' })] })
    );

    expect(getByTestId('run-detail-prompt').textContent).toContain('generate the RFC');
  });

  it('shows the phase progression', () => {
    const { getByTestId } = mount(buildSnapshot({ tasks: [task('r-1')] }));

    expect(getByTestId('dashboard-phase-progression')).not.toBeNull();
  });

  it('shows this queue’s live feed, not the workspace’s', () => {
    const { getByTestId } = mount(
      buildSnapshot({
        tasks: [task('r-1', { status: 'in-flight' })],
        inFlightTaskId: 'r-1',
        liveSummary: 'nightly-phase-2'
      })
    );

    expect(getByTestId('run-detail-live-feed').textContent).toContain('nightly-phase-2');
  });

  it('reports an idle feed when this queue has no Run executing', () => {
    const { getByTestId } = mount(buildSnapshot({ tasks: [task('r-1')] }));

    expect(getByTestId('run-detail-live-feed').textContent).toMatch(/idle/i);
  });

  it('offers the Task’s lifecycle controls', () => {
    const { getByTestId } = mount(
      buildSnapshot({ tasks: [task('r-1', { status: 'in-flight' })] })
    );

    expect(getByTestId('run-detail-controls')).not.toBeNull();
  });

  it('does not mount the topology view for a Pipeline-backed Run', () => {
    const { queryByTestId } = mount(buildSnapshot({ tasks: [task('r-1')] }));

    expect(queryByTestId('workflow-run')).toBeNull();
  });
});

describe('RunDetailTier — a Run that is gone (FR-062)', () => {
  it('explains rather than rendering an empty view', () => {
    const { getByTestId, queryByTestId } = mount(buildSnapshot({ tasks: [task('other')] }));

    expect(getByTestId('run-detail-missing').textContent).toMatch(/no longer/i);
    expect(queryByTestId('dashboard-phase-progression')).toBeNull();
    expect(queryByTestId('workflow-run')).toBeNull();
  });

  it('still offers the way back out', async () => {
    const onBack = vi.fn();
    const { getByTestId } = mount(buildSnapshot({ tasks: [] }), { onBack });

    await fireEvent.click(getByTestId('run-detail-back'));

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('RunDetailTier — navigation and primacy (FR-059, FR-060, FR-065)', () => {
  it('offers a keyboard-operable back affordance naming the parent queue', async () => {
    const onBack = vi.fn();
    const { getByTestId } = mount(buildSnapshot({ tasks: [task('r-1')] }), { onBack });

    const back = getByTestId('run-detail-back');
    expect(back.tagName).toBe('BUTTON');
    expect(back.textContent).toContain('nightly');
    await fireEvent.keyDown(back, { key: 'Enter' });

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('owns exactly one <main> landmark', () => {
    const { container } = mount(buildSnapshot({ tasks: [task('r-1')] }));

    expect(container.querySelectorAll('main')).toHaveLength(1);
  });

  it('renders read-only in a non-primary window', () => {
    const { queryByTestId, getByTestId } = mount(
      buildSnapshot({ tasks: [task('r-1', { status: 'in-flight' })] }),
      { isPrimary: false }
    );

    expect(queryByTestId('run-detail-controls')).toBeNull();
    // Reading the Run is still allowed.
    expect(getByTestId('run-detail-prompt')).not.toBeNull();
  });
});
