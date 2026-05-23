// Feature 065 (T051 / FR-018 / Q6) — idle-pending Start queue affordance.
//
// QueueListView must surface the idle-pending UI surface correctly:
//   (1) The lifecycle indicator labels the state as "idle-pending" (or an
//       equivalent operator-facing string).
//   (2) When `scheduledStartAt != null`, `ScheduledStartIndicator` is
//       rendered (countdown + Cancel/Change/Start now actions live there).
//   (3) When `scheduledStartAt === null`, a "Start queue" button renders.
//   (4) Clicking "Start queue" opens the chooser in
//       `idle-pending-restart` mode.
//   (5) The chooser commit applies the schedule once-to-the-queue (per
//       Q6 / FR-018), NOT per-task — assert by rendering with 3 pending
//       tasks and verifying a single `CMD_START_QUEUE` dispatch.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import QueueListView from '../QueueListView.svelte';
import { snapshotStore } from '../../lib/snapshot-store.svelte';
import { STATE_SNAPSHOT, CMD_START_QUEUE } from '../../lib/messages';
import type {
  WorkflowSnapshot,
  QueueProjection,
  QueueItem
} from '../../lib/snapshot-types';

vi.mock('../../lib/reorder-task', () => ({
  postReorderTask: vi.fn()
}));

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'test-correlation' })),
  acquireVsCodeApi: vi.fn(() => null)
}));

vi.mock('../../lib/use-confirm', () => ({
  useConfirm: vi.fn(async () => true),
  isModalOpen: () => false
}));

function makeQueue(partial: Partial<QueueProjection>): QueueProjection {
  return {
    inFlight: null,
    pending: [],
    recent: [],
    orderedItems: [],
    paused: false,
    ...partial
  };
}

function makeSnapshot(queue: Partial<QueueProjection>): WorkflowSnapshot {
  return {
    schemaVersion: 3,
    isPrimary: true,
    status: 'idle',
    activeFeature: null,
    phases: [],
    queue: makeQueue(queue)
  } as unknown as unknown as WorkflowSnapshot;
}

function makeItem(id: string, position: number): QueueItem {
  return {
    id,
    label: `Task ${id}`,
    status: 'pending',
    position,
    enqueuedAt: new Date(1_700_000_000_000 + position * 1000).toISOString()
  } as unknown as QueueItem;
}

