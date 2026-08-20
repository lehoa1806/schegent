// Feature 091 (T016, US2 — FR-014 to FR-018) — the surface that makes the
// connected-run view and the Run composer things an operator can actually open.
//
// `WorkflowRun.test.ts` and `RunLauncher.test.ts` both pass today, on components
// no shipped entry point imports. That is the shape of the gap: correctness
// tested in isolation says nothing about reachability, and a green suite over
// unmounted code reads exactly like a green suite over mounted code.
//
// So what is pinned here is the wrapper's own decisions, which are the only
// place this slice can go wrong:
//
//   * M2 — one view per connected Run, and *none* when there are none. An empty
//     `connectedRuns` must render no `WorkflowRun` instance at all, not an
//     instance with nothing in it.
//   * M3 — a hydrating Run is rendered, not filtered. Skipping it would satisfy
//     M2's "only when a connected Run exists" reading and silently defeat the
//     hydration gate the view exists to show; the loading state is a Run the
//     operator has, not a Run they do not.
//   * M4 — the composer opens for a Pipeline chosen from the effective catalog.
//
// Both children read zero stores, so everything arrives as props and nothing
// here needs a host. The two IPC seams are stubbed only because mounting the
// composer would otherwise reach for a `vscode` that jsdom does not have.
//
// Feature 102 (US1, T015) — M4 is gone and the launch zone replaced it. The
// `<select>` offered the effective Pipeline catalog: no Workflows, no version,
// and no way to tell published from merely present. What is pinned in its place
// is that both sections mount, that the picker did not survive, and that Runs
// offers no lifecycle action (FR-004) — the last of which is a claim about what
// the surface does *not* render, so it is asserted over the whole rendered text
// rather than against a handful of test ids that a new control would not have.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConnectedNodeProjection,
  ConnectedRunProjection,
  LaunchProjection,
  PipelineDefinition,
  PortableWorkflowDefinition,
  QueueItem,
  WorkflowSnapshot
} from '../../lib/snapshot-types';
import { foldLegacyRun, type LegacyRunFields } from '../../lib/__tests__/queue-runtime-fixture';

const launchWorkflow = vi.fn();
const launchPipeline = vi.fn();
vi.mock('../../lib/workflow-run-ipc', () => ({
  continueWorkflow: vi.fn(),
  launchWorkflow: (...args: readonly unknown[]) => launchWorkflow(...args)
}));
vi.mock('../../lib/run-launcher-ipc', () => ({
  launchPipeline: (...args: readonly unknown[]) => launchPipeline(...args)
}));

// Late import so the component binds to the stubs above.
import RunsSurface from '../RunsSurface.svelte';

afterEach(() => {
  cleanup();
  launchWorkflow.mockReset();
  launchPipeline.mockReset();
});

const PIPELINE: PipelineDefinition = {
  id: 'analysis-pipeline',
  name: 'Analysis Pipeline',
  phases: ['speckit-specify', 'speckit-plan'],
  inputs: [{ portId: 'topic', label: 'Topic', type: 'text', required: true }],
  outputs: [{ portId: 'report', label: 'Report', type: 'markdown' }]
};

