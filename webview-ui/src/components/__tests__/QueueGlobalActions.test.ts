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
}> = {}) {
  return {
    paused: false,
    isPrimary: true,
    completedCount: 0,
    failedCount: 0,
    ...overrides
  };
}

describe('QueueGlobalActions', () => {
  it('shows Pause Queue when not paused, hides Resume Queue', () => {
    const { queryByTestId } = render(QueueGlobalActions, { props: defaultProps({ paused: false }) });
    expect(queryByTestId('queue-pause-button')).not.toBeNull();
    expect(queryByTestId('queue-resume-button')).toBeNull();
  });

  it('shows Resume Queue when paused, hides Pause Queue', () => {
    const { queryByTestId } = render(QueueGlobalActions, { props: defaultProps({ paused: true }) });
    expect(queryByTestId('queue-resume-button')).not.toBeNull();
    expect(queryByTestId('queue-pause-button')).toBeNull();
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
      props: defaultProps({ isPrimary: false, completedCount: 5, failedCount: 5 })
    });
    container.querySelectorAll('button').forEach((b) => {
      expect(b.getAttribute('aria-disabled')).toBe('true');
    });
  });

  it('Clicking Pause posts CMD_PAUSE_QUEUE', async () => {
    const { getByTestId } = render(QueueGlobalActions, { props: defaultProps({ paused: false }) });
    await fireEvent.click(getByTestId('queue-pause-button'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_PAUSE_QUEUE);
  });

  it('Clicking Resume posts CMD_RESUME_QUEUE', async () => {
    const { getByTestId } = render(QueueGlobalActions, { props: defaultProps({ paused: true }) });
    await fireEvent.click(getByTestId('queue-resume-button'));
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
