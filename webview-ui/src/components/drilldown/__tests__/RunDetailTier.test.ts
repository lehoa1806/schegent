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
  RunOutputRecord,
  WorkflowSnapshot
} from '../../../lib/snapshot-types';
import type { PhaseLogReadResult } from '../../../../../src/services/phase-log/types';

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

// The Activity Feed embed (T006) resolves through `phase-log-store.svelte.ts`,
// which defaults to these `phase-log-ipc` functions. Mocked here so the
// regression test below can assert exactly what selection tuple this tier
// asks for, without a real IPC round-trip.
const readPhaseLogSpy = vi.fn<(req: unknown) => Promise<PhaseLogReadResult>>();
vi.mock('../../../lib/phase-log-ipc', () => ({
  readPhaseLog: (req: unknown) => readPhaseLogSpy(req),
  startPhaseLogTail: vi.fn(),
  stopPhaseLogTail: vi.fn(),
  subscribePhaseLogPush: () => () => {},
  openVerboseSetting: vi.fn()
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
  readonly outputs?: readonly RunOutputRecord[];
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
                outputs: overrides.outputs ?? []
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
  readPhaseLogSpy.mockReset();
  readPhaseLogSpy.mockResolvedValue({
    outcome: 'success',
    manifest: {
      iterations: [],
      selectedIteration: null,
      entries: [],
      skippedLines: 0,
      truncatedCount: 0,
      verboseDiagnosticsState: { kind: 'enabled-with-sessions' },
      isInFlight: false
    }
  });
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

  // Feature 097 moved the live feed and the liveness pair onto the Context tab.
  // The tab is activated first so these still assert the feed's content rather
  // than which tab happens to open by default.
  it('shows this queue’s live feed, not the workspace’s', async () => {
    const { getByTestId } = mount(
      buildSnapshot({
        tasks: [task('r-1', { status: 'in-flight' })],
        inFlightTaskId: 'r-1',
        liveSummary: 'nightly-phase-2'
      })
    );
    await fireEvent.click(getByTestId('run-tab-context'));

    expect(getByTestId('run-detail-live-feed').textContent).toContain('nightly-phase-2');
  });

  it('reports an idle feed when this queue has no Run executing', async () => {
    const { getByTestId } = mount(buildSnapshot({ tasks: [task('r-1')] }));
    await fireEvent.click(getByTestId('run-tab-context'));

    expect(getByTestId('run-detail-live-feed').textContent).toMatch(/idle/i);
  });

  it('disables the phase controls when the Run executing here is a different one', () => {
    // The phase strip below the title is the *queue's* strip, and its controls
    // are addressed by queue alone. On this tier — one destination, one Run —
    // that put a live Pause/Restart/Skip under the title of a Task that is not
    // the one they would act on. Same `isExecuting` conjunct the live feed
    // above already applies, for the same reason.
    const { getByTestId } = mount(
      buildSnapshot({
        tasks: [task('r-1'), task('sibling', { status: 'in-flight' })],
        inFlightTaskId: 'sibling'
      })
    );

    expect(getByTestId('phase-control-restart').getAttribute('aria-disabled')).toBe('true');
    expect(getByTestId('phase-control-skip').getAttribute('aria-disabled')).toBe('true');
    expect(getByTestId('phase-control-pause').getAttribute('aria-disabled')).toBe('true');
  });

  it('leaves the phase controls live for the Run this tier is about', () => {
    // The other half of the guard: disabling everything unconditionally would
    // pass the test above and take the feature away.
    const { getByTestId } = mount(
      buildSnapshot({
        tasks: [task('r-1', { status: 'in-flight' })],
        inFlightTaskId: 'r-1'
      })
    );

    expect(getByTestId('phase-control-restart').getAttribute('aria-disabled')).toBe('false');
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

// Feature 097 (T010, T011, FR-010, SC-003) — the same resolver tier 2's row
// calls (`resolveTaskPipelineName`), so the two tiers can never disagree
// about what a Task's Pipeline is named.
describe('RunDetailTier — pipeline name (T010, T011, FR-010, SC-003)', () => {
  it('shows the Task’s pipeline name', () => {
    const { getByTestId } = mount(
      buildSnapshot({ tasks: [task('r-1', { currentPipelineId: 'standard' })] })
    );

    expect(getByTestId('run-detail-pipeline').textContent).toContain('Standard');
  });

  it('falls back to a labeled placeholder for an unresolved Pipeline, never the raw id', () => {
    const { getByTestId } = mount(
      buildSnapshot({ tasks: [task('r-1', { currentPipelineId: 'ghost-pipeline' })] })
    );

    const text = getByTestId('run-detail-pipeline').textContent ?? '';
    expect(text).toMatch(/unknown pipeline/i);
    expect(text).not.toContain('ghost-pipeline');
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

describe('RunDetailTier — Activity Feed and outputs (T006, FR-007)', () => {
  it('mounts the Activity Feed for a Pipeline-backed Run', () => {
    const { getByTestId } = mount(buildSnapshot({ tasks: [task('r-1')] }));

    expect(getByTestId('phase-log-feed')).not.toBeNull();
  });

  it('asks the Activity Feed to load this Run’s own queue and phase, not the default queue', async () => {
    // Regression: the embed used to pin only { taskId, pipelineId }, leaving
    // queueId/phaseId null forever. `loadIfComplete()` requires all four, so
    // on any queue other than 'default' — this fixture's Run lives on
    // 'q-beta' — no fetch ever fired and the feed stayed permanently empty.
    mount(
      buildSnapshot({
        tasks: [task('r-1', { currentPipelineId: 'standard', currentPhase: 'speckit-plan' })]
      })
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(readPhaseLogSpy).toHaveBeenCalledWith({
      selection: {
        queueId: 'q-beta',
        taskId: 'r-1',
        pipelineId: 'standard',
        phaseId: 'speckit-plan',
        iterationN: null
      }
    });
  });

  it('keeps the pin when the default queue’s in-flight identity changes while Live Mode is on', async () => {
    // Regression: PhaseLogFeed's own Live-Mode auto-follow effect
    // (`applyInFlightIdentityChange`) used to run unconditionally, so a
    // phase transition on the *default* queue's in-flight task — unrelated
    // to the Run this tier is showing — silently redirected the Activity
    // Feed to that other queue's task. Live Mode defaults to on and this
    // tier never turns it off (its own pin uses { origin: 'cascade' }), so
    // nothing but `autoFollow={false}` on the embed prevents the steal.
    const initialSnapshot = buildSnapshot({
      tasks: [task('r-1', { currentPipelineId: 'standard', currentPhase: 'speckit-plan' })]
    });
    const { rerender } = mount(initialSnapshot);

    await Promise.resolve();
    await Promise.resolve();
    readPhaseLogSpy.mockClear();

    const nextSnapshot: WorkflowSnapshot = {
      ...initialSnapshot,
      queue: {
        ...initialSnapshot.queue,
        inFlight: {
          ...task('other-queue-task'),
          queueId: 'default',
          currentPipelineId: 'standard',
          currentPhase: 'speckit-specify'
        }
      }
    } as unknown as WorkflowSnapshot;

    await rerender({
      snapshot: nextSnapshot,
      queueId: 'q-beta',
      runId: 'r-1',
      isPrimary: true,
      onBack: () => {}
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(readPhaseLogSpy).not.toHaveBeenCalledWith({
      selection: expect.objectContaining({ queueId: 'default' })
    });
  });

  it('does not mount the Activity Feed for a Workflow-backed Run', () => {
    const { queryByTestId } = mount(
      buildSnapshot({ tasks: [task('member')], connectedRuns: [CONNECTED_RUN] }),
      { runId: 'cr-1' }
    );

    expect(queryByTestId('phase-log-feed')).toBeNull();
  });

  it('does not mount the Activity Feed when the Run is gone', () => {
    const { queryByTestId } = mount(buildSnapshot({ tasks: [task('other')] }));

    expect(queryByTestId('phase-log-feed')).toBeNull();
  });

  // Feature 097 moved the outputs section onto its own tab. Every test below
  // opens that tab — including the two negative ones, which would otherwise
  // pass merely because the tab was closed rather than because nothing rendered.
  it('shows this Run’s recorded outputs once it is the one executing', async () => {
    const { getByTestId } = mount(
      buildSnapshot({
        tasks: [task('r-1', { status: 'in-flight' })],
        inFlightTaskId: 'r-1',
        outputs: [{ name: 'summary', status: 'resolved', reference: 'out/summary.md' }]
      })
    );
    await fireEvent.click(getByTestId('run-tab-outputs'));

    expect(getByTestId('run-outputs').textContent).toContain('summary');
  });

  it('shows no outputs section when the Run has recorded none', async () => {
    const { getByTestId, queryByTestId } = mount(
      buildSnapshot({ tasks: [task('r-1', { status: 'in-flight' })], inFlightTaskId: 'r-1' })
    );
    await fireEvent.click(getByTestId('run-tab-outputs'));

    expect(queryByTestId('run-outputs')).toBeNull();
  });

  it('does not show outputs recorded by a different Run executing on this queue', async () => {
    // Same non-borrowing guarantee as the disabled phase controls above: a Task
    // that is not the one executing must not surface a sibling Run's outputs.
    const { getByTestId, queryByTestId } = mount(
      buildSnapshot({
        tasks: [task('r-1'), task('sibling', { status: 'in-flight' })],
        inFlightTaskId: 'sibling',
        outputs: [{ name: 'summary', status: 'resolved', reference: 'out/summary.md' }]
      })
    );
    await fireEvent.click(getByTestId('run-tab-outputs'));

    expect(queryByTestId('run-outputs')).toBeNull();
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