const SECOND_PIPELINE: PipelineDefinition = {
  id: 'review-pipeline',
  name: 'Review Pipeline',
  phases: ['speckit-analyze'],
  inputs: [],
  outputs: []
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

function connectedRun(overrides: Partial<ConnectedRunProjection> = {}): ConnectedRunProjection {
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

/**
 * The active graph behind `research-workflow` (feature 102, T030).
 *
 * The trigger form needs it to answer "which Pipeline does the start node name",
 * which the launch projection deliberately does not carry. `node-a` sits on the
 * Pipeline the effective catalog already holds, so the launch resolves.
 */
const WORKFLOW_GRAPH: PortableWorkflowDefinition = {
  workflowId: 'research-workflow',
  name: 'Research Workflow',
  version: 2,
  nodes: [{ nodeId: 'node-a', pipelineId: 'analysis-pipeline', label: 'Analyse' }],
  connections: [],
  startNodeIds: ['node-a']
};

function buildSnapshot(overrides: Partial<WorkflowSnapshot> & LegacyRunFields = {}): WorkflowSnapshot {
  const { status, activeFeature, phases, liveActivity, workflowElapsedMs, ...rest } = overrides;
  return {
    schemaVersion: 4,
    isPrimary: true,
    // Feature 092 — the v3 root run singulars now hang off the queue that owns
    // the Run. `foldLegacyRun` performs that fold, so the call sites below keep
    // their v3 wording.
    queues: foldLegacyRun({
      status: status ?? 'idle',
      activeFeature: activeFeature ?? null,
      phases: phases ?? [],
      liveActivity: liveActivity ?? null,
      workflowElapsedMs: workflowElapsedMs ?? 0
    }),
    queue: {
      orderedItems: [QUEUE_ITEM],
      inFlight: QUEUE_ITEM,
      pending: [],
      recent: [],
      paused: false
    },
    auditTail: [],
    monitor: null,
    history: [],
    producedAt: '2026-08-01T00:00:00.000Z',
    availablePipelines: [PIPELINE, SECOND_PIPELINE],
    availablePhases: [],
    availableModels: { claude: [], codex: [], agy: [] },
    availableBackends: ['claude'],
    workflowCatalog: {
      state: 'ready',
      records: [],
      effective: [WORKFLOW_GRAPH],
      revision: 'wf-1',
      warnings: []
    },
    ...rest
  } as unknown as WorkflowSnapshot;
}

describe('connected runs on the Runs surface (FR-014, FR-015)', () => {
  it('renders one connected-run view per projected run (M1)', () => {
    const { getAllByTestId, getAllByTestId: byId } = render(RunsSurface, {
      snapshot: buildSnapshot({
        connectedRuns: [
          connectedRun(),
          connectedRun({ connectedRunId: 'connected-run-2', workflowId: 'review-workflow' })
        ]
      })
    });
    expect(getAllByTestId('workflow-run')).toHaveLength(2);
    expect(byId('workflow-run-id').map((element) => element.textContent?.trim())).toEqual([
      'connected-run-1',
      'connected-run-2'
    ]);
  });

  it('renders no connected-run view when the projection carries an empty list (M2)', () => {
    const { queryByTestId } = render(RunsSurface, {
      snapshot: buildSnapshot({ connectedRuns: [] })
    });
    expect(queryByTestId('workflow-run')).toBeNull();
  });

  it('renders no connected-run view when the projection omits the field entirely (M2)', () => {
    // A host bundle predating connected runs, and every workspace that has never
    // started one. Absent is not the same shape as empty and must not throw.
    const { queryByTestId } = render(RunsSurface, { snapshot: buildSnapshot() });
    expect(queryByTestId('workflow-run')).toBeNull();
  });

  it('threads the queue rows through so a node finds its attempt (M1)', () => {
    // The reused Run surfaces look an attempt up in `queueItems` by
    // `latestQueueItemId`. Unthreaded, the lookup misses and the view renders
    // the "still arriving" branch instead — which is the precise discriminator
    // asserted here, because both branches render *something*.
    const { getByTestId, queryByTestId } = render(RunsSurface, {
      snapshot: buildSnapshot({
        connectedRuns: [
          connectedRun({
            nodes: [
              node({ state: 'in-flight', actions: [], latestQueueItemId: QUEUE_ITEM.id })
            ]
          })
        ]
      })
    });
    expect(getByTestId('workflow-node-attempt-node-a')).toBeTruthy();
    expect(queryByTestId('workflow-node-attempt-pending-node-a')).toBeNull();
    expect(getByTestId('workflow-node-attempt-node-a').textContent).toContain(
      'Analyse the corpus'
    );
  });

  it('threads the effective catalog through so a node can open its composer (M1)', async () => {
    // Unthreaded, `WorkflowRun` finds no Pipeline for the node and renders its
    // unresolved-catalog message instead of the continuation composer.
    const { getByTestId, queryByTestId } = render(RunsSurface, {
      snapshot: buildSnapshot({ connectedRuns: [connectedRun()] })
    });
    await fireEvent.click(getByTestId('workflow-node-action-node-a-start'));
    await tick();
    expect(queryByTestId('workflow-run-unresolved-pipeline')).toBeNull();
  });
});

describe('a connected run that is still hydrating (FR-016)', () => {
  it('is rendered with its loading state rather than filtered out (M3)', () => {
    const { getByTestId } = render(RunsSurface, {
      snapshot: buildSnapshot({ connectedRuns: [connectedRun({ hydrating: true, nodes: [] })] })
    });
    expect(getByTestId('workflow-run')).toBeTruthy();
    expect(getByTestId('workflow-run-hydrating')).toBeTruthy();
  });

  it('is counted alongside hydrated runs, not in place of them (M2, M3)', () => {
    const { getAllByTestId, getByTestId } = render(RunsSurface, {
      snapshot: buildSnapshot({
        connectedRuns: [
          connectedRun({ hydrating: true, nodes: [] }),
          connectedRun({ connectedRunId: 'connected-run-2' })
        ]
      })
    });
    expect(getAllByTestId('workflow-run')).toHaveLength(2);
    expect(getByTestId('workflow-run-hydrating')).toBeTruthy();
  });
});

const LAUNCHABLES: LaunchProjection = {
  pipelines: {
    state: 'entries',
    entries: [
      {
        kind: 'pipeline',
        id: 'analysis-pipeline',
        name: 'Analysis Pipeline',
        activeVersionId: 'v3',
        inputs: []
      }
    ]
  },
  workflows: {
    state: 'entries',
    entries: [
      {
        kind: 'workflow',
        id: 'research-workflow',
        name: 'Research Workflow',
        activeVersionId: 'v2',
        inputs: [],
        startNodeIds: ['node-a']
      }
    ]
  }
};

describe('the launch zone on the Runs surface (FR-001, FR-020)', () => {
  it('renders both sections, each listing what the projection offers', () => {
    const { getByTestId } = render(RunsSurface, {
      snapshot: buildSnapshot({ connectedRuns: [], launchables: LAUNCHABLES })
    });

    expect(getByTestId('runs-surface-launch-zone')).toBeTruthy();
    expect(getByTestId('launchable-row-pipeline-analysis-pipeline').textContent).toContain(
      'Analysis Pipeline'
    );
    expect(getByTestId('launchable-row-workflow-research-workflow').textContent).toContain(
      'Research Workflow'
    );
  });

  it('renders both sections in their loading arm when the field is absent (FR-006)', () => {
    // A host bundle predating the projection, and every workspace whose catalogs
    // have not resolved yet. Neither section may claim the workspace has nothing.
    const { getByTestId } = render(RunsSurface, {
      snapshot: buildSnapshot({ connectedRuns: [] })
    });

    expect(getByTestId('launch-section-loading-pipeline')).toBeTruthy();
    expect(getByTestId('launch-section-loading-workflow')).toBeTruthy();
  });

  it('offers no Pipeline picker — the sections replaced it', () => {
    // The `<select>` listed the effective Pipeline catalog with no version and
    // no Workflows. Asserted on the element as well as the test id, so a picker
    // reintroduced under a different handle is still caught.
    const { queryByTestId, container } = render(RunsSurface, {
      snapshot: buildSnapshot({ connectedRuns: [], launchables: LAUNCHABLES })
    });

    expect(queryByTestId('runs-surface-pipeline-select')).toBeNull();
    expect(queryByTestId('runs-surface-compose')).toBeNull();
    expect(container.querySelector('select')).toBeNull();
  });

  it('offers no lifecycle action anywhere on the surface (FR-004)', () => {
    // Runs is where work is started and only where work is started. Creating,
    // editing, publishing, restoring, and deactivating all live in the Builder,
    // and an operator offered them here would be one edit away from changing
    // what the next run freezes.
    const { container } = render(RunsSurface, {
      snapshot: buildSnapshot({ connectedRuns: [], launchables: LAUNCHABLES })
    });
    const text = (container.textContent ?? '').toLowerCase();

    for (const action of ['create', 'edit', 'publish', 'restore', 'deactivate']) {
      expect(text).not.toContain(action);
    }
  });
});

// Feature 102 (T030, US3 — FR-019, FR-020) — the two launch paths, and the zone
// neither of them displaces.
//
// A Pipeline goes to the queue and a Workflow becomes a connected run spanning
// its nodes. They are different host seams with different outcomes, and the whole
// reason the surface lists them apart is that starting one is not starting the
// other. The failure this pins is the plausible simplification: one submit path
// that "handles both", which would either enqueue a Workflow as a single run or
// open a connected run for a lone Pipeline.
//
// FR-020 is the other half. The restructure replaced the compose controls, and
// the in-flight zone sat directly above them — a launch flow that took the whole
// surface would leave the operator watching nothing.
describe('the two launch paths stay distinct (FR-019)', () => {
  async function openWorkflowForm(snapshot: WorkflowSnapshot) {
    const view = render(RunsSurface, { snapshot });
    await fireEvent.click(view.getByTestId('launchable-select-workflow-research-workflow'));
    await fireEvent.click(view.getByTestId('launchable-detail-trigger'));
    return view;
  }

  it('sends a Pipeline to the queue and opens no connected run', async () => {
    launchPipeline.mockResolvedValue({ outcome: 'enqueued', requestId: 'request-11' });
    const { getByTestId, queryByTestId } = render(RunsSurface, {
      snapshot: buildSnapshot({ connectedRuns: [], launchables: LAUNCHABLES })
    });

    await fireEvent.click(getByTestId('launchable-select-pipeline-analysis-pipeline'));
    await fireEvent.click(getByTestId('launchable-detail-trigger'));
    await fireEvent.click(getByTestId('run-launcher-submit'));

    expect(launchPipeline).toHaveBeenCalledTimes(1);
    expect(launchPipeline.mock.calls[0][0]).toMatchObject({ pipelineId: 'analysis-pipeline' });
    expect(launchWorkflow).not.toHaveBeenCalled();
    // A queued run is not a connected one, and nothing about enqueuing conjures a
    // connected-run view out of the surface's own state.
    expect(queryByTestId('workflow-run')).toBeNull();
  });

  it('sends a Workflow to the connected-run seam, naming the start node and its Pipeline', async () => {
    launchWorkflow.mockResolvedValue({
      outcome: 'started',
      connectedRunId: 'connected-run-9',
      revision: 2,
      queueItemId: 'queue-item-9'
    });
    const { getByTestId } = await openWorkflowForm(
      buildSnapshot({ connectedRuns: [], launchables: LAUNCHABLES })
    );

    await fireEvent.click(getByTestId('workflow-trigger-submit'));

    expect(launchWorkflow).toHaveBeenCalledTimes(1);
    expect(launchWorkflow.mock.calls[0][0]).toMatchObject({
      workflowId: 'research-workflow',
      startNodeId: 'node-a',
      // From the graph, not the projection — the projection carries no
      // node-to-Pipeline map, and the host refuses a mismatch.
      request: { pipelineId: 'analysis-pipeline' }
    });
    expect(launchPipeline).not.toHaveBeenCalled();
  });

  it('shows the started run in the connected-runs zone once the host projects it', async () => {
    launchWorkflow.mockResolvedValue({
      outcome: 'started',
      connectedRunId: 'connected-run-9',
      revision: 2,
      queueItemId: 'queue-item-9'
    });
    const { getByTestId, rerender } = await openWorkflowForm(
      buildSnapshot({ connectedRuns: [], launchables: LAUNCHABLES })
    );
    await fireEvent.click(getByTestId('workflow-trigger-submit'));

    // The surface holds no run state of its own: the run appears because the next
    // snapshot carries it, which is the only way it could appear correctly.
    await rerender({
      snapshot: buildSnapshot({
        connectedRuns: [connectedRun({ connectedRunId: 'connected-run-9' })],
        launchables: LAUNCHABLES
      })
    });

    expect(getByTestId('workflow-run-id').textContent).toContain('connected-run-9');
  });

  it('keeps the in-flight zone on screen while a trigger form is open (FR-020)', async () => {
    const { getByTestId } = await openWorkflowForm(
      buildSnapshot({ connectedRuns: [connectedRun()], launchables: LAUNCHABLES })
    );

    expect(getByTestId('workflow-trigger')).toBeTruthy();
    expect(getByTestId('workflow-run')).toBeTruthy();
    expect(getByTestId('runs-surface-launch-zone')).toBeTruthy();
  });
});
