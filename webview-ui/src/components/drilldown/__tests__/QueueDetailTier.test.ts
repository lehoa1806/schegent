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
import {
  CMD_ACK,
  CMD_CLEAR_ALL,
  CMD_CLEAR_COMPLETED,
  CMD_DELETE_QUEUE,
  CMD_MOVE_QUEUE_ITEM_DOWN,
  CMD_MOVE_QUEUE_ITEM_UP,
  CMD_MOVE_TASK,
  CMD_PAUSE_QUEUE,
  CMD_REORDER_TASK,
  CMD_RENAME_QUEUE,
  CMD_RESUME_QUEUE,
  CMD_START
} from '../../../lib/messages';
import { buildInFlightRun, buildQueueRuntime } from '../../../lib/__tests__/queue-runtime-fixture';
import { snapshotStore } from '../../../lib/snapshot-store.svelte';
import { useConfirm } from '../../../lib/use-confirm';
import { IDLE_GENERAL_SETTINGS } from '../../../lib/snapshot-types';
import type {
  ConnectedRunProjection,
  InFlightRunProjection,
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
  // Feature 097 (T012) removed the registry-schedule UI (Mechanism B); the
  // wire field stays mandatory but dormant — always null here.
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
    readonly inFlightRun?: InFlightRunProjection | null;
    /** Feature 097 — override when a test needs more than one phase to tell rows apart. */
    readonly pipelines?: readonly {
      readonly id: string;
      readonly name: string;
      readonly phases: readonly string[];
    }[];
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
        inFlightRun: overrides.inFlightRun ?? null,
        pendingCount: betaTasks.filter((item) => item.status === 'pending').length,
        tasks: betaTasks
      })
    ]),
    queue: Object.freeze({
      inFlight: null,
      pending: Object.freeze([]),
      recent: Object.freeze([]),
      orderedItems: Object.freeze([task('other-queue-task', { label: 'not mine' })]),
      queues: Object.freeze([
        summary('default', 'Default', 0),
        summary('q-beta', 'nightly', 1)
      ]),
      paused: false
    }),
    ...(overrides.connectedRuns !== undefined
      ? { connectedRuns: overrides.connectedRuns }
      : {}),
    auditTail: Object.freeze([]),
    monitor: null,
    history: Object.freeze([]),
    producedAt: '2026-08-12T00:00:30.000Z',
    availablePipelines: Object.freeze(
      overrides.pipelines ?? [
        Object.freeze({ id: 'standard', name: 'Standard', phases: Object.freeze(['speckit-specify']) })
      ]
    ),
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

// Feature 095 — the queue-control helpers are correlated requests: they post,
// register a one-shot ack listener on the real store, and resolve when the host
// answers. The host is absent here, so these drive the store's own public ack
// path rather than stubbing the helper module — which keeps the assertions on
// the payloads the component actually puts on the wire.
function correlationIdOf(callIndex: number): string {
  const result = postCommandSpy.mock.results[callIndex];
  expect(result, `no post at index ${callIndex}`).toBeDefined();
  return (result!.value as { correlationId: string }).correlationId;
}

function ack(
  callIndex: number,
  status: 'accepted' | 'rejected',
  reason?: string,
  result?: unknown
): void {
  snapshotStore.apply({
    type: CMD_ACK,
    correlationId: correlationIdOf(callIndex),
    status,
    ...(reason !== undefined ? { reason } : {}),
    ...(result !== undefined ? { result } : {})
  } as never);
}

/** What the host says deleting `q-beta` costs — deliberately unlike the snapshot. */
const DELETE_IMPACT = {
  queueId: 'q-beta',
  pendingTaskCount: 9,
  boundConnectedRunIds: ['cr-7', 'cr-8']
};

