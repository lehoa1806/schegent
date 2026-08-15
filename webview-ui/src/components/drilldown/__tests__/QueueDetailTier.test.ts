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
  CMD_CLEAR_QUEUE_SCHEDULE,
  CMD_DELETE_QUEUE,
  CMD_MOVE_TASK,
  CMD_PAUSE_QUEUE,
  CMD_RENAME_QUEUE,
  CMD_SET_QUEUE_SCHEDULE,
  CMD_START
} from '../../../lib/messages';
import { buildQueueRuntime } from '../../../lib/__tests__/queue-runtime-fixture';
import { snapshotStore } from '../../../lib/snapshot-store.svelte';
import { useConfirm } from '../../../lib/use-confirm';
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

function summary(
  id: string,
  name: string,
  position: number,
  schedule: QueueSummary['schedule'] = null
): QueueSummary {
  return {
    id,
    name,
    position,
    state: 'active',
    pauseSource: null,
    schedule,
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
    /** Feature 095 — `q-beta`'s registry schedule, the US2 mechanism. */
    readonly betaSchedule?: QueueSummary['schedule'];
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
      queues: Object.freeze([
        summary('default', 'Default', 0),
        summary('q-beta', 'nightly', 1, overrides.betaSchedule ?? null)
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

const ARMED = Object.freeze({
  expression: 'in 2 hours',
  kind: 'relative' as const,
  targetAt: '2026-08-12T02:00:00.000Z'
});

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

// Feature 095 (T023, US2, FR-006 to FR-009) — the queue's registry schedule.
describe('QueueDetailTier — arming a scheduled start (US2)', () => {
  it('sends the operator’s expression verbatim, with no local parsing (FR-007)', async () => {
    const { getByTestId } = mount(buildSnapshot([]));

    await fireEvent.input(getByTestId('queue-schedule-expression'), {
      target: { value: '  every other Tuesday at 14:00  ' }
    });
    await fireEvent.click(getByTestId('queue-schedule-arm'));

    expect(postCommandSpy).toHaveBeenCalledWith(CMD_SET_QUEUE_SCHEDULE, {
      queueId: 'q-beta',
      expression: 'every other Tuesday at 14:00'
    });
    // Nothing derived travels with it: no target instant, no parsed kind.
    const payload = postCommandSpy.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['expression', 'queueId']);
  });

  it('renders the armed expression and target for a queue whose lifecycle is running', () => {
    const { getByTestId } = mount(
      buildSnapshot([], { lifecycle: 'running', betaSchedule: ARMED })
    );

    expect(getByTestId('queue-schedule-armed').textContent).toContain('in 2 hours');
    const target = getByTestId('queue-schedule-target').textContent ?? '';
    // Formatted, not the raw ISO string the projection carries.
    expect(target).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(target).not.toContain('T02:00:00.000Z');
  });

  it('renders no armed state and offers no disarm when the queue carries no schedule', () => {
    const { getByTestId, queryByTestId } = mount(buildSnapshot([]));

    expect(queryByTestId('queue-schedule-armed')).toBeNull();
    expect(queryByTestId('queue-schedule-disarm')).toBeNull();
    expect(getByTestId('queue-schedule-arm').textContent).toContain('Arm');
  });

  it('re-arms an armed queue with a plain arm, never a clear-then-set', async () => {
    const { getByTestId } = mount(buildSnapshot([], { betaSchedule: ARMED }));

    await fireEvent.input(getByTestId('queue-schedule-expression'), {
      target: { value: 'at 09:00' }
    });
    await fireEvent.click(getByTestId('queue-schedule-arm'));

    expect(postCommandSpy).toHaveBeenCalledTimes(1);
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_SET_QUEUE_SCHEDULE, {
      queueId: 'q-beta',
      expression: 'at 09:00'
    });
  });

  it('disarms an armed queue', async () => {
    const { getByTestId } = mount(buildSnapshot([], { betaSchedule: ARMED }));

    await fireEvent.click(getByTestId('queue-schedule-disarm'));

    expect(postCommandSpy).toHaveBeenCalledWith(CMD_CLEAR_QUEUE_SCHEDULE, { queueId: 'q-beta' });
  });

  it('surfaces an unparseable-expression refusal (FR-008)', async () => {
    const { getByTestId } = mount(buildSnapshot([]));

    await fireEvent.input(getByTestId('queue-schedule-expression'), {
      target: { value: 'whenever' }
    });
    await fireEvent.click(getByTestId('queue-schedule-arm'));
    // What `parseSchedule` answers for text it cannot match to any form.
    ack(0, 'rejected', 'unrecognized-format');

    await vi.waitFor(() =>
      expect(getByTestId('queue-control-refusal').textContent).toMatch(/could not be read/i)
    );
  });

  it('posts nothing for an empty expression', async () => {
    const { getByTestId } = mount(buildSnapshot([]));

    await fireEvent.input(getByTestId('queue-schedule-expression'), { target: { value: '   ' } });
    await fireEvent.click(getByTestId('queue-schedule-arm'));

    expect(postCommandSpy).not.toHaveBeenCalled();
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

describe('QueueDetailTier — read-only in a non-primary window (FR-065)', () => {
  it('withholds the configuration affordance', () => {
    const { queryByTestId } = mount(buildSnapshot([]), { isPrimary: false });

    expect(queryByTestId('queue-config-open')).toBeNull();
  });

  // Feature 095 — the three new controls are mutations, so they observe the
  // same rule the pre-existing configuration affordance does.
  it('withholds the delete, schedule and move controls', () => {
    const { queryByTestId } = mount(buildSnapshot([task('waiting')]), { isPrimary: false });

    expect(queryByTestId('queue-delete')).toBeNull();
    expect(queryByTestId('queue-schedule')).toBeNull();
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
