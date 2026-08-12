// Feature 092 (T100, FR-057, FR-064, FR-047, FR-065, US5 scenario 3) — tier 2 of
// the drill-down: one queue's work, its controls, and its configuration.
//
// The tier scopes the existing operations panes to the queue it is showing rather
// than re-implementing them, so these tests assert two distinct things: the
// tier's own chrome (title, lifecycle, throughput, row collapse, configuration,
// back affordance), and that the embedded panes address **this** queue — a pause
// posts the queue's id, and the rows are this queue's rows and not the default
// queue's.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import QueueDetailTier from '../QueueDetailTier.svelte';
import { CMD_PAUSE_QUEUE, CMD_RENAME_QUEUE, CMD_START } from '../../../lib/messages';
import { buildQueueRuntime } from '../../../lib/__tests__/queue-runtime-fixture';
import { IDLE_GENERAL_SETTINGS } from '../../../lib/snapshot-types';
import type {
  ConnectedRunProjection,
  QueueItem,
  QueueSummary,
  WorkflowSnapshot
} from '../../../lib/snapshot-types';

let nextCorrelationId = 0;
const postCommandSpy = vi.fn((..._args: readonly unknown[]) => ({
  correlationId: `corr-${++nextCorrelationId}`
}));
vi.mock('../../../lib/vscode-api', () => ({
  postCommand: (...args: unknown[]) => postCommandSpy(...args),
  onHostMessage: () => () => {},
  getWebviewState: () => undefined,
  setWebviewState: () => {}
}));

// The embedded pause control routes through the universal confirmation gate
// (feature 063). These tests assert the post-confirm IPC path; the dialog itself
// is covered by use-confirm.test.ts.
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

function summary(id: string, name: string, position: number): QueueSummary {
  return {
    id,
    name,
    position,
    state: 'active',
    pauseSource: null,
    schedule: null,
    taskCount: 0
  };
}

function connectedRun(
  connectedRunId: string,
  queueItemIds: readonly (string | undefined)[]
): ConnectedRunProjection {
  return {
    connectedRunId,
    workflowId: 'wf-release',
    revision: 3,
    hydrating: false,
    nodes: queueItemIds.map((queueItemId, index) => ({
      nodeId: `n-${index}`,
      pipelineId: 'standard',
      state: 'completed' as const,
      actions: [],
      attemptCount: 1,
      ...(queueItemId !== undefined ? { latestQueueItemId: queueItemId } : {})
    }))
  };
}

/**
 * A snapshot carrying two queues. Every assertion about scoping reads `q-beta`,
 * so anything that leaked from `default` shows up as a failure rather than as a
 * plausible-looking row.
 */
function buildSnapshot(
  betaTasks: readonly QueueItem[],
  overrides: {
    readonly lifecycle?: 'running' | 'operator-paused' | 'idle-pending' | 'active-empty';
    readonly connectedRuns?: readonly ConnectedRunProjection[];
  } = {}
): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: 4,
    isPrimary: true,
    queues: Object.freeze([
      buildQueueRuntime({
        queueId: 'default',
        name: 'Default',
        position: 0,
        lifecycle: 'running',
        tasks: [task('other-queue-task', { position: 0, label: 'not mine' })]
      }),
      buildQueueRuntime({
        queueId: 'q-beta',
        name: 'nightly',
        position: 1,
        lifecycle: overrides.lifecycle ?? 'running',
        pendingCount: betaTasks.filter((item) => item.status === 'pending').length,
        tasks: betaTasks
      })
    ]),
    queue: Object.freeze({
      inFlight: null,
      pending: Object.freeze([]),
      recent: Object.freeze([]),
      orderedItems: Object.freeze([task('other-queue-task', { label: 'not mine' })]),
      queues: Object.freeze([summary('default', 'Default', 0), summary('q-beta', 'nightly', 1)]),
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
    readonly isPrimary?: boolean;
    readonly onBack?: () => void;
    readonly onSelectRun?: (runId: string) => void;
  } = {}
) {
  return render(QueueDetailTier, {
    props: {
      snapshot,
      queueId: props.queueId ?? 'q-beta',
      isPrimary: props.isPrimary ?? true,
      onBack: props.onBack ?? (() => {}),
      ...(props.onSelectRun !== undefined ? { onSelectRun: props.onSelectRun } : {})
    }
  });
}

