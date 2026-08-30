import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import PhaseControlMenu from '../PhaseControlMenu.svelte';
import {
  CMD_PAUSE_PHASE,
  CMD_RESTART_PHASE,
  CMD_RESUME_PHASE,
  CMD_SKIP_PHASE,
  CMD_DISABLE_PHASE,
  CMD_ENABLE_PHASE,
  CMD_RETRY_PHASE_NOW
} from '../../lib/messages';
import { useConfirm } from '../../lib/use-confirm';

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

const confirmMock = vi.mocked(useConfirm);

beforeEach(() => {
  postCommandSpy.mockReset();
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
});

afterEach(() => cleanup());

describe('PhaseControlMenu', () => {
  it('dispatches pause, resume, and restart through phase-control helpers', async () => {
    const { getByTestId, rerender } = render(PhaseControlMenu, {
      props: { targetsSubjectRun: true, queueId: TEST_QUEUE_ID, currentPhase: 'speckit-plan', isPrimary: true, manualPauseAt: null }
    });

    await fireEvent.click(getByTestId('phase-control-pause'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_PAUSE_PHASE, { queueId: TEST_QUEUE_ID });

    await rerender({ targetsSubjectRun: true, queueId: TEST_QUEUE_ID,
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
      props: { targetsSubjectRun: true, queueId: TEST_QUEUE_ID, currentPhase: 'speckit-plan', isPrimary: false, manualPauseAt: null }
    });

    container.querySelectorAll('button').forEach((button) => {
      expect(button.getAttribute('aria-disabled')).toBe('true');
    });
    await fireEvent.click(getByTestId('phase-control-pause'));
    expect(postCommandSpy).not.toHaveBeenCalled();
  });

  it('enables override clearing only when the current phase has an override', async () => {
    const { getByTestId } = render(PhaseControlMenu, {
      props: { targetsSubjectRun: true, queueId: TEST_QUEUE_ID,
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

// Lifecycle round-check finding C — retry-now had no operator route at all.
// `CMD_RETRY_PHASE_NOW` was one of thirteen `RunControlCommand` arms and the
// only one dispatched by nothing: FR-R3-140 deleted `PhaseTracker.svelte`, the
// component that used to hold the dispatcher, and `schegent.retryPhaseNow` has
// no palette entry either. The capability behind it — arm the continue gate,
// cancel the pending timer, clear a `retry-cap-exhausted` queue pause — was
// fully built and unreachable.
//
// It lives here rather than in `phase-control.ts` for the reason that module
// already records: `tests/lint/destructive-actions.lint.test.ts` requires the
// `postCommand` to sit in the same scope as the `useConfirm` gating it, and the
// confirm needs the active phase name for its body copy.
describe('PhaseControlMenu — retry now (lifecycle round-check finding C)', () => {
  const waiting = (overrides: Record<string, unknown> = {}) =>
    render(PhaseControlMenu, {
      props: {
        targetsSubjectRun: true,
        queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-implement',
        isPrimary: true,
        manualPauseAt: null,
        isWaitingRetry: true,
        ...overrides
      }
    });

  it('offers the control only while a delayed retry is armed', () => {
    // The host answers `not-pending-retry` when no backoff is running, so a
    // permanently-visible button would be an affordance whose only effect is a
    // rejection toast. It surfaces beside the countdown badge or not at all.
    const { queryByTestId } = render(PhaseControlMenu, {
      props: {
        targetsSubjectRun: true,
        queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-implement',
        isPrimary: true,
        manualPauseAt: null,
        isWaitingRetry: false
      }
    });

    expect(queryByTestId('phase-control-retry-now')).toBeNull();
  });

  it('confirms, then posts the queue-addressed retry-now command', async () => {
    const { getByTestId } = waiting();

    await fireEvent.click(getByTestId('phase-control-retry-now'));

    expect(confirmMock).toHaveBeenCalledWith(
      'run.retry-phase-now',
      expect.objectContaining({ context: { phaseName: 'speckit-implement' } })
    );
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_RETRY_PHASE_NOW, {
      queueId: TEST_QUEUE_ID
    });
  });

  it('posts nothing when the operator declines the confirmation', async () => {
    confirmMock.mockResolvedValue(false);
    const { getByTestId } = waiting();

    await fireEvent.click(getByTestId('phase-control-retry-now'));

    expect(postCommandSpy).not.toHaveBeenCalled();
  });

  it('is disabled, and posts nothing, on a run this view is not showing', async () => {
    // `isWaitingRetry` is read off the displayed surface while the command is
    // addressed by `queueId` — the same mismatch every control here guards
    // against. Skipping the guard would let a countdown shown for one Task
    // shortcut the backoff of another.
    const { getByTestId } = waiting({ targetsSubjectRun: false });

    expect(getByTestId('phase-control-retry-now').getAttribute('aria-disabled')).toBe('true');
    await fireEvent.click(getByTestId('phase-control-retry-now'));
    expect(confirmMock).not.toHaveBeenCalled();
    expect(postCommandSpy).not.toHaveBeenCalled();
  });

  it('is disabled on a secondary window', async () => {
    const { getByTestId } = waiting({ isPrimary: false });

    expect(getByTestId('phase-control-retry-now').getAttribute('aria-disabled')).toBe('true');
    await fireEvent.click(getByTestId('phase-control-retry-now'));
    expect(postCommandSpy).not.toHaveBeenCalled();
  });
});

// Off-target phase controls — the surface can be showing one Task's phases
// while the queue it names is executing a different Run. Every control above is
// addressed by `queueId` alone, so on such a surface the command it posts is
// well-formed and names a real Run — the host cannot refuse it, because nothing
// in the payload says which Task the operator was looking at. The refusal has to
// happen here, and `isPrimary` alone was never the whole precondition.
describe('PhaseControlMenu — controls that do not address the displayed run', () => {
  const OFF_TARGET =
    'Unavailable while this view is showing a task other than the run executing on this queue.';

  const offTarget = (overrides: Record<string, unknown> = {}) =>
    render(PhaseControlMenu, {
      props: {
        targetsSubjectRun: false,
        queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-plan',
        isPrimary: true,
        manualPauseAt: null,
        ...overrides
      }
    });

  it('disables the queue-addressed controls and posts nothing when clicked', async () => {
    const { getByTestId } = offTarget();

    for (const testId of [
      'phase-control-pause',
      'phase-control-restart',
      'phase-control-skip',
      'phase-control-disable'
    ]) {
      expect(getByTestId(testId).getAttribute('aria-disabled')).toBe('true');
      await fireEvent.click(getByTestId(testId));
    }

    // Disabled is not enough on its own — each handler must also return early.
    // A control that greys out but still posts is the same defect wearing a
    // different colour.
    expect(postCommandSpy).not.toHaveBeenCalled();
  });

  it('disables Resume on a paused run it is not showing', async () => {
    const { getByTestId } = offTarget({ manualPauseAt: '2026-05-13T00:00:00.000Z' });

    expect(getByTestId('phase-control-resume').getAttribute('aria-disabled')).toBe('true');
    await fireEvent.click(getByTestId('phase-control-resume'));
    expect(postCommandSpy).not.toHaveBeenCalled();
  });

  it('disables Enable even when the displayed phase carries an override', async () => {
    // `hasOverride` is read off the *displayed* phase, so without the address
    // guard this control reads as enabled and clears an override on a phase of
    // another Run entirely.
    const { getByTestId } = offTarget({
      phaseOverrides: [{ phaseId: 'speckit-plan', action: 'disabled' as const }]
    });

    expect(getByTestId('phase-control-enable').getAttribute('aria-disabled')).toBe('true');
    await fireEvent.click(getByTestId('phase-control-enable'));
    expect(postCommandSpy).not.toHaveBeenCalled();
  });

  it('says why, rather than failing closed silently', () => {
    const { getByTestId } = offTarget();

    expect(getByTestId('phase-control-restart').getAttribute('title')).toBe(OFF_TARGET);
    expect(getByTestId('phase-control-skip').getAttribute('title')).toBe(OFF_TARGET);
  });

  it('leaves Delete enabled — it addresses the displayed task, not the queue', async () => {
    // The one control the guard must not touch. It posts the Task id and phase
    // the surface is displaying, so it was correctly addressed before this fix
    // and disabling it would remove a working capability to fix a defect it
    // does not have.
    const { getByTestId } = offTarget({ activeTaskId: 'task-7' });

    expect(getByTestId('phase-control-delete').getAttribute('aria-disabled')).toBe('false');
    expect(getByTestId('phase-control-delete').getAttribute('title')).not.toBe(OFF_TARGET);
  });
});
