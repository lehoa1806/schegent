// Feature 030 T029 (US2) — webview unit test for the reorder UX on
// `QueueItem.svelte`.
//
// Assertions:
//   1. Mounting with a pending task renders a drag handle.
//   2. Mounting with a pending task renders up/down arrow buttons.
//   3. Clicking the up arrow dispatches CMD_MOVE_QUEUE_ITEM_UP via the
//      shared helper.
//   4. Mounting with an in-flight task renders NO drag handle and NO
//      up/down arrow buttons.
//
// The component routes through the shared helper at
// `webview-ui/src/lib/reorder-task.ts`; we mock that module so the test
// asserts the function call shape without going through postCommand.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import QueueItem from '../QueueItem.svelte';
import type { QueueItem as QueueItemSnapshot } from '../../lib/snapshot-types';

const postReorderTaskSpy = vi.fn();
const postMoveItemUpSpy = vi.fn();
const postMoveItemDownSpy = vi.fn();

vi.mock('../../lib/reorder-task', () => ({
  postReorderTask: (...args: unknown[]) => postReorderTaskSpy(...args),
  postMoveItemUp: (...args: unknown[]) => postMoveItemUpSpy(...args),
  postMoveItemDown: (...args: unknown[]) => postMoveItemDownSpy(...args)
}));

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'corr-stub' }))
}));

vi.mock('../../lib/snapshot-store.svelte', () => ({
  snapshotStore: {
    isPrimary: true,
    queue: {
      queues: [
        {
          id: 'default',
          name: 'Default queue',
          position: 0,
          state: 'active',
          schedule: null,
          taskCount: 1
        }
      ]
    },
    queues: [
      {
        id: 'default',
        name: 'Default queue',
        position: 0,
        state: 'active',
        schedule: null,
        taskCount: 1
      }
    ],
    markPending: vi.fn(),
    onceAck: vi.fn()
  }
}));

beforeEach(() => {
  postReorderTaskSpy.mockReset();
  postMoveItemUpSpy.mockReset();
  postMoveItemDownSpy.mockReset();
});
afterEach(() => cleanup());

function item(overrides: Partial<QueueItemSnapshot> = {}): QueueItemSnapshot {
  return {
    id: 'task-1',
    label: 'Reorder candidate',
    enqueuedAt: '2026-05-10T11:00:00.000Z',
    startedAt: null,
    updatedAt: '2026-05-10T11:00:00.000Z',
    completedAt: null,
    status: 'pending',
    retryCount: 0,
    lastErrorSummary: null,
    pausedReason: null,
    currentPhase: null,
    queueId: 'default',
    position: 0,
    pauseCause: null,
    ...overrides
  };
}

describe('Feature 030 (US2, T029) — QueueItem reorder affordances', () => {
  it('renders a drag handle for a pending task', () => {
    const { getByTestId } = render(QueueItem, {
      props: { item: item() }
    });
    expect(getByTestId('queue-item-drag-handle-task-1')).toBeTruthy();
  });

  it('renders up and down arrow buttons for a pending task', () => {
    const { getByTestId } = render(QueueItem, {
      props: { item: item() }
    });
    const upBtn = getByTestId('queue-item-reorder-up-task-1');
    const downBtn = getByTestId('queue-item-reorder-down-task-1');
    expect(upBtn).toBeTruthy();
    expect(downBtn).toBeTruthy();
    // Real <button> elements — keyboard-accessible by default.
    expect(upBtn.tagName).toBe('BUTTON');
    expect(downBtn.tagName).toBe('BUTTON');
  });

  it('clicking the up arrow dispatches postMoveItemUp via the shared helper', async () => {
    const { getByTestId } = render(QueueItem, {
      props: { item: item() }
    });
    await fireEvent.click(getByTestId('queue-item-reorder-up-task-1'));
    expect(postMoveItemUpSpy).toHaveBeenCalledTimes(1);
    expect(postMoveItemUpSpy).toHaveBeenCalledWith('task-1');
  });

  it('clicking the down arrow dispatches postMoveItemDown via the shared helper', async () => {
    const { getByTestId } = render(QueueItem, {
      props: { item: item() }
    });
    await fireEvent.click(getByTestId('queue-item-reorder-down-task-1'));
    expect(postMoveItemDownSpy).toHaveBeenCalledTimes(1);
    expect(postMoveItemDownSpy).toHaveBeenCalledWith('task-1');
  });

  it('does NOT render drag handle / up / down for an in-flight task', () => {
    const { queryByTestId } = render(QueueItem, {
      props: { item: item({ status: 'in-flight' }) }
    });
    expect(queryByTestId('queue-item-drag-handle-task-1')).toBeNull();
    expect(queryByTestId('queue-item-reorder-up-task-1')).toBeNull();
    expect(queryByTestId('queue-item-reorder-down-task-1')).toBeNull();
  });
});