beforeEach(() => {
  postCommandSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('QueueDetailTier — this queue’s work (FR-057)', () => {
  it('titles the tier with the queue’s own name and lifecycle', () => {
    const { getByTestId } = mount(buildSnapshot([task('a')], { lifecycle: 'idle-pending' }));

    expect(getByTestId('queue-detail-title').textContent).toContain('nightly');
    expect(getByTestId('queue-detail-lifecycle').textContent).toContain('Idle (pending)');
  });

  it('lists this queue’s active and historical Tasks and nothing from another queue', () => {
    const { getByTestId, queryByTestId } = mount(
      buildSnapshot([
        task('live', { position: 0, status: 'in-flight', label: 'generate rfc' }),
        task('waiting', { position: 1, status: 'pending' }),
        task('done', { position: 2, status: 'completed' })
      ])
    );

    expect(getByTestId('queue-task-row-live').textContent).toContain('generate rfc');
    expect(queryByTestId('queue-task-row-waiting')).not.toBeNull();
    expect(queryByTestId('queue-task-row-done')).not.toBeNull();
    expect(queryByTestId('queue-task-row-other-queue-task')).toBeNull();
  });

  it('reports the queue’s throughput from its own rows', () => {
    const { getByTestId } = mount(
      buildSnapshot([
        task('a', { position: 0, status: 'completed' }),
        task('b', { position: 1, status: 'completed' }),
        task('c', { position: 2, status: 'failed' }),
        task('d', { position: 3, status: 'pending' })
      ])
    );

    const throughput = getByTestId('queue-detail-throughput').textContent ?? '';
    expect(throughput).toContain('2');
    expect(throughput).toMatch(/complete/i);
    expect(throughput).toMatch(/1\s*failed/i);
  });

  it('pauses THIS queue, not the workspace default', async () => {
    const { getByTestId } = mount(
      buildSnapshot([task('live', { status: 'in-flight' })])
    );

    await fireEvent.click(getByTestId('dashboard-queue-action'));

    expect(postCommandSpy).toHaveBeenCalledWith(CMD_PAUSE_QUEUE, { queueId: 'q-beta' });
  });

  it('enqueues added work onto THIS queue', async () => {
    const { getByTestId } = mount(buildSnapshot([]));

    const textarea = getByTestId('dashboard-queue-input-textarea');
    await fireEvent.input(textarea, { target: { value: 'ship the release' } });
    await fireEvent.click(getByTestId('dashboard-queue-input-submit'));

    expect(postCommandSpy).toHaveBeenCalledWith(
      CMD_START,
      expect.objectContaining({ description: 'ship the release', queueId: 'q-beta' })
    );
  });
});

describe('QueueDetailTier — a connected run is one row (FR-047)', () => {
  it('collapses a connected run’s member Tasks into one row carrying node progress', () => {
    const { getByTestId, queryByTestId } = mount(
      buildSnapshot(
        [
          task('n1', { position: 0, status: 'completed', label: 'stage one' }),
          task('n2', { position: 1, status: 'in-flight', label: 'stage two' })
        ],
        { connectedRuns: [connectedRun('cr-1', ['n1', 'n2', undefined])] }
      )
    );

    const row = getByTestId('queue-run-row-cr-1');
    expect(row.textContent).toContain('stage one');
    expect(row.textContent).toContain('1');
    expect(row.textContent).toContain('3');
    // The member Tasks must not ALSO appear as their own rows.
    expect(queryByTestId('queue-task-row-n1')).toBeNull();
    expect(queryByTestId('queue-task-row-n2')).toBeNull();
  });

  it('keeps standalone Tasks as their own rows, interleaved by position', () => {
    const { getByTestId } = mount(
      buildSnapshot(
        [
          task('solo-first', { position: 0 }),
          task('member', { position: 1 }),
          task('solo-last', { position: 2 })
        ],
        { connectedRuns: [connectedRun('cr-1', ['member'])] }
      )
    );

    const ids = Array.from(
      getByTestId('queue-detail-rows').querySelectorAll('[data-row-key]')
    ).map((node) => node.getAttribute('data-row-key'));

    expect(ids).toEqual(['task:solo-first', 'run:cr-1', 'task:solo-last']);
  });
});

describe('QueueDetailTier — configuration is reachable (FR-064)', () => {
  it('renames the queue by id, with a trimmed name', async () => {
    const { getByTestId } = mount(buildSnapshot([]));

    await fireEvent.click(getByTestId('queue-config-open'));
    await fireEvent.input(getByTestId('queue-rename-name'), {
      target: { value: '  release train  ' }
    });
    await fireEvent.click(getByTestId('queue-rename-submit'));

    expect(postCommandSpy).toHaveBeenCalledWith(CMD_RENAME_QUEUE, {
      queueId: 'q-beta',
      name: 'release train'
    });
  });

  it('refuses a blank rename', async () => {
    const { getByTestId } = mount(buildSnapshot([]));

    await fireEvent.click(getByTestId('queue-config-open'));
    await fireEvent.input(getByTestId('queue-rename-name'), { target: { value: '   ' } });
    await fireEvent.click(getByTestId('queue-rename-submit'));

    expect(postCommandSpy).not.toHaveBeenCalledWith(
      CMD_RENAME_QUEUE,
      expect.anything()
    );
  });

  it('seeds the rename field with the queue’s current name', async () => {
    const { getByTestId } = mount(buildSnapshot([]));

    await fireEvent.click(getByTestId('queue-config-open'));

    expect((getByTestId('queue-rename-name') as HTMLInputElement).value).toBe('nightly');
  });
});

describe('QueueDetailTier — navigating between tiers (FR-060, FR-061)', () => {
  it('offers a back affordance that reports the parent tier', async () => {
    const onBack = vi.fn();
    const { getByTestId } = mount(buildSnapshot([]), { onBack });

    await fireEvent.click(getByTestId('queue-detail-back'));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('reports the Task a standalone row addresses', async () => {
    const onSelectRun = vi.fn();
    const { getByTestId } = mount(buildSnapshot([task('solo')]), { onSelectRun });

    await fireEvent.click(getByTestId('queue-task-row-solo'));

    expect(onSelectRun).toHaveBeenCalledWith('solo');
  });

  it('reports the connected run a collapsed row addresses', async () => {
    const onSelectRun = vi.fn();
    const { getByTestId } = mount(
      buildSnapshot([task('member')], { connectedRuns: [connectedRun('cr-1', ['member'])] }),
      { onSelectRun }
    );

    await fireEvent.click(getByTestId('queue-run-row-cr-1'));

    expect(onSelectRun).toHaveBeenCalledWith('cr-1');
  });

  it('activates a row from the keyboard alone (FR-059)', async () => {
    const onSelectRun = vi.fn();
    const { getByTestId } = mount(buildSnapshot([task('solo')]), { onSelectRun });

    const row = getByTestId('queue-task-row-solo');
    expect(row.tagName).toBe('BUTTON');
    await fireEvent.keyDown(row, { key: 'Enter' });

    expect(onSelectRun).toHaveBeenCalledWith('solo');
  });

  it('does not render a second <main> landmark — the embedded pane owns it', () => {
    const { container } = mount(buildSnapshot([]));

    expect(container.querySelectorAll('main')).toHaveLength(1);
  });
});

describe('QueueDetailTier — read-only in a non-primary window (FR-065)', () => {
  it('withholds the configuration affordance', () => {
    const { queryByTestId } = mount(buildSnapshot([]), { isPrimary: false });

    expect(queryByTestId('queue-config-open')).toBeNull();
  });

  it('still lets the operator drill in and back out', async () => {
    const onBack = vi.fn();
    const onSelectRun = vi.fn();
    const { getByTestId } = mount(buildSnapshot([task('solo')]), {
      isPrimary: false,
      onBack,
      onSelectRun
    });

    await fireEvent.click(getByTestId('queue-task-row-solo'));
    await fireEvent.click(getByTestId('queue-detail-back'));

    expect(onSelectRun).toHaveBeenCalledWith('solo');
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
