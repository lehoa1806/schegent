// The Queue Detail row list in the redesign: a status chip on every row, a row menu that holds
// Open and the reorder actions, the note under the table, and the search and status filter above
// it. The tier's own tests (QueueDetailTier.test.ts) cover what these controls post to the host;
// these cover what the list draws and how the filter narrows it.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import QueueDetailRows from '../QueueDetailRows.svelte';
import { buildQueueRuntime } from '../../../lib/__tests__/queue-runtime-fixture';
import { IDLE_GENERAL_SETTINGS } from '../../../lib/snapshot-types';
import type {
  ConnectedRunProjection,
  QueueItem,
  QueueSummary,
  WorkflowSnapshot
} from '../../../lib/snapshot-types';

afterEach(() => cleanup());

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

function summary(id: string, name: string, position: number): QueueSummary {
  return {
    id,
    name,
    position,
    state: 'active',
    pauseSource: null,
    schedule: null,
    taskCount: 0,
    failurePolicy: 'halt-on-failure',
    failurePolicyOverride: null
  };
}

function connectedRun(connectedRunId: string, queueItemIds: readonly string[]): ConnectedRunProjection {
  return {
    connectedRunId,
    workflowId: 'wf-release',
    revision: 1,
    hydrating: false,
    nodes: queueItemIds.map((queueItemId, index) => ({
      nodeId: `n-${index}`,
      pipelineId: 'standard',
      state: 'completed' as const,
      actions: [],
      attemptCount: 1,
      latestQueueItemId: queueItemId
    }))
  };
}

/** `q-beta` holds the rows; `default` exists so a pending Task has somewhere to move to. */
function buildSnapshot(
  tasks: readonly QueueItem[],
  connectedRuns?: readonly ConnectedRunProjection[]
): WorkflowSnapshot {
  return {
    schemaVersion: 4,
    isPrimary: true,
    queues: [
      buildQueueRuntime({
        queueId: 'q-beta',
        name: 'nightly',
        position: 1,
        pendingCount: tasks.filter((item) => item.status === 'pending').length,
        tasks
      })
    ],
    queue: {
      inFlight: null,
      pending: [],
      recent: [],
      orderedItems: [],
      queues: [summary('default', 'Default', 0), summary('q-beta', 'nightly', 1)],
      paused: false
    },
    ...(connectedRuns !== undefined ? { connectedRuns } : {}),
    auditTail: [],
    monitor: null,
    history: [],
    producedAt: '2026-08-12T00:00:30.000Z',
    availablePipelines: [{ id: 'standard', name: 'Standard', phases: ['speckit-specify'] }],
    availablePhases: [],
    availableModels: { claude: [], codex: [], agy: [] },
    availableBackends: ['claude'],
    generalSettings: IDLE_GENERAL_SETTINGS
  } as unknown as WorkflowSnapshot;
}

function mount(
  tasks: readonly QueueItem[],
  options: {
    readonly isPrimary?: boolean;
    readonly connectedRuns?: readonly ConnectedRunProjection[];
    readonly onSelectRun?: (runId: string) => void;
  } = {}
) {
  return render(QueueDetailRows, {
    props: {
      snapshot: buildSnapshot(tasks, options.connectedRuns),
      queueId: 'q-beta',
      isPrimary: options.isPrimary ?? true,
      onSelectRun: options.onSelectRun ?? (() => {})
    }
  });
}

/** Four Tasks on the one-phase `standard` pipeline, one per view, in run order. */
const MIXED = [
  task('waiting', { position: 0, label: 'Write the spec', currentPipelineId: 'standard' }),
  task('live', {
    position: 1,
    label: 'Plan the change',
    status: 'in-flight',
    currentPipelineId: 'standard',
    currentPhase: 'speckit-specify'
  }),
  task('done', { position: 2, label: 'Tidy the docs', status: 'completed', currentPipelineId: 'standard' }),
  task('broken', {
    position: 3,
    label: 'Fix the build',
    status: 'failed',
    currentPipelineId: 'standard',
    currentPhase: 'speckit-specify'
  })
];

