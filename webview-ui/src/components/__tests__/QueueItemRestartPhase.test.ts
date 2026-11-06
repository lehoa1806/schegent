import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import QueueItemRestartPhase from '../QueueItemRestartPhase.svelte';
import type { QueueItem } from '../../lib/snapshot-types';
import type { LifecycleControlResult } from '../../lib/lifecycle-control-ipc';

// Spec 278 (OD-2) — the failed row's Restart goes through the shared phase-control helper, so
// this test mocks the helper and never the command it posts.
const restartPhaseSpy = vi.fn(
  async (..._args: unknown[]): Promise<LifecycleControlResult> => ({ outcome: 'accepted' }) as LifecycleControlResult
);
vi.mock('../../lib/phase-control', () => ({
  restartPhase: (...args: unknown[]) => restartPhaseSpy(...args)
}));

const FAILED_ROW: QueueItem = {
  id: 'task-7',
  label: 'Add export button',
  status: 'failed',
  currentPhase: 'implement',
  queueId: 'queue-b'
} as unknown as QueueItem;

function row(overrides: Partial<QueueItem>): QueueItem {
  return { ...FAILED_ROW, ...overrides } as QueueItem;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await tick();
}

beforeEach(() => {
  restartPhaseSpy.mockReset();
  restartPhaseSpy.mockResolvedValue({ outcome: 'accepted' } as LifecycleControlResult);
});
afterEach(() => cleanup());

describe('QueueItemRestartPhase (spec 278, OD-2)', () => {
  it('offers Restart on a failed row whose Run still names a phase', () => {
    const { queryByTestId } = render(QueueItemRestartPhase, { props: { item: FAILED_ROW, disabled: false } });
    const button = queryByTestId('queue-item-restart-phase-task-7');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-label')).toContain('implement');
  });

  it.each(['pending', 'in-flight', 'paused', 'completed', 'canceled'] as const)(
    'offers nothing on a %s row',
    (status) => {
      const { queryByTestId } = render(QueueItemRestartPhase, {
        props: { item: row({ status }), disabled: false }
      });
      expect(queryByTestId('queue-item-restart-phase-task-7')).toBeNull();
    }
  );

  it('offers nothing on a failed row with no stored Run phase', () => {
    const { queryByTestId } = render(QueueItemRestartPhase, {
      props: { item: row({ currentPhase: null }), disabled: false }
    });
    expect(queryByTestId('queue-item-restart-phase-task-7')).toBeNull();
  });

  it('restarts the failed phase of the row\'s own queue', async () => {
    const { getByTestId } = render(QueueItemRestartPhase, { props: { item: FAILED_ROW, disabled: false } });
    await fireEvent.click(getByTestId('queue-item-restart-phase-task-7'));
    await settle();
    expect(restartPhaseSpy).toHaveBeenCalledTimes(1);
    const call = restartPhaseSpy.mock.calls.at(0) ?? [];
    expect(call.at(0)).toBe('implement');
    expect(call.at(1)).toBe('queue-b');
  });

  it('falls back to the default queue when the row carries no queue id', async () => {
    const { getByTestId } = render(QueueItemRestartPhase, {
      props: { item: row({ queueId: undefined }), disabled: false }
    });
    await fireEvent.click(getByTestId('queue-item-restart-phase-task-7'));
    await settle();
    expect(restartPhaseSpy.mock.calls.at(0)?.at(1)).toBe('default');
  });

  it('posts nothing when the row is not the primary surface', async () => {
    const { getByTestId } = render(QueueItemRestartPhase, { props: { item: FAILED_ROW, disabled: true } });
    const button = getByTestId('queue-item-restart-phase-task-7');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await fireEvent.click(button);
    await settle();
    expect(restartPhaseSpy).not.toHaveBeenCalled();
  });

  it('shows the host\'s refusal sentence and nothing on acceptance', async () => {
    restartPhaseSpy.mockResolvedValueOnce({
      outcome: 'refused',
      message: 'Restart is not available for this Run.'
    } as LifecycleControlResult);
    const { getByTestId, queryByTestId } = render(QueueItemRestartPhase, {
      props: { item: FAILED_ROW, disabled: false }
    });
    await fireEvent.click(getByTestId('queue-item-restart-phase-task-7'));
    await settle();
    expect(getByTestId('queue-item-restart-phase-message-task-7').textContent).toBe(
      'Restart is not available for this Run.'
    );
    await fireEvent.click(getByTestId('queue-item-restart-phase-task-7'));
    await settle();
    expect(queryByTestId('queue-item-restart-phase-message-task-7')).toBeNull();
  });
});
