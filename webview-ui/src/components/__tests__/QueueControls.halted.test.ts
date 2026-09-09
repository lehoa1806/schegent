// Feature 195 (T031, FR-007, FR-008, FR-009) — QueueControls renders retry
// and remove for the failed task a halt names, in the queue header, reusing
// QueueItemActions's existing dispatch rather than adding a second IPC path.
//
// Contract §3 (rendering requirements): "The queue header states the same
// fact and the same name, with retry and remove reachable." This file pins
// that the header does so, and only when the queue is actually halted.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import QueueControls from '../QueueControls.svelte';
import type { QueueItem } from '../../lib/snapshot-types';

let nextCorrelationId = 0;
const postCommandSpy = vi.fn((..._args: readonly unknown[]) => ({
  correlationId: `corr-${++nextCorrelationId}`
}));
vi.mock('../../lib/vscode-api', () => ({
  postCommand: (...args: unknown[]) => postCommandSpy(...args)
}));

vi.mock('../../lib/use-confirm', () => ({
  useConfirm: vi.fn(async () => true)
}));

vi.mock('../../lib/snapshot-store.svelte', () => ({
  snapshotStore: {
    queues: [],
    markPending: vi.fn(),
    onceAck: vi.fn()
  }
}));

import {
  CMD_RETRY_QUEUE_ITEM,
  CMD_REMOVE_QUEUE_ITEM,
  CMD_ATTEST_TASK_COMPLETED
} from '../../lib/messages';

beforeEach(() => {
  postCommandSpy.mockReset();
});
afterEach(() => cleanup());

const QUEUE_ID = 'q-halted';

function buildHaltedTask(overrides: Partial<QueueItem> = {}): QueueItem {
  return Object.freeze({
    id: 'task-7',
    label: 'Wire the payments webhook',
    enqueuedAt: '2026-09-04T10:00:00.000Z',
    startedAt: '2026-09-04T10:00:01.000Z',
    updatedAt: '2026-09-04T10:05:00.000Z',
    completedAt: '2026-09-04T10:05:00.000Z',
    status: 'failed',
    retryCount: 1,
    lastErrorSummary: 'exit code 1',
    pausedReason: null,
    currentPhase: null,
    position: 1,
    phaseProgress: null,
    ...overrides
  });
}

function defaultProps(overrides: Partial<{
  haltedTask: QueueItem | null;
  isPrimary: boolean;
}> = {}) {
  return {
    isPrimary: true,
    queueId: QUEUE_ID,
    paused: false,
    pendingCount: 2,
    hasInFlight: false,
    clearDoneDisabled: true,
    cleanDisabled: true,
    haltedTask: null as QueueItem | null,
    onResume: vi.fn(),
    onPause: vi.fn(),
    onClearDone: vi.fn(),
    onClean: vi.fn(),
    ...overrides
  };
}

describe('QueueControls — halted task actions in the queue header (FR-009)', () => {
  it('renders nothing about a halt when haltedTask is null', () => {
    const { queryByTestId } = render(QueueControls, { props: defaultProps() });
    expect(queryByTestId('dashboard-queue-halted-actions')).toBeNull();
  });

  it('names the failed task and offers retry and remove when haltedTask is set', () => {
    const task = buildHaltedTask();
    const { getByTestId, queryByTestId } = render(QueueControls, {
      props: defaultProps({ haltedTask: task })
    });

    const section = getByTestId('dashboard-queue-halted-actions');
    expect(section.textContent).toContain(task.label);
    expect(queryByTestId(`queue-item-retry-${task.id}`)).not.toBeNull();
    expect(queryByTestId(`queue-item-remove-${task.id}`)).not.toBeNull();
  });

  it('dispatches CMD_RETRY_QUEUE_ITEM for the named task on retry click', async () => {
    const task = buildHaltedTask();
    const { getByTestId } = render(QueueControls, {
      props: defaultProps({ haltedTask: task })
    });

    await fireEvent.click(getByTestId(`queue-item-retry-${task.id}`));

    expect(postCommandSpy).toHaveBeenCalledWith(CMD_RETRY_QUEUE_ITEM, { id: task.id });
  });

  it('dispatches CMD_REMOVE_QUEUE_ITEM for the named task on confirmed remove', async () => {
    const task = buildHaltedTask();
    const { getByTestId } = render(QueueControls, {
      props: defaultProps({ haltedTask: task })
    });

    await fireEvent.click(getByTestId(`queue-item-remove-${task.id}`));

    expect(postCommandSpy).toHaveBeenCalledWith(
      CMD_REMOVE_QUEUE_ITEM,
      expect.objectContaining({ id: task.id, confirmed: true })
    );
  });

  it('disables retry and remove in a non-primary window', () => {
    const task = buildHaltedTask();
    const { getByTestId } = render(QueueControls, {
      props: defaultProps({ haltedTask: task, isPrimary: false })
    });

    expect(getByTestId(`queue-item-retry-${task.id}`).getAttribute('aria-disabled')).toBe('true');
    expect(getByTestId(`queue-item-remove-${task.id}`).getAttribute('aria-disabled')).toBe('true');
  });

  // Feature 195 (T064, FR-025) — the header reports the halt, so it must state
  // every way out of it, not two of three. This surface gains no dispatch of
  // its own: the affordance arrives with `QueueItemActions`, the same way retry
  // and remove already do, which is why the assertions below are about the
  // header *reaching* the third exit rather than about a new IPC path.
  it('offers attested completion beside retry and remove (T064, FR-025)', () => {
    const task = buildHaltedTask();
    const { queryByTestId } = render(QueueControls, {
      props: defaultProps({ haltedTask: task })
    });

    expect(queryByTestId(`queue-item-attest-${task.id}`)).not.toBeNull();
  });

  it('dispatches CMD_ATTEST_TASK_COMPLETED for the named task on a confirmed attestation', async () => {
    const task = buildHaltedTask();
    const { getByTestId } = render(QueueControls, {
      props: defaultProps({ haltedTask: task })
    });

    await fireEvent.click(getByTestId(`queue-item-attest-${task.id}`));

    expect(postCommandSpy).toHaveBeenCalledWith(
      CMD_ATTEST_TASK_COMPLETED,
      expect.objectContaining({ taskId: task.id, confirmed: true })
    );
  });
});