beforeEach(() => {
  postCommandSpy.mockClear();
  vi.mocked(useConfirm).mockClear();
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
      buildSnapshot([task('live', { status: 'in-flight' })], {
        inFlightRun: buildInFlightRun({ runId: 'live' })
      })
    );

    await fireEvent.click(getByTestId('dashboard-queue-action'));

    expect(postCommandSpy).toHaveBeenCalledWith(CMD_PAUSE_QUEUE, { queueId: 'q-beta' });
  });

  // T012a (FR-017) — the relocated `QueueControls` mount routes all four
  // handlers through this tier's own `queueId`, not `Dashboard.svelte`'s
  // removed optional-`queueId` branch. Pause is covered above; these three
  // cover the remaining handlers the mount wires up.
  it('resumes THIS queue when it is paused', async () => {
    const { getByTestId } = mount(
      buildSnapshot([task('waiting', { position: 0, status: 'pending' })], {
        lifecycle: 'operator-paused'
      })
    );

    await fireEvent.click(getByTestId('dashboard-queue-action'));

    expect(postCommandSpy).toHaveBeenCalledWith(CMD_RESUME_QUEUE, { queueId: 'q-beta' });
  });

  it('clears THIS queue’s completed Tasks', async () => {
    const { getByTestId } = mount(
      buildSnapshot([task('done', { position: 0, status: 'completed' })])
    );

    await fireEvent.click(getByTestId('dashboard-queue-clear-done'));

    expect(postCommandSpy).toHaveBeenCalledWith(CMD_CLEAR_COMPLETED);
  });

  it('cleans all of THIS queue’s finished and pending Tasks', async () => {
    const { getByTestId } = mount(
      buildSnapshot([task('done', { position: 0, status: 'completed' })])
    );

    await fireEvent.click(getByTestId('dashboard-queue-clean'));

    expect(postCommandSpy).toHaveBeenCalledWith(CMD_CLEAR_ALL);
  });

  it('disables Clear Done when this queue has no completed Tasks', () => {
    const { getByTestId } = mount(buildSnapshot([task('p', { status: 'pending' })]));

    expect((getByTestId('dashboard-queue-clear-done') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables Clear Done once this queue has a completed Task', () => {
    const { getByTestId } = mount(buildSnapshot([task('done', { status: 'completed' })]));

    expect((getByTestId('dashboard-queue-clear-done') as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables Clean All only when every reset surface is empty (FR-008 idle gate)', () => {
    const { getByTestId } = mount(buildSnapshot([]));

    expect((getByTestId('dashboard-queue-clean') as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    ['a pending Task', task('p', { status: 'pending' })],
    ['a failed Task', task('f', { status: 'failed' })],
    ['a canceled Task', task('c', { status: 'canceled' })]
  ])('enables Clean All when this queue has %s', (_label, oneTask) => {
    const { getByTestId } = mount(buildSnapshot([oneTask]));

    expect((getByTestId('dashboard-queue-clean') as HTMLButtonElement).disabled).toBe(false);
  });

  it('enables Clean All when this queue has an in-flight Task, even with nothing else to reset', () => {
    const { getByTestId } = mount(
      buildSnapshot([task('live', { status: 'in-flight' })], {
        inFlightRun: buildInFlightRun({ runId: 'live' })
      })
    );

    expect((getByTestId('dashboard-queue-clean') as HTMLButtonElement).disabled).toBe(false);
  });

  it('enables Clean All when this queue is paused, even with an otherwise empty queue', () => {
    const { getByTestId } = mount(buildSnapshot([], { lifecycle: 'operator-paused' }));

    expect((getByTestId('dashboard-queue-clean') as HTMLButtonElement).disabled).toBe(false);
  });

  it('enqueues added work onto THIS queue', async () => {
    const { getByTestId } = mount(buildSnapshot([]));

    await fireEvent.click(getByTestId('queue-composer-open'));
    const textarea = getByTestId('dashboard-queue-input-textarea');
    await fireEvent.input(textarea, { target: { value: 'ship the release' } });
    await fireEvent.click(getByTestId('dashboard-queue-input-submit'));

    expect(postCommandSpy).toHaveBeenCalledWith(
      CMD_START,
      expect.objectContaining({ description: 'ship the release', queueId: 'q-beta' })
    );
  });
});

// Feature 097 (T008, FR-009, data-model.md `ComposerVisibility`) — the add-work
// composer is closed by default and opened on demand, rather than permanently
// occupying the view.
describe('QueueDetailTier — on-demand composer (T008, FR-009)', () => {
  it('shows no composer form by default', () => {
    const { queryByTestId } = mount(buildSnapshot([]));

    expect(queryByTestId('queue-composer')).toBeNull();
    expect(queryByTestId('dashboard-queue-input-textarea')).toBeNull();
  });

  it('opens the composer on "Add work" and hides the trigger while it is open', async () => {
    const { getByTestId, queryByTestId } = mount(buildSnapshot([]));

    await fireEvent.click(getByTestId('queue-composer-open'));

    expect(getByTestId('queue-composer')).not.toBeNull();
    expect(queryByTestId('queue-composer-open')).toBeNull();
  });

  it('closes the composer once the submitted Task appears in this queue’s pending count', async () => {
    const { getByTestId, queryByTestId, rerender } = mount(buildSnapshot([]));

    await fireEvent.click(getByTestId('queue-composer-open'));
    await fireEvent.input(getByTestId('dashboard-queue-input-textarea'), {
      target: { value: 'ship the release' }
    });
    await fireEvent.click(getByTestId('dashboard-queue-input-submit'));

    expect(getByTestId('queue-composer')).not.toBeNull();

    // The host accepted the Task; the next snapshot poll reflects it in this
    // queue's pending count, which is the only signal the parent has, since
    // `QueueInputForm` posts its own submission command internally and exposes
    // no event-handler props (research.md R3).
    await rerender({ snapshot: buildSnapshot([task('new-task')]) });

    expect(queryByTestId('queue-composer')).toBeNull();
    expect(queryByTestId('queue-composer-open')).not.toBeNull();
  });

  it('closes the composer on a submission that lands after unrelated draining lowered the count', async () => {
    const { getByTestId, queryByTestId, rerender } = mount(
      buildSnapshot([task('a'), task('b'), task('c')])
    );

    await fireEvent.click(getByTestId('queue-composer-open'));
    expect(getByTestId('queue-composer')).not.toBeNull();

    // Unrelated: one of this queue's own pending Tasks starts executing while
    // the composer is open, independent of anything typed into it.
    await rerender({
      snapshot: buildSnapshot([task('a', { status: 'in-flight' }), task('b'), task('c')])
    });
    expect(getByTestId('queue-composer')).not.toBeNull();

    // The composer's own submission lands, restoring the pending count to its
    // open-time value (3) rather than exceeding it. A frozen open-time
    // baseline would read 3 > 3 as false and leave the composer open;
    // tracking the lowest point seen since open (2) instead reads 3 > 2 as
    // true and closes it.
    await rerender({
      snapshot: buildSnapshot([
        task('a', { status: 'in-flight' }),
        task('b'),
        task('c'),
        task('new-task')
      ])
    });

    expect(queryByTestId('queue-composer')).toBeNull();
    expect(queryByTestId('queue-composer-open')).not.toBeNull();
  });

  it('does not close the composer while this queue’s pending count is unchanged', async () => {
    const { getByTestId, rerender } = mount(buildSnapshot([]));

    await fireEvent.click(getByTestId('queue-composer-open'));
    // An unrelated snapshot poll — e.g. a different queue's task count moving —
    // must not be mistaken for this composer's own submission.
    await rerender({ snapshot: buildSnapshot([]) });

    expect(getByTestId('queue-composer')).not.toBeNull();
  });

  it('closes the composer on explicit cancel, without submitting anything', async () => {
    const { getByTestId, queryByTestId } = mount(buildSnapshot([]));

    await fireEvent.click(getByTestId('queue-composer-open'));
    await fireEvent.input(getByTestId('dashboard-queue-input-textarea'), {
      target: { value: 'discard me' }
    });
    await fireEvent.click(getByTestId('queue-composer-cancel'));

    expect(queryByTestId('queue-composer')).toBeNull();
    expect(queryByTestId('queue-composer-open')).not.toBeNull();
    expect(postCommandSpy).not.toHaveBeenCalledWith(CMD_START, expect.anything());
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

  it('exposes every row as a single labeled, focusable button — run rows and Task rows alike (BUG-003)', () => {
    const { getByTestId } = mount(
      buildSnapshot(
        [task('solo', { position: 0, status: 'pending' }), task('member', { position: 1 })],
        { connectedRuns: [connectedRun('cr-1', ['member'])] }
      )
    );

    const rows = Array.from(getByTestId('queue-detail-rows').querySelectorAll('[data-row-key]'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tagName, `row ${row.getAttribute('data-row-key')} must be its own button`).toBe('BUTTON');
      expect(row.getAttribute('type')).toBe('button');
      expect(row.getAttribute('aria-label')).toBeTruthy();
      // Interactive content does not nest — the pending Task's move <select>
      // sits beside this button as a sibling, never inside it.
      expect(row.querySelector('select, button, a')).toBeNull();
    }
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

  // Feature 097 (T003, T005) — Dashboard is no longer embedded, so the tier's
  // own root is now the one <main> landmark rather than a pane it mounts.
  it('renders exactly one <main> landmark — its own', () => {
    const { container, getByTestId } = mount(buildSnapshot([]));

    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect(getByTestId('queue-detail-tier').tagName).toBe('MAIN');
  });
});

// Feature 095 (T018, US1, FR-002 to FR-005) — the delete control.
describe('QueueDetailTier — deleting a queue (US1)', () => {
  it('probes unconfirmed, confirms with the host impact, then deletes confirmed', async () => {
    const { getByTestId } = mount(buildSnapshot([task('a')]));

    await fireEvent.click(getByTestId('queue-delete'));

    // The first post carries no `confirmed` flag: it asks what the delete costs.
    expect(postCommandSpy).toHaveBeenCalledTimes(1);
    expect(postCommandSpy).toHaveBeenNthCalledWith(1, CMD_DELETE_QUEUE, { queueId: 'q-beta' });

    ack(0, 'rejected', 'confirmation-required', DELETE_IMPACT);
    await vi.waitFor(() => expect(useConfirm).toHaveBeenCalledTimes(1));

    // FR-004 — the counts are the host's, not a fold over the snapshot, which
    // here reports one pending Task and no connected runs.
    expect(vi.mocked(useConfirm).mock.calls[0]![0]).toBe('queue.delete');
    expect(vi.mocked(useConfirm).mock.calls[0]![1]).toMatchObject({
      context: { queueName: 'nightly', pendingTaskCount: 9, connectedRunCount: 2 }
    });

    await vi.waitFor(() => expect(postCommandSpy).toHaveBeenCalledTimes(2));
    expect(postCommandSpy).toHaveBeenNthCalledWith(2, CMD_DELETE_QUEUE, {
      queueId: 'q-beta',
      confirmed: true
    });
  });

  it('posts nothing further when the operator declines', async () => {
    vi.mocked(useConfirm).mockResolvedValueOnce(false);
    const onBack = vi.fn();
    const { getByTestId } = mount(buildSnapshot([]), { onBack });

    await fireEvent.click(getByTestId('queue-delete'));
    ack(0, 'rejected', 'confirmation-required', DELETE_IMPACT);
    await vi.waitFor(() => expect(useConfirm).toHaveBeenCalledTimes(1));

    expect(postCommandSpy).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
  });

  it('returns to the queue list once the deletion is accepted (FR-005)', async () => {
    const onBack = vi.fn();
    const { getByTestId } = mount(buildSnapshot([]), { onBack });

    await fireEvent.click(getByTestId('queue-delete'));
    ack(0, 'rejected', 'confirmation-required', DELETE_IMPACT);
    await vi.waitFor(() => expect(postCommandSpy).toHaveBeenCalledTimes(2));
    ack(1, 'accepted');

    await vi.waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
  });

  it('disables the control with a stated reason on the default queue (FR-003)', () => {
    const { getByTestId } = mount(buildSnapshot([]), { queueId: 'default' });

    expect((getByTestId('queue-delete') as HTMLButtonElement).disabled).toBe(true);
    expect(getByTestId('queue-delete-disabled-reason').textContent).toMatch(/default queue/i);
  });

  it('leaves the control live on a non-default queue', () => {
    const { getByTestId, queryByTestId } = mount(buildSnapshot([]));

    expect((getByTestId('queue-delete') as HTMLButtonElement).disabled).toBe(false);
    expect(queryByTestId('queue-delete-disabled-reason')).toBeNull();
  });

  it('surfaces a refusal that arrives ahead of the confirmation gate', async () => {
    const { getByTestId, queryByTestId } = mount(buildSnapshot([]));

    await fireEvent.click(getByTestId('queue-delete'));
    // `QueueManager.queueDeletionImpact` emits this code; `queue-refusal-vocabulary.test.ts`
    // pins the pairing. The spec's name for it — `in-flight-task` — is not a code.
    ack(0, 'rejected', 'queue-has-in-flight-task');

    await vi.waitFor(() =>
      expect(getByTestId('queue-control-refusal').textContent).toMatch(/in flight/i)
    );
    expect(useConfirm).not.toHaveBeenCalled();
    expect(queryByTestId('queue-delete-disabled-reason')).toBeNull();
  });
});

// Feature 095 (T034, US4, FR-015, FR-016) — moving a pending Task.
describe('QueueDetailTier — moving a pending Task (US4)', () => {
  it('posts the Task and its target queue and no position (FR-016)', async () => {
    const { getByTestId } = mount(buildSnapshot([task('waiting')]));

    await fireEvent.change(getByTestId('queue-task-move-waiting'), {
      target: { value: 'default' }
    });

    expect(postCommandSpy).toHaveBeenCalledWith(CMD_MOVE_TASK, {
      taskId: 'waiting',
      targetQueueId: 'default'
    });
    const payload = postCommandSpy.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(payload)).not.toContain('position');
  });

  it('offers every other queue and never the source queue (FR-015)', () => {
    const { getByTestId } = mount(buildSnapshot([task('waiting')]));

    const options = Array.from(
      (getByTestId('queue-task-move-waiting') as HTMLSelectElement).options
    ).map((option) => option.value);

    expect(options).toEqual(['', 'default']);
  });

  it('omits the control for a Task that is no longer pending', () => {
    const { queryByTestId } = mount(
      buildSnapshot([
        task('live', { position: 0, status: 'in-flight' }),
        task('done', { position: 1, status: 'completed' })
      ])
    );

    expect(queryByTestId('queue-task-move-live')).toBeNull();
    expect(queryByTestId('queue-task-move-done')).toBeNull();
  });

  it('surfaces the connected-run-child refusal', async () => {
    const { getByTestId } = mount(buildSnapshot([task('waiting')]));

    await fireEvent.change(getByTestId('queue-task-move-waiting'), {
      target: { value: 'default' }
    });
    // `QueueManager.moveTask`'s code for it.
    ack(0, 'rejected', 'task-bound-to-connected-run');

    await vi.waitFor(() =>
      expect(getByTestId('queue-control-refusal').textContent).toMatch(/connected run/i)
    );
  });

  it('posts nothing when the operator re-picks the placeholder', async () => {
    const { getByTestId } = mount(buildSnapshot([task('waiting')]));

    await fireEvent.change(getByTestId('queue-task-move-waiting'), { target: { value: '' } });

    expect(postCommandSpy).not.toHaveBeenCalled();
  });
});

// Feature 030 (US2, T034) reorder, restored onto QueueDetailRows after code
// review found the FR-047 collapsed-row rewrite (features 095/097) carried
// the move-to-queue select over but dropped the drag handle and the up/down
// buttons, along with their only mount site (`QueueItem.svelte`, orphaned by
// the same rewrite). Assertions mirror QueueItem.reorder.test.ts's shape for
// the same capability, adapted to the fact every row here shares one
// component instance rather than one `QueueItem` per row.
describe('QueueDetailTier — reordering a pending Task (US2, feature 030)', () => {
  it('renders a drag handle and up/down buttons for a pending Task', () => {
    const { getByTestId } = mount(buildSnapshot([task('waiting')]));

    expect(getByTestId('queue-task-drag-handle-waiting')).toBeTruthy();
    expect(getByTestId('queue-task-reorder-up-waiting')).toBeTruthy();
    expect(getByTestId('queue-task-reorder-down-waiting')).toBeTruthy();
  });

  it('omits reorder controls for a Task that is no longer pending', () => {
    const { queryByTestId } = mount(buildSnapshot([task('live', { status: 'in-flight' })]));

    expect(queryByTestId('queue-task-drag-handle-live')).toBeNull();
    expect(queryByTestId('queue-task-reorder-up-live')).toBeNull();
    expect(queryByTestId('queue-task-reorder-down-live')).toBeNull();
  });

  it('withholds reorder controls in a non-primary window (FR-065)', () => {
    const { queryByTestId } = mount(buildSnapshot([task('waiting')]), { isPrimary: false });

    expect(queryByTestId('queue-task-drag-handle-waiting')).toBeNull();
    expect(queryByTestId('queue-task-reorder-up-waiting')).toBeNull();
    expect(queryByTestId('queue-task-reorder-down-waiting')).toBeNull();
  });

  it('is not draggable until its handle is pressed, and disarms on release', async () => {
    const { getByTestId } = mount(buildSnapshot([task('waiting')]));
    const handle = getByTestId('queue-task-drag-handle-waiting');
    const wrap = handle.parentElement as HTMLElement;

    expect(wrap.getAttribute('draggable')).toBe('false');

    await fireEvent.mouseDown(handle);
    expect(wrap.getAttribute('draggable')).toBe('true');

    await fireEvent.mouseUp(handle);
    expect(wrap.getAttribute('draggable')).toBe('false');
  });

  it('disarms on dragend without a release', async () => {
    const { getByTestId } = mount(buildSnapshot([task('waiting')]));
    const handle = getByTestId('queue-task-drag-handle-waiting');
    const wrap = handle.parentElement as HTMLElement;

    await fireEvent.mouseDown(handle);
    await fireEvent.dragEnd(wrap);

    expect(wrap.getAttribute('draggable')).toBe('false');
  });

  it('dropping an armed drag onto another row posts CMD_REORDER_TASK at the target position', async () => {
    const { getByTestId } = mount(
      buildSnapshot([task('source', { position: 0 }), task('target', { position: 1 })])
    );

    const handle = getByTestId('queue-task-drag-handle-source');
    const targetWrap = getByTestId('queue-task-row-target').parentElement as HTMLElement;

    await fireEvent.mouseDown(handle);
    await fireEvent.drop(targetWrap, { dataTransfer: { getData: () => 'source' } });

    expect(postCommandSpy).toHaveBeenCalledWith(CMD_REORDER_TASK, {
      taskId: 'source',
      newPosition: 1
    });
  });

  it('dropping onto its own row is a no-op', async () => {
    const { getByTestId } = mount(buildSnapshot([task('waiting')]));
    const handle = getByTestId('queue-task-drag-handle-waiting');
    const wrap = handle.parentElement as HTMLElement;

    await fireEvent.mouseDown(handle);
    await fireEvent.drop(wrap, { dataTransfer: { getData: () => 'waiting' } });

    expect(postCommandSpy).not.toHaveBeenCalledWith(CMD_REORDER_TASK, expect.anything());
  });

  it('clicking the up arrow posts CMD_MOVE_QUEUE_ITEM_UP for that Task', async () => {
    const { getByTestId } = mount(buildSnapshot([task('waiting')]));

    await fireEvent.click(getByTestId('queue-task-reorder-up-waiting'));

    expect(postCommandSpy).toHaveBeenCalledWith(CMD_MOVE_QUEUE_ITEM_UP, { id: 'waiting' });
  });

  it('clicking the down arrow posts CMD_MOVE_QUEUE_ITEM_DOWN for that Task', async () => {
    const { getByTestId } = mount(buildSnapshot([task('waiting')]));

    await fireEvent.click(getByTestId('queue-task-reorder-down-waiting'));

    expect(postCommandSpy).toHaveBeenCalledWith(CMD_MOVE_QUEUE_ITEM_DOWN, { id: 'waiting' });
  });

  it('surfaces a refusal when the host rejects a reorder', async () => {
    const { getByTestId } = mount(buildSnapshot([task('waiting')]));

    await fireEvent.click(getByTestId('queue-task-reorder-up-waiting'));
    ack(0, 'rejected', 'timeout');

    await vi.waitFor(() =>
      expect(getByTestId('queue-control-refusal').textContent).toMatch(/did not answer/i)
    );
  });
});

// Feature 097 (T004, T005, FR-003, FR-004, FR-005/SC-002, FR-010/SC-003) — the
// Task row surfaces its own Pipeline, phase progress, timing, retry count and
// last error, each derived from that row's own Task only.
describe('QueueDetailTier — Task row surfaces its own detail', () => {
  it('resolves the Task’s Pipeline by name, never by id (FR-010)', () => {
    const { getByTestId } = mount(buildSnapshot([task('a', { currentPipelineId: 'standard' })]));

    expect(getByTestId('queue-task-pipeline-a').textContent).toContain('Standard');
  });

  it('falls back to a labeled placeholder for an unresolved Pipeline, never the raw id (FR-010)', () => {
    const { getByTestId } = mount(
      buildSnapshot([task('a', { currentPipelineId: 'deleted-pipeline' })])
    );

    const text = getByTestId('queue-task-pipeline-a').textContent ?? '';
    expect(text).toMatch(/unknown pipeline/i);
    expect(text).not.toContain('deleted-pipeline');
  });

  it('counts phase completion against the Task’s own resolved Pipeline (FR-003)', () => {
    const { getByTestId } = mount(
      buildSnapshot(
        [task('a', { currentPipelineId: 'standard', currentPhase: 'speckit-plan' })],
        {
          pipelines: [
            { id: 'standard', name: 'Standard', phases: ['speckit-specify', 'speckit-plan', 'speckit-tasks'] }
          ]
        }
      )
    );

    expect(getByTestId('queue-task-progress-a').textContent).toContain('1/3');
  });

  it('shows elapsed time once a Task has started, waiting time before then (FR-004)', () => {
    const { getByTestId } = mount(
      buildSnapshot([
        task('started', { startedAt: '2026-08-12T00:00:00.000Z' }),
        task('waiting', { startedAt: null })
      ])
    );

    expect(getByTestId('queue-task-timing-started').textContent).toMatch(/elapsed/i);
    expect(getByTestId('queue-task-timing-waiting').textContent).toMatch(/waiting/i);
  });

  it('shows a retry count only once the Task has retried', () => {
    const { getByTestId, queryByTestId } = mount(
      buildSnapshot([task('retried', { retryCount: 2 }), task('fresh', { retryCount: 0 })])
    );

    expect(getByTestId('queue-task-retry-retried').textContent).toContain('2');
    expect(queryByTestId('queue-task-retry-fresh')).toBeNull();
  });

  it('shows the last error only once the Task has one', () => {
    const { getByTestId, queryByTestId } = mount(
      buildSnapshot([
        task('failed', { lastErrorSummary: 'exit code 1' }),
        task('clean', { lastErrorSummary: null })
      ])
    );

    expect(getByTestId('queue-task-error-failed').textContent).toContain('exit code 1');
    expect(queryByTestId('queue-task-error-clean')).toBeNull();
  });

  it('derives a non-executing row’s progress and timing from its own Task only, never a sibling’s (FR-005, SC-002)', () => {
    const { getByTestId } = mount(
      buildSnapshot(
        [
          task('live', {
            position: 0,
            status: 'in-flight',
            currentPipelineId: 'standard',
            currentPhase: 'speckit-tasks',
            startedAt: '2026-08-12T00:00:00.000Z'
          }),
          task('waiting', {
            position: 1,
            status: 'pending',
            currentPipelineId: 'standard',
            currentPhase: null,
            startedAt: null
          })
        ],
        {
          pipelines: [
            { id: 'standard', name: 'Standard', phases: ['speckit-specify', 'speckit-plan', 'speckit-tasks'] }
          ]
        }
      )
    );

    // The executing Task is two phases in; the still-pending Task must read as
    // having completed none of its own — not the executing Task's count.
    expect(getByTestId('queue-task-progress-live').textContent).toContain('2/3');
    expect(getByTestId('queue-task-progress-waiting').textContent).toContain('0/3');
    expect(getByTestId('queue-task-timing-live').textContent).toMatch(/elapsed/i);
    expect(getByTestId('queue-task-timing-waiting').textContent).toMatch(/waiting/i);
  });
});

describe('QueueDetailTier — empty queue (Edge Case)', () => {
  it('renders an empty state rather than stale or placeholder rows', () => {
    const { getByTestId, queryByTestId } = mount(buildSnapshot([]));

    expect(getByTestId('queue-detail-empty').textContent).toContain('no work yet');
    expect(queryByTestId('queue-task-row-a')).toBeNull();
  });
});

describe('QueueDetailTier — read-only in a non-primary window (FR-065)', () => {
  it('withholds the configuration affordance', () => {
    const { queryByTestId } = mount(buildSnapshot([]), { isPrimary: false });

    expect(queryByTestId('queue-config-open')).toBeNull();
  });

  // Feature 095 — the delete and move controls are mutations, so they
  // observe the same rule the pre-existing configuration affordance does.
  // The registry-schedule control this test used to also cover is gone
  // (feature 097, T012); the idle-pending affordance that now shares this
  // tier's chrome has its own isPrimary coverage below.
  it('withholds the delete and move controls', () => {
    const { queryByTestId } = mount(buildSnapshot([task('waiting')]), { isPrimary: false });

    expect(queryByTestId('queue-delete')).toBeNull();
    expect(queryByTestId('queue-task-move-waiting')).toBeNull();
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

// Feature 097 (T012a) — the idle-pending start affordance now shares this
// tier's chrome. `QueueIdlePendingPanel` reads the *default* queue's own
// projection (a pre-existing limitation carried forward unmodified, see the
// component's own header comment) and carries no isPrimary prop of its own;
// gating is entirely the mount decision made here.
describe('QueueDetailTier — mounts the idle-pending affordance (T012a)', () => {
  function idlePendingSnapshot(): WorkflowSnapshot {
    const base = buildSnapshot([]);
    return {
      ...base,
      queue: { ...base.queue, lifecycle: 'idle-pending', scheduledStartAt: null }
    } as WorkflowSnapshot;
  }

  it('shows the idle-pending start affordance when the default queue is idle-pending', () => {
    const { getByTestId } = mount(idlePendingSnapshot());

    expect(getByTestId('idle-pending-start-queue-button')).not.toBeNull();
  });

  it('withholds the idle-pending affordance in a non-primary window', () => {
    const { queryByTestId } = mount(idlePendingSnapshot(), { isPrimary: false });

    expect(queryByTestId('idle-pending-start-queue-button')).toBeNull();
  });
});
