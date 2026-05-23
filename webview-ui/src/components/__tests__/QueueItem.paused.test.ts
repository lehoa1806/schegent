// Feature 065 / BUG-006 (T072) — paused-row badge + restore countdown.
//
// Asserts:
//   1. A system-paused row renders the badge with
//      `data-testid='queue-item-pause-badge-{id}'`, `data-pause-source`
//      `'system-paused'`, and the rate-limit label.
//   2. When `paused.resetsAtMs > now`, the restore-time chip with
//      `data-testid='queue-item-restore-time-{id}'` renders alongside.
//   3. An operator-paused row renders the badge with
//      `data-pause-source='operator-paused'` and NO restore-time chip.
//   4. A non-paused row renders neither chip (`paused` field absent).
//
// The test injects a fake `nowFine` via `__setTickerForTests` so the
// countdown is deterministic without vitest fake timers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import QueueItem from '../QueueItem.svelte';
import type { QueueItem as QueueItemSnapshot } from '../../lib/snapshot-types';
import { __setTickerForTests, __resetTickerForTests } from '../../lib/tick-store';

vi.mock('../../lib/reorder-task', () => ({
  postReorderTask: vi.fn(),
  postMoveItemUp: vi.fn(),
  postMoveItemDown: vi.fn()
}));

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'corr-stub' }))
}));

vi.mock('../../lib/use-confirm', () => ({
  useConfirm: vi.fn(async () => true)
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

const FROZEN_NOW = 1_750_000_000_000;

beforeEach(() => {
  // Freeze the 1-second ticker so countdown assertions are deterministic.
  __setTickerForTests({ now: () => FROZEN_NOW });
});
afterEach(() => {
  cleanup();
  __resetTickerForTests();
});

function item(overrides: Partial<QueueItemSnapshot> = {}): QueueItemSnapshot {
  return {
    id: 'task-1',
    label: 'Paused candidate',
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

describe('Feature 065 BUG-006 (T072) — QueueItem paused-row badge', () => {
  it('renders the system-paused badge for a rate-limit-paused task with restore countdown', () => {
    const target = FROZEN_NOW + 5 * 60_000; // 5 minutes ahead
    const { getByTestId } = render(QueueItem, {
      props: {
        item: item({
          status: 'paused',
          paused: {
            pauseSource: 'system-paused',
            pauseCauseCategory: 'rate-limit',
            resetsAtMs: target
          }
        })
      }
    });

    const badge = getByTestId('queue-item-pause-badge-task-1');
    expect(badge.getAttribute('data-pause-source')).toBe('system-paused');
    expect(badge.getAttribute('data-pause-cause-category')).toBe('rate-limit');
    expect(badge.textContent).toContain('Paused (rate-limit)');

    const restoreChip = getByTestId('queue-item-restore-time-task-1');
    expect(restoreChip).toBeTruthy();
    expect(restoreChip.textContent).toContain('auto-resumes in');
    // 5 minutes ahead → 5m 0s in the formatted countdown.
    expect(restoreChip.textContent).toContain('5m');
  });

  it('renders the operator-paused badge with no restore-time chip', () => {
    const { getByTestId, queryByTestId } = render(QueueItem, {
      props: {
        item: item({
          status: 'paused',
          paused: { pauseSource: 'operator-paused' }
        })
      }
    });

    const badge = getByTestId('queue-item-pause-badge-task-1');
    expect(badge.getAttribute('data-pause-source')).toBe('operator-paused');
    expect(badge.getAttribute('data-pause-cause-category')).toBe('');
    expect(badge.textContent).toContain('Paused');
    // Operator-paused: no restore-time chip.
    expect(queryByTestId('queue-item-restore-time-task-1')).toBeNull();
  });

  it('suppresses the restore-time chip when resetsAtMs is in the past', () => {
    const past = FROZEN_NOW - 60_000;
    const { getByTestId, queryByTestId } = render(QueueItem, {
      props: {
        item: item({
          status: 'paused',
          paused: {
            pauseSource: 'system-paused',
            pauseCauseCategory: 'rate-limit',
            resetsAtMs: past
          }
        })
      }
    });

    // Badge still renders (the row is paused) but countdown is suppressed.
    expect(getByTestId('queue-item-pause-badge-task-1')).toBeTruthy();
    expect(queryByTestId('queue-item-restore-time-task-1')).toBeNull();
  });

  it('renders no paused badge for a non-paused (pending) row', () => {
    const { queryByTestId } = render(QueueItem, {
      props: { item: item({ status: 'pending' }) }
    });
    expect(queryByTestId('queue-item-pause-badge-task-1')).toBeNull();
    expect(queryByTestId('queue-item-restore-time-task-1')).toBeNull();
  });

  it('renders no paused badge for an in-flight row', () => {
    const { queryByTestId } = render(QueueItem, {
      props: { item: item({ status: 'in-flight' }) }
    });
    expect(queryByTestId('queue-item-pause-badge-task-1')).toBeNull();
    expect(queryByTestId('queue-item-restore-time-task-1')).toBeNull();
  });
});