beforeEach(() => {
  snapshotStore.apply({
    type: STATE_SNAPSHOT,
    payload: makeSnapshot({ lifecycle: 'active-empty' })
  } as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('QueueListView — idle-pending Start queue affordance (FR-018 / Q6)', () => {
  it('(1) labels the lifecycle as idle-pending', async () => {
    snapshotStore.apply({
      type: STATE_SNAPSHOT,
      payload: makeSnapshot({ lifecycle: 'idle-pending' })
    } as never);

    const { queryByTestId } = render(QueueListView, {
      props: {
        orderedItems: [],
        isPrimary: true,
        selectedTaskId: null,
        onTaskSelect: () => undefined
      }
    });

    const labelEl = queryByTestId('queue-lifecycle-label');
    expect(labelEl).not.toBeNull();
    expect(labelEl!.getAttribute('data-lifecycle')).toBe('idle-pending');
    // The text need only be non-empty — the lifecycle-label test asserts
    // pairwise distinctness; here we just verify the wiring.
    expect((labelEl!.textContent ?? '').trim().length).toBeGreaterThan(0);
  });

  it('(2) renders ScheduledStartIndicator when scheduledStartAt != null', async () => {
    snapshotStore.apply({
      type: STATE_SNAPSHOT,
      payload: makeSnapshot({
        lifecycle: 'idle-pending',
        scheduledStartAt: 1_700_000_060_000,
        scheduledStartSource: 'operator-chooser'
      })
    } as never);

    const { queryByTestId } = render(QueueListView, {
      props: {
        orderedItems: [],
        isPrimary: true,
        selectedTaskId: null,
        onTaskSelect: () => undefined
      }
    });

    expect(queryByTestId('idle-pending-scheduled-host')).not.toBeNull();
    expect(queryByTestId('scheduled-start-countdown')).not.toBeNull();
    // The Start queue button must NOT render when a schedule is armed.
    expect(queryByTestId('idle-pending-start-queue-button')).toBeNull();
  });

  it('(3) renders Start queue button when scheduledStartAt === null', async () => {
    snapshotStore.apply({
      type: STATE_SNAPSHOT,
      payload: makeSnapshot({
        lifecycle: 'idle-pending',
        scheduledStartAt: null,
        scheduledStartSource: null
      })
    } as never);

    const { queryByTestId } = render(QueueListView, {
      props: {
        orderedItems: [],
        isPrimary: true,
        selectedTaskId: null,
        onTaskSelect: () => undefined
      }
    });

    const startBtn = queryByTestId('idle-pending-start-queue-button');
    expect(startBtn).not.toBeNull();
    // The ScheduledStartIndicator host must NOT render when there is no
    // armed schedule.
    expect(queryByTestId('idle-pending-scheduled-host')).toBeNull();
  });

  it('(4) clicking Start queue opens the chooser in idle-pending-restart mode', async () => {
    snapshotStore.apply({
      type: STATE_SNAPSHOT,
      payload: makeSnapshot({
        lifecycle: 'idle-pending',
        scheduledStartAt: null
      })
    } as never);

    const { queryByTestId } = render(QueueListView, {
      props: {
        orderedItems: [],
        isPrimary: true,
        selectedTaskId: null,
        onTaskSelect: () => undefined
      }
    });

    const startBtn = queryByTestId('idle-pending-start-queue-button') as HTMLButtonElement | null;
    expect(startBtn).not.toBeNull();
    await fireEvent.click(startBtn!);
    await tick();

    // After click: chooser host should be visible, the button should
    // disappear, and the chooser should render in restart mode (the
    // restart-mode chooser exposes the `start-mode-chooser-cancel-schedule`
    // affordance — the empty-enqueue mode does NOT).
    expect(queryByTestId('idle-pending-chooser-host')).not.toBeNull();
    expect(queryByTestId('start-mode-chooser')).not.toBeNull();
    expect(queryByTestId('start-mode-chooser-cancel-schedule')).not.toBeNull();
    expect(queryByTestId('idle-pending-start-queue-button')).toBeNull();
  });

  it('(5) chooser commit dispatches a SINGLE CMD_START_QUEUE for the whole queue even with 3 pending tasks', async () => {
    const vscodeApi = await import('../../lib/vscode-api');
    const postCommandMock = vi.mocked(vscodeApi.postCommand);
    postCommandMock.mockClear();

    snapshotStore.apply({
      type: STATE_SNAPSHOT,
      payload: makeSnapshot({
        lifecycle: 'idle-pending',
        scheduledStartAt: null
      })
    } as never);

    const items: readonly QueueItem[] = [
      makeItem('task-1', 0),
      makeItem('task-2', 1),
      makeItem('task-3', 2)
    ];

    const { queryByTestId } = render(QueueListView, {
      props: {
        orderedItems: items,
        isPrimary: true,
        selectedTaskId: null,
        onTaskSelect: () => undefined
      }
    });

    const startBtn = queryByTestId('idle-pending-start-queue-button') as HTMLButtonElement | null;
    expect(startBtn).not.toBeNull();
    await fireEvent.click(startBtn!);
    await tick();

    // Click the "Start now" affordance inside the chooser — this fires the
    // chooser's `onCommit` with `startMode: 'now'`.
    const startNow = queryByTestId('start-mode-chooser-now') as HTMLButtonElement | null;
    expect(startNow).not.toBeNull();
    await fireEvent.click(startNow!);
    await tick();

    // Per Q6 / FR-018: exactly ONE CMD_START_QUEUE dispatch for the entire
    // queue (not per-task) regardless of how many pending items are in the
    // list.
    const startQueueCalls = postCommandMock.mock.calls.filter(
      (call) => call[0] === CMD_START_QUEUE
    );
    expect(startQueueCalls.length).toBe(1);

    const [, payload] = startQueueCalls[0] as unknown as [string, { startIntent: { startMode: string; source: string } }];
    expect(payload.startIntent.startMode).toBe('now');
    expect(payload.startIntent.source).toBe('operator-restart');
  });
});
