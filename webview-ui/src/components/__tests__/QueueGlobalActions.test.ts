import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import QueueGlobalActions from '../QueueGlobalActions.svelte';

const postCommandSpy = vi.fn();
vi.mock('../../lib/vscode-api', () => ({
  postCommand: (...args: unknown[]) => postCommandSpy(...args)
}));

import {
  CMD_PAUSE_QUEUE,
  CMD_RESUME_QUEUE,
  CMD_START_QUEUE,
  CMD_CLEAR_COMPLETED,
  CMD_CLEAR_FAILED,
  CMD_OPEN_DASHBOARD
} from '../../lib/messages';

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
}> = {}) {
  return {
    paused: false,
    isPrimary: true,
    completedCount: 0,
    failedCount: 0,
    pendingCount: 0,
    hasInFlight: false,
    ...overrides
  };
}

describe('QueueGlobalActions', () => {
  // BUG-003 / FR-012a — tri-state contextual button tests

  it('shows Start Queue when pending tasks exist and nothing in-flight', () => {
    const { queryByTestId } = render(QueueGlobalActions, {
      props: defaultProps({ pendingCount: 2, hasInFlight: false, paused: false })
    });
    const btn = queryByTestId('queue-action-button');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Start Queue');
  });

  it('shows Pause Queue when a run is in-flight and not paused', () => {
    const { queryByTestId } = render(QueueGlobalActions, {
      props: defaultProps({ hasInFlight: true, paused: false })
    });
    const btn = queryByTestId('queue-action-button');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Pause Queue');
  });

  it('shows Resume Queue when paused', () => {
    const { queryByTestId } = render(QueueGlobalActions, {
      props: defaultProps({ paused: true })
    });
    const btn = queryByTestId('queue-action-button');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Resume Queue');
  });

  it('hides the action button when idle (no pending, no in-flight, not paused)', () => {
    const { queryByTestId } = render(QueueGlobalActions, {
      props: defaultProps({ pendingCount: 0, hasInFlight: false, paused: false })
    });
    expect(queryByTestId('queue-action-button')).toBeNull();
  });

  it('paused takes precedence over in-flight (shows Resume)', () => {
    const { queryByTestId } = render(QueueGlobalActions, {
      props: defaultProps({ paused: true, hasInFlight: true, pendingCount: 3 })
    });
    const btn = queryByTestId('queue-action-button');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Resume Queue');
  });

  it('in-flight takes precedence over pending (shows Pause)', () => {
    const { queryByTestId } = render(QueueGlobalActions, {
      props: defaultProps({ hasInFlight: true, pendingCount: 3, paused: false })
    });
    const btn = queryByTestId('queue-action-button');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Pause Queue');
  });

  it('Clear Completed disabled when no completed items', () => {
    const { getByTestId } = render(QueueGlobalActions, { props: defaultProps({ completedCount: 0 }) });
    const btn = getByTestId('queue-clear-completed-button');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
  });

  it('Clear Completed enabled when completedCount > 0', () => {
    const { getByTestId } = render(QueueGlobalActions, { props: defaultProps({ completedCount: 3 }) });
    const btn = getByTestId('queue-clear-completed-button');
    expect(btn.getAttribute('aria-disabled')).toBe('false');
  });

  it('Clear Failed disabled when no failed items', () => {
    const { getByTestId } = render(QueueGlobalActions, { props: defaultProps({ failedCount: 0 }) });
    const btn = getByTestId('queue-clear-failed-button');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
  });

  it('Open Dashboard always rendered, no precondition', () => {
    const { getByTestId } = render(QueueGlobalActions, { props: defaultProps() });
    expect(getByTestId('queue-open-dashboard-button')).not.toBeNull();
  });

  it('All controls aria-disabled when isPrimary===false', () => {
    const { container } = render(QueueGlobalActions, {
      props: defaultProps({ isPrimary: false, completedCount: 5, failedCount: 5, hasInFlight: true })
    });
    container.querySelectorAll('button').forEach((b) => {
      expect(b.getAttribute('aria-disabled')).toBe('true');
    });
  });

  it('Clicking Start posts CMD_START_QUEUE', async () => {
    const { getByTestId } = render(QueueGlobalActions, {
      props: defaultProps({ pendingCount: 1, hasInFlight: false, paused: false })
    });
    await fireEvent.click(getByTestId('queue-action-button'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_START_QUEUE);
  });

  it('Clicking Pause posts CMD_PAUSE_QUEUE', async () => {
    const { getByTestId } = render(QueueGlobalActions, {
      props: defaultProps({ hasInFlight: true, paused: false })
    });
    await fireEvent.click(getByTestId('queue-action-button'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_PAUSE_QUEUE);
  });

  it('Clicking Resume posts CMD_RESUME_QUEUE', async () => {
    const { getByTestId } = render(QueueGlobalActions, {
      props: defaultProps({ paused: true })
    });
    await fireEvent.click(getByTestId('queue-action-button'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_RESUME_QUEUE);
  });

  // Feature 030 (US3, T042) — the per-queue Pause/Resume queueId
  // payload was dropped. With the single-queue migration there is
  // only one queue, so Pause/Resume always operate on the unified
  // default queue and never carry a queueId. The bare-call shapes
  // are exercised by the two sibling tests above.

  it('Clicking Clear Completed when enabled posts CMD_CLEAR_COMPLETED', async () => {
    const { getByTestId } = render(QueueGlobalActions, { props: defaultProps({ completedCount: 1 }) });
    await fireEvent.click(getByTestId('queue-clear-completed-button'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_CLEAR_COMPLETED);
  });

  it('Clicking Clear Failed when enabled posts CMD_CLEAR_FAILED', async () => {
    const { getByTestId } = render(QueueGlobalActions, { props: defaultProps({ failedCount: 2 }) });
    await fireEvent.click(getByTestId('queue-clear-failed-button'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_CLEAR_FAILED);
  });

  it('Clicking Clear Completed when disabled does NOT post', async () => {
    const { getByTestId } = render(QueueGlobalActions, { props: defaultProps({ completedCount: 0 }) });
    await fireEvent.click(getByTestId('queue-clear-completed-button'));
    expect(postCommandSpy).not.toHaveBeenCalled();
  });

  it('Clicking Open Dashboard posts CMD_OPEN_DASHBOARD', async () => {
    const { getByTestId } = render(QueueGlobalActions, { props: defaultProps() });
    await fireEvent.click(getByTestId('queue-open-dashboard-button'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_OPEN_DASHBOARD);
  });

  it('Click on aria-disabled (non-primary) does NOT post', async () => {
    const { getByTestId } = render(QueueGlobalActions, {
      props: defaultProps({ isPrimary: false, completedCount: 5 })
    });
    await fireEvent.click(getByTestId('queue-clear-completed-button'));
    expect(postCommandSpy).not.toHaveBeenCalled();
  });
});
