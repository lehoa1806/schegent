// Published definitions compose into Tasks addressed to the open Queue.
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
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

vi.mock('../../lib/vscode-api', () => ({ postCommand: vi.fn(), onHostMessage: () => () => {} }));

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
import QueueTaskComposer from '../QueueTaskComposer.svelte';
import { postCommand } from '../../lib/vscode-api';

afterEach(() => {
  cleanup();
  vi.mocked(postCommand).mockClear();
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
  position: 0,
  phaseProgress: null
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

describe('the Queue task composer (FR-001, FR-020)', () => {
  it('renders the Workflows section and no Pipelines section, even when Pipelines are offered (FR-001)', () => {
    // Feature 285 (OD-2): the projection still carries a Pipeline section, and the composer
    // lists none of it.
    const { getByTestId, queryByTestId } = render(QueueTaskComposer, {
      snapshot: buildSnapshot({ connectedRuns: [], launchables: LAUNCHABLES })
    });

    expect(getByTestId('queue-task-composer-launch-zone')).toBeTruthy();
    expect(queryByTestId('launch-section-pipeline')).toBeNull();
    expect(queryByTestId('launchable-row-pipeline-analysis-pipeline')).toBeNull();
    expect(getByTestId('launchable-row-workflow-research-workflow').textContent).toContain(
      'Research Workflow'
    );
  });

  it('carries the "Local-first, not offline" note the retired Queue form carried (FR-002)', () => {
    const { getByTestId } = render(QueueTaskComposer, {
      snapshot: buildSnapshot({ connectedRuns: [] })
    });

    expect(getByTestId('dashboard-network-dependence-note').textContent).toContain(
      'Local-first, not offline'
    );
  });

  it('renders Workflows in its loading arm and omits empty Pipelines when the field is absent (FR-006)', () => {
    const { getByTestId, queryByTestId } = render(QueueTaskComposer, {
      snapshot: buildSnapshot({ connectedRuns: [] })
    });

    expect(queryByTestId('launch-section-loading-pipeline')).toBeNull();
    expect(getByTestId('launch-section-loading-workflow')).toBeTruthy();
  });

  it('offers no Pipeline picker — the sections replaced it', () => {
    // The `<select>` listed the effective Pipeline catalog with no version and
    // no Workflows. Asserted on the element as well as the test id, so a picker
    // reintroduced under a different handle is still caught.
    const { queryByTestId, container } = render(QueueTaskComposer, {
      snapshot: buildSnapshot({ connectedRuns: [], launchables: LAUNCHABLES })
    });

    expect(queryByTestId('queue-task-composer-pipeline-select')).toBeNull();
    expect(queryByTestId('queue-task-composer-compose')).toBeNull();
    expect(container.querySelector('select')).toBeNull();
  });

  it('offers no lifecycle action anywhere on the surface (FR-004)', () => {
    // Runs is where work is started and only where work is started. Creating,
    // editing, publishing, restoring, and deactivating all live in the Builder,
    // and an operator offered them here would be one edit away from changing
    // what the next run freezes.
    const { container } = render(QueueTaskComposer, {
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
//
// Feature 285 (OD-2, FR-001): the Pipeline path is retired from the composer; the first case
// below pins that it stays gone.
describe('the two launch paths stay distinct (FR-019)', () => {
  async function openWorkflowForm(snapshot: WorkflowSnapshot) {
    const view = render(QueueTaskComposer, { snapshot });
    await fireEvent.click(view.getByTestId('launchable-select-workflow-research-workflow'));
    await fireEvent.click(view.getByTestId('launchable-detail-trigger'));
    return view;
  }

  it('offers no control that sends a Pipeline to the queue (FR-001)', async () => {
    // Feature 285 (OD-2): the Pipeline launcher arm is gone. A Workflow launch is the only
    // submission the composer makes, and it never goes through the Pipeline launch command.
    launchWorkflow.mockResolvedValue({
      outcome: 'started',
      connectedRunId: 'connected-run-11',
      revision: 1,
      queueItemId: 'queue-item-11'
    });
    const { getByTestId, queryByTestId } = await openWorkflowForm(
      buildSnapshot({ connectedRuns: [], launchables: LAUNCHABLES })
    );

    expect(queryByTestId('launchable-select-pipeline-analysis-pipeline')).toBeNull();
    expect(queryByTestId('run-launcher-submit')).toBeNull();
    await fireEvent.click(getByTestId('workflow-trigger-submit'));

    expect(launchWorkflow).toHaveBeenCalledTimes(1);
    expect(launchPipeline).not.toHaveBeenCalled();
  });

  // Moved from the retired Queue form's test (feature 065, BUG-001, FR-018): a submission never
  // opens the start-mode chooser, at any queue lifecycle. Only "Start queue" reaches it.
  for (const lifecycle of ['running', 'operator-paused', 'idle-pending', 'active-empty'] as const) {
    it(`a Workflow submit renders no start-mode chooser at lifecycle "${lifecycle}" (FR-018)`, async () => {
      launchWorkflow.mockResolvedValue({
        outcome: 'started',
        connectedRunId: 'connected-run-12',
        revision: 1,
        queueItemId: 'queue-item-12'
      });
      const base = buildSnapshot({ connectedRuns: [], launchables: LAUNCHABLES });
      const { getByTestId, queryByTestId } = await openWorkflowForm({
        ...base,
        queue: { ...base.queue, lifecycle }
      } as WorkflowSnapshot);

      await fireEvent.click(getByTestId('workflow-trigger-submit'));
      await tick();

      expect(launchWorkflow).toHaveBeenCalledTimes(1);
      expect(queryByTestId('start-mode-chooser')).toBeNull();
      expect(queryByTestId('start-mode-chooser-discard')).toBeNull();
    });
  }

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

  it('binds Workflow tasks to the selected queue and does not start it', async () => {
    launchWorkflow.mockResolvedValue({ outcome: 'started', connectedRunId: 'run-9', revision: 1, queueItemId: 'item-9' });
    const view = render(QueueTaskComposer, { snapshot: buildSnapshot({ launchables: LAUNCHABLES }), queueId: 'queue-beta' });
    await fireEvent.click(view.getByTestId('launchable-select-workflow-research-workflow'));
    await fireEvent.click(view.getByTestId('launchable-detail-trigger'));
    expect(view.getByTestId('workflow-trigger-submit').textContent).toContain('Add task');
    await fireEvent.click(view.getByTestId('workflow-trigger-submit'));
    expect(launchWorkflow.mock.calls[0][0]).toMatchObject({ queueId: 'queue-beta', workflowId: 'research-workflow' });
    expect(view.getByTestId('workflow-trigger-status').textContent).toContain('Added task to queue');
    expect(postCommand).not.toHaveBeenCalled();
  });

  it('keeps execution monitoring in Queue task detail', async () => {
    const { queryByTestId } = await openWorkflowForm(buildSnapshot({ connectedRuns: [connectedRun()], launchables: LAUNCHABLES }));
    expect(queryByTestId('workflow-trigger')).toBeTruthy();
    expect(queryByTestId('workflow-run')).toBeNull();
  });
});

// Feature 285 (FR-006a): the composer preselects the resolved default Workflow when the
// launch projection offers it and nothing is selected. Preselection opens and submits nothing.
describe('the composer preselects the default Workflow (FR-006a)', () => {
  it('selects a launchable default Workflow and opens no form', () => {
    const { getByTestId, queryByTestId } = render(QueueTaskComposer, {
      snapshot: buildSnapshot({ launchables: LAUNCHABLES, defaultWorkflowId: 'research-workflow' })
    });

    expect(getByTestId('launchable-detail-name').textContent).toContain('Research Workflow');
    expect(queryByTestId('workflow-trigger')).toBeNull();
    expect(launchWorkflow).not.toHaveBeenCalled();
    expect(postCommand).not.toHaveBeenCalled();
  });

  it('selects nothing with no default, an empty default or one that is not launchable', () => {
    for (const defaultWorkflowId of [undefined, '', 'retired-workflow', 'analysis-pipeline']) {
      const { queryByTestId, unmount } = render(QueueTaskComposer, {
        snapshot: buildSnapshot({
          launchables: LAUNCHABLES,
          ...(defaultWorkflowId === undefined ? {} : { defaultWorkflowId })
        })
      });

      expect(queryByTestId('launchable-detail'), String(defaultWorkflowId)).toBeNull();
      unmount();
    }
  });

  it('does not reselect the default once the operator has cleared the selection', async () => {
    const snapshot = buildSnapshot({
      launchables: LAUNCHABLES,
      defaultWorkflowId: 'research-workflow'
    });
    const { getByTestId, queryByTestId, rerender } = render(QueueTaskComposer, { snapshot });

    await fireEvent.click(getByTestId('launchable-select-workflow-research-workflow'));
    expect(queryByTestId('launchable-detail')).toBeNull();

    await rerender({ snapshot: { ...snapshot, producedAt: '2026-08-01T00:00:05.000Z' } });
    expect(queryByTestId('launchable-detail')).toBeNull();
  });

  it('preselects the default once the projection first offers it', async () => {
    const { queryByTestId, getByTestId, rerender } = render(QueueTaskComposer, {
      snapshot: buildSnapshot({ defaultWorkflowId: 'research-workflow' })
    });
    expect(queryByTestId('launchable-detail')).toBeNull();

    await rerender({
      snapshot: buildSnapshot({ launchables: LAUNCHABLES, defaultWorkflowId: 'research-workflow' })
    });
    expect(getByTestId('launchable-detail-name').textContent).toContain('Research Workflow');
  });
});