describe('QueueDetailRows — status chips', () => {
  it('names each Task row’s status in the product’s own words', () => {
    const { getByTestId } = mount(MIXED);

    expect(getByTestId('queue-task-status-waiting').textContent).toBe('Pending');
    expect(getByTestId('queue-task-status-live').textContent).toBe('Running');
    expect(getByTestId('queue-task-status-done').textContent).toBe('Completed');
    expect(getByTestId('queue-task-status-broken').textContent).toBe('Failed');
    expect(getByTestId('queue-task-status-live').classList.contains('s-run')).toBe(true);
    expect(getByTestId('queue-task-status-broken').classList.contains('s-err')).toBe(true);
  });

  it('gives a connected run’s row a chip for the run’s own status', () => {
    const { getByTestId } = mount(
      [task('m1', { position: 0, status: 'in-flight' }), task('m2', { position: 1, status: 'completed' })],
      { connectedRuns: [connectedRun('cr-1', ['m1', 'm2'])] }
    );

    expect(getByTestId('queue-run-status-cr-1').textContent).toBe('Running');
  });
});

describe('QueueDetailRows — the progress bar', () => {
  function barOf(element: HTMLElement): readonly string[] {
    return Array.from(element.querySelectorAll('.bar > span')).map((segment) => segment.className.trim());
  }

  it('marks the phase in flight, and marks it failed when the Task failed', () => {
    const { getByTestId } = mount(MIXED);

    expect(barOf(getByTestId('queue-task-progress-live'))).toEqual([expect.stringMatching(/\br\b/)]);
    expect(barOf(getByTestId('queue-task-progress-broken'))).toEqual([expect.stringMatching(/\bf\b/)]);
  });

  it('draws no bar for a pending Task, which has not started a phase', () => {
    const { getByTestId } = mount(MIXED);

    expect(getByTestId('queue-task-progress-waiting').querySelector('.bar')).toBeNull();
  });
});

describe('QueueDetailRows — the row menu', () => {
  it('opens a Task from its row menu', async () => {
    const onSelectRun = vi.fn();
    const { getByTestId } = mount([task('solo')], { onSelectRun });
    const open = getByTestId('queue-task-open-solo');

    expect(open.getAttribute('role')).toBe('menuitem');
    expect(open.closest('[role="menu"]')?.getAttribute('aria-label')).toBe('Actions for task solo');
    await fireEvent.click(open);
    expect(onSelectRun).toHaveBeenCalledWith('solo');
  });

  it('opens a connected run from its row menu', async () => {
    const onSelectRun = vi.fn();
    const { getByTestId } = mount([task('m1', { status: 'in-flight' })], {
      connectedRuns: [connectedRun('cr-1', ['m1'])],
      onSelectRun
    });

    await fireEvent.click(getByTestId('queue-run-open-cr-1'));
    expect(onSelectRun).toHaveBeenCalledWith('cr-1');
  });

  it('puts Move up and Move down in a pending Task’s menu', () => {
    const { getByTestId } = mount([task('solo')]);

    for (const testId of ['queue-task-reorder-up-solo', 'queue-task-reorder-down-solo']) {
      const item = getByTestId(testId);
      expect(item.getAttribute('role')).toBe('menuitem');
      expect(item.closest('[role="menu"]')?.getAttribute('aria-label')).toBe('Actions for task solo');
    }
  });

  it('keeps each row’s run-order number on the row', () => {
    const { getByTestId } = mount(MIXED);

    expect(getByTestId('queue-task-row-done').textContent.trim().startsWith('3')).toBe(true);
  });
});

