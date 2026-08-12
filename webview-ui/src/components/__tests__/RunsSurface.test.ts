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

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConnectedNodeProjection,
  ConnectedRunProjection,
  PipelineDefinition,
  QueueItem,
  WorkflowSnapshot
} from '../../lib/snapshot-types';
import { foldLegacyRun, type LegacyRunFields } from '../../lib/__tests__/queue-runtime-fixture';

vi.mock('../../lib/workflow-run-ipc', () => ({
  continueWorkflow: vi.fn()
}));
vi.mock('../../lib/run-launcher-ipc', () => ({
  launchPipeline: vi.fn()
}));

// Late import so the component binds to the stubs above.
import RunsSurface from '../RunsSurface.svelte';

afterEach(() => cleanup());

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

describe('the Run composer on the Runs surface (FR-017)', () => {
  it('opens for a Pipeline selected from the effective catalog (M4)', async () => {
    const { getByTestId, queryByTestId } = render(RunsSurface, {
      snapshot: buildSnapshot({ connectedRuns: [] })
    });
    // Closed until the operator asks for it — the surface's first job is the
    // connected runs, and an always-open composer would bury them.
    expect(queryByTestId('run-launcher')).toBeNull();

    await fireEvent.change(getByTestId('runs-surface-pipeline-select'), {
      target: { value: 'analysis-pipeline' }
    });
    await fireEvent.click(getByTestId('runs-surface-compose'));
    await tick();

    expect(getByTestId('run-launcher')).toBeTruthy();
  });

  it('composes for the Pipeline the operator picked, not the first in the catalog (M4)', async () => {
    const { getByTestId } = render(RunsSurface, {
      snapshot: buildSnapshot({ connectedRuns: [] })
    });
    await fireEvent.change(getByTestId('runs-surface-pipeline-select'), {
      target: { value: 'review-pipeline' }
    });
    await fireEvent.click(getByTestId('runs-surface-compose'));
    await tick();

    expect(getByTestId('run-launcher').textContent).toContain('Review Pipeline');
  });

  it('closes an open composer when its Pipeline leaves the catalog', async () => {
    // The composer resolves its Pipeline from the catalog on every projection
    // rather than capturing it at open time. A Pipeline deleted mid-compose
    // would otherwise leave the operator filling in a form against a definition
    // the host has already stopped accepting.
    const { getByTestId, queryByTestId, rerender } = render(RunsSurface, {
      snapshot: buildSnapshot({ connectedRuns: [] })
    });
    await fireEvent.change(getByTestId('runs-surface-pipeline-select'), {
      target: { value: 'analysis-pipeline' }
    });
    await fireEvent.click(getByTestId('runs-surface-compose'));
    await tick();
    expect(getByTestId('run-launcher')).toBeTruthy();

    await rerender({
      snapshot: buildSnapshot({ connectedRuns: [], availablePipelines: [SECOND_PIPELINE] })
    });
    await tick();

    expect(queryByTestId('run-launcher')).toBeNull();
    // The surviving Pipeline is still offered — the catalog shrank, it did not
    // empty, so the compose control stays available for what remains.
    expect(getByTestId('runs-surface-pipeline-select')).toBeTruthy();
  });

  it('offers no composer when the effective catalog is empty', async () => {
    // Nothing to compose against is a different state from "not yet asked", and
    // a picker with no options plus a live button is a control that can only
    // fail.
    const { queryByTestId } = render(RunsSurface, {
      snapshot: buildSnapshot({ connectedRuns: [], availablePipelines: [] })
    });
    expect(queryByTestId('runs-surface-pipeline-select')).toBeNull();
    expect(queryByTestId('runs-surface-compose')).toBeNull();
  });
});
