import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import PhaseControlMenu from '../PhaseControlMenu.svelte';
import {
  CMD_PAUSE_PHASE,
  CMD_RESTART_PHASE,
  CMD_RESUME_PHASE,
  CMD_SKIP_PHASE,
  CMD_DISABLE_PHASE,
  CMD_ENABLE_PHASE
} from '../../lib/messages';

// Feature 093 (T080) — lifecycle controls are queue-addressed, so the component
// under test needs the queue whose Run it acts on, and every payload it posts
// carries that queue. The assertions below are the webview-side half of the
// contract the host pins in `queue-addressed-phase-controls.test.ts`.
const TEST_QUEUE_ID = 'q-alpha';

const postCommandSpy = vi.fn();
vi.mock('../../lib/vscode-api', () => ({
  postCommand: (...args: unknown[]) => postCommandSpy(...args)
}));

vi.mock('../../lib/use-confirm', () => ({
  useConfirm: vi.fn().mockResolvedValue(true)
}));

beforeEach(() => {
  postCommandSpy.mockReset();
});

afterEach(() => cleanup());

describe('PhaseControlMenu', () => {
  it('dispatches pause, resume, and restart through phase-control helpers', async () => {
    const { getByTestId, rerender } = render(PhaseControlMenu, {
      props: { queueId: TEST_QUEUE_ID, currentPhase: 'speckit-plan', isPrimary: true, manualPauseAt: null }
    });

    await fireEvent.click(getByTestId('phase-control-pause'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_PAUSE_PHASE, { queueId: TEST_QUEUE_ID });

    await rerender({ queueId: TEST_QUEUE_ID,
      currentPhase: 'speckit-plan',
      isPrimary: true,
      manualPauseAt: '2026-05-13T00:00:00.000Z'
    });
    await fireEvent.click(getByTestId('phase-control-resume'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_RESUME_PHASE, { queueId: TEST_QUEUE_ID });

    await fireEvent.click(getByTestId('phase-control-restart'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_RESTART_PHASE, {
      queueId: TEST_QUEUE_ID,
      phaseId: 'speckit-plan'
    });

    await fireEvent.click(getByTestId('phase-control-skip'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_SKIP_PHASE, {
      queueId: TEST_QUEUE_ID,
      phaseId: 'speckit-plan'
    });

    await fireEvent.click(getByTestId('phase-control-disable'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_DISABLE_PHASE, {
      queueId: TEST_QUEUE_ID,
      phaseId: 'speckit-plan'
    });
  });

  it('disables mutating controls when not primary', async () => {
    const { container, getByTestId } = render(PhaseControlMenu, {
      props: { queueId: TEST_QUEUE_ID, currentPhase: 'speckit-plan', isPrimary: false, manualPauseAt: null }
    });

    container.querySelectorAll('button').forEach((button) => {
      expect(button.getAttribute('aria-disabled')).toBe('true');
    });
    await fireEvent.click(getByTestId('phase-control-pause'));
    expect(postCommandSpy).not.toHaveBeenCalled();
  });

  it('enables override clearing only when the current phase has an override', async () => {
    const { getByTestId } = render(PhaseControlMenu, {
      props: { queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-plan',
        isPrimary: true,
        manualPauseAt: null,
        phaseOverrides: [{ phaseId: 'speckit-plan', action: 'disabled' }]
      }
    });

    expect(getByTestId('phase-control-enable').getAttribute('aria-disabled')).toBe('false');
    await fireEvent.click(getByTestId('phase-control-enable'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_ENABLE_PHASE, {
      queueId: TEST_QUEUE_ID,
      phaseId: 'speckit-plan'
    });
  });
});
