// Feature 065 (T028c, BUG-007 / 2026-05-23) — QueueGlobalActions MUST
// suppress its `action === 'start'` branch when
// `queueLifecycle === 'idle-pending'` so the FR-018 chooser surface, now
// `QueueIdlePendingPanel.svelte`, remains the sole dispatcher of
// `CMD_START_QUEUE` against an idle-pending queue.
//
// This component is the sidebar cousin of QueueControls. The same
// suppression invariant applies — both share the same tri-state
// derivation, and both could otherwise emit a bare `CMD_START_QUEUE`
// that the host correctly no-ops in `idle-pending` per
// `contracts/sidebar-ipc.diff.md` line 119.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import QueueGlobalActions from '../QueueGlobalActions.svelte';
import type { QueueLifecycle } from '../../lib/snapshot-types';

const postCommandSpy = vi.fn();
vi.mock('../../lib/vscode-api', () => ({
  postCommand: (...args: unknown[]) => postCommandSpy(...args)
}));

beforeEach(() => {
  postCommandSpy.mockReset();
});

afterEach(() => cleanup());

function defaultProps(overrides: Partial<{
  paused: boolean;
  isPrimary: boolean;
  completedCount: number;
  failedCount: number;
  pendingCount: number;
  hasInFlight: boolean;
  queueLifecycle: QueueLifecycle | null;
}> = {}) {
  return {
    paused: false,
    isPrimary: true,
    completedCount: 0,
    failedCount: 0,
    pendingCount: 0,
    hasInFlight: false,
    queueLifecycle: null as QueueLifecycle | null,
    ...overrides
  };
}

describe('QueueGlobalActions — idle-pending suppression (BUG-007 / FR-018)', () => {
  it('hides Start Queue when queueLifecycle === "idle-pending" even with pending tasks', () => {
    const { queryByTestId } = render(QueueGlobalActions, {
      props: defaultProps({
        pendingCount: 3,
        hasInFlight: false,
        paused: false,
        queueLifecycle: 'idle-pending'
      })
    });
    expect(queryByTestId('queue-action-button')).toBeNull();
  });

  it('shows Start Queue when queueLifecycle === "active-empty" with pending tasks', () => {
    const { queryByTestId } = render(QueueGlobalActions, {
      props: defaultProps({
        pendingCount: 3,
        hasInFlight: false,
        paused: false,
        queueLifecycle: 'active-empty'
      })
    });
    const btn = queryByTestId('queue-action-button');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Start Queue');
  });

  it('shows Start Queue when queueLifecycle is null (pre-065 backward-compat)', () => {
    const { queryByTestId } = render(QueueGlobalActions, {
      props: defaultProps({
        pendingCount: 3,
        hasInFlight: false,
        paused: false,
        queueLifecycle: null
      })
    });
    const btn = queryByTestId('queue-action-button');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Start Queue');
  });

  it('still shows Pause Queue when in-flight (suppression scoped to Start branch only)', () => {
    const { queryByTestId } = render(QueueGlobalActions, {
      props: defaultProps({
        pendingCount: 3,
        hasInFlight: true,
        paused: false,
        queueLifecycle: 'idle-pending'
      })
    });
    const btn = queryByTestId('queue-action-button');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Pause Queue');
  });

  it('still shows Resume Queue when paused, regardless of lifecycle', () => {
    const { queryByTestId } = render(QueueGlobalActions, {
      props: defaultProps({
        pendingCount: 3,
        hasInFlight: false,
        paused: true,
        queueLifecycle: 'idle-pending'
      })
    });
    const btn = queryByTestId('queue-action-button');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Resume Queue');
  });

  it('does NOT dispatch CMD_START_QUEUE via this component when queueLifecycle === "idle-pending"', () => {
    const { queryByTestId } = render(QueueGlobalActions, {
      props: defaultProps({
        pendingCount: 5,
        hasInFlight: false,
        paused: false,
        queueLifecycle: 'idle-pending'
      })
    });
    expect(queryByTestId('queue-action-button')).toBeNull();
    expect(postCommandSpy).not.toHaveBeenCalled();
  });

  it('regression: dispatches CMD_START_QUEUE on click when queueLifecycle !== "idle-pending"', async () => {
    const { getByTestId } = render(QueueGlobalActions, {
      props: defaultProps({
        pendingCount: 2,
        hasInFlight: false,
        paused: false,
        queueLifecycle: 'active-empty'
      })
    });
    await fireEvent.click(getByTestId('queue-action-button'));
    expect(postCommandSpy).toHaveBeenCalledTimes(1);
  });

  it('Clear Completed and Clear Failed remain functional in idle-pending', () => {
    // The suppression MUST be narrow: the maintenance affordances (Clear
    // Completed, Clear Failed, Open Dashboard) MUST remain available
    // regardless of lifecycle. Operators need them to manage Recent.
    const { getByTestId } = render(QueueGlobalActions, {
      props: defaultProps({
        pendingCount: 3,
        completedCount: 2,
        failedCount: 1,
        queueLifecycle: 'idle-pending'
      })
    });
    expect(getByTestId('queue-clear-completed-button').getAttribute('aria-disabled')).toBe(
      'false'
    );
    expect(getByTestId('queue-clear-failed-button').getAttribute('aria-disabled')).toBe('false');
    expect(getByTestId('queue-open-dashboard-button')).not.toBeNull();
  });
});
