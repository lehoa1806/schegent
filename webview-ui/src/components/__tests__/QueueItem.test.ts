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

  // Feature 065 BUG-004 (FR-024) — the queue item card MUST render its
  // action button cluster on a dedicated final row, separate from the
  // row that displays the task id, with the enqueued timestamp on the
  // same final row to the left of the action cluster. These DOM-order
  // assertions pin the row composition so a future refactor cannot
  // re-promote the actions back into row-1.
  describe('Feature 065 BUG-004 (FR-024) — card row composition', () => {
    it('places the action cluster after the prompt label in DOM order', () => {
      const { container } = render(QueueItem, { props: { item: item() } });
      const label = container.querySelector('.label');
      const actionsSlot = container.querySelector('.actions-slot');
      expect(label).not.toBeNull();
      expect(actionsSlot).not.toBeNull();
      if (!label || !actionsSlot) return;
      // Node.DOCUMENT_POSITION_FOLLOWING (4) means actionsSlot follows label.
      const position = label.compareDocumentPosition(actionsSlot);
      expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      );
    });

    it('places the enqueued timestamp on the footer row, to the left of the action cluster', () => {
      const { container, getByTestId } = render(QueueItem, {
        props: { item: item() }
      });
      const timeEl = getByTestId('queue-item-enqueued-task-1');
      const actionsSlot = container.querySelector('.actions-slot');
      expect(timeEl).toBeTruthy();
      expect(actionsSlot).not.toBeNull();
      if (!actionsSlot) return;
      // Both live inside .row-footer; timeEl is in .row-footer-left and
      // the actions cluster is in .row-footer-right. Verify timeEl
      // precedes the action cluster in DOM order.
      const position = timeEl.compareDocumentPosition(actionsSlot);
      expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      );
      // The timestamp must live inside .row-footer-left, not row-1.
      expect(timeEl.closest('.row-footer-left')).not.toBeNull();
      expect(timeEl.closest('.row-1')).toBeNull();
    });

    it('places the enqueued timestamp after the meta chips when they are rendered', () => {
      const { container, getByTestId } = render(QueueItem, {
        props: {
          item: item({
            status: 'in-flight',
            currentPhase: 'speckit-plan',
            retryCount: 2
          })
        }
      });
      const metaRow = container.querySelector('.row-3.meta');
      const timeEl = getByTestId('queue-item-enqueued-task-1');
      expect(metaRow).not.toBeNull();
      if (!metaRow) return;
      const position = metaRow.compareDocumentPosition(timeEl);
      expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      );
    });
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