describe('QueueDetailRows — the note under the table', () => {
  it('says how the order works, and how to change it, in the primary window', () => {
    const { getByTestId } = mount(MIXED);

    expect(getByTestId('queue-detail-countline').textContent).toBe(
      'Tasks run top to bottom. Drag a pending task, or use its menu, to change the order.'
    );
  });

  it('leaves out the part about changing the order in a read-only window (FR-065)', () => {
    const { getByTestId } = mount(MIXED, { isPrimary: false });

    expect(getByTestId('queue-detail-countline').textContent).toBe('Tasks run top to bottom.');
  });
});

describe('QueueDetailRows — search and status filter', () => {
  const SHOW = ['all', 'active', 'pending', 'finished'] as const;

  function pressed(getByTestId: (id: string) => HTMLElement): readonly string[] {
    return SHOW.filter((id) => getByTestId(`queue-detail-show-${id}`).getAttribute('aria-pressed') === 'true');
  }

  it('offers All, Active, Pending and Finished, with All chosen', () => {
    const { getByTestId } = mount(MIXED);

    expect(SHOW.map((id) => getByTestId(`queue-detail-show-${id}`).textContent.trim())).toEqual([
      'All',
      'Active',
      'Pending',
      'Finished'
    ]);
    expect(pressed(getByTestId)).toEqual(['all']);
  });

  it('shows only the rows of the chosen status', async () => {
    const { getByTestId, queryByTestId } = mount(MIXED);

    await fireEvent.click(getByTestId('queue-detail-show-finished'));

    expect(pressed(getByTestId)).toEqual(['finished']);
    expect(queryByTestId('queue-task-row-done')).not.toBeNull();
    expect(queryByTestId('queue-task-row-broken')).not.toBeNull();
    expect(queryByTestId('queue-task-row-waiting')).toBeNull();
    expect(queryByTestId('queue-task-row-live')).toBeNull();
  });

  it('files a connected run under its own status', async () => {
    const { getByTestId, queryByTestId } = mount([task('m1', { status: 'in-flight' })], {
      connectedRuns: [connectedRun('cr-1', ['m1'])]
    });

    await fireEvent.click(getByTestId('queue-detail-show-finished'));
    expect(queryByTestId('queue-run-row-cr-1')).toBeNull();

    await fireEvent.click(getByTestId('queue-detail-show-active'));
    expect(queryByTestId('queue-run-row-cr-1')).not.toBeNull();
  });

  it('narrows the rows to those whose name or id matches the search', async () => {
    const { getByTestId, queryByTestId } = mount(MIXED);

    await fireEvent.input(getByTestId('queue-detail-search'), { target: { value: 'PLAN' } });

    expect(queryByTestId('queue-task-row-live')).not.toBeNull();
    expect(queryByTestId('queue-task-row-waiting')).toBeNull();
    expect(queryByTestId('queue-detail-no-match')).toBeNull();
  });

  it('says so when nothing matches, and offers to show every task again', async () => {
    const { getByTestId, queryByTestId } = mount(MIXED);
    const search = getByTestId('queue-detail-search') as HTMLInputElement;

    await fireEvent.click(getByTestId('queue-detail-show-active'));
    await fireEvent.input(search, { target: { value: 'nothing like this' } });
    expect(getByTestId('queue-detail-no-match').textContent).toContain('No tasks match');

    await fireEvent.click(getByTestId('queue-detail-show-everything'));

    expect(queryByTestId('queue-detail-no-match')).toBeNull();
    expect(search.value).toBe('');
    expect(pressed(getByTestId)).toEqual(['all']);
    expect(queryByTestId('queue-task-row-waiting')).not.toBeNull();
  });

  it('draws no search or filter for a queue with no work', () => {
    const { getByTestId, queryByTestId } = mount([]);

    expect(getByTestId('queue-detail-empty')).toBeTruthy();
    expect(queryByTestId('queue-detail-search')).toBeNull();
    expect(queryByTestId('queue-detail-show-all')).toBeNull();
  });
});
