import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import QueueItem from '../QueueItem.svelte';
// Feature 030 (US3, T045) — the move-task command was removed alongside
// the multi-queue surfaces. The per-row "Move to another queue"
// affordance no longer exists; the test that exercised it has been
// deleted. The lint regression at
// `tests/lint/no-multi-queue-commands.test.ts` pins this discipline.
import { CMD_MODIFY_TASK } from '../../lib/messages';
import type { QueueItem as QueueItemSnapshot } from '../../lib/snapshot-types';

// BUG-002 (T117) — QueueItemActions.onRemovePending destructures
// `{ correlationId }` from postCommand's return value and routes the ACK
// through snapshotStore.markPending / onceAck, so the mocks must mirror
// the real shape even though these tests focus on dispatch ids.
const postCommandSpy = vi.fn((..._args: unknown[]) => ({ correlationId: 'corr-stub' }));
vi.mock('../../lib/vscode-api', () => ({
  postCommand: (...args: unknown[]) => postCommandSpy(...args)
}));

// Feature 063 — the "edit a pending task" flow now routes through
// `useConfirm('run.modify-task', …)`. Auto-confirm for this dispatch
// test; the prompt itself is covered by use-confirm.test.ts.
vi.mock('../../lib/use-confirm', () => ({
  useConfirm: vi.fn(async () => true)
}));

vi.mock('../../lib/snapshot-store.svelte', () => ({
  snapshotStore: {
    isPrimary: true,
    queue: {
      queues: [
        { id: 'default', name: 'Default queue', position: 0, state: 'active', schedule: null, taskCount: 1 },
        { id: 'queue-2', name: 'Secondary', position: 1, state: 'active', schedule: null, taskCount: 0 }
      ]
    },
    queues: [
      { id: 'default', name: 'Default queue', position: 0, state: 'active', schedule: null, taskCount: 1 },
      { id: 'queue-2', name: 'Secondary', position: 1, state: 'active', schedule: null, taskCount: 0 }
    ],
    markPending: vi.fn(),
    onceAck: vi.fn()
  }
}));

beforeEach(() => {
  postCommandSpy.mockReset();
  postCommandSpy.mockImplementation(() => ({ correlationId: 'corr-stub' }));
});
afterEach(() => cleanup());

function item(overrides: Partial<QueueItemSnapshot> = {}): QueueItemSnapshot {
  return {
    id: 'task-1',
    label: 'Original task',
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

describe('QueueItem task actions', () => {
  it('edits a pending task description', async () => {
    const { getByTestId } = render(QueueItem, { props: { item: item() } });
    await fireEvent.click(getByTestId('queue-item-edit-task-1'));
    await fireEvent.input(getByTestId('queue-item-edit-input-task-1'), {
      target: { value: 'Updated task' }
    });
    await fireEvent.click(getByTestId('queue-item-edit-save-task-1'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_MODIFY_TASK, {
      taskId: 'task-1',
      description: 'Updated task'
    });
  });

  // Feature 030 (US3, T045) — the "moves a pending task to another queue"
  // test was deleted. The move-task command and the inline move form were
  // removed alongside the multi-queue surfaces.

  it('renders remove button for pending tasks and hides edit for in-flight tasks', async () => {
    const { queryByTestId, rerender } = render(QueueItem, {
      props: { item: item() }
    });
    // ✖ button is present for pending tasks (confirm flow is owned by Dashboard)
    expect(queryByTestId('queue-item-remove-task-1')).not.toBeNull();

    await rerender({ item: item({ status: 'in-flight' }) });
    expect(queryByTestId('queue-item-edit-task-1')).toBeNull();
    // Feature 030 (US3, T045) — the "Move to another queue" button is
    // gone entirely; no assertion for its absence is needed.
  });

  it('renders distinct queue, phase, breakpoint, and task pause labels with tooltips', async () => {
    const { getByTestId, rerender } = render(QueueItem, {
      props: { item: item({ pauseCause: 'queue-paused' }) }
    });
    let badge = getByTestId('queue-item-pause-cause-task-1');
    expect(badge.textContent).toContain('Queue paused');
    expect(badge.getAttribute('title')).toContain('resume the queue');

    await rerender({ item: item({ pauseCause: 'phase-paused' }) });
    badge = getByTestId('queue-item-pause-cause-task-1');
    expect(badge.textContent).toContain('Paused (operator)');
    expect(badge.getAttribute('title')).toContain('Operator paused the active phase');

    await rerender({ item: item({ pauseCause: 'breakpoint' }) });
    badge = getByTestId('queue-item-pause-cause-task-1');
    expect(badge.textContent).toContain('Paused (breakpoint)');
    expect(badge.getAttribute('title')).toContain('breakpoint');

    await rerender({ item: item({ pauseCause: 'manually-paused-task' }) });
    badge = getByTestId('queue-item-pause-cause-task-1');
    expect(badge.textContent).toContain('Task paused');
    expect(badge.getAttribute('title')).toContain('resume the task');
  });
});
